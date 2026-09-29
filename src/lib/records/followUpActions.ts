/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   WHAT THE CARD ASKS YOU TO DO                                           ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Every renewal card on /follow-up used to carry the same button — "Take
 * Action" — whether the record was a lapsed lease, an unpaid electricity bill
 * or an expiring PUC certificate. The other three tabs already say what they
 * want ("Resolve Gap", "Upload Document", "View Task"); renewals was the one
 * that made the reader open the record to find out what the action was.
 *
 * The verb is a property of the taxonomy module, so it is looked up from the
 * module (with a handful of sub-category overrides where the module verb is too
 * coarse — a premium receipt is paid, not renewed) rather than branched on at
 * the call site. Adding a module here is a line in a map.
 *
 * ── WHY THIS IS SERVER-SIDE COPY ───────────────────────────────────────────
 * `remindersForCategory` sets it on the item, not the page. /follow-up, the
 * sidebar count route and the notification job all read the same builder, and
 * followUps.ts's own header is about what happens when two of them keep a rule
 * to themselves: they drift. One producer, one wording.
 *
 * No I/O and no imports on purpose — this is a lookup, and it stays testable as
 * one (tests/followUpActions.test.ts).
 */

export interface RenewalAction {
  /** Button text while the date is still ahead. */
  cta: string;
  /**
   * Button text once the date has passed. Defaults to `${cta} Now`, which reads
   * correctly for every mapped verb; the fallback overrides it because "Review
   * & Renew Now" does not.
   */
  overdueCta?: string;
  /** The "Recommended Action:" sentence — how to actually clear the reminder. */
  how: string;
}

/**
 * Taxonomy module → what you do about a reminder filed under it.
 *
 * Keys are `moduleKey` values from src/lib/documentCategories.ts. `other` is
 * deliberately absent: the catch-all holds records whose module could not be
 * determined, so it has no verb of its own and takes the fallback.
 */
const MODULE_ACTIONS: Record<string, RenewalAction> = {
  insurance: {
    cta: 'Renew Policy',
    how: 'Pay the renewal premium and file the new policy schedule.',
  },
  vehicle: {
    cta: 'Renew Registration',
    how: 'Renew at the RTO or an authorised centre, then upload the new certificate.',
  },
  utility_bills: {
    cta: 'Pay Bill',
    how: 'Pay the bill and file the receipt against this record.',
  },
  tax_compliance: {
    cta: 'File Now',
    how: 'File the return or pay the instalment before the due date.',
  },
  property_legal: {
    cta: 'Review Contract',
    how: 'Review the deed or agreement and start the renewal.',
  },
  rentals_subscriptions: {
    cta: 'Renew Agreement',
    how: 'Confirm with the landlord or provider and file the renewed agreement.',
  },
  warranty_amc: {
    cta: 'Renew AMC',
    how: 'Contact the service provider to extend the warranty or AMC.',
  },
  identity: {
    cta: 'Renew Document',
    how: 'Start the renewal with the issuing authority and upload the new copy.',
  },
  civil_government: {
    cta: 'Renew Document',
    how: 'Apply for the renewal with the issuing department.',
  },
  bank_investments: {
    cta: 'Review Account',
    how: 'Confirm the maturity or renewal instruction with your bank.',
  },
  health_medical: {
    cta: 'Book Follow-Up',
    how: 'Schedule the follow-up and file the new report.',
  },
  employment: {
    cta: 'Review Record',
    how: 'Review the document and file the updated copy.',
  },
  education: {
    cta: 'Review Record',
    how: 'Review the document and file the updated copy.',
  },
};

/**
 * `${moduleKey}/${documentKey}` overrides, for the sub-categories whose module
 * verb would be wrong rather than merely vague — you pay a premium receipt and
 * a property tax receipt, you do not "renew" them.
 */
const SUB_CATEGORY_ACTIONS: Record<string, RenewalAction> = {
  'insurance/premium_receipts': {
    cta: 'Pay Premium',
    how: 'Pay the premium instalment and file the receipt.',
  },
  'vehicle/puc_certificate': {
    cta: 'Renew PUC',
    how: 'Get the emissions test done and upload the new PUC certificate.',
  },
  'property_legal/property_tax_receipts': {
    cta: 'Pay Property Tax',
    how: 'Pay the municipal property tax and file the receipt.',
  },
  'rentals_subscriptions/subscription_receipts': {
    cta: 'Renew Subscription',
    how: 'Renew or cancel the subscription before it auto-charges.',
  },
  'bank_investments/loan_agreements': {
    cta: 'Review Loan',
    how: 'Check the instalment or reset date with your lender.',
  },
  'identity/passport': {
    cta: 'Renew Passport',
    how: 'Book a Passport Seva appointment and upload the reissued passport.',
  },
  'identity/driving_license': {
    cta: 'Renew Licence',
    how: 'Renew the licence at the RTO and upload the new card.',
  },
};

/** Used for `other`, for any module without an entry, and for a missing key. */
const FALLBACK: RenewalAction = {
  cta: 'Review & Renew',
  overdueCta: 'Renew Now',
  how: 'Open the record and renew or update it.',
};

/**
 * The action for one reminder's category. Always resolves — an unmapped or
 * absent module gets the fallback rather than throwing, because this decides a
 * button's text and must never be the reason a card fails to render.
 */
export function renewalAction(
  moduleKey: string | null | undefined,
  documentKey?: string | null,
): RenewalAction {
  if (moduleKey && documentKey) {
    const override = SUB_CATEGORY_ACTIONS[`${moduleKey}/${documentKey}`];
    if (override) return override;
  }
  return (moduleKey && MODULE_ACTIONS[moduleKey]) || FALLBACK;
}

/**
 * The button text, given how many days are left.
 *
 * Only a real negative number means overdue. `daysUntil` returns
 * POSITIVE_INFINITY for a missing or unparseable date and a to-do with no due
 * date arrives as null — neither says anything about urgency, and treating
 * them as numbers is what once rendered "URGENT (nulld left)" on this page.
 */
export function renewalActionLabel(
  moduleKey: string | null | undefined,
  documentKey: string | null | undefined,
  daysLeft: number | null | undefined,
): string {
  const action = renewalAction(moduleKey, documentKey);
  const overdue = typeof daysLeft === 'number' && Number.isFinite(daysLeft) && daysLeft < 0;
  if (!overdue) return action.cta;
  return action.overdueCta ?? `${action.cta} Now`;
}
