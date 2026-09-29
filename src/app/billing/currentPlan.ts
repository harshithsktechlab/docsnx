/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   resolveCurrentPlan — what the Billing page's "Current Plan" card says  ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * This lives outside page.js because of the bug it exists to prevent.
 *
 * /api/auth/me returns `planDetails` as a SIBLING of `user`:
 *
 *   { success, user: {...}, planStatus: {...}, planDetails: {...}, ... }
 *
 * The card used to read `currentUser.planDetails?.name`, where `currentUser`
 * was only the `user` half of that payload. The path does not exist, so the
 * optional chain quietly produced `undefined` and every tenant — active plan or
 * not — was labelled "No Active Plan", while the plan grid on the same page
 * correctly marked their plan "Current". Nothing threw; the fallback string
 * simply looked plausible.
 *
 * So the whole payload is passed in here, and the reads happen in one place
 * that a test can hold to the real response shape.
 */

/** The subset of the /api/auth/me payload this card reads. */
export interface SessionPayload {
  user?: {
    tenant?: { subscriptionPlanId?: string | null; subscriptionExpiry?: string | Date | null } | null;
    subscriptionExpiry?: string | Date | null;
  } | null;
  planDetails?: { name?: string | null } | null;
}

export interface CurrentPlan {
  id: string | null;
  name: string;
  expiry: string | Date | null;
}

export const NO_ACTIVE_PLAN = 'No Active Plan';

export function resolveCurrentPlan(
  session: SessionPayload | null | undefined,
  availablePlans: Array<{ id: string; name: string }> = [],
): CurrentPlan | null {
  const user = session?.user;
  if (!user) return null;

  const id = user.tenant?.subscriptionPlanId || null;

  return {
    id,
    // `planDetails` first — the server already resolved it, including its
    // fallback to the `isDefault` plan for a tenant with none assigned.
    // `availablePlans` is the same list the grid below matches against, so the
    // card and the grid's "Current" badge cannot disagree.
    name: session?.planDetails?.name
      || (id ? availablePlans.find(p => p.id === id)?.name : undefined)
      || NO_ACTIVE_PLAN,
    expiry: user.tenant?.subscriptionExpiry || user.subscriptionExpiry || null,
  };
}
