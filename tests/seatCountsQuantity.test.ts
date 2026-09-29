/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   A PURCHASED QUANTITY HAS TO REACH THE LIMIT                            ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `activeAddonSeats` is the only reader that turns an add-on into an
 * entitlement: /api/companies and the seat checks add its answer to the plan's
 * allowance. If it ignores the quantity, a customer pays for three seats, gets a
 * captured payment and a valid `tenant_addons` row — and one seat. Nothing
 * anywhere reports a problem.
 *
 * The expiry behaviour is pinned alongside it because the multiply had to be
 * added INSIDE that branch, and getting it wrong the other way (counting a
 * lapsed add-on three times over) is just as bad.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** The `tenant_addons` rows, with their joined add-on. Set per test. */
let held: any[] = [];

vi.mock('@/lib/db', () => ({
  db: {
    query: {
      tenantAddons: { findMany: async () => held },
      tenants: { findFirst: async () => null },
      subscriptionPlans: { findFirst: async () => null },
    },
  },
  withTenant: async (_t: string, cb: any) => cb({}),
}));

vi.mock('@/db/schema', () => ({
  companyAccess: 'companyAccess',
  subscriptionPlans: 'subscriptionPlans',
  tenants: 'tenants',
  users: 'users',
}));

const { activeAddonSeats } = await import('@/lib/account/seatCounts');

const TENANT = 'tenant-1';
const inFuture = new Date(Date.now() + 86_400_000);
const inPast = new Date(Date.now() - 86_400_000);

/** One purchased add-on row. */
function row(overrides: any = {}) {
  return {
    expiresAt: inFuture,
    quantity: 1,
    addon: { extraMembers: 1, extraCompanies: 0, extraMembersPerCompany: 0 },
    ...overrides,
  };
}

beforeEach(() => { held = []; });

describe('activeAddonSeats multiplies by quantity', () => {
  it('counts one unit as the add-on grants', async () => {
    held = [row()];
    await expect(activeAddonSeats(TENANT, 'extraMembers')).resolves.toBe(1);
  });

  it('counts three of a "+1 member" add-on as three seats', async () => {
    held = [row({ quantity: 3 })];
    await expect(activeAddonSeats(TENANT, 'extraMembers')).resolves.toBe(3);
  });

  it('multiplies the add-on grant, not just the row', async () => {
    // A "+5 seats" add-on bought twice is ten, not two and not five.
    held = [row({ quantity: 2, addon: { extraMembers: 5 } })];
    await expect(activeAddonSeats(TENANT, 'extraMembers')).resolves.toBe(10);
  });

  it('adds up several rows', async () => {
    held = [row({ quantity: 3 }), row({ quantity: 2 })];
    await expect(activeAddonSeats(TENANT, 'extraMembers')).resolves.toBe(5);
  });

  it('reads a pre-0061 row with no quantity as one unit', async () => {
    held = [row({ quantity: null }), row({ quantity: undefined })];
    await expect(activeAddonSeats(TENANT, 'extraMembers')).resolves.toBe(2);
  });

  it('counts a perpetual add-on, which has no expiry', async () => {
    held = [row({ expiresAt: null, quantity: 4 })];
    await expect(activeAddonSeats(TENANT, 'extraMembers')).resolves.toBe(4);
  });

  it('ignores a lapsed add-on however many were bought', async () => {
    // The multiply lives inside the live branch — a lapsed row counted three
    // times would be worse than the bug it fixes.
    held = [row({ expiresAt: inPast, quantity: 10 })];
    await expect(activeAddonSeats(TENANT, 'extraMembers')).resolves.toBe(0);
  });

  it('counts only the column asked for', async () => {
    // A tenant holding company add-ons has no extra personal seats from them.
    held = [row({
      quantity: 3,
      addon: { extraMembers: 0, extraCompanies: 1, extraMembersPerCompany: 0 },
    })];
    await expect(activeAddonSeats(TENANT, 'extraCompanies')).resolves.toBe(3);
    await expect(activeAddonSeats(TENANT, 'extraMembers')).resolves.toBe(0);
  });

  it('keeps members-per-company on its own grain', async () => {
    // 2 of a "+1 member in each company" add-on raises the per-company cap by
    // two — it is not two extra employees across the account.
    held = [row({
      quantity: 2,
      addon: { extraMembers: 0, extraCompanies: 0, extraMembersPerCompany: 1 },
    })];
    await expect(activeAddonSeats(TENANT, 'extraMembersPerCompany')).resolves.toBe(2);
  });

  it('is zero when nothing is held', async () => {
    await expect(activeAddonSeats(TENANT, 'extraMembers')).resolves.toBe(0);
  });
});
