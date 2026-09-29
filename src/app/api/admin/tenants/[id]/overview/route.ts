import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import {
  tenants, users, documents, passwords, subscriptionPlans, addons, tenantAddons,
  payments, invoices, discountCodes, discountUsages, creditTransactions, tenantAiUsages,
} from '@/db/schema';
import { and, count, desc, eq, isNull, isNotNull, sum, sql } from 'drizzle-orm';
import { getUserFromRequest } from '@/lib/auth';
import { checkStorageLimit } from '@/lib/storage';
import { DOCUMENT_CATEGORY_MODULES, UNCATEGORIZED } from '@/lib/documentCategories';
import { visibleDocument } from '@/lib/records/documentVisibility';
import { getDefaultPlan } from '@/lib/planProvisioning';
import { serverError } from '@/lib/routeError';

export const dynamic = 'force-dynamic';

/** Lists are for reading, not for export — enough history to answer a question. */
const HISTORY_LIMIT = 25;

const MODULE_NAMES = new Map(
  DOCUMENT_CATEGORY_MODULES.map((m) => [m.moduleKey, m.moduleName] as const),
);

/**
 * GET /api/admin/tenants/:id/overview
 *
 * Everything the super admin needs to answer "who is this tenant, what are they
 * paying for, and what have they got in here" in one round trip. Auth:
 * SUPER_ADMIN only.
 *
 * Exists because the workspace list could show a name, a UUID and a plan badge
 * and nothing else — while `discount_usages`, `payments`, `invoices` and
 * `credit_transactions` had been accumulating rows keyed by tenant that nothing
 * in the product ever read back.
 *
 * NOT wrapped in `withTenant`: this is a deliberately cross-tenant fleet read,
 * like every other route under /api/admin. The tenant id comes from the URL and
 * is only ever used after the SUPER_ADMIN gate above it.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getUserFromRequest(req);
    if (!user || user.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Access denied. Super Admin only.' }, { status: 403 });
    }

    const { id: tenantId } = await params;

    // Explicit columns, not `select()`. `apiKey` is ciphertext and
    // `googleDriveTokens` is a live OAuth grant; neither has any business in a
    // browser payload, and a `select *` here would ship both.
    const tenant = await db.query.tenants.findFirst({
      where: eq(tenants.id, tenantId),
      columns: {
        id: true, name: true, isActive: true, createdAt: true, updatedAt: true,
        aiProvider: true, aiModel: true, aiCreditsBalance: true,
        // Which axes this tenant has, for the default-plan fallback below.
        accountType: true,
        subscriptionPlanId: true, subscriptionExpiry: true,
        amcLastPaidAt: true, amcNextDueDate: true,
        planNoticeStage: true, planNoticeSentAt: true,
        hasCompletedOnboarding: true, vaultMode: true,
        googleDriveEnabled: true, googleAccountEmail: true,
        billingName: true, billingGst: true, billingAddress: true,
        billingEmail: true, billingPhone: true, contactName: true,
        apiKey: true,
      },
    });

    if (!tenant) {
      return NextResponse.json({ error: 'Tenant not found.' }, { status: 404 });
    }

    const [
      members, recordTotals, credentialTotal, moduleRows,
      plan, defaultPlan, tenantAddonRows,
      paymentRows, invoiceRows, promoRows, creditRows, aiUsageRows,
      latestCycleRow, storageData,
    ] = await Promise.all([
      db.select({
        id: users.id,
        name: users.name,
        email: users.email,
        phoneNumber: users.phoneNumber,
        role: users.role,
        emailVerified: users.emailVerified,
        phoneVerified: users.phoneVerified,
        createdAt: users.createdAt,
      })
        .from(users)
        .where(and(eq(users.tenantId, tenantId), isNull(users.deletedAt)))
        .orderBy(users.createdAt),

      db.select({
        records: count(),
        files: sql<number>`count(*) filter (where ${documents.filePath} is not null or ${documents.fileDriveId} is not null)`.mapWith(Number),
        bytes: sum(documents.fileSize).mapWith(Number),
      })
        .from(documents)
        .where(and(eq(documents.tenantId, tenantId), visibleDocument())),

      db.select({ value: count() })
        .from(passwords)
        .where(and(eq(passwords.tenantId, tenantId), isNull(passwords.deletedAt))),

      db.select({ moduleKey: documents.categoryModuleKey, value: count() })
        .from(documents)
        .where(and(eq(documents.tenantId, tenantId), visibleDocument()))
        .groupBy(documents.categoryModuleKey),

      tenant.subscriptionPlanId
        ? db.query.subscriptionPlans.findFirst({ where: eq(subscriptionPlans.id, tenant.subscriptionPlanId) })
        : Promise.resolve(undefined),
      // The default FOR THIS TENANT'S ACCOUNT TYPE. Since 0058 there are three
      // defaults, one trial per type, so a bare `isDefault` lookup would report
      // another type's quotas — and would pick differently between two
      // identical requests, since nothing orders it.
      getDefaultPlan(tenant.accountType),

      db.select({
        id: tenantAddons.id,
        addonId: addons.id,
        name: addons.name,
        description: addons.description,
        billingCycle: addons.billingCycle,
        extraMembers: addons.extraMembers,
        aiCredits: addons.aiCredits,
        storageLimitGB: addons.storageLimitGB,
        isActive: tenantAddons.isActive,
        purchasedAt: tenantAddons.purchasedAt,
        expiresAt: tenantAddons.expiresAt,
      })
        .from(tenantAddons)
        .innerJoin(addons, eq(tenantAddons.addonId, addons.id))
        .where(eq(tenantAddons.tenantId, tenantId))
        .orderBy(desc(tenantAddons.purchasedAt)),

      db.select({
        id: payments.id,
        amount: payments.amount,
        currency: payments.currency,
        status: payments.status,
        paymentMethod: payments.paymentMethod,
        paymentRef: payments.paymentRef,
        razorpayOrderId: payments.razorpayOrderId,
        planBillingCycle: payments.planBillingCycle,
        invoiceUrl: payments.invoiceUrl,
        initiatedBy: payments.initiatedBy,
        createdAt: payments.createdAt,
        planName: subscriptionPlans.name,
        addonName: addons.name,
      })
        .from(payments)
        .leftJoin(subscriptionPlans, eq(payments.planId, subscriptionPlans.id))
        .leftJoin(addons, eq(payments.addonId, addons.id))
        .where(eq(payments.tenantId, tenantId))
        .orderBy(desc(payments.createdAt))
        .limit(HISTORY_LIMIT),

      db.select({
        id: invoices.id,
        invoiceNumber: invoices.invoiceNumber,
        invoiceType: invoices.invoiceType,
        amount: invoices.amount,
        currency: invoices.currency,
        status: invoices.status,
        dueDate: invoices.dueDate,
        issuedDate: invoices.issuedDate,
        paymentLink: invoices.paymentLink,
      })
        .from(invoices)
        .where(eq(invoices.tenantId, tenantId))
        .orderBy(desc(invoices.issuedDate))
        .limit(HISTORY_LIMIT),

      // The redemption trail. Written on every discounted checkout since the
      // feature shipped and, until now, read by nothing.
      db.select({
        id: discountUsages.id,
        code: discountCodes.code,
        type: discountCodes.type,
        discountPct: discountCodes.discountPct,
        discountAmount: discountCodes.discountAmount,
        billingCycle: discountCodes.billingCycle,
        amountSaved: discountUsages.amountSaved,
        usedAt: discountUsages.usedAt,
        paymentId: discountUsages.paymentId,
        paymentAmount: payments.amount,
        paymentStatus: payments.status,
      })
        .from(discountUsages)
        .innerJoin(discountCodes, eq(discountUsages.discountCodeId, discountCodes.id))
        .leftJoin(payments, eq(discountUsages.paymentId, payments.id))
        .where(eq(discountUsages.tenantId, tenantId))
        .orderBy(desc(discountUsages.usedAt))
        .limit(HISTORY_LIMIT),

      db.select({
        id: creditTransactions.id,
        amount: creditTransactions.amount,
        balanceAfter: creditTransactions.balanceAfter,
        reason: creditTransactions.reason,
        description: creditTransactions.description,
        createdAt: creditTransactions.createdAt,
      })
        .from(creditTransactions)
        .where(eq(creditTransactions.tenantId, tenantId))
        .orderBy(desc(creditTransactions.createdAt))
        .limit(HISTORY_LIMIT),

      db.select({
        modelName: tenantAiUsages.modelName,
        promptTokens: sum(tenantAiUsages.promptTokens).mapWith(Number),
        completionTokens: sum(tenantAiUsages.completionTokens).mapWith(Number),
        cost: sum(tenantAiUsages.cost).mapWith(Number),
        calls: count(),
      })
        .from(tenantAiUsages)
        .where(eq(tenantAiUsages.tenantId, tenantId))
        .groupBy(tenantAiUsages.modelName),

      // `tenants` carries no billing-cycle column, so the cycle of record is
      // whatever the last captured plan payment was taken on.
      db.select({ planBillingCycle: payments.planBillingCycle, createdAt: payments.createdAt })
        .from(payments)
        .where(and(
          eq(payments.tenantId, tenantId),
          eq(payments.status, 'captured'),
          isNotNull(payments.planBillingCycle),
        ))
        .orderBy(desc(payments.createdAt))
        .limit(1),

      checkStorageLimit(tenantId, 0),
    ]);

    const effectivePlan = plan ?? defaultPlan ?? null;
    const liveAddons = tenantAddonRows.filter(
      (a) => a.isActive && (!a.expiresAt || new Date(a.expiresAt) > new Date()),
    );
    const owner = members.find((m) => m.role === 'TENANT_ADMIN') ?? null;

    const totals = recordTotals[0] ?? { records: 0, files: 0, bytes: 0 };

    return NextResponse.json({
      success: true,
      tenant: {
        id: tenant.id,
        name: tenant.name,
        isActive: tenant.isActive,
        createdAt: tenant.createdAt,
        hasCompletedOnboarding: tenant.hasCompletedOnboarding,
        vaultMode: tenant.vaultMode,
        googleDriveEnabled: tenant.googleDriveEnabled,
        googleAccountEmail: tenant.googleAccountEmail,
        aiProvider: tenant.aiProvider,
        aiModel: tenant.aiModel,
        // Whether a key exists, never the key. It is stored encrypted and there
        // is no reason to decrypt it for a status badge.
        hasCustomApiKey: Boolean(tenant.apiKey),
      },
      contact: {
        owner,
        billing: {
          contactName: tenant.contactName,
          billingEmail: tenant.billingEmail,
          billingPhone: tenant.billingPhone,
          billingName: tenant.billingName,
          billingGst: tenant.billingGst,
          billingAddress: tenant.billingAddress,
        },
        members: members.map((m) => ({
          id: m.id, name: m.name, email: m.email, phoneNumber: m.phoneNumber,
          role: m.role, emailVerified: m.emailVerified, phoneVerified: m.phoneVerified, joinedAt: m.createdAt,
        })),
      },
      plan: effectivePlan
        ? {
            id: effectivePlan.id,
            name: effectivePlan.name,
            isFallbackDefault: !plan,
            price: effectivePlan.price,
            priceYearly: effectivePlan.priceYearly,
            priceOneTime: effectivePlan.priceOneTime,
            amcAmount: effectivePlan.amcAmount,
            aiCredits: effectivePlan.aiCredits,
            maxMembers: effectivePlan.maxMembers,
            storageLimitGB: effectivePlan.storageLimitGB,
            durationDays: effectivePlan.durationDays,
            isLifetime: effectivePlan.isLifetime,
          }
        : null,
      subscription: {
        expiry: tenant.subscriptionExpiry,
        billingCycle: latestCycleRow[0]?.planBillingCycle ?? null,
        amcLastPaidAt: tenant.amcLastPaidAt,
        amcNextDueDate: tenant.amcNextDueDate,
        planNoticeStage: tenant.planNoticeStage,
        planNoticeSentAt: tenant.planNoticeSentAt,
      },
      addons: tenantAddonRows,
      // Seats granted by the plan plus every LIVE add-on — an expired add-on
      // still shows in the list above but must not inflate the entitlement.
      entitlements: {
        maxMembers: liveAddons.reduce((n, a) => n + (a.extraMembers || 0), effectivePlan?.maxMembers ?? 1),
        aiCreditsBalance: tenant.aiCreditsBalance,
        planAiCredits: effectivePlan?.aiCredits ?? 0,
        storage: {
          currentBytes: storageData.currentBytes,
          limitBytes: Number.isFinite(storageData.limitBytes) ? storageData.limitBytes : null,
          unlimited: Boolean(storageData.unlimited),
          isGoogleDrive: Boolean(storageData.isGoogleDrive),
          quotaCheckedAt: storageData.quotaCheckedAt ?? null,
        },
      },
      promoCodes: promoRows,
      payments: paymentRows,
      invoices: invoiceRows,
      credits: { balance: tenant.aiCreditsBalance, transactions: creditRows },
      aiUsage: aiUsageRows,
      records: {
        total: Number(totals.records) || 0,
        files: Number(totals.files) || 0,
        credentials: Number(credentialTotal[0]?.value) || 0,
        bytes: Number(totals.bytes) || 0,
        byModule: moduleRows
          .map((r) => ({
            moduleKey: r.moduleKey,
            // A null key is a legacy 'db'-mode row that predates the taxonomy,
            // not a module — say so rather than rendering a blank label.
            moduleName: r.moduleKey
              ? (MODULE_NAMES.get(r.moduleKey) ?? (r.moduleKey === UNCATEGORIZED.moduleKey ? 'Other' : r.moduleKey))
              : 'Unfiled',
            count: Number(r.value),
          }))
          .sort((a, b) => b.count - a.count),
      },
    });
  } catch (error) {
    return serverError(error, 'loading overview');
  }
}
