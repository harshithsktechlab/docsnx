/**
 * Per-sub-category counts for a module page.
 *
 * Two things need pinning. A sub-category the member cannot view must be ABSENT
 * from the response rather than present with zero — a zero is a statement about
 * their records ("you have none"), and they are not entitled to that statement.
 *
 * And the due/overdue tallies have to come out of the records' `reminders`, in
 * the tenant's encrypted stores on Drive. They used to be read from an open-tier
 * projection in Postgres (`documents.metadata`), which let this endpoint answer
 * a sixteen-tile page without opening sixteen stores; that column is gone, so
 * the tallies now go through `remindersForCategory` — one store read per
 * PERMITTED sub-category, cached — and gain the `resolved` flag the projection
 * never carried.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let rows: any[] = [];
/** `${moduleKey}/${documentKey}` → the store's records, by record id. */
let stores: Record<string, Record<string, any>> = {};
/** Categories whose store read should blow up, as `moduleKey/documentKey`. */
let unreadable = new Set<string>();

const hasPermission = vi.fn();

vi.mock('@/lib/db', () => ({
  db: {},
  withTenant: vi.fn(async (_t: string, cb: any) => cb({
    select: () => ({ from: () => ({ where: async () => rows }) }),
  })),
}));
vi.mock('@/lib/auth', () => ({
  getUserFromRequest: vi.fn(async () => ({ id: 'u1', tenantId: 't1', role: 'STANDARD' })),
  hasPermission: (...a: any[]) => hasPermission(...a),
  // The household gate the counts route now asks on the personal path. This
  // caller IS a household member; the refusal lives in
  // tests/personalWorkspaceAccess.test.ts.
  hasPersonalAccess: () => true,
}));
// The real `remindersForCategory` walk runs; only the Drive round trip is
// stubbed. Mocking the walk itself would test the mock, not the rule that a
// record contributes its earliest UNRESOLVED deadline and nothing else.
vi.mock('@/lib/vault/vaultRecords', () => ({
  readJsonStore: vi.fn(async (_ctx: any, moduleKey: string, key: any) => {
    const label = `${moduleKey}/${key.documentKey}`;
    if (unreadable.has(label)) throw new Error(`store ${label} unreadable`);
    return { store: { records: stores[label] ?? {} }, pointer: { revision: 1 } };
  }),
}));

const { GET } = await import('@/app/api/modules/[moduleKey]/counts/route');

const params = (moduleKey: string) => ({ params: Promise.resolve({ moduleKey }) });
const call = async (moduleKey: string) => {
  const res = await GET(new Request(`http://localhost/api/modules/${moduleKey}/counts`), params(moduleKey));
  return { status: res.status, body: await res.json() };
};

const iso = (days: number) => {
  const due = new Date();
  due.setDate(due.getDate() + days);
  return due.toISOString();
};

let nextId = 0;

/**
 * A pointer row plus its Drive record, with a deadline `days` away.
 *
 * `reminders` is what `toTaxonomyRecord` derives at write time — only fields
 * that are genuinely deadlines get one, which is why "not a deadline" is now
 * expressed by giving the record no reminder rather than by an unrecognised key.
 */
function record(
  moduleKey: string,
  documentKey: string,
  opts: { days?: number; file?: boolean; reminders?: any[] } = {},
) {
  const id = `doc-${++nextId}`;
  const reminders = opts.reminders ?? (opts.days === undefined ? [] : [{
    key: 'valid_to', label: 'Validity', date: iso(opts.days), resolved: false,
  }]);

  const label = `${moduleKey}/${documentKey}`;
  stores[label] = stores[label] ?? {};
  stores[label][id] = { id, name: `record ${id}`, open: {}, masked: {}, reminders };

  return {
    id,
    title: `record ${id}`,
    // Both halves: since mirroring, a tile's records can be stored under a
    // DIFFERENT module from the one being asked about, so the route attributes
    // rows by the whole pair rather than by documentKey alone.
    moduleKey,
    documentKey,
    filePath: opts.file === false ? null : '/api/records/x/y/file',
    createdAt: new Date(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  rows = [];
  stores = {};
  unreadable = new Set();
  nextId = 0;
  hasPermission.mockResolvedValue(true);
});

describe('the module segment', () => {
  it('404s a module that is not in the taxonomy', async () => {
    const { status } = await call('not_a_module');
    expect(status).toBe(404);
  });
});

describe('permissions', () => {
  it('omits a denied sub-category entirely, rather than reporting zero', async () => {
    hasPermission.mockImplementation(
      async (_u: any, _m: string, _a: string, documentKey?: string) => documentKey !== 'passport',
    );
    const { body } = await call('identity');
    expect(Object.keys(body.counts)).toContain('pan_card');
    expect(Object.keys(body.counts)).not.toContain('passport');
  });

  it('returns nothing at all when the whole module is denied', async () => {
    hasPermission.mockResolvedValue(false);
    const { body } = await call('identity');
    expect(body.counts).toEqual({});
  });
});

describe('counting', () => {
  it('gives every permitted sub-category a row, so a tile can say "nothing yet"', async () => {
    const { body } = await call('identity');
    expect(body.counts.pan_card).toMatchObject({ total: 0, overdue: 0, dueSoon: 0, nextDueAt: null });
  });

  it('separates records with a document from those without', async () => {
    rows = [
      record('identity', 'pan_card'),
      record('identity', 'pan_card', { file: false }),
      record('identity', 'pan_card', { file: false }),
    ];
    const { body } = await call('identity');
    expect(body.counts.pan_card).toMatchObject({ total: 3, withFile: 1, dataOnly: 2 });
  });

  it('reads deadlines out of the records\' reminders', async () => {
    rows = [
      record('identity', 'passport', { days: -5 }),   // overdue
      record('identity', 'passport', { days: 10 }),   // due soon
      record('identity', 'passport', { days: 200 }),  // later
    ];
    const { body } = await call('identity');
    expect(body.counts.passport).toMatchObject({ total: 3, overdue: 1, dueSoon: 1 });
    // The soonest date still ahead of us, not the overdue one.
    expect(new Date(body.counts.passport.nextDueAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('takes the EARLIEST deadline when a record carries several', async () => {
    // A vehicle RC tracks insurance, PUC and fitness independently; the nearest
    // is the one the tile should react to — and it counts as ONE record due,
    // not three.
    rows = [record('vehicle', 'registration_certificate', {
      reminders: [
        { key: 'valid_to', label: 'Validity', date: iso(300), resolved: false },
        { key: 'puc_expiry', label: 'PUC', date: iso(3), resolved: false },
      ],
    })];
    const { body } = await call('vehicle');
    expect(body.counts.registration_certificate).toMatchObject({ dueSoon: 1, overdue: 0 });
  });

  it('ignores a reminder the record marks resolved', async () => {
    // The projection could not express this: a paid bill still counted as due.
    // Reading the store is what buys the distinction.
    rows = [record('utility_bills', 'electricity', {
      reminders: [{ key: 'due_date', label: 'Bill Due', date: iso(-30), resolved: true }],
    })];
    const { body } = await call('utility_bills');
    expect(body.counts.electricity).toMatchObject({ total: 1, overdue: 0, dueSoon: 0 });
  });

  it('counts a record that carries no reminders at all', async () => {
    rows = [record('identity', 'pan_card')];
    const { body } = await call('identity');
    expect(body.counts.pan_card).toMatchObject({ total: 1, overdue: 0, dueSoon: 0, nextDueAt: null });
  });

  /**
   * ── MIRRORS: THE SAME RECORD, SHOWN IN TWO MODULES ───────────────────────
   *
   * A motor policy is stored once, under `insurance/vehicle_policies`, and the
   * Vehicle module lists it too through `vehicle/insurance_cross_ref` — an
   * ADDRESS, not a second bucket (src/lib/categoryMirrors.ts). So the Vehicle
   * tile has to count rows that are not in the Vehicle module at all, read
   * their deadlines out of the Insurance store, and say that it is doing so —
   * because the module page has to leave those records OUT of its total or one
   * record gets counted twice across the app.
   */
  describe('a mirrored sub-category', () => {
    it('counts the records of the category it mirrors, not its own module', async () => {
      rows = [
        record('insurance', 'vehicle_policies'),
        record('insurance', 'vehicle_policies', { file: false }),
        record('vehicle', 'registration_certificate'),
      ];
      const { body } = await call('vehicle');
      // Stored in Insurance, shown here. The module predicate this route used
      // to carry would have excluded exactly these rows.
      expect(body.counts.insurance_cross_ref).toMatchObject({
        total: 2, withFile: 1, dataOnly: 1,
      });
      // The module's own sub-category is unaffected.
      expect(body.counts.registration_certificate).toMatchObject({ total: 1 });
    });

    it('flags itself so the module page can leave it out of the total', async () => {
      rows = [record('insurance', 'vehicle_policies')];
      const { body } = await call('vehicle');
      expect(body.counts.insurance_cross_ref.mirrored).toBe(true);
      expect(body.counts.insurance_cross_ref.mirrorOf).toEqual({
        moduleKey: 'insurance', documentKey: 'vehicle_policies',
      });
    });

    it('leaves every ordinary sub-category unmirrored', async () => {
      const { body } = await call('identity');
      for (const count of Object.values(body.counts) as any[]) {
        expect(count.mirrored).toBe(false);
        expect(count.mirrorOf).toBeNull();
      }
    });

    it('reads deadlines from the CANONICAL store, where the policies are', async () => {
      // The alias has no store on Drive and never did. Reading `vehicle/
      // insurance_cross_ref` would find an empty one and report nothing due.
      rows = [
        record('insurance', 'vehicle_policies', { days: -3 }),
        record('insurance', 'vehicle_policies', { days: 12 }),
      ];
      const { body } = await call('vehicle');
      expect(body.counts.insurance_cross_ref).toMatchObject({
        total: 2, overdue: 1, dueSoon: 1,
      });
    });

    it('is governed by the permission of the module that HOLDS the records', async () => {
      // Full Vehicle rights are not a way into Insurance. The tile disappears
      // with the Insurance permission, not with the Vehicle one.
      hasPermission.mockImplementation(
        async (_u: any, moduleKey: string) => moduleKey !== 'insurance',
      );
      const { body } = await call('vehicle');
      expect(Object.keys(body.counts)).toContain('registration_certificate');
      expect(Object.keys(body.counts)).not.toContain('insurance_cross_ref');
    });

    it('appears when Insurance is granted, even with the alias key denied', async () => {
      // The alias's own permission row exists in the table and is deliberately
      // not consulted: honouring it would make the tile deniable from a module
      // that does not own the data.
      hasPermission.mockImplementation(
        async (_u: any, _m: string, _a: string, documentKey?: string) =>
          documentKey !== 'insurance_cross_ref',
      );
      rows = [record('insurance', 'vehicle_policies')];
      const { body } = await call('vehicle');
      expect(body.counts.insurance_cross_ref).toMatchObject({ total: 1, mirrored: true });
    });

    /**
     * ── THE OTHER SIDE OF THE MIRROR ────────────────────────────────────────
     *
     * Every case above looks at Vehicle, the module that BORROWS the record.
     * Insurance is where it lives, and there it must behave like any other
     * sub-category — the canonical is a place, not an address, and treating it
     * as one would take the policies off their own module's page.
     */
    it('is an ordinary tile on the module that OWNS it', async () => {
      rows = [record('insurance', 'vehicle_policies')];
      const { body } = await call('insurance');
      expect(body.counts.vehicle_policies).toMatchObject({
        total: 1, mirrored: false, mirrorOf: null,
      });
    });

    it('counts toward Insurance alongside that module’s other policies', async () => {
      // The requirement in its own numbers: three other policies plus the shared
      // one make four on this page, while Vehicle separately shows three. Six
      // documents exist; see tests/dashboardCounts.test.ts for why those do not
      // add up, and why that is the intended behaviour rather than a defect.
      rows = [
        record('insurance', 'life_policies'),
        record('insurance', 'health_policies'),
        record('insurance', 'term_policies'),
        record('insurance', 'vehicle_policies'),
      ];
      const { body } = await call('insurance');
      const total = Object.values(body.counts).reduce((n: number, c: any) => n + c.total, 0);
      expect(total).toBe(4);
      expect(body.counts.vehicle_policies.total).toBe(1);
    });

    it('shows the same record on both modules, badged on the borrowing side only', async () => {
      rows = [record('insurance', 'vehicle_policies')];

      const insurance = (await call('insurance')).body;
      const vehicle = (await call('vehicle')).body;

      // One record, both pages. Only Vehicle says where it came from — Insurance
      // has nothing to disclaim, the record is simply its own.
      expect(insurance.counts.vehicle_policies.total).toBe(1);
      expect(vehicle.counts.insurance_cross_ref.total).toBe(1);
      expect(insurance.counts.vehicle_policies.mirrorOf).toBeNull();
      expect(vehicle.counts.insurance_cross_ref.mirrorOf).toEqual({
        moduleKey: 'insurance', documentKey: 'vehicle_policies',
      });
    });
  });

  it('still reports totals when a store cannot be read', async () => {
    // Drive down or the grant revoked. The tile loses its due counts, not its
    // existence — the same degradation the follow-up page accepts.
    rows = [record('identity', 'pan_card', { days: -5 })];
    unreadable.add('identity/pan_card');
    const { body } = await call('identity');
    expect(body.counts.pan_card).toMatchObject({ total: 1, overdue: 0, nextDueAt: null });
  });
});
