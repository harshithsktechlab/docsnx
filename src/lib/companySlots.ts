/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   HOW MANY COMPANIES ARE LEFT — and what to say about it                 ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * A business plan sells "N companies, M members in each". N is almost always 1:
 * the company the customer named on the sign-up form, created in the same
 * transaction as their tenant (see POST /api/auth/register). The onboarding
 * wizard nonetheless opened its Companies step with an empty "Company Name" box
 * and an "Add Company" button — a form whose only possible outcome, on that
 * plan, was the 403 from POST /api/companies saying the plan includes one.
 *
 * So the step asks this module what to draw. The rule is deliberately NOT "hide
 * the form when the list is non-empty": a tenant on a three-company plan has
 * two left after sign-up and must be able to add them here.
 *
 * ── AN UNKNOWN LIMIT MEANS SHOW THE FORM ───────────────────────────────────
 * `limit` is null when the quota could not be read — an older cached bundle, a
 * failed request, a member whom GET /api/companies does not tell. Hiding the
 * form then would strand an admin who genuinely has room, and the server is
 * still the thing enforcing the limit. Optimism here costs at worst a 403 with
 * a sentence explaining it; pessimism costs a wizard that cannot be finished.
 */

/** What the Companies step needs to know, all of it derived from two numbers. */
export interface CompanySlots {
  /** The plan's allowance plus add-ons, or null when it could not be read. */
  limit: number | null;
  /** Companies already holding a slot — live ones, deactivated included. */
  used: number;
  /** Slots left, or null when the limit is unknown. Never negative. */
  remaining: number | null;
  /** Draw the "Add Company" form? */
  canAdd: boolean;
  /** True only when the limit is known AND genuinely reached. */
  atLimit: boolean;
  /** No business allowance at all — an upgrade, not an add-on. */
  noAllowance: boolean;
}

/**
 * A count that is actually a count, else null.
 *
 * Not `Number(value)` alone: `Number(null)` is 0 and `Number('')` is 0, so an
 * ABSENT quota would parse as an allowance of ZERO — and a zero allowance is
 * the one value that tells the wizard the account has no business plan. That is
 * the worst available misreading of "I don't know yet".
 */
function whole(value: unknown): number | null {
  const n = typeof value === 'number'
    ? value
    : (typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * @param used  live companies in the tenant — from the server's own count, not
 *              the length of the list on screen. The list is what the CALLER
 *              may reach and omits deactivated companies, which still hold a
 *              slot; deriving `used` from it would offer a slot POST refuses.
 * @param limit the plan allowance, or null/undefined when it is not known.
 */
export function companySlots(used: unknown, limit: unknown): CompanySlots {
  const usedCount = whole(used) ?? 0;
  const limitCount = whole(limit);

  if (limitCount === null) {
    return {
      limit: null, used: usedCount, remaining: null,
      canAdd: true, atLimit: false, noAllowance: false,
    };
  }

  const remaining = Math.max(0, limitCount - usedCount);
  return {
    limit: limitCount,
    used: usedCount,
    remaining,
    canAdd: remaining > 0,
    atLimit: remaining === 0,
    // A zero allowance is not "you are full", it is "you have no business plan".
    // The two want different words and a different button.
    noAllowance: limitCount === 0,
  };
}

/** `1` reads better than `1 company` in a sentence about a plan's contents. */
function companyCount(n: number): string {
  return `${n} ${n === 1 ? 'company' : 'companies'}`;
}

/**
 * The sentence under "Your Companies", in the wizard's voice.
 *
 * One lead clause, then the part that changes — because the step's own job
 * ("everything is filed under a company") is true on every plan, and only the
 * instruction that follows depends on how many slots are left.
 */
export function companyStepBlurb(slots: CompanySlots): string {
  const lead = 'Every business document is filed under a company.';

  if (slots.noAllowance) {
    return `${lead} Your plan does not include a business account yet — choose a `
      + 'business plan from Billing to add one.';
  }
  if (slots.limit === null) {
    return `${lead} You added one when you signed up — add more here if you run `
      + 'more than one.';
  }
  if (slots.used === 0) {
    return `${lead} Your plan includes ${companyCount(slots.limit)} — add `
      + `${slots.limit === 1 ? 'yours' : 'your first'} to continue.`;
  }
  if (slots.atLimit) {
    return slots.limit === 1
      ? `${lead} You named yours when you signed up, and your plan includes one — `
        + 'so this step is already done.'
      : `${lead} You have added all ${companyCount(slots.limit)} your plan includes.`;
  }
  return `${lead} Your plan includes ${companyCount(slots.limit)}, so you can add `
    + `${slots.remaining} more.`;
}
