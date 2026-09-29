/**
 * The order the super admin's plan list is read in.
 *
 * Live plans first, retired ones after. The screen is read top-down and an
 * inactive plan is history — a draft price list, a plan typed twice, last
 * year's trial — so it must never sit between two plans that are still being
 * sold. `/api/admin/plans` orders by price and `Array.prototype.sort` is
 * stable, so that ordering survives inside each half.
 *
 * Lives here rather than inline in the page because the page is a `.js` file
 * carrying JSX, which the test runner cannot import.
 */

export interface ListablePlan {
  name?: string | null;
  isActive?: boolean | null;
}

/** Case-insensitive match on the plan name; a blank query matches everything. */
export function matchesPlanQuery(plan: ListablePlan, query: string): boolean {
  const q = (query || '').toLowerCase().trim();
  if (!q) return true;
  return (plan.name || '').toLowerCase().includes(q);
}

/**
 * Filters by the search box, then puts every active plan ahead of every
 * inactive one. Returns a new array — the caller's state is never mutated.
 */
export function orderPlansForAdmin<T extends ListablePlan>(plans: T[], query = ''): T[] {
  return (plans || [])
    .filter(p => matchesPlanQuery(p, query))
    .sort((a, b) => Number(Boolean(b.isActive)) - Number(Boolean(a.isActive)));
}
