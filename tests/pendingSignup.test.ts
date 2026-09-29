/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   WHO MAY BE RETIRED — the rule, tested without a database              ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `isReclaimablePending` decides whether a fresh registration may take over a
 * live row's email address and mobile number. It is the whole security surface
 * of the retry path, so it is tested exhaustively here and only sketched in
 * registerPendingReclaim.test.ts, which is about the route's plumbing.
 *
 * Too loose and a stranger who knows an address deletes somebody's workspace.
 * Too tight and the person whose verification codes never arrived is locked out
 * of their own contact details, which is the bug this all exists to fix.
 */
import { describe, it, expect } from 'vitest';
import { isReclaimablePending, type PendingCandidate } from '@/lib/pendingSignup';

/** A self-signup that was created and never verified on either channel. */
function pending(overrides: Partial<PendingCandidate> = {}): PendingCandidate {
  return {
    id: 'user-1',
    tenantId: 'tenant-1',
    role: 'TENANT_ADMIN',
    emailVerified: false,
    phoneVerified: false,
    deletedAt: null,
    ...overrides,
  };
}

describe('isReclaimablePending', () => {
  it('admits a self-signup that proved nothing and is alone in its tenant', () => {
    expect(isReclaimablePending(pending(), 1)).toBe(true);
  });

  // ── THE VERIFIED FLAGS ────────────────────────────────────────────────────
  // The distinction that matters most: NOT `!isFullyVerified(user)`. A tenant
  // admin owes a code on both channels, so one cleared channel still leaves the
  // account unverified — and also proves a real person holds a real inbox.

  it('refuses a row that proved its email, even though it is not fully verified', () => {
    expect(isReclaimablePending(pending({ emailVerified: true }), 1)).toBe(false);
  });

  it('refuses a row that proved its handset', () => {
    expect(isReclaimablePending(pending({ phoneVerified: true }), 1)).toBe(false);
  });

  it('refuses a fully verified account', () => {
    expect(
      isReclaimablePending(pending({ emailVerified: true, phoneVerified: true }), 1),
    ).toBe(false);
  });

  // ── THE ROLE ──────────────────────────────────────────────────────────────

  it('refuses a member seat, which lives inside somebody else’s workspace', () => {
    // The likeliest real collision: a tenant admin added this person by mobile
    // number, and that number is now the one being registered with. Retiring it
    // would delete a seat out of an account that has nothing to do with the
    // caller.
    expect(isReclaimablePending(pending({ role: 'STANDARD' }), 1)).toBe(false);
  });

  it('refuses a super admin', () => {
    expect(isReclaimablePending(pending({ role: 'SUPER_ADMIN' }), 1)).toBe(false);
  });

  it('refuses an unrecognised role rather than guessing', () => {
    expect(isReclaimablePending(pending({ role: 'AUDITOR' }), 1)).toBe(false);
  });

  // ── AND NOTHING BUILT BEHIND IT ───────────────────────────────────────────

  it('refuses a tenant that holds a second live user', () => {
    expect(isReclaimablePending(pending(), 2)).toBe(false);
  });

  it('refuses a count of zero, which means the caller could not establish one', () => {
    // Fails closed. A zero here cannot be true — the row itself is live and in
    // that tenant — so it is a broken lookup, not an empty workspace.
    expect(isReclaimablePending(pending(), 0)).toBe(false);
  });

  it('refuses a row with no tenant at all', () => {
    expect(isReclaimablePending(pending({ tenantId: null }), 1)).toBe(false);
  });

  // ── ALREADY GONE ──────────────────────────────────────────────────────────

  it('refuses an already soft-deleted row', () => {
    // Its partial indexes are already free, so it is in nobody's way and there
    // is nothing here to retire. Reaching this would mean the caller's lookup
    // forgot its `deleted_at` predicate.
    expect(isReclaimablePending(pending({ deletedAt: new Date() }), 1)).toBe(false);
  });

  it('treats a missing deletedAt key as live', () => {
    const { deletedAt, ...withoutKey } = pending();
    expect(isReclaimablePending(withoutKey as PendingCandidate, 1)).toBe(true);
  });
});
