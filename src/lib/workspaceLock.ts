/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   WHICH HALF OF THE APP IS CLOSED, AND WHETHER THE OTHER ONE IS OPEN     ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The browser's copy of `tenantFullyLapsed` / `workspaceLapsed`, reading the
 * `planStatus.axes` block that /api/auth/me now sends.
 *
 * ── WHY IT IS NOT IN Shell.js ──────────────────────────────────────────────
 * Shell is JSX in a `.js` file and vitest cannot import it at all (see the
 * `vitest-cannot-parse-jsx-in-js` note). Everything Shell has to DECIDE about
 * the lock lives here so it can be proven, and Shell only renders it — the same
 * split `workspaceNav.ts` and `accountMenu.ts` already use.
 *
 * ── NOTHING HERE IS A SECURITY DECISION ────────────────────────────────────
 * It decides what to SHOW. Every tenant-data route answers 402 on its own
 * (`requireActivePlanFor`), so a user who forges their way past this sees a page
 * frame with nothing in it. That is the same relationship `clientCan` has with
 * `hasPermission`.
 */

export type LockAxis = 'personal' | 'business';

export interface AxisLockState {
  /** Does this tenant HAVE this half? From `tenants.account_type`. */
  exists?: boolean;
  /** Expired, or never bought — the same screen either way. */
  lapsed?: boolean;
  expiresAt?: string | null;
}

export interface PlanStatusPayload {
  accountType?: string | null;
  axes?: Partial<Record<LockAxis, AxisLockState>>;
  fullyLapsed?: boolean;
  /** Pre-axes shape, still sent. Used only as the fallback below. */
  isExpired?: boolean;
  hasPlan?: boolean;
}

export interface WorkspaceLock {
  /** The workspace in the URL is closed and must not render. */
  locked: boolean;
  /** EVERY half is closed — the whole app, as it behaved before axes existed. */
  fullyLapsed: boolean;
  /** Which half the URL is in. */
  axis: LockAxis;
  /**
   * There is a live half to move to.
   *
   * What keeps the workspace switcher on screen while one side is locked. It
   * used to hide on any lock, which — the moment two halves could lapse on
   * different dates — would strand the half the customer had paid for.
   */
  otherHalfOpen: boolean;
}

/** A company in the URL means the business half. One rule, same as the server's. */
export function lockAxisFor(activeCompanyId: string | null | undefined): LockAxis {
  return activeCompanyId ? 'business' : 'personal';
}

export function workspaceLock(
  planStatus: PlanStatusPayload | null | undefined,
  activeCompanyId: string | null | undefined,
): WorkspaceLock {
  const axis = lockAxisFor(activeCompanyId);
  const axes = planStatus?.axes;

  /**
   * Before the axes block existed the answer was one boolean for the whole app.
   * A client that has not reloaded since a deploy — or any caller passing an
   * older payload — falls back to it rather than reading `undefined` as "open",
   * which would unlock a lapsed tenant's whole app until they refreshed.
   */
  if (!axes) {
    const legacy = !!planStatus?.isExpired || planStatus?.hasPlan === false;
    return { locked: legacy, fullyLapsed: legacy, axis, otherHalfOpen: false };
  }

  const live = (a: LockAxis) => axes[a]?.exists === true && axes[a]?.lapsed !== true;
  const existing = (['personal', 'business'] as LockAxis[]).filter((a) => axes[a]?.exists);

  /**
   * An axis the tenant does not HAVE is not locked, it is absent. Answering
   * `true` would close a company workspace on a tenant whose `account_type` has
   * not been switched to 'both' yet — the app would look expired to someone who
   * has paid, which is the worst of the failure modes here.
   */
  const locked = axes[axis]?.exists === true && axes[axis]?.lapsed === true;

  return {
    locked,
    // `every` over an EMPTY list is true, which would lock a tenant whose
    // account_type is unreadable. Guarded, and it falls back to open — the
    // server still refuses anything that is genuinely unpaid.
    fullyLapsed: planStatus?.fullyLapsed
      ?? (existing.length > 0 && existing.every((a) => axes[a]?.lapsed === true)),
    axis,
    otherHalfOpen: live(axis === 'personal' ? 'business' : 'personal'),
  };
}

/** "Personal" / "Business", for a message that has to name the half that lapsed. */
export function lockAxisLabel(axis: LockAxis): string {
  return axis === 'business' ? 'Business' : 'Personal';
}
