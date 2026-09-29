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
  DOC_CLASSIFY: CREDIT_REASONS.spend_doc_classify,
};

const LABELS: Record<string, string> = {
  [CREDIT_REASONS.signup_grant]: 'Welcome credits',
  [CREDIT_REASONS.plan_grant]: 'Plan credits',
  [CREDIT_REASONS.addon_grant]: 'Add-on credits',
  [CREDIT_REASONS.admin_adjust]: 'Admin adjustment',
  [CREDIT_REASONS.admin_set]: 'Admin correction',
  [CREDIT_REASONS.trial_grant]: 'Trial credits',
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

/** Every reason code, for building the filter dropdown. */
export const ALL_CREDIT_REASONS = Object.values(CREDIT_REASONS) as CreditReason[];
