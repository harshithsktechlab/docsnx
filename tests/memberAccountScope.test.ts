/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   A MEMBER BELONGS TO ONE ACCOUNT                                        ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Someone added to work on a company must not also be able to read the
 * household's documents, and someone added to the household must not reach a
 * company.
 *
 * There is no third gate for this, and that is the design rather than an
 * omission: `hasPermission` already denies outright when no permission row
 * matches, so a member seeded with only one account's modules is refused every
 * module of the other. The bug was never a missing check — it was that BOTH
 * accounts' modules were seeded to everyone.
 *
 * Which makes the seeding load-bearing, and worth asserting: if the two default
 * sets ever overlap in a RECORD module, nothing else in the suite would notice.
 *
 * They now overlap deliberately in four: passwords, to-dos, important contacts
 * and profiles exist in both accounts. That is a different mechanism, not a hole
 * in this one — those tables carry a `company_id`, so the permission says "you
 * may use Passwords" and the predicate says WHICH passwords. A record module has
 * no such axis, so for records the grant is still the whole of the gate, and the
 * halves below must stay strictly disjoint.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/db', () => ({ db: {}, withTenant: vi.fn() }));

const {
  SHARED_UTILITY_KEYS,
  PERSONAL_PERMISSION_KEYS,
  BUSINESS_PERMISSION_KEYS,
  PERMISSION_MODULE_KEYS,
  DEFAULT_PERSONAL_PERMISSIONS,
  DEFAULT_BUSINESS_PERMISSIONS,
  defaultPermissionsFor,
} = await import('@/lib/moduleRegistry');
const { hasPermission } = await import('@/lib/auth');

/** A member holding exactly the rows one account's defaults would seed. */
const memberWith = (rows: readonly any[]) => ({
  id: 'u1', tenantId: 't1', role: 'STANDARD', isExpired: false,
  permissions: rows.map((r) => ({ ...r, documentKey: null })),
}) as any;

describe('the two default grants divide the taxonomy', () => {
  it('shares no RECORD module between personal and business', () => {
    // The taxonomy halves are what must stay disjoint. A `biz_*` module in the
    // personal grant is a household member reading a company's filings; a
    // personal category in the business grant is the reverse. Neither has a
    // second gate behind it — the seeded rows ARE the gate.
    const overlap = PERSONAL_PERMISSION_KEYS
      .filter((k: string) => BUSINESS_PERMISSION_KEYS.includes(k))
      .filter((k: string) => !SHARED_UTILITY_KEYS.includes(k));
    expect(overlap, 'a record module in both grants is a member in both accounts').toEqual([]);
  });

  it('shares exactly the four utilities, by name', () => {
    // Enumerated rather than derived, deliberately. The overlap above is allowed
    // ONLY for modules whose tables carry a `company_id`, so widening the shared
    // set is a decision that must be made here, in front of this comment, and
    // not fall out of an edit to the registry.
    expect([...SHARED_UTILITY_KEYS].sort())
      .toEqual(['emergency_contacts', 'passwords', 'profiles', 'todos']);

    for (const key of SHARED_UTILITY_KEYS) {
      expect(PERSONAL_PERMISSION_KEYS, key).toContain(key);
      expect(BUSINESS_PERMISSION_KEYS, key).toContain(key);
    }
  });

  it('covers every grantable module between them', () => {
    // Neither list may quietly drop a module: one that is in neither is a module
    // no new member can ever be given, which reads as a broken feature rather
    // than as a permission.
    const union = [...new Set([...PERSONAL_PERMISSION_KEYS, ...BUSINESS_PERMISSION_KEYS])];
    expect(union.sort()).toEqual([...PERMISSION_MODULE_KEYS].sort());
  });

  it('gives a business member the company modules and the utilities, nothing else', () => {
    const unexpected = BUSINESS_PERMISSION_KEYS.filter(
      (k: string) => !k.startsWith('biz_') && !SHARED_UTILITY_KEYS.includes(k));
    expect(unexpected, 'a business member reaching a personal category').toEqual([]);
    expect(BUSINESS_PERMISSION_KEYS).toHaveLength(14 + SHARED_UTILITY_KEYS.length);
  });
});

describe('the seeded rows ARE the gate', () => {
  it('refuses a business member every personal module', async () => {
    const member = memberWith(DEFAULT_BUSINESS_PERMISSIONS);
    for (const key of ['identity', 'health_medical', 'bank_investments', 'insurance']) {
      expect(await hasPermission(member, key, 'view'), key).toBe(false);
      expect(await hasPermission(member, key, 'add'), key).toBe(false);
    }
  });

  it('refuses a personal member every business module', async () => {
    const member = memberWith(DEFAULT_PERSONAL_PERMISSIONS);
    for (const key of ['biz_tax', 'biz_registration', 'biz_hr']) {
      expect(await hasPermission(member, key, 'view'), key).toBe(false);
      expect(await hasPermission(member, key, 'add'), key).toBe(false);
    }
  });

  it('still gives each member their own account in full', async () => {
    const personal = memberWith(DEFAULT_PERSONAL_PERMISSIONS);
    const business = memberWith(DEFAULT_BUSINESS_PERMISSIONS);
    expect(await hasPermission(personal, 'identity', 'add')).toBe(true);
    expect(await hasPermission(business, 'biz_tax', 'add')).toBe(true);
  });

  it('leaves a TENANT_ADMIN reaching both, as before', async () => {
    // Admins short-circuit `hasPermission` and hold no rows at all, so the
    // split must not have made them narrower.
    const admin = { id: 'a1', tenantId: 't1', role: 'TENANT_ADMIN', isExpired: false, permissions: [] } as any;
    expect(await hasPermission(admin, 'identity', 'delete')).toBe(true);
    expect(await hasPermission(admin, 'biz_tax', 'delete')).toBe(true);
  });
});

describe('defaultPermissionsFor', () => {
  it('treats anything that is not "business" as personal', () => {
    // The callers pass a value derived from `tenants.account_type`, and the safe
    // direction to be wrong in is personal: forgetting to grant is a support
    // request, forgetting to revoke is a disclosure.
    for (const scope of ['personal', undefined, null, '', 'nonsense'] as any[]) {
      expect(defaultPermissionsFor(scope)).toBe(DEFAULT_PERSONAL_PERMISSIONS);
    }
    expect(defaultPermissionsFor('business')).toBe(DEFAULT_BUSINESS_PERMISSIONS);
  });
});

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   AND THE FOUR THAT THE SEEDING DOES *NOT* GATE                          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Everything above says the seeded rows ARE the gate. For record modules that
 * is true. For the four shared utilities it is not, and the gap between those
 * two sentences is where a business member read the household's passwords.
 *
 * These assertions exist so that fact is stated in the file that would
 * otherwise imply the opposite. The gate for the household half is
 * `hasPersonalAccess` — tests/personalWorkspaceAccess.test.ts.
 */
describe('the shared four are reachability, not permission', () => {
  it('gives a business member a grant on all four, by design', async () => {
    const member = memberWith(DEFAULT_BUSINESS_PERMISSIONS);
    for (const key of SHARED_UTILITY_KEYS) {
      // `profiles` aside — it is keyed by user_id and belongs to neither half —
      // these are the keys whose rows live in both accounts, told apart by
      // `company_id` and by nothing in this file.
      expect(await hasPermission(member, key, 'view'), key).toBe(true);
    }
  });

  it('does not let that grant answer WHICH account', async () => {
    /**
     * The negative that matters. `hasPermission` is asked about a module key
     * and is handed no company, so for these four it cannot distinguish a
     * request for Acme's passwords from a request for the household's — both
     * members get the identical answer here.
     *
     * Which is why the separation had to live somewhere else, and why deleting
     * `hasPersonalAccess` would not fail a single assertion in this file.
     */
    const business = memberWith(DEFAULT_BUSINESS_PERMISSIONS);
    const personal = memberWith(DEFAULT_PERSONAL_PERMISSIONS);
    for (const key of SHARED_UTILITY_KEYS) {
      expect(await hasPermission(business, key, 'view'), key)
        .toBe(await hasPermission(personal, key, 'view'));
    }
  });
});
