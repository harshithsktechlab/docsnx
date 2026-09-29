/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   WHICH PLAN ANSWERS FOR WHICH MODULE                                    ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `hasPermission` (server) and `clientCan` (browser) both have to apply the
 * expired-plan carve-out, and both have to apply it to the SAME axis or the UI
 * offers an action the API then refuses — or, worse, hides one a paying member
 * is entitled to, with nothing to click and nothing to report.
 *
 * So the rule lives here once and both import it. It was briefly written out in
 * each, and the two had already drifted by the time the first test ran.
 *
 * ── NO `db` IMPORT ─────────────────────────────────────────────────────────
 * `clientCan` is in the browser bundle, so this module has to survive being
 * pulled into a client graph — the same rule `planGate.ts` and `creditLedger.ts`
 * follow.
 */
import { isBusinessModule } from './documentCategories';
import { SHARED_UTILITY_KEYS } from './moduleRegistry';

/** Enough of a session to answer. Duck-typed so a test can hand in a literal. */
export interface AxisViewer {
  isExpired?: boolean;
  planExpiry?: { personal?: boolean; business?: boolean } | null;
}

/**
 * ── WHICH PLAN ANSWERS FOR WHICH MODULE ────────────────────────────────────
 *
 * Three cases, and each has a wrong version that looks like a working app:
 *
 *   biz_*             the BUSINESS plan. Reading the household's here is what
 *                     let a lapsed personal plan deny the modules of a company
 *                     the customer was still paying for.
 *
 *   shared utilities  the ACCOUNT-LEVEL answer. `passwords`, `todos`,
 *                     `emergency_contacts` and `profiles` exist in both halves
 *                     under ONE module key, so this function genuinely cannot
 *                     tell which is being asked about. It denies only when the
 *                     whole account is dead, and the per-workspace gate is
 *                     `resolveUtilityCompany` — which has the company id this
 *                     function does not. Gating them on the personal axis here
 *                     would close a paid company's passwords.
 *
 *   everything else   the PERSONAL plan. These are the household's record
 *                     modules. Reading the account-level flag would leave them
 *                     open while the household's own plan was lapsed, for any
 *                     tenant whose business half was still alive.
 */
export function moduleAxisLapsed(viewer: AxisViewer | null | undefined, moduleKey: string): boolean {
  if (!viewer) return false;
  // The account-level answer, and the fallback everywhere below: a session from
  // before `planExpiry` existed, or a hand-built user object in a test.
  const account = !!viewer.isExpired;

  if (isBusinessModule(moduleKey)) return viewer.planExpiry?.business ?? account;
  if (SHARED_UTILITY_KEYS.includes(moduleKey)) return account;
  return viewer.planExpiry?.personal ?? account;
}
