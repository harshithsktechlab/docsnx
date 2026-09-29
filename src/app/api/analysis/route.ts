import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { aiAnalysisCache } from '@/db/schema';
import { getUserFromRequest, hasCompanyAccess, hasPersonalAccess } from '@/lib/auth';
import { requireActivePlan, requireActivePlanFor } from '@/lib/planGate';
import { eq, and } from 'drizzle-orm';
import { generateCategoryAnalysis } from '@/lib/ai';
import { getAIProfile } from '@/lib/aiProfiles';
import { companyIdFromRequest, listRecords, recordContextFor } from '@/lib/records/handler';
import { inCompanyOf } from '@/lib/records/companyScope';
import { BUSINESS_MODULE_PREFIX } from '@/lib/documentCategories';
import { isRecordScope } from '@/lib/records/registry';
import { serverError } from '@/lib/routeError';
import { AI_ERROR_MESSAGES, AI_STATUS } from '@/lib/aiErrors';

/** A failure placeholder rather than an analysis — never cached, never served from cache. */
function isFailedAnalysis(data: unknown): boolean {
  return typeof data === 'object' && data !== null && 'error' in data;
}

export async function GET(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const gate = requireActivePlan(user);
    if (gate) return gate;

    if (user.role === 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const tenantId = user.tenantId;

    const { searchParams } = new URL(req.url);
    const forceRefresh = searchParams.get('refresh') === 'true';
    const category = searchParams.get('category');

    if (!category) {
      return NextResponse.json({ error: 'Category is required' }, { status: 400 });
    }

    const profile = getAIProfile(category);

    // The category the caller asks for is one of SIX spellings this route used
    // to accept — `lic_mediclaim` or `insurance`, `vehicles` or `vehicle`,
    // `contracts` or `contract_agreement`. They all resolve to a record SCOPE:
    // analysis is per PAGE, since that is the set of records a user asked about.
    // 0023's taxonomy module names are accepted as aliases too, so a caller that
    // has already moved to the new vocabulary keeps working.
    const ALIASES: Record<string, string> = {
      insurance: 'lic_mediclaim', investment: 'investments', vehicle: 'vehicles',
      document: 'documents', bank: 'bank_info', banking: 'bank_info', demat: 'trading',
      warranty_amc: 'warranty', contracts: 'rentals', contract_agreement: 'rentals',
      tax: 'tax_compliance', will_estate: 'wills_estate', loan_debt: 'loans_debt',
      utility_bill: 'utility_bills',
      // 0023 module names → the page that owns most of them.
      identity: 'documents', education: 'documents', civil_government: 'documents',
      bank_investments: 'bank_info', health_medical: 'medical',
      property_legal: 'wills_estate', employment: 'employment_payroll',
      rentals_subscriptions: 'rentals',
      other: 'documents',
    };
    const moduleKey = ALIASES[category] ?? category;

    if (!isRecordScope(moduleKey)) {
      return NextResponse.json({ error: 'Invalid category' }, { status: 400 });
    }

    /**
     * ── WHICH WORKSPACE IS BEING ANALYSED ────────────────────────────────────
     *
     * A business module analysed with no company builds a PERSONAL context, so
     * `listRecords` filters on `company_id IS NULL` and the model is handed an
     * empty set — the page then reports, confidently, that the company has no
     * records. Wrong and expensive: it costs an AI call to say nothing.
     *
     * So the same four rules as every other business surface: shape-check,
     * require the module and the company to agree, then PROVE whichever
     * workspace was asked for — the company, or the household.
     */
    const companyId = companyIdFromRequest(req);
    if (companyId === undefined) {
      return NextResponse.json({ error: 'Invalid company' }, { status: 400 });
    }
    const wantsCompany = moduleKey.startsWith(BUSINESS_MODULE_PREFIX);
    if (wantsCompany !== Boolean(companyId)) {
      return NextResponse.json(
        { error: wantsCompany
          ? 'This module belongs to a company. Choose one first.'
          : 'This module is personal and takes no company.' },
        { status: 400 },
      );
    }
    if (companyId && !await hasCompanyAccess(user, companyId)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    // The household is a workspace and is proven like one. A business member
    // holds no personal module, so `isRecordScope` has already refused them
    // above — this is the belt to that pair of braces, and it keeps this
    // hand-rolled gate identical to `resolveUtilityCompany`, which is the only
    // reason the two can be read against each other.
    if (!companyId && !hasPersonalAccess(user)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    /**
     * The plan that covers THIS workspace, now that the company is proven.
     *
     * This route resolves its company by hand rather than through
     * `resolveUtilityCompany` (it has to enforce module/company agreement
     * against `moduleKey`, which that helper does not know), so it does not
     * inherit that function's plan gate and has to ask for itself. The
     * account-level `requireActivePlan` at the top of the handler stays: it
     * fires only when every axis is dead, and is not a substitute for this.
     */
    const workspaceGate = requireActivePlanFor(user, companyId ?? null);
    if (workspaceGate) return workspaceGate;

    // Check cache first if not force refreshing
    //
    // The company is resolved ABOVE this rather than after it, which is the
    // order it used to be in. The cache key includes the workspace, so reading
    // it before the company is known — and before `hasCompanyAccess` has proved
    // it — would hand back whichever company's answer happened to be stored.
    if (!forceRefresh) {
      const cached = await db.query.aiAnalysisCache.findFirst({
        where: and(
          eq(aiAnalysisCache.tenantId, tenantId),
          eq(aiAnalysisCache.userId, user.id),
          eq(aiAnalysisCache.category, category),
          inCompanyOf(aiAnalysisCache.companyId, companyId),
        ),
      });

      // A row carrying `error` is a failure that an older build cached as an
      // answer. It is a miss, so it is regenerated rather than served forever.
      if (cached && cached.analysisData && !isFailedAnalysis(cached.analysisData)) {
        return NextResponse.json({
          success: true,
          analysis: {
            ...(typeof cached.analysisData === 'object' ? cached.analysisData : {}),
            disclaimer: profile.mandatoryDisclaimer
          },
          disclaimer: profile.mandatoryDisclaimer,
          cached: true,
          updatedAt: cached.updatedAt
        });
      }
    }

    // One query where there were fifteen branches. `prepareAiPayload` still
    // strips credentials and masks PII downstream, but the bigger change is
    // that only the OPEN tier reaches it: sealed values are not in the
    // projection at all, so the AI cannot be handed an identifier by accident.
    // The AI sees only what this member is allowed to see. `recordContextFor`
    // resolves that per sub-category, so a denied category is absent from the
    // payload rather than the whole request being refused.
    const ctx = await recordContextFor(user, moduleKey, 'view', companyId);
    if (ctx.keys.length === 0) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    const { records } = await listRecords(ctx, { limit: 500 });
    const categoryData = records.map((r) => ({
      id: r.id,
      title: r.title,
      category: r.categoryName,
      recordType: r.recordType,
      issuer: r.issuer,
      ...r.fields,
    }));

    const analysis = await generateCategoryAnalysis(moduleKey, categoryData, tenantId, user.id, companyId);
    // `generateCategoryAnalysis` throws on failure now. This guard stays in case
    // it ever returns a failure again, because caching one overwrites the last
    // good analysis.
    if (isFailedAnalysis(analysis)) {
      return NextResponse.json(
        { error: AI_ERROR_MESSAGES.UNKNOWN, errorCode: 'UNKNOWN' },
        { status: 502 },
      );
    }
    const enrichedAnalysis = {
      ...(typeof analysis === 'object' ? analysis : {}),
      disclaimer: profile.mandatoryDisclaimer
    };

    // Save to cache, under the workspace it was derived from. `inCompanyOf`
    // here as well as on the read: without it the lookup finds the household's
    // row and the company's answer is written over the top of it.
    const existingCache = await db.query.aiAnalysisCache.findFirst({
      where: and(
        eq(aiAnalysisCache.tenantId, tenantId),
        eq(aiAnalysisCache.userId, user.id),
        eq(aiAnalysisCache.category, category),
        inCompanyOf(aiAnalysisCache.companyId, companyId),
      ),
    });

    if (existingCache) {
      await db.update(aiAnalysisCache)
        .set({
          analysisData: enrichedAnalysis,
          updatedAt: new Date()
        })
        .where(eq(aiAnalysisCache.id, existingCache.id));
    } else {
      await db.insert(aiAnalysisCache).values({
        tenantId,
        userId: user.id,
        category,
        companyId,
        analysisData: enrichedAnalysis,
      });
    }

    return NextResponse.json({
      success: true,
      analysis: enrichedAnalysis,
      disclaimer: profile.mandatoryDisclaimer,
      cached: false
    });
  } catch (error: any) {
    // A classified AI failure carries a written, actionable sentence and its
    // code — both are safe to send and the client keys off the code. Anything
    // else is an unclassified throw whose `message` may quote SQL, a Drive file
    // id or key material, so it goes to the journal and not to the browser.
    if (error?.errorCode) {
      return NextResponse.json(
        { error: AI_ERROR_MESSAGES[error.errorCode] || error.message, errorCode: error.errorCode },
        { status: AI_STATUS[error.errorCode] || 500 },
      );
    }
    return serverError(error, 'analysing your portfolio');
  }
}
