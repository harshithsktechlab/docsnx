import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import {
  tenants,
  users,
  documents,
  passwords,
  subscriptionPlans,
  tenantAiUsages,
  apiKeys,
  aiApiKeys,
  systemConfigs,
  auditLogs,
} from '@/db/schema';
import { eq, desc, sum, count, and, gte, lte, sql, isNull } from 'drizzle-orm';
import { getUserFromRequest } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user || user.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Access denied. Super Admin only.' }, { status: 403 });
    }

    // 1. Fetch all tenants & plans
    const allTenants = await db.select().from(tenants).orderBy(desc(tenants.createdAt));
    const allPlans = await db.select().from(subscriptionPlans);

    const planMap = new Map(allPlans.map((p) => [p.id, p]));

    // 2. Compute Fleet Stats
    const totalTenants = allTenants.length;
    const activeTenants = allTenants.filter((t) => t.isActive).length;
    const inactiveTenants = totalTenants - activeTenants;
    const onboardedTenants = allTenants.filter((t) => t.hasCompletedOnboarding).length;
    const googleDriveEnabledTenants = allTenants.filter((t) => t.googleDriveEnabled).length;

    // Estimated MRR calculation based on active tenant subscription plans
    let estimatedMRR = 0;
    const planDistributionMap: Record<string, { planId: string; name: string; price: number; count: number }> = {};

    for (const plan of allPlans) {
      planDistributionMap[plan.id] = {
        planId: plan.id,
        name: plan.name,
        price: Number(plan.price || 0),
        count: 0,
      };
    }

    for (const t of allTenants) {
      if (t.subscriptionPlanId && planDistributionMap[t.subscriptionPlanId]) {
        planDistributionMap[t.subscriptionPlanId].count += 1;
        if (t.isActive) {
          const planObj = planMap.get(t.subscriptionPlanId);
          if (planObj) {
            /**
             * `subscription_plans.price` IS the monthly price — the yearly and
             * one-time figures have columns of their own — so it is already the
             * monthly-equivalent this sum wants.
             *
             * This used to read `planObj.interval`, a column that does not
             * exist on the table. It was therefore always undefined, always
             * fell through to 'YEARLY', and always divided by twelve: the
             * dashboard reported one twelfth of the real MRR for every tenant
             * on the platform, and had since the field was first read.
             *
             * A tenant billed yearly still contributes their monthly equivalent
             * here. Which cycle a given tenant is actually on is not knowable
             * from `tenants` — it carries no billing-cycle column; the cycle of
             * record is the last captured payment's `plan_billing_cycle`.
             */
            estimatedMRR += Number(planObj.price || 0);
          }
        }
      }
    }

    const subscriptionBreakdown = Object.values(planDistributionMap);

    // 3. User & Vault telemetry counts
    const [userCount] = await db.select({ value: count() }).from(users).where(isNull(users.deletedAt));
    const [passCount] = await db.select({ value: count() }).from(passwords).where(isNull(passwords.deletedAt));

    // Every module's records are `documents` rows, so what were fourteen
    // sequential counts — thirteen of them over tables that no longer hold
    // anything — is one query.
    //
    // Platform-wide, deliberately not tenant-scoped: this is the SUPER_ADMIN
    // console, and `withTenant` would scope it to the admin's own tenant.
    const [recordCount] = await db
      .select({ value: count() })
      .from(documents)
      .where(isNull(documents.deletedAt));

    const totalVaultRecords = (recordCount?.value || 0) + (passCount?.value || 0);

    // 4. AI FinOps Telemetry
    const totalAiCreditsBalance = allTenants.reduce((acc, t) => acc + (t.aiCreditsBalance || 0), 0);
    const aiCostQuery = await db.select({ totalCost: sum(tenantAiUsages.cost) }).from(tenantAiUsages);
    const totalAiUsageCost = Number(aiCostQuery[0]?.totalCost || 0);

    // 5. API Key Health
    const activeApiKeysList = await db.select().from(apiKeys);
    const activeAiApiKeysList = await db.select().from(aiApiKeys);
    const totalApiKeys = activeApiKeysList.length + activeAiApiKeysList.length;
    const activeApiKeysCount =
      activeApiKeysList.filter((k) => k.isActive).length +
      activeAiApiKeysList.filter((k) => k.isActive).length;
    const errorApiKeysCount = activeApiKeysList.filter((k) => (k.errorCount || 0) > 0).length;

    // 6. Expiring & AMC Overdue Watchlists
    const now = new Date();
    const thirtyDaysFromNow = new Date();
    thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30);

    const expiringTenants = allTenants
      .filter((t) => t.subscriptionExpiry && new Date(t.subscriptionExpiry) <= thirtyDaysFromNow)
      .slice(0, 8)
      .map((t) => ({
        id: t.id,
        name: t.name,
        isActive: t.isActive,
        expiry: t.subscriptionExpiry,
        planName: t.subscriptionPlanId ? planMap.get(t.subscriptionPlanId)?.name || 'Custom' : 'Trial / Default',
      }));

    const overdueAmcTenants = allTenants
      .filter((t) => t.amcNextDueDate && new Date(t.amcNextDueDate) <= thirtyDaysFromNow)
      .slice(0, 8)
      .map((t) => ({
        id: t.id,
        name: t.name,
        isActive: t.isActive,
        amcDueDate: t.amcNextDueDate,
      }));

    // 7. Recent Tenants with Admin Email
    const recentTenantsSlice = allTenants.slice(0, 8);
    const recentTenantsWithAdmin = await Promise.all(
      recentTenantsSlice.map(async (t) => {
        const [adminUser] = await db
          .select({ email: users.email, name: users.name })
          .from(users)
          .where(and(eq(users.tenantId, t.id), eq(users.role, 'TENANT_ADMIN')))
          .limit(1);
        return {
          id: t.id,
          name: t.name,
          isActive: t.isActive,
          hasCompletedOnboarding: t.hasCompletedOnboarding,
          googleDriveEnabled: t.googleDriveEnabled,
          aiProvider: t.aiProvider,
          aiModel: t.aiModel,
          aiCreditsBalance: t.aiCreditsBalance,
          createdAt: t.createdAt,
          adminEmail: adminUser?.email || 'N/A',
          adminName: adminUser?.name || 'N/A',
          planName: t.subscriptionPlanId ? planMap.get(t.subscriptionPlanId)?.name || 'Standard' : 'Standard',
        };
      })
    );

    // 8. Recent Audit Logs
    const recentAuditLogs = await db
      .select()
      .from(auditLogs)
      .orderBy(desc(auditLogs.createdAt))
      .limit(8);

    // 9. System Config check
    const [sysConfig] = await db.select().from(systemConfigs).limit(1);

    return NextResponse.json({
      success: true,
      stats: {
        totalTenants,
        activeTenants,
        inactiveTenants,
        onboardedTenants,
        googleDriveEnabledTenants,
        totalUsers: userCount?.value || 0,
        totalVaultRecords,
        totalAiCreditsBalance,
        totalAiUsageCost,
        estimatedMRR: Math.round(estimatedMRR * 100) / 100,
      },
      subscriptionBreakdown,
      expiringTenants,
      overdueAmcTenants,
      aiKeyHealth: {
        totalApiKeys,
        activeApiKeysCount,
        errorApiKeysCount,
      },
      systemStatus: {
        // No `platformName`: the product's name is static (src/lib/brand.ts),
        // and this badge was the last place a billing-entity name could rename
        // the application. `sysConfig` is still read for the SMTP check below.
        smtpConfigured: Boolean(sysConfig?.smtpHost),
      },
      recentTenants: recentTenantsWithAdmin,
      recentAuditLogs,
    });
  } catch (error: any) {
    console.error('Failed to fetch admin dashboard summary:', error);
    return NextResponse.json(
      { success: false, error: error.message || 'Internal server error' },
      { status: 500 }
    );
  }
}
