/**
 * The AI credit ledger's vocabulary and display helpers.
 *
 * This module is deliberately free of any `db` / `pg` import so it can be
 * imported from client components (the /billing/credits page) as well as from
 * server routes — the same split that keeps `auditActions.ts` separate from
 * `audit.ts`. The writers live in `src/lib/planProvisioning.ts`.
 *
 * Kept separate from `ACTIONS.credits.*` in auditActions.ts on purpose: those
 * strings feed the /audit-logs filter dropdown, and ledger-only reasons have no
 * business appearing there. Where a movement writes BOTH a ledger row and an
 * audit row, each keeps its own vocabulary.
 */

/**
 * The two AI credit pools. A tenant holds one balance per pool: `personal` is
 * `tenants.ai_credits_balance` (the name it had as the one wallet) and
 * `business` is `tenants.ai_credits_balance_business`.
 */
export const CREDIT_POOLS = ['personal', 'business'] as const;
export type CreditPool = (typeof CREDIT_POOLS)[number];

export const POOL_LABELS: Record<CreditPool, string> = {
  personal: 'Personal',
  business: 'Business',
};

export function isCreditPool(value: unknown): value is CreditPool {
  return value === 'personal' || value === 'business';
}

/** The pool a workspace spends: a company draws on Business, the household on Personal. */
export function poolForWorkspace(companyId: string | null | undefined): CreditPool {
  return companyId ? 'business' : 'personal';
}

export function otherPool(pool: CreditPool): CreditPool {
  return pool === 'personal' ? 'business' : 'personal';
}

/**
 * What one grant of a plan adds to each pool.
 *
 * Reads the two parts, and falls back to the legacy single figure for a plan
 * object that predates them (a fixture, or a partial row): it all went to the
 * one wallet, which is the Personal pool. Never lets a missing part read as a
 * grant of nothing when `aiCredits` says otherwise.
 */
export function planCreditGrant(plan: {
  aiCredits?: number | null;
  aiCreditsPersonal?: number | null;
  aiCreditsBusiness?: number | null;
  appliesTo?: string | null;
}): { personal: number; business: number; total: number } {
  const hasParts = plan.aiCreditsPersonal != null || plan.aiCreditsBusiness != null;
  if (hasParts) {
    const personal = plan.aiCreditsPersonal ?? 0;
    const business = plan.aiCreditsBusiness ?? 0;
    return { personal, business, total: personal + business };
  }
  const total = plan.aiCredits ?? 0;
  return plan.appliesTo === 'business'
    ? { personal: 0, business: total, total }
    : { personal: total, business: 0, total };
}

/** Canonical `reason` codes stored in `credit_transactions.reason`. */
export const CREDIT_REASONS = {
  // ─── Credits in ───────────────────────────────────────────────────────────
  /** Seeded onto a brand-new tenant from its assigned plan. */
  signup_grant: 'signup_grant',
  /** A subscription plan applied — new, renewed or upgraded. */
  plan_grant: 'plan_grant',
  /** An add-on purchase that carries AI credits. */
  addon_grant: 'addon_grant',
  /** Super admin moved the balance by a signed delta. */
  admin_adjust: 'admin_adjust',
  /** Super admin overwrote the balance with an absolute figure. */
  admin_set: 'admin_set',
  /** Trial credits granted outside a plan. */
  trial_grant: 'trial_grant',
  /** Existing credits divided between the Personal and Business pools (0086). */
  pool_split: 'pool_split',

  // ─── Credits out ──────────────────────────────────────────────────────────
  spend_record_analysis: 'spend_record_analysis',
  spend_category_analysis: 'spend_category_analysis',
  spend_portfolio_analysis: 'spend_portfolio_analysis',
  spend_bulk_scan: 'spend_bulk_scan',
  /**
   * Naming ONE uploaded document's sub-category, before its fields are read.
   *
   * Its own reason rather than `spend_bulk_scan`: it is a tenth of the cost and
   * a different question, and the Documents Manager's auto-fill spends it on
   * every classify. Folded into Power Scan, the credits page would report a
   * batch scan the tenant never ran.
   */
  spend_doc_classify: 'spend_doc_classify',
} as const;

export type CreditReason = (typeof CREDIT_REASONS)[keyof typeof CREDIT_REASONS];

/**
 * The action names `executeTenantWithRotation` is called with, mapped to the
 * reason recorded for the deduction.
 *
 * Deliberately a total map over the action names in src/lib/ai.js rather than a
 * string transform: a new AI action must be given a reason here consciously,
 * and the fallback below makes an unmapped one visible instead of silent.
 */
export const AI_ACTION_TO_REASON: Record<string, CreditReason> = {
  RECORD_ANALYSIS: CREDIT_REASONS.spend_record_analysis,
  CATEGORY_ANALYSIS: CREDIT_REASONS.spend_category_analysis,
  PORTFOLIO_ANALYSIS: CREDIT_REASONS.spend_portfolio_analysis,
  BULK_SCAN: CREDIT_REASONS.spend_bulk_scan,
  /**
   * Reading ONE document's fields. Its own action so `tenant_ai_usages` can
   * tell it apart from a batch scan, but priced and labelled exactly as a
   * Power scan in the credit ledger — that is what it has always cost.
   */
  FIELD_READ: CREDIT_REASONS.spend_bulk_scan,
  DOC_CLASSIFY: CREDIT_REASONS.spend_doc_classify,
};

const LABELS: Record<string, string> = {
  [CREDIT_REASONS.signup_grant]: 'Welcome credits',
  [CREDIT_REASONS.plan_grant]: 'Plan credits',
  [CREDIT_REASONS.addon_grant]: 'Add-on credits',
  [CREDIT_REASONS.admin_adjust]: 'Admin adjustment',
  [CREDIT_REASONS.admin_set]: 'Admin correction',
  [CREDIT_REASONS.trial_grant]: 'Trial credits',
  [CREDIT_REASONS.pool_split]: 'Credits divided between pools',
  [CREDIT_REASONS.spend_record_analysis]: 'Record analysis',
  [CREDIT_REASONS.spend_category_analysis]: 'Category analysis',
  [CREDIT_REASONS.spend_portfolio_analysis]: 'Portfolio analysis',
  [CREDIT_REASONS.spend_bulk_scan]: 'Power scan',
  [CREDIT_REASONS.spend_doc_classify]: 'Document identified',
};

/**
 * Display label for a reason code.
 *
 * An unknown code is title-cased rather than dropped: a row written by a future
 * reason this build has not heard of must still be legible in the table, since
 * the ledger is append-only and old rows are read by new code forever.
 */
export function formatCreditReason(reason: string): string {
  if (LABELS[reason]) return LABELS[reason];
  return reason
    .replace(/^spend_/, '')
    .split('_')
    .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
    .join(' ');
}

/** Badge variant for a movement, keyed on the sign of `amount`. */
export function creditAmountVariant(amount: number): 'success' | 'secondary' {
  return amount >= 0 ? 'success' : 'secondary';
}

/** 'grant' | 'spend', derived from the sign. Used by the ledger's direction filter. */
export function creditDirection(amount: number): 'grant' | 'spend' {
  return amount >= 0 ? 'grant' : 'spend';
}

/**
 * Display names for `tenant_ai_usages.action` — the AI task a call performed.
 * Same wording as the credits page, plus "Field read", which the credit ledger
 * files under Power scan (it is priced as one) but the usage log tells apart.
 */
export const AI_TASK_LABELS: Record<string, string> = {
  RECORD_ANALYSIS: 'Record analysis',
  CATEGORY_ANALYSIS: 'Category analysis',
  PORTFOLIO_ANALYSIS: 'Portfolio analysis',
  BULK_SCAN: 'Power scan',
  FIELD_READ: 'Field read',
  DOC_CLASSIFY: 'Document identified',
};

/** One line on what each task is, for the AI Usage page's help text. */
export const AI_TASK_DESCRIPTIONS: Record<string, string> = {
  BULK_SCAN: 'Power Scan pass 1 — one call per scan that sorts every page into records.',
  FIELD_READ: 'Reading one document\'s fields (Power Scan pass 2, or an upload with a category).',
  DOC_CLASSIFY: 'Working out what an uploaded document is (Documents Manager auto-fill).',
  CATEGORY_ANALYSIS: 'AI insights over all records of one category.',
  RECORD_ANALYSIS: 'AI insights on one record.',
  PORTFOLIO_ANALYSIS: 'AI insights over the whole portfolio.',
};

/** Label for an action code; NULL is a row written before task tracking (0075). */
export function aiTaskLabel(action: string | null | undefined): string {
  if (!action || action === 'NONE') return 'Before tracking';
  return AI_TASK_LABELS[action] ?? action;
}

/** Every reason code, for building the filter dropdown. */
export const ALL_CREDIT_REASONS = Object.values(CREDIT_REASONS) as CreditReason[];
