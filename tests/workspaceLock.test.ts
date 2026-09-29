/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE BROWSER LOCKS THE HALF THAT IS UNPAID, AND ONLY THAT HALF          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Every case here has a failure mode that looks like a working app:
 *
 *   · a `business` tenant reading as "open" forever, because nothing consulted
 *     its plan — the bug this whole change exists to fix;
 *   · a paid half locked because the other one lapsed, which reads to the
 *     customer as the product having eaten their data;
 *   · the switcher hidden while one half is alive, stranding the half they pay
 *     for behind a lock screen for the half they do not.
 */
import { describe, it, expect } from 'vitest';
import { lockAxisFor, workspaceLock } from '@/lib/workspaceLock';

const ACME = '3f4e0b2a-0000-4000-8000-0000000000ac';

const axis = (exists: boolean, lapsed: boolean) => ({ exists, lapsed });

/** `both` tenant: personal alive, business dead. */
const BUSINESS_DEAD = {
  accountType: 'both',
  axes: { personal: axis(true, false), business: axis(true, true) },
  fullyLapsed: false,
};

/** `both` tenant: business alive, personal dead. */
const PERSONAL_DEAD = {
  accountType: 'both',
  axes: { personal: axis(true, true), business: axis(true, false) },
  fullyLapsed: false,
};

describe('lockAxisFor', () => {
  it('reads the axis off the company in the URL', () => {
    expect(lockAxisFor(null)).toBe('personal');
    expect(lockAxisFor(undefined)).toBe('personal');
    expect(lockAxisFor(ACME)).toBe('business');
  });
});

describe('a one-account tenant locks on its one plan', () => {
  it('locks a personal tenant when its plan lapses', () => {
    const status = {
      accountType: 'personal',
      axes: { personal: axis(true, true), business: axis(false, true) },
      fullyLapsed: true,
    };
    const lock = workspaceLock(status, null);
    expect(lock.locked).toBe(true);
    expect(lock.fullyLapsed).toBe(true);
    // Nothing to switch to — the switcher stays hidden, as it always has.
    expect(lock.otherHalfOpen).toBe(false);
  });

  /**
   * THE BUG. A `business` tenant has no personal plan, so every check that read
   * the personal axis reported "not expired" and the account never locked at
   * all, however long its business plan had been dead.
   */
  it('locks a business tenant when its plan lapses', () => {
    const status = {
      accountType: 'business',
      axes: { personal: axis(false, true), business: axis(true, true) },
      fullyLapsed: true,
    };
    expect(workspaceLock(status, ACME).locked).toBe(true);
    expect(workspaceLock(status, ACME).fullyLapsed).toBe(true);
  });

  /**
   * The mirror of it: a `business` tenant's ABSENT personal axis must not read
   * as lapsed, or the app would look expired to a customer who has paid.
   */
  it('does not lock a business tenant for lacking a personal plan', () => {
    const status = {
      accountType: 'business',
      axes: { personal: axis(false, true), business: axis(true, false) },
      fullyLapsed: false,
    };
    expect(workspaceLock(status, ACME).locked).toBe(false);
    expect(workspaceLock(status, null).locked).toBe(false);
  });
});

describe('a both-account tenant locks only the half that lapsed', () => {
  it('closes the companies and leaves the household open', () => {
    expect(workspaceLock(BUSINESS_DEAD, ACME).locked).toBe(true);
    expect(workspaceLock(BUSINESS_DEAD, null).locked).toBe(false);
  });

  it('closes the household and leaves the companies open', () => {
    expect(workspaceLock(PERSONAL_DEAD, null).locked).toBe(true);
    expect(workspaceLock(PERSONAL_DEAD, ACME).locked).toBe(false);
  });

  /**
   * The switcher is the only way out of a locked half. Hidden — which is what
   * Shell did on ANY lock — the customer is left staring at a renewal screen for
   * an account they may not even want, with the half they pay for unreachable.
   */
  it('reports the other half open, so the switcher stays on screen', () => {
    expect(workspaceLock(BUSINESS_DEAD, ACME).otherHalfOpen).toBe(true);
    expect(workspaceLock(PERSONAL_DEAD, null).otherHalfOpen).toBe(true);
  });

  it('is not fully lapsed while either half lives', () => {
    expect(workspaceLock(BUSINESS_DEAD, ACME).fullyLapsed).toBe(false);
    expect(workspaceLock(PERSONAL_DEAD, null).fullyLapsed).toBe(false);
  });

  /**
   * A single `both` plan writes ONE expiry into both column pairs, so the two
   * axes die together and the account closes as a unit — the behaviour asked
   * for, arriving without a branch anywhere.
   */
  it('closes everything when a combined plan lapses', () => {
    const status = {
      accountType: 'both',
      axes: { personal: axis(true, true), business: axis(true, true) },
      fullyLapsed: true,
    };
    expect(workspaceLock(status, null).locked).toBe(true);
    expect(workspaceLock(status, ACME).locked).toBe(true);
    expect(workspaceLock(status, ACME).fullyLapsed).toBe(true);
    expect(workspaceLock(status, ACME).otherHalfOpen).toBe(false);
  });
});

describe('payloads that are not the current shape', () => {
  /**
   * A tab open across a deploy sends the old `planStatus`. Reading a missing
   * `axes` as "open" would unlock a lapsed tenant's whole app until they
   * refreshed, so the old boolean is honoured instead.
   */
  it('falls back to the pre-axes boolean', () => {
    expect(workspaceLock({ isExpired: true }, null).locked).toBe(true);
    expect(workspaceLock({ hasPlan: false }, null).locked).toBe(true);
    expect(workspaceLock({ isExpired: false, hasPlan: true }, null).locked).toBe(false);
  });

  // `[].every(...)` is true, which would lock a tenant whose account_type could
  // not be read. It falls back to open — the server still refuses what is unpaid.
  it('does not lock on an unreadable account type', () => {
    const lock = workspaceLock({ axes: {} }, null);
    expect(lock.locked).toBe(false);
    expect(lock.fullyLapsed).toBe(false);
  });

  it('survives a null payload', () => {
    expect(workspaceLock(null, null).locked).toBe(false);
    expect(workspaceLock(undefined, ACME).locked).toBe(false);
  });
});
