import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { tenants, users, documents, passwords, tenantAiUsages, profiles, subscriptionPlans, tenantAddons, addons } from '@/db/schema';
import { eq, desc, sum, count, and, ne, isNull, sql } from 'drizzle-orm';
import { getUserFromRequest, hashPassword } from '@/lib/auth';
import { checkStorageLimit } from '@/lib/storage';
import { encryptField } from '@/lib/fieldCrypto';
import { DEFAULT_GEMINI_MODEL } from '@/lib/aiModels';
import { getDefaultPlan, newTenantPlanValues, recordSignupGrant } from '@/lib/planProvisioning';
import { visibleDocument } from '@/lib/records/documentVisibility';
import { serverError } from '@/lib/routeError';


export const dynamic = 'force-dynamic';

// GET — List all tenants with stats and aggregated AI usage metrics (Super Admin only)
export async function GET(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user || user.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Access denied. Super Admin only.' }, { status: 403 });
    }

    /**
     * Explicit columns, not `select()`. The row carries `apiKey` (ciphertext)
     * and `googleDriveTokens` (a live OAuth grant); a whole-row read pulls both
     * into a payload that is spread straight into the response below.
     */
    const tenantColumns = {
      id: tenants.id,
      name: tenants.name,
      isActive: tenants.isActive,
      createdAt: tenants.createdAt,
      aiProvider: tenants.aiProvider,
      aiModel: tenants.aiModel,
      aiCreditsBalance: tenants.aiCreditsBalance,
      accountType: tenants.accountType,
      subscriptionPlanId: tenants.subscriptionPlanId,
      subscriptionExpiry: tenants.subscriptionExpiry,
      amcNextDueDate: tenants.amcNextDueDate,
      planNoticeStage: tenants.planNoticeStage,
      hasCompletedOnboarding: tenants.hasCompletedOnboarding,
      vaultMode: tenants.vaultMode,
      googleDriveEnabled: tenants.googleDriveEnabled,
      googleAccountEmail: tenants.googleAccountEmail,
      billingName: tenants.billingName,
      billingGst: tenants.billingGst,
      billingAddress: tenants.billingAddress,
      billingEmail: tenants.billingEmail,
      billingPhone: tenants.billingPhone,
      contactName: tenants.contactName,
      // Whether a dedicated key exists — never the key.
      hasCustomApiKey: sql<boolean>`${tenants.apiKey} is not null`.mapWith(Boolean),
    };

    const tenantsList = user.tenantId
      ? await db.select(tenantColumns).from(tenants).where(ne(tenants.id, user.tenantId)).orderBy(desc(tenants.createdAt))
      : await db.select(tenantColumns).from(tenants).orderBy(desc(tenants.createdAt));

    // Everything below is fleet-wide and grouped by tenant, run ONCE. This used
    // to be seven queries per tenant inside the map — a plain N+1 that grew
    // with the customer list.
    const [memberRows, recordRows, credentialRows, adminRows, planRows, addonRows] = await Promise.all([
      db.select({ tenantId: users.tenantId, value: count() })
        .from(users)
        .where(isNull(users.deletedAt))
        .groupBy(users.tenantId),

      // Every module's records live in `documents`. The old code filtered
      // `category_module_key = 'documents'` and grouped on six pre-taxonomy keys
      // ('medical', 'bank_info', …); none of those values exist any more, so
      // every tile read zero. The honest split is total rows vs rows that
      // actually carry an attachment.
      db.select({
        tenantId: documents.tenantId,
        records: count(),
        files: sql<number>`count(*) filter (where ${documents.filePath} is not null or ${documents.fileDriveId} is not null)`.mapWith(Number),
      })
        .from(documents)
        // `visibleDocument()` rather than a bare deletedAt check: a tombstone is
        // not something the tenant has, and a half-written 'pending' row is not
        // something they can open. Both would overstate the tile.
        .where(visibleDocument())
        .groupBy(documents.tenantId),

      // Credentials were never counted at all — `passwords` was imported and
      // then never queried, so the "Creds" tile read `undefined || 0`.
      db.select({ tenantId: passwords.tenantId, value: count() })
        .from(passwords)
        .where(isNull(passwords.deletedAt))
        .groupBy(passwords.tenantId),

      // The owner account. `deletedAt` matters: without it an erased admin is
      // still reported as the tenant's contact.
      db.select({
        tenantId: users.tenantId,
        id: users.id,
        name: users.name,
        email: users.email,
        phoneNumber: users.phoneNumber,
        emailVerified: users.emailVerified,
        phoneVerified: users.phoneVerified,
        createdAt: users.createdAt,
      })
        .from(users)
        .where(and(eq(users.role, 'TENANT_ADMIN'), isNull(users.deletedAt)))
        .orderBy(users.createdAt),

      db.select({
        id: subscriptionPlans.id,
        name: subscriptionPlans.name,
        maxMembers: subscriptionPlans.maxMembers,
        storageLimitGB: subscriptionPlans.storageLimitGB,
        aiCredits: subscriptionPlans.aiCredits,
        isDefault: subscriptionPlans.isDefault,
        // Which axis a default belongs to — there are three since 0058.
        appliesTo: subscriptionPlans.appliesTo,
      }).from(subscriptionPlans),

      db.select({
        tenantId: tenantAddons.tenantId,
        id: tenantAddons.id,
        addonId: addons.id,
        name: addons.name,
        extraMembers: addons.extraMembers,
        aiCredits: addons.aiCredits,
      })
        .from(tenantAddons)
        .innerJoin(addons, eq(tenantAddons.addonId, addons.id))
        .where(eq(tenantAddons.isActive, true)),
    ]);

    const membersByTenant = new Map(memberRows.map((r) => [r.tenantId, Number(r.value)]));
    const recordsByTenant = new Map(recordRows.map((r) => [r.tenantId, r]));
    const credentialsByTenant = new Map(credentialRows.map((r) => [r.tenantId, Number(r.value)]));
    // First live TENANT_ADMIN by join date wins, matching the old `limit(1)`.
    const adminByTenant = new Map<string, (typeof adminRows)[number]>();
    for (const row of adminRows) {
      if (!adminByTenant.has(row.tenantId)) adminByTenant.set(row.tenantId, row);
    }
    const planById = new Map(planRows.map((p) => [p.id, p]));
    /**
     * The default plan FOR AN ACCOUNT TYPE. Since 0058 there are three — one
     * trial per type — so `find(p => p.isDefault)` returns whichever happens to
     * sort first and would report the wrong quotas for two thirds of the list.
     *
     * Resolved from `planRows`, which this route already loaded, rather than
     * with three more queries. Falls back by name so the answer is stable when
     * a tenant's type has no default of its own.
     */
    const defaultsByAxis = new Map(
      planRows.filter((p) => p.isDefault).map((p) => [p.appliesTo, p]),
    );
    const fallbackDefault = planRows
      .filter((p) => p.isDefault)
      .sort((a, b) => String(a.name).localeCompare(String(b.name)))[0] ?? null;
    const defaultPlanFor = (accountType: string | null | undefined) =>
      defaultsByAxis.get(accountType ?? 'personal') ?? fallbackDefault;
    const addonsByTenant = new Map<string, typeof addonRows>();
    for (const row of addonRows) {
      const list = addonsByTenant.get(row.tenantId);
      if (list) list.push(row);
      else addonsByTenant.set(row.tenantId, [row]);
    }

    const tenantsResult = await Promise.all(tenantsList.map(async (t) => {
      const recordCounts = recordsByTenant.get(t.id);
      const counts = {
        members: membersByTenant.get(t.id) ?? 0,
        records: recordCounts ? Number(recordCounts.records) : 0,
        files: recordCounts ? Number(recordCounts.files) : 0,
        credentials: credentialsByTenant.get(t.id) ?? 0,
      };

      const adminUser = adminByTenant.get(t.id) ?? null;

      const planDetails = (t.subscriptionPlanId ? planById.get(t.subscriptionPlanId) : defaultPlanFor(t.accountType))
        ?? { name: 'Default Plan', maxMembers: 1, storageLimitGB: 1, aiCredits: 0 };

      const activeAddons = addonsByTenant.get(t.id) ?? [];
      const maxMembers = activeAddons.reduce(
        (total, addon) => total + (addon.extraMembers || 0),
        planDetails.maxMembers,
      );

      // The one read that cannot be grouped: it resolves the Drive bypass and
      // the add-on storage grant per tenant.
      const storageData = await checkStorageLimit(t.id, 0);

      return {
        ...t,
        _count: counts,
        adminEmail: adminUser?.email || null,
        adminContact: adminUser
          ? {
              id: adminUser.id,
              name: adminUser.name,
              email: adminUser.email,
              phoneNumber: adminUser.phoneNumber,
              emailVerified: adminUser.emailVerified,
              phoneVerified: adminUser.phoneVerified,
              joinedAt: adminUser.createdAt,
            }
          : null,
        planName: planDetails.name,
        planAiCredits: planDetails.aiCredits,
        maxMembers: maxMembers,
        activeAddons: activeAddons,
        storageData: {
          currentBytes: storageData.currentBytes,
          // `limitBytes` is Infinity only when there is no ceiling to report —
          // a Drive quota never read, or a pooled Workspace account — and
          // JSON.stringify turns that into null, so the client branches on
          // `unlimited`. A connected Drive with a cached quota sends its real
          // figures here, which is what the workspace list shows instead of
          // the word "unlimited".
          limitBytes: Number.isFinite(storageData.limitBytes) ? storageData.limitBytes : null,
          unlimited: Boolean(storageData.unlimited),
          isGoogleDrive: Boolean(storageData.isGoogleDrive),
          quotaCheckedAt: storageData.quotaCheckedAt ?? null,
        },
      };
    }));

    // Fetch and aggregate AI usage metrics for each tenant
    const aiUsages = await db.select({
      tenantId: tenantAiUsages.tenantId,
      promptTokens: sum(tenantAiUsages.promptTokens).mapWith(Number),
      completionTokens: sum(tenantAiUsages.completionTokens).mapWith(Number),
      cost: sum(tenantAiUsages.cost).mapWith(Number)
    })
    .from(tenantAiUsages)
    .groupBy(tenantAiUsages.tenantId);

    const usagesMap: Record<string, any> = {};
    aiUsages.forEach(usage => {
      usagesMap[usage.tenantId] = {
        promptTokens: usage.promptTokens || 0,
        completionTokens: usage.completionTokens || 0,
        cost: Number(usage.cost || 0)
      };
    });

    const tenantsWithUsage = tenantsResult.map(t => ({
      ...t,
      aiUsage: usagesMap[t.id] || { promptTokens: 0, completionTokens: 0, cost: 0 }
    }));

    return NextResponse.json({ success: true, tenants: tenantsWithUsage });
  } catch (error) {
    return serverError(error, 'listing tenants');
  }
}

// POST — Create a new tenant with initial custom settings
export async function POST(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user || user.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Access denied. Super Admin only.' }, { status: 403 });
    }

    const { 
      name, apiKey, aiProvider, aiModel, subscriptionPlanId, 
      subscriptionExpiry, isActive, adminEmail, adminName, adminPassword 
    } = await req.json();

    if (!name) {
      return NextResponse.json({ error: 'Name is required.' }, { status: 400 });
    }

    // Check Admin Email uniqueness
    if (adminEmail) {
      const [existingUser] = await db.select({ id: users.id }).from(users).where(eq(users.email, adminEmail.toLowerCase().trim()));
      if (existingUser) {
        return NextResponse.json({ error: 'Admin Email already registered.' }, { status: 400 });
      }
    }

    const expiryDate = subscriptionExpiry ? new Date(subscriptionExpiry) : null;

    // Load the full plan row, not just its id — the tenant's starting AI credit
    // balance is seeded from it.
    let assignedPlan = null;
    if (subscriptionPlanId) {
      // subscriptionPlanId here is treated as a plan UUID sent from the form
      assignedPlan = await db.query.subscriptionPlans.findFirst({
        where: (plan, { eq }) => eq(plan.id, subscriptionPlanId),
      }) || null;
    }

    if (!assignedPlan) {
      // Same reasoning as the SSO route: this path sets no `account_type`,
      // so the tenant is created personal and takes the personal trial.
      assignedPlan = await getDefaultPlan('personal');

      if (!assignedPlan) {
        return NextResponse.json({ error: 'Tenant creation disabled: No default subscription plan configured in the system.' }, { status: 400 });
      }
    }

    const planValues = newTenantPlanValues(assignedPlan);

    const [newTenant] = await db.insert(tenants).values({
      name: name.trim(),
      apiKey: apiKey ? encryptField(apiKey.trim()) : null, // encrypted at rest
      aiProvider: aiProvider || 'gemini',
      aiModel: aiModel || DEFAULT_GEMINI_MODEL,
      ...planValues,
      // An explicit expiry from the form wins over the plan's duration.
      ...(expiryDate ? { subscriptionExpiry: expiryDate } : {}),
      isActive: isActive !== undefined ? isActive : true
    }).returning();

    // Opens the credit ledger. Attributed to the acting super admin rather
    // than to the tenant's own admin, who may not exist yet.
    await recordSignupGrant(db, {
      tenantId: newTenant.id,
      amount: planValues.aiCreditsBalance,
      userId: user.id,
      planName: assignedPlan?.name,
    });

    // Create initial admin user if provided
    if (adminEmail && adminPassword) {
      const passwordHash = await hashPassword(adminPassword);
      const [newUser] = await db.insert(users).values({
        tenantId: newTenant.id,
        email: adminEmail.toLowerCase().trim(),
        passwordHash,
        name: (adminName || 'Tenant Admin').trim(),
        role: 'TENANT_ADMIN'
      }).returning();

      // Create default profile
      await db.insert(profiles).values({
        userId: newUser.id,
        personalDetails: {},
        educationDetails: {},
        shoppingDetails: {},
        legalDetails: {},
      });
    }

    return NextResponse.json({ success: true, tenant: newTenant }, { status: 201 });
  } catch (error) {
    return serverError(error, 'creating tenant');
  }
}
