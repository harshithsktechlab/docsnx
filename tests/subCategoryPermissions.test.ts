/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   SUB-CATEGORY PERMISSIONS (migration 0024)                              ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Permissions carry two grains: a MODULE DEFAULT (`document_key IS NULL`) and
 * per-sub-category OVERRIDES. `hasPermission` resolves most-specific-first.
 *
 * These assertions exist because this class of bug is invisible in manual
 * testing: TENANT_ADMIN short-circuits `hasPermission` to true, so an admin
 * clicking through the app sees a correctly-behaving product no matter what the
 * resolution order actually does. The same blind spot has already shipped three
 * missing permission keys (see moduleRegistry.js).
 *
 * The backfill assertions replay 0024's rule in TypeScript against the SQL the
 * migration actually contains, so a hand-edit to either is caught here rather
 * than by a member discovering they can read a sibling's bank locker
 * inventory.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { hasPermission, permittedDocumentKeys } from '@/lib/auth';
import { clientCan } from '@/lib/clientAuth';
import { DEFAULT_PERSONAL_PERMISSIONS } from '@/lib/moduleRegistry';

const BACKFILL = readFileSync(
  join(__dirname, '..', 'drizzle', '0024_permissions_sub_category.sql'), 'utf8');

const FLAGS = {
  canView: true, canAdd: true, canEdit: false, canDelete: false, canShare: false,
};
const DENIED = {
  canView: false, canAdd: false, canEdit: false, canDelete: false, canShare: false,
};

const member = (permissions: any[]) => ({
  id: 'u1', email: 'a@b.c', name: 'Member', role: 'STANDARD',
  tenantId: 't1', isExpired: false, permissions,
}) as any;

const moduleDefault = (module: string, flags = FLAGS) =>
  ({ module, documentKey: null, ...flags });
const override = (module: string, documentKey: string, flags: any) =>
  ({ module, documentKey, ...flags });

describe('resolution order', () => {
  it('reads the module default when no documentKey is asked for', async () => {
    const user = member([moduleDefault('bank_investments')]);
    expect(await hasPermission(user, 'bank_investments', 'view')).toBe(true);
    expect(await hasPermission(user, 'bank_investments', 'delete')).toBe(false);
  });

  it('keeps every pre-0024 three-argument call site meaning what it meant', async () => {
    // The whole reason `documentKey` is optional and last. A route that has not
    // been touched still asks the module-wide question and still gets the
    // module-wide answer.
    const user = member([
      moduleDefault('passwords'),
      override('passwords', 'ignored_key', DENIED),
    ]);
    expect(await hasPermission(user, 'passwords', 'view')).toBe(true);
  });

  it('lets an override DENY one sub-category of an allowed module', async () => {
    // The requirement this migration exists for: deny "Bank locker agreement"
    // without denying all of Bank & Investments.
    const user = member([
      moduleDefault('bank_investments'),
      override('bank_investments', 'bank_locker_agreement', DENIED),
    ]);
    expect(await hasPermission(user, 'bank_investments', 'view', 'bank_statements_passbooks')).toBe(true);
    expect(await hasPermission(user, 'bank_investments', 'view', 'bank_locker_agreement')).toBe(false);
    // …and the module-wide question is unaffected: the page still opens.
    expect(await hasPermission(user, 'bank_investments', 'view')).toBe(true);
  });

  it('lets an override ALLOW one sub-category of a denied module', async () => {
    // The other direction, and the reason step 1 is a full override rather than
    // an intersection with the default.
    const user = member([
      moduleDefault('biz_finance', DENIED),
      override('biz_finance', 'invoices', FLAGS),
    ]);
    expect(await hasPermission(user, 'biz_finance', 'view', 'invoices')).toBe(true);
    expect(await hasPermission(user, 'biz_finance', 'view', 'audited_financial_statements'))
      .toBe(false);
  });

  it('falls through to the default for a sub-category with no override', async () => {
    const user = member([moduleDefault('identity')]);
    expect(await hasPermission(user, 'identity', 'add', 'passport')).toBe(true);
    expect(await hasPermission(user, 'identity', 'edit', 'passport')).toBe(false);
  });

  it('denies when there is neither an override nor a default', async () => {
    // Deny-by-default is unchanged: a module absent from the rows is a module
    // this member cannot reach, whichever sub-category is asked about.
    const user = member([moduleDefault('identity')]);
    expect(await hasPermission(user, 'insurance', 'view')).toBe(false);
    expect(await hasPermission(user, 'insurance', 'view', 'life_policies')).toBe(false);
  });

  it('never lets one module\'s override answer for another', async () => {
    // `pan_card` exists under BOTH `identity` and `biz_registration`. Matching on
    // documentKey alone would make a grant on the member's own PAN card open the
    // company's.
    const user = member([
      moduleDefault('identity', DENIED),
      override('identity', 'pan_card', FLAGS),
      moduleDefault('biz_registration', DENIED),
    ]);
    expect(await hasPermission(user, 'identity', 'view', 'pan_card')).toBe(true);
    expect(await hasPermission(user, 'biz_registration', 'view', 'pan_card')).toBe(false);
  });

  it('still denies an expired subscription and an absent user, at both grains', async () => {
    const expired = { ...member([moduleDefault('identity')]), isExpired: true };
    expect(await hasPermission(expired, 'identity', 'view')).toBe(false);
    expect(await hasPermission(expired, 'identity', 'view', 'passport')).toBe(false);
    expect(await hasPermission(null as any, 'identity', 'view', 'passport')).toBe(false);
  });

  it('short-circuits TENANT_ADMIN at both grains', async () => {
    const admin = { ...member([]), role: 'TENANT_ADMIN' };
    expect(await hasPermission(admin, 'biz_finance', 'delete', 'invoices')).toBe(true);
  });

  it('never grants SUPER_ADMIN a tenant sub-category', async () => {
    // The platform role administers tenants; it does not read inside them. Its
    // allowlist is three platform modules and no taxonomy module is on it.
    const platform = { ...member([moduleDefault('identity')]), role: 'SUPER_ADMIN' };
    expect(await hasPermission(platform, 'identity', 'view', 'passport')).toBe(false);
    expect(await hasPermission(platform, 'tenants', 'view')).toBe(true);
  });
});

describe('permittedDocumentKeys', () => {
  it('returns the allowed subset, so a denied category narrows rather than 403s', async () => {
    const user = member([
      moduleDefault('identity'),
      override('identity', 'passport', DENIED),
    ]);
    expect(await permittedDocumentKeys(user, 'identity', ['pan_card', 'passport', 'voter_id']))
      .toEqual(['pan_card', 'voter_id']);
  });

  it('returns [] rather than everything when nothing is permitted', async () => {
    // The one failure mode that must not be "no filter": an empty list has to
    // mean an empty result set, not an unfiltered query.
    const user = member([moduleDefault('identity', DENIED)]);
    expect(await permittedDocumentKeys(user, 'identity', ['pan_card', 'passport'])).toEqual([]);
  });
});

describe('the new-member default', () => {
  it('seeds module defaults only, never a sub-category row', async () => {
    // Seeding all 83 would make a category added later INVISIBLE to every
    // existing member rather than inherited — the opposite of what a default is
    // for.
    for (const row of DEFAULT_PERSONAL_PERMISSIONS) {
      expect(row.documentKey, `${row.module} seeds a sub-category row`).toBeNull();
    }
    const modules = DEFAULT_PERSONAL_PERMISSIONS.map((r) => r.module);
    expect(new Set(modules).size, 'a module is seeded twice').toBe(modules.length);
  });
});

describe('the 0024 backfill', () => {
  it('takes the INTERSECTION of contributing modules, never the union', async () => {
    // Five modules merged into `bank_investments`. A union would hand a member
    // who held `bank_info` but not `trading` the demat documents too — a silent
    // privilege escalation across a migration nobody would think to audit.
    expect(BACKFILL).toContain('bool_and(can_view)');
    expect(BACKFILL).not.toMatch(/bool_or\s*\(/);
  });

  it('writes an override only where the owning module was more permissive', () => {
    expect(BACKFILL).toContain('IS DISTINCT FROM');
    expect(BACKFILL).toContain('JOIN baseline b');
  });

  it('covers all 83 live categories, and says so at runtime', () => {
    // The map is the inverse of 0023's re-key. A category missing from it would
    // silently inherit the intersection instead of its own module's flags.
    const owners = [...BACKFILL.matchAll(/^ {4}\('([a-z0-9_]+)','([a-z0-9_]+)','([a-z0-9_]+)'\)[,;]?$/gm)];
    expect(owners).toHaveLength(83);
    expect(new Set(owners.map((m) => `${m[1]}/${m[2]}`)).size,
      'a category is owned twice').toBe(83);
    expect(BACKFILL).toContain('perm_owner must cover all 83 live categories');
  });

  it('is idempotent — a second run must not wipe what the first wrote', () => {
    // It DELETEs before INSERTing, so an unguarded re-run would compute nothing
    // and delete everything.
    expect(BACKFILL).toContain('backfill already applied');
    expect(BACKFILL).toContain('IF NOT EXISTS (SELECT 1 FROM permissions WHERE module = ANY(dissolved))');
  });

  it('leaves no dissolved module key behind, and no orphan override', () => {
    expect(BACKFILL).toContain('still name a dissolved module');
    expect(BACKFILL).toContain('overrides have no module default row');
  });

  it('makes uniqueness NULL-safe, or one user could hold two defaults', () => {
    expect(BACKFILL).toContain(`coalesce("document_key", '')`);
  });
});

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   clientCan MUST AGREE WITH hasPermission                                ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `clientCan` decides whether to RENDER a control; `hasPermission` decides
 * whether the request succeeds. They are two hand-written copies of the same
 * precedence rule, and the failure mode of a mismatch is silent and asymmetric:
 *
 *  · too permissive — the UI offers an action that then 403s, which is the bug
 *    the document manager shipped with (Edit and Delete on every row);
 *  · too strict — a member is quietly locked out of something they were granted,
 *    with nothing to click and nothing to report.
 *
 * Neither shows up in manual testing, because TENANT_ADMIN short-circuits both.
 * So the two are asserted against each other directly, over every action.
 */
describe('clientCan and hasPermission agree', () => {
  const ACTIONS = ['view', 'add', 'edit', 'delete', 'share'] as const;

  const CASES: Array<{ name: string; permissions: any[]; module: string; key: string | null }> = [
    {
      name: 'module default only',
      permissions: [moduleDefault('identity')],
      module: 'identity', key: 'passport',
    },
    {
      name: 'sub-category override wins over a permissive default',
      permissions: [
        moduleDefault('identity', { canView: true, canAdd: true, canEdit: true, canDelete: true, canShare: true }),
        override('identity', 'passport', DENIED),
      ],
      module: 'identity', key: 'passport',
    },
    {
      name: 'sub-category override wins over a restrictive default',
      permissions: [
        moduleDefault('identity', DENIED),
        override('identity', 'passport', { canView: true, canAdd: false, canEdit: false, canDelete: false, canShare: true }),
      ],
      module: 'identity', key: 'passport',
    },
    {
      name: 'an override for a DIFFERENT key does not answer this one',
      permissions: [moduleDefault('identity'), override('identity', 'pan_card', DENIED)],
      module: 'identity', key: 'passport',
    },
    {
      name: 'no row at all denies by default',
      permissions: [moduleDefault('medical')],
      module: 'identity', key: 'passport',
    },
    {
      name: 'asked without a documentKey',
      permissions: [moduleDefault('identity'), override('identity', 'passport', DENIED)],
      module: 'identity', key: null,
    },
  ];

  for (const c of CASES) {
    for (const action of ACTIONS) {
      it(`${c.name} — ${action}`, async () => {
        const user = member(c.permissions);
        const server = await hasPermission(user, c.module, action, c.key ?? undefined);
        const client = clientCan(user, c.module, c.key, action);
        expect(client, `clientCan disagreed with hasPermission on ${action}`).toBe(server);
      });
    }
  }

  it('agrees that an expired member may do nothing', async () => {
    const user = { ...member([moduleDefault('identity')]), isExpired: true };
    for (const action of ACTIONS) {
      expect(await hasPermission(user, 'identity', action, 'passport')).toBe(false);
      expect(clientCan(user, 'identity', 'passport', action)).toBe(false);
    }
  });

  it('agrees that TENANT_ADMIN may do everything', async () => {
    const admin = { ...member([]), role: 'TENANT_ADMIN' };
    for (const action of ACTIONS) {
      expect(await hasPermission(admin, 'identity', action, 'passport')).toBe(true);
      expect(clientCan(admin, 'identity', 'passport', action)).toBe(true);
    }
  });

  it('agrees that SUPER_ADMIN reaches no taxonomy module', async () => {
    // A platform role administers tenants; it does not read inside them.
    const platform = { ...member([]), role: 'SUPER_ADMIN' };
    for (const action of ACTIONS) {
      expect(await hasPermission(platform, 'identity', action, 'passport')).toBe(false);
      expect(clientCan(platform, 'identity', 'passport', action)).toBe(false);
    }
  });
});
