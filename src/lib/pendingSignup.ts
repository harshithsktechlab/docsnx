/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   WHEN A SIGN-UP MAY BE TAKEN OVER — pure, and stated exactly once       ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * /api/auth/register creates the tenant, its admin, the profile and the credit
 * ledger BEFORE a single code is sent — deliberately, so a mailer hiccup cannot
 * throw a completed signup away. The cost is that a challenge nobody ever
 * answered leaves a live row holding the address (`users_email_uq`) and the
 * handset (`users_phone_dial_uq`), and the person retrying is refused on behalf
 * of an account that was never theirs to begin with.
 *
 * The way out is that an account which has never proved a single channel has no
 * proven owner: nobody has authenticated as it, nothing has been filed into it,
 * and the codes it was issued went to contacts the retry is now re-stating. So
 * a re-registration may RETIRE it and start clean.
 *
 * ── WHY THIS IS NOT `!isFullyVerified(user)` ───────────────────────────────
 * That predicate (src/lib/verificationChannels.ts) answers "does this account
 * still owe a code?", which is a strictly weaker question. A tenant admin who
 * clicked the link in their email and never received the WhatsApp copy is NOT
 * fully verified — and is also a real person demonstrably holding a real inbox.
 * Letting a stranger who knows that address wipe them out would be the exact
 * takeover this file exists to prevent. Both flags must be false.
 *
 * ── PURE ON PURPOSE ────────────────────────────────────────────────────────
 * No `db`, no imports at all. The rule is the part worth testing exhaustively,
 * and the route is the part that has to go and count rows for it; keeping them
 * apart means the rule cannot be quietly restated a second way if the members
 * path (/api/users) ever adopts it.
 */

/** The account fields the rule reads. Structural, so a full row fits. */
export interface PendingCandidate {
  id: string;
  tenantId: string | null;
  role: string;
  emailVerified: boolean;
  phoneVerified: boolean;
  deletedAt?: Date | string | null;
}

/**
 * May a fresh registration retire this row and take its address / number?
 *
 * `liveUsersInTenant` is the number of NON-deleted users sharing this row's
 * tenant, this row included — so 1 means "this account and nothing else".
 *
 * Fails closed on every uncertainty: an unknown role, a missing tenant, a count
 * the caller could not establish. Refusing costs someone a support request;
 * agreeing wrongly hands them somebody else's workspace.
 */
export function isReclaimablePending(
  user: PendingCandidate,
  liveUsersInTenant: number,
): boolean {
  // Already retired. Its indexes are free, so it is not in anyone's way and
  // there is nothing here to reclaim.
  if (user.deletedAt) return false;

  // ── ONLY A SELF-SIGNUP ROW ────────────────────────────────────────────────
  // A STANDARD member seat was created by a tenant admin INSIDE their
  // workspace: the number on it is the admin's record of who that person is,
  // and retiring it from the outside would delete a seat out of somebody's
  // account. A SUPER_ADMIN never arrives through /register at all.
  if (user.role !== 'TENANT_ADMIN') return false;

  // ── NEITHER CHANNEL EVER PROVED ───────────────────────────────────────────
  // See the header. One proved channel is one real person too many.
  if (user.emailVerified || user.phoneVerified) return false;

  // ── AND NOTHING WAS EVER BUILT BEHIND IT ──────────────────────────────────
  // An account that never had a session cannot have added a member, so this
  // should always hold for a row the two checks above admitted. It is here
  // because it is the invariant that actually matters — "no one else is in this
  // tenant" — rather than a proxy for it, and because a future path that marks
  // an account unverified again (a forced re-verification, an email change)
  // would otherwise make the two checks above dangerous without touching them.
  if (!user.tenantId) return false;
  if (liveUsersInTenant !== 1) return false;

  return true;
}
