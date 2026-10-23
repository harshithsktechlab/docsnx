/**
 * Which of a person's several seats an email / mobile lands on (0082).
 *
 * The same identifier now matches one `users` row per tenant, all with the same
 * password. Login, verify-otp and resend-otp must each pick the SAME seat for
 * the same data, and the seat has to be the one the person can actually use.
 */
import { describe, it, expect } from 'vitest';
import { pickSeat, isSignableSeat, type PickableSeat } from '@/lib/account/membershipPick';

let n = 0;
function seat(over: Partial<PickableSeat> = {}): PickableSeat {
  n += 1;
  return {
    id: `seat-${n}`,
    role: 'STANDARD',
    email: 'p@example.test',
    phoneNumber: '+919876543210',
    emailVerified: false,
    phoneVerified: true,
    activatedAt: new Date('2026-01-01'),
    signInDisabledAt: null,
    createdAt: new Date(`2026-01-${String(n).padStart(2, '0')}`),
    tenant: { isActive: true, deletedAt: null },
    ...over,
  };
}

describe('isSignableSeat', () => {
  it('is true for an active, activated member', () => {
    expect(isSignableSeat(seat())).toBe(true);
  });
  it.each([
    ['a suspended tenant', { tenant: { isActive: false } }],
    ['a deleted tenant', { tenant: { isActive: true, deletedAt: new Date() } }],
    ['a switched-off sign-in', { signInDisabledAt: new Date() }],
    ['an invited member who has not set a password', { activatedAt: null }],
  ])('is false for %s', (_name, over) => {
    expect(isSignableSeat(seat(over as any))).toBe(false);
  });
  it('does not make an OWNER wait for activation', () => {
    expect(isSignableSeat(seat({ role: 'TENANT_ADMIN', activatedAt: null }))).toBe(true);
  });
});

describe('pickSeat', () => {
  it('returns null when the person has no seats', () => {
    expect(pickSeat([])).toBeNull();
  });

  it('login prefers a seat that needs no further code over an owner awaiting email', () => {
    // The member seat works today. The new owner seat still owes an email code,
    // and must not lock the person out of the seat that works.
    const member = seat({ role: 'STANDARD', phoneVerified: true });
    const owner = seat({ role: 'TENANT_ADMIN', phoneVerified: true, emailVerified: false });
    expect(pickSeat([owner, member], 'login')).toBe(member);
  });

  it('verify prefers the seat that still owes a code', () => {
    const member = seat({ role: 'STANDARD', phoneVerified: true });
    const owner = seat({ role: 'TENANT_ADMIN', phoneVerified: true, emailVerified: false });
    expect(pickSeat([member, owner], 'verify')).toBe(owner);
  });

  it('never prefers a seat the person cannot sign in to', () => {
    const disabled = seat({ signInDisabledAt: new Date(), role: 'TENANT_ADMIN' });
    const working = seat();
    expect(pickSeat([disabled, working], 'login')).toBe(working);
  });

  it('still returns an unusable seat when it is the only one, so login can say why', () => {
    const only = seat({ activatedAt: null });
    expect(pickSeat([only], 'login')).toBe(only);
  });

  it('puts owners before members, then older before newer, for the default intent', () => {
    const older = seat({ createdAt: new Date('2026-01-01') });
    const newer = seat({ createdAt: new Date('2026-03-01') });
    const owner = seat({ role: 'TENANT_ADMIN', createdAt: new Date('2026-06-01') });
    expect(pickSeat([newer, older, owner])).toBe(owner);
    expect(pickSeat([newer, older])).toBe(older);
  });

  it('is deterministic whatever order the database returns the rows in', () => {
    const a = seat({ createdAt: new Date('2026-01-01') });
    const b = seat({ createdAt: new Date('2026-02-01') });
    const c = seat({ createdAt: new Date('2026-03-01') });
    expect(pickSeat([c, a, b], 'login')).toBe(pickSeat([b, c, a], 'login'));
  });
});
