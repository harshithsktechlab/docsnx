// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * AI credits are two pools — Personal for the household workspace, Business for
 * the companies — and a combined plan is the sum of the two it combines.
 *
 * What is pinned here is what must hold whatever the data is: which pool a call
 * is charged to, that the other pool is never touched without a member's
 * consent, that the combined plan is re-derived rather than typed, and that the
 * client asks before replaying a request.
 */
vi.mock('@/lib/db', () => ({ db: {}, withTenant: vi.fn() }));
vi.mock('@/lib/aiKeyManager', async () => {
  // The real `choosePool` and constants, without dragging in the key rotation,
  // encryption and provider SDKs the rest of the module imports.
  const actual = await vi.importActual<any>('@/lib/aiKeyManager');
  return actual;
});

import {
  CREDIT_POOLS, isCreditPool, otherPool, planCreditGrant, poolForWorkspace,
} from '@/lib/creditLedger';
import { creditColumns, creditPartsFor, syncComboCredits } from '@/lib/planCredits';

describe('pool vocabulary', () => {
  it('maps a workspace to its own pool', () => {
    expect(poolForWorkspace(null)).toBe('personal');
    expect(poolForWorkspace(undefined)).toBe('personal');
    expect(poolForWorkspace('company-1')).toBe('business');
  });

  it('names the other pool', () => {
    expect(otherPool('personal')).toBe('business');
    expect(otherPool('business')).toBe('personal');
  });

  it('recognises only the two pools', () => {
    expect(CREDIT_POOLS).toEqual(['personal', 'business']);
    expect(isCreditPool('business')).toBe(true);
    expect(isCreditPool('both')).toBe(false);
    expect(isCreditPool(undefined)).toBe(false);
  });
});

describe('planCreditGrant', () => {
  it('reads the two halves — a combined plan is the sum, 100 + 500 = 600', () => {
    expect(planCreditGrant({ aiCredits: 600, aiCreditsPersonal: 100, aiCreditsBusiness: 500 }))
      .toEqual({ personal: 100, business: 500, total: 600 });
  });

  it('falls back to the single figure for a plan that predates the halves', () => {
    expect(planCreditGrant({ aiCredits: 100 })).toEqual({ personal: 100, business: 0, total: 100 });
    expect(planCreditGrant({ aiCredits: 100, appliesTo: 'business' })).toEqual({ personal: 0, business: 100, total: 100 });
  });

  it('treats a missing half as zero when the other is present', () => {
    expect(planCreditGrant({ aiCredits: 500, aiCreditsBusiness: 500 })).toEqual({ personal: 0, business: 500, total: 500 });
  });
});

describe('creditPartsFor / creditColumns', () => {
  it('gives a single-axis plan its one number, and a combined plan none', () => {
    expect(creditPartsFor('personal', 100)).toEqual({ personal: 100, business: 0 });
    expect(creditPartsFor('business', 500)).toEqual({ personal: 0, business: 500 });
    expect(creditPartsFor('both', 600)).toBeNull();
  });

  it('truncates and floors at zero', () => {
    expect(creditPartsFor('personal', 10.9)).toEqual({ personal: 10, business: 0 });
    expect(creditPartsFor('personal', -5)).toEqual({ personal: 0, business: 0 });
  });

  it('always writes the total as the sum of the parts', () => {
    expect(creditColumns({ personal: 100, business: 500 }))
      .toEqual({ aiCreditsPersonal: 100, aiCreditsBusiness: 500, aiCredits: 600 });
  });
});

describe('syncComboCredits', () => {
  let selects: any[][];
  let call: number;
  const updates: any[] = [];

  /** select #1 = cheapest Personal plan, #2 = cheapest Business plan, #3 = combined plans. */
  const tx = () => ({
    select: () => {
      const rows = selects[call++] ?? [];
      const self: any = {
        from: () => self,
        where: () => self,
        orderBy: () => self,
        limit: () => Promise.resolve(rows),
        then: (res: any) => Promise.resolve(rows).then(res),
      };
      return self;
    },
    update: () => ({ set: (v: any) => { updates.push(v); return { where: () => Promise.resolve() }; } }),
  });

  beforeEach(() => { call = 0; updates.length = 0; });

  const personal = (n: number) => [{ id: 'p', aiCreditsPersonal: n, aiCreditsBusiness: 0 }];
  const business = (n: number) => [{ id: 'b', aiCreditsPersonal: 0, aiCreditsBusiness: n }];
  const combo = (p: number, b: number) => [{ id: 'c', name: 'Personal + Business', aiCreditsPersonal: p, aiCreditsBusiness: b }];

  it('makes the combined plan Personal + Business (100 + 500 = 600)', async () => {
    selects = [personal(100), business(500), combo(1000, 2000)];
    const changed = await syncComboCredits(tx() as any);
    expect(changed).toEqual([{ id: 'c', name: 'Personal + Business', personal: 100, business: 500 }]);
    expect(updates[0]).toMatchObject({ aiCreditsPersonal: 100, aiCreditsBusiness: 500, aiCredits: 600 });
  });

  it('follows a change: Personal 150 makes the combined plan 650', async () => {
    selects = [personal(150), business(500), combo(100, 500)];
    await syncComboCredits(tx() as any);
    expect(updates[0]).toMatchObject({ aiCredits: 650 });
  });

  it('writes nothing when the combined plan already agrees', async () => {
    selects = [personal(100), business(500), combo(100, 500)];
    expect(await syncComboCredits(tx() as any)).toEqual([]);
    expect(updates).toHaveLength(0);
  });

  it('keeps a half it has no source plan for, rather than dropping it to zero', async () => {
    selects = [[], business(500), combo(100, 300)];
    await syncComboCredits(tx() as any);
    expect(updates[0]).toMatchObject({ aiCreditsPersonal: 100, aiCreditsBusiness: 500, aiCredits: 600 });
  });
});

describe('choosePool — which pool pays, and the other only with consent', () => {
  const FUTURE = () => new Date(Date.now() + 5 * 60_000);
  const PAST = () => new Date(Date.now() - 60_000);
  const base = { aiCreditsBalance: 100, aiCreditsBalanceBusiness: 500 };

  let choosePool: any;
  beforeEach(async () => { ({ choosePool } = await import('@/lib/aiKeyManager')); });

  it('charges the household to Personal and a company to Business', () => {
    expect(choosePool(base, null, 'u1', 10)).toEqual({ pool: 'personal', borrowed: false });
    expect(choosePool(base, 'company-1', 'u1', 10)).toEqual({ pool: 'business', borrowed: false });
  });

  it('does not borrow silently: an empty Personal pool asks, even with Business credits to spare', () => {
    const tenant = { ...base, aiCreditsBalance: 0 };
    let thrown: any;
    try { choosePool(tenant, null, 'u1', 10); } catch (e) { thrown = e; }
    expect(thrown.errorCode).toBe('CREDIT_POOL_EMPTY');
    expect(thrown.borrowFrom).toBe('business');
    expect(thrown.required).toBe(10);
    expect(thrown.otherBalance).toBe(500);
  });

  it('borrows once this member has agreed, and says so', () => {
    const tenant = {
      ...base, aiCreditsBalance: 0,
      aiBorrowFrom: 'business', aiBorrowBy: 'u1', aiBorrowExpiresAt: FUTURE(),
    };
    expect(choosePool(tenant, null, 'u1', 10)).toEqual({ pool: 'business', borrowed: true });
  });

  it('ignores a consent that has lapsed', () => {
    const tenant = { ...base, aiCreditsBalance: 0, aiBorrowFrom: 'business', aiBorrowBy: 'u1', aiBorrowExpiresAt: PAST() };
    expect(() => choosePool(tenant, null, 'u1', 10)).toThrow();
  });

  it('ignores another member\'s consent', () => {
    const tenant = { ...base, aiCreditsBalance: 0, aiBorrowFrom: 'business', aiBorrowBy: 'someone-else', aiBorrowExpiresAt: FUTURE() };
    expect(() => choosePool(tenant, null, 'u1', 10)).toThrow();
  });

  it('ignores a consent for the other direction', () => {
    // u1 agreed to spend PERSONAL credits; this call needs the Business pool's overflow.
    const tenant = { aiCreditsBalance: 500, aiCreditsBalanceBusiness: 0, aiBorrowFrom: 'business', aiBorrowBy: 'u1', aiBorrowExpiresAt: FUTURE() };
    expect(() => choosePool(tenant, 'company-1', 'u1', 10)).toThrow();
  });

  it('never lets a call with no member borrow', () => {
    const tenant = { ...base, aiCreditsBalance: 0, aiBorrowFrom: 'business', aiBorrowBy: 'u1', aiBorrowExpiresAt: FUTURE() };
    expect(() => choosePool(tenant, null, null, 10)).toThrow();
  });

  it('is a plain INSUFFICIENT_CREDITS when neither pool can cover it', () => {
    let thrown: any;
    try { choosePool({ aiCreditsBalance: 5, aiCreditsBalanceBusiness: 5 }, null, 'u1', 10); } catch (e) { thrown = e; }
    expect(thrown.errorCode).toBe('INSUFFICIENT_CREDITS');
  });

  it('borrows the other way too — a company short of Business credits can use Personal ones, with consent', () => {
    const tenant = { aiCreditsBalance: 200, aiCreditsBalanceBusiness: 0, aiBorrowFrom: 'personal', aiBorrowBy: 'u1', aiBorrowExpiresAt: FUTURE() };
    expect(choosePool(tenant, 'company-1', 'u1', 10)).toEqual({ pool: 'personal', borrowed: true });
  });
});

describe('the client asks before replaying a request', () => {
  const offerBody = { errorCode: 'CREDIT_POOL_EMPTY', borrowFrom: 'business', required: 10, otherBalance: 500 };
  let mod: typeof import('@/lib/net/creditBorrow');

  beforeEach(async () => {
    vi.resetModules();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
    mod = await import('@/lib/net/creditBorrow');
  });

  it('recognises only the pool-empty answer with a valid pool', () => {
    expect(mod.offerFrom(offerBody)).toEqual({ from: 'business', required: 10, otherBalance: 500 });
    expect(mod.offerFrom({ errorCode: 'INSUFFICIENT_CREDITS' })).toBeNull();
    expect(mod.offerFrom({ errorCode: 'CREDIT_POOL_EMPTY', borrowFrom: 'nonsense' })).toBeNull();
    expect(mod.offerFrom(null)).toBeNull();
  });

  it('does nothing — and does not retry — when no dialog is mounted', async () => {
    const retry = vi.fn(async () => 'again');
    expect(await mod.retryAfterBorrow(offerBody, retry)).toBeNull();
    expect(retry).not.toHaveBeenCalled();
  });

  it('records the consent and replays once on a yes', async () => {
    mod.registerBorrowPrompt((_offer, answer) => answer(true));
    const retry = vi.fn(async () => 'again');
    expect(await mod.retryAfterBorrow(offerBody, retry)).toBe('again');
    expect(retry).toHaveBeenCalledTimes(1);
    const [url, init] = (fetch as any).mock.calls[0];
    expect(url).toBe('/api/billing/credits/borrow');
    expect(JSON.parse(init.body)).toEqual({ from: 'business' });
  });

  it('records nothing and does not replay on a no', async () => {
    mod.registerBorrowPrompt((_offer, answer) => answer(false));
    const retry = vi.fn(async () => 'again');
    expect(await mod.retryAfterBorrow(offerBody, retry)).toBeNull();
    expect(retry).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not replay when the consent could not be recorded', async () => {
    (fetch as any).mockResolvedValueOnce({ ok: false });
    mod.registerBorrowPrompt((_offer, answer) => answer(true));
    const retry = vi.fn(async () => 'again');
    expect(await mod.retryAfterBorrow(offerBody, retry)).toBeNull();
    expect(retry).not.toHaveBeenCalled();
  });

  it('asks one question for requests that fail together', async () => {
    const shown = vi.fn();
    let answerNow: (yes: boolean) => void = () => {};
    mod.registerBorrowPrompt((offer, answer) => { shown(offer); answerNow = answer; });
    const retryA = vi.fn(async () => 'a');
    const retryB = vi.fn(async () => 'b');
    const first = mod.retryAfterBorrow(offerBody, retryA);
    const second = mod.retryAfterBorrow(offerBody, retryB);
    answerNow(true);
    expect(await Promise.all([first, second])).toEqual(['a', 'b']);
    expect(shown).toHaveBeenCalledTimes(1);
  });
});
