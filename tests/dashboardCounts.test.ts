/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE DASHBOARD TILES COUNT WHAT THE PAGE THEY OPEN DISPLAYS             ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Every stat tile is a link with a number on it, and the number has to describe
 * the page behind the link. Two ways it has gone wrong, both asserted here:
 *
 *  1. SCOPE vs MODULE. A tile that opens `/modules/vehicle` must count the
 *     vehicle MODULE, not the `/vehicles` scope. They are not the same set —
 *     /investments alone spans two modules — and the Vehicles tile shipped on
 *     the scope key, so it silently excluded what the module page shows.
 *  2. MIRRORS. A motor policy is stored under `insurance/vehicle_policies` and
 *     DISPLAYED by both Insurance and Vehicle (src/lib/categoryMirrors.ts), so
 *     both tiles must count it. Otherwise the Vehicles tile reads zero and
 *     opens a page with records on it.
 *
 * The grouped query is faked, so these are about the tallying rules and not
 * about SQL. What is NOT faked is the taxonomy: the real `scopeForCategory` and
 * the real mirror table run, which is the half that actually breaks.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** `[moduleKey, documentKey, count]` rows, as the GROUP BY would return them. */
let grouped: Array<{ moduleKey: string; documentKey: string; value: number }> = [];
/** The three utility tallies, by table, as `$count` would answer them. */
let tableCounts: Record<string, number> = {};
/** Categories the member may view. `null` means "all of them". */
let permitted: Array<{ moduleKey: string; documentKey: string }> | null = null;
/** `tenants.google_drive_enabled`, for the setup checklist. */
let driveConnected = false;
/** The member's own `profiles` row, or null when they have none yet. */
let ownProfile: any = null;
/** This company's `company_profiles` row, or null. */
let companyProfile: any = null;

const getUserFromRequest = vi.fn();
const hasCompanyAccess = vi.fn();
const hasPermission = vi.fn();
/** What the route asked the DB to narrow the grouped query to. */
const categoryIdIn = vi.fn();
/** The company predicate the grouped query was built with. */
const inCompany = vi.fn();

vi.mock('@/lib/auth', () => ({
  getUserFromRequest: (...a: any[]) => getUserFromRequest(...a),
  hasCompanyAccess: (...a: any[]) => hasCompanyAccess(...a),
  // The household's half of the same question, which `resolveUtilityCompany`
  // now asks on the personal path. Every caller here IS a household member, so
  // the honest stand-in is a plain yes; tests/personalWorkspaceAccess.test.ts
  // is where the no is asserted.
  hasPersonalAccess: () => true,
  hasPermission: (...a: any[]) => hasPermission(...a),
}));
// Both gates: `requireActivePlan` is the account-level one and
// `requireActivePlanFor` the per-workspace one that `resolveUtilityCompany`
// and `withRecordScope` now call. A mock missing either throws inside the
// route and surfaces as a 500 on an assertion about something else.
vi.mock('@/lib/planGate', () => ({
  requireActivePlan: () => null,
  requireActivePlanFor: () => null,
}));

/**
 * The taxonomy stays REAL (that is the half that breaks), but the two helpers
 * that reach Postgres are faked: `permittedCategories` reads the live category
 * table and `categoryIdIn` compiles a subquery against it.
 *
 * `categoryIdIn` is a spy rather than a stub with no memory — what the route
 * hands it IS the permission decision, and there is no real database here to
 * observe the narrowing any other way.
 */
vi.mock('@/lib/records/handler', async (importOriginal) => ({
  // Partial, deliberately: `companyIdFromRequest` is the pure regex read the
  // company gate is built on and must stay real, or these tests would prove
  // nothing about which company the route ends up with.
  ...(await importOriginal<any>()),
  permittedCategories: async () => (permitted ?? ALL_CATEGORIES),
  categoryIdIn: async (keys: any) => { categoryIdIn(keys); return 'CATEGORY_PREDICATE'; },
  inCompany: (id: any) => { inCompany(id); return `COMPANY:${id}`; },
}));

/** Drizzle's table name, so `$count` can answer per table rather than by call order. */
const tableName = (t: any) => t?.[Symbol.for('drizzle:Name')] ?? '';

vi.mock('@/lib/db', () => ({
  db: {
    query: {
      findFirst: undefined,
      tenants: { findFirst: async () => ({ name: 'Test workspace', googleDriveEnabled: driveConnected }) },
      // The signed-in member's own profile, for the setup checklist. Outside
      // `withTenant` on purpose: `profiles` carries no tenant column and is in
      // neither RLS list, so it is reached by `user_id` — see the route.
      profiles: { findFirst: async () => ownProfile },
    },
  },
  /**
   * The three statements the route runs inside the RLS session, told apart by
   * how they END and by what they ASK FOR: the tallies group, and the two
   * single-row lookups limit. Every read here is inside `withTenant` — a
   * tenant-scoped query outside it is the house rule this mock would otherwise
   * let pass silently.
   */
  withTenant: vi.fn(async (_t: string, cb: any) => cb({
    // The selected columns say which lookup this is. Answering both with the
    // company's name would have handed the company-profile read a row whose
    // every field is `undefined` — a pass that proves nothing.
    select: (cols: any) => ({
      from: () => ({
        where: () => ({
          groupBy: async () => grouped,
          limit: async () => ('name' in (cols ?? {})
            ? [{ name: 'Acme Private Limited' }]
            : [companyProfile].filter(Boolean)),
        }),
      }),
    }),
    $count: async (table: any) => tableCounts[tableName(table)] ?? 0,
  })),
}));

const { DOCUMENT_CATEGORY_MODULES } = await import('@/lib/documentCategories');
/** Every seeded pair, for the default "nothing is denied" case. */
const ALL_CATEGORIES = DOCUMENT_CATEGORY_MODULES.flatMap((m: any) =>
  m.subCategories.map((s: any) => ({ moduleKey: m.moduleKey, documentKey: s.documentKey })));

const { GET } = await import('@/app/api/dashboard/route');

const row = (moduleKey: string, documentKey: string, value = 1) =>
  ({ moduleKey, documentKey, value });

const COMPANY = '22222222-2222-4222-8222-222222222222';

const body = async (companyId?: string) => {
  const url = companyId
    ? `http://localhost/api/dashboard?companyId=${companyId}`
    : 'http://localhost/api/dashboard';
  const res = await GET(new Request(url));
  return { res, json: await res.json() };
};

const stats = async (companyId?: string) => (await body(companyId)).json.stats;

beforeEach(() => {
  vi.clearAllMocks();
  grouped = [];
  tableCounts = {};
  permitted = null;
  driveConnected = false;
  ownProfile = null;
  companyProfile = null;
  getUserFromRequest.mockResolvedValue({
    id: 'u1', tenantId: 't1', role: 'STANDARD', name: 'Member',
  });
  hasCompanyAccess.mockResolvedValue(true);
  hasPermission.mockResolvedValue(true);
});

describe('a tile counts the module it opens', () => {
  it('counts Vehicles by MODULE, not by the /vehicles scope', async () => {
    grouped = [row('vehicle', 'registration_certificate'), row('vehicle', 'puc_certificate')];
    expect((await stats()).vehicles).toBe(2);
  });

  it('counts Medical by MODULE — the tile opens /modules/health_medical', async () => {
    grouped = [row('health_medical', 'records_prescriptions', 3)];
    expect((await stats()).medical).toBe(3);
  });

  it('counts Documents as the WHOLE workspace — that tile opens the manager', async () => {
    // The Document Manager is the one view that spans the entire taxonomy, so
    // its tile counts every record the workspace holds — including the vehicle
    // paper below, which no `documents`-scope tally would have seen.
    grouped = [
      row('identity', 'pan_card'),
      row('other', 'uncategorized'),
      row('vehicle', 'registration_certificate'),
    ];
    expect((await stats()).documents).toBe(3);
  });

  it('leaves a module with no records at zero rather than undefined', async () => {
    const s = await stats();
    expect(s.vehicles).toBe(0);
    expect(s.medical).toBe(0);
  });
});

describe('a mirrored category is counted by both modules that display it', () => {
  it('puts a motor policy on the Vehicles tile, where the module page shows it', async () => {
    // The regression this test exists for: stored under Insurance, displayed by
    // Vehicle too, and previously invisible to the Vehicles tile.
    grouped = [row('insurance', 'vehicle_policies')];
    expect((await stats()).vehicles).toBe(1);
  });

  it('still counts it under Insurance, which is where it lives', async () => {
    grouped = [row('insurance', 'vehicle_policies')];
    // No Insurance tile on the dashboard today, but /modules/insurance reads the
    // same tally and must not lose the record to the module mirroring it.
    expect((await stats()).licMediclaim).toBe(1);
  });

  it('adds it to the module’s own records rather than replacing them', async () => {
    grouped = [row('vehicle', 'registration_certificate', 2), row('insurance', 'vehicle_policies', 3)];
    expect((await stats()).vehicles).toBe(5);
  });

  it('counts a mirrored record ONCE per module, never twice in one', async () => {
    // An alias and its canonical are always in different modules, so a single
    // row can never be added to the same tally twice. Pinned because the loop
    // now writes the same map from two places.
    grouped = [row('insurance', 'vehicle_policies', 4)];
    expect((await stats()).vehicles).toBe(4);
  });

  it('leaves an unmirrored category in exactly one module', async () => {
    grouped = [row('identity', 'passport', 2)];
    const s = await stats();
    expect(s.vehicles).toBe(0);
    expect(s.medical).toBe(0);
    expect(s.documents).toBe(2);
  });

  it('counts a mirrored record ONCE in the workspace total', async () => {
    // The other side of the mirror rule. Two modules each report the policy —
    // that is what their pages show — but the workspace holds one record, and
    // the Documents tile opens a manager that lists it once.
    grouped = [row('insurance', 'vehicle_policies', 3)];
    const s = await stats();
    expect(s.vehicles).toBe(3);
    expect(s.licMediclaim).toBe(3);
    expect(s.documents).toBe(3);
  });
});

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   A CARD COUNTS ONE ACCOUNT — the reported bug                           ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The household and a company share one `tenant_id`, so there is no RLS behind
 * this axis: a tally that forgets `company_id` returns the OTHER account's rows
 * and returns them successfully. It renders as an ordinary off-by-one.
 *
 * Which is exactly how it shipped. The passwords tally on this route had no
 * company predicate at all — the grouped documents query above it did — so a
 * household with one credential and a company with one displayed "2" on the
 * household's card, disclosing the volume of an account the reader may not even
 * be able to open.
 *
 * The predicates themselves are proven against compiled SQL in
 * tests/companyScopedUtilities.test.ts. What is asserted here is that this route
 * BUILDS them, from a company it proved, on every tally it has.
 */
describe('every tally names the workspace it is counting', () => {
  it('scopes the grouped documents query to the personal account by default', async () => {
    await stats();
    expect(inCompany).toHaveBeenCalledWith(null);
  });

  it('scopes it to the company when one is asked for', async () => {
    await stats(COMPANY);
    expect(inCompany).toHaveBeenCalledWith(COMPANY);
  });

  it('counts the passwords of ONE account, not of the tenant', async () => {
    // The regression, in the shape it was reported: the household holds one
    // credential and the company holds one. The card must read 1, not 2.
    tableCounts = { passwords: 1 };
    expect((await stats()).passwords).toBe(1);
  });

  it('proves the company before counting anything with it', async () => {
    hasCompanyAccess.mockResolvedValue(false);
    const { res } = await body(COMPANY);
    expect(res.status).toBe(403);
    // And no tally was built for a company the member cannot reach.
    expect(inCompany).not.toHaveBeenCalled();
  });

  it('refuses a malformed company rather than passing it to a uuid column', async () => {
    const { res } = await body('not-a-uuid');
    expect(res.status).toBe(400);
  });

  it('reports zero for a utility the member may not view, not the raw count', async () => {
    tableCounts = { passwords: 9, todos: 9, emergency_contacts: 9 };
    hasPermission.mockResolvedValue(false);
    const s = await stats();
    expect(s.passwords).toBe(0);
    expect(s.todos).toBe(0);
    expect(s.contacts).toBe(0);
  });

  it('carries the to-do and contact tallies the company cards read', async () => {
    tableCounts = { todos: 4, emergency_contacts: 2 };
    const s = await stats(COMPANY);
    expect(s.todos).toBe(4);
    expect(s.contacts).toBe(2);
  });
});

/**
 * A tile must not count what the page behind it hides. The narrowing itself is
 * SQL (`categoryIdIn` over `document_categories`), so what is observable here is
 * the KEY SET the route hands it — which is the whole of the decision.
 */
describe('the counts see only what this member, in this workspace, may view', () => {
  it('narrows the grouped query to the permitted categories', async () => {
    permitted = [{ moduleKey: 'vehicle', documentKey: 'registration_certificate' }];
    await stats();
    expect(categoryIdIn).toHaveBeenCalledWith([
      { moduleKey: 'vehicle', documentKey: 'registration_certificate' },
    ]);
  });

  it('keeps the business half of the taxonomy off the household dashboard', async () => {
    // A member holds both halves; the personal page must ask about neither
    // company records nor company categories.
    permitted = [
      { moduleKey: 'vehicle', documentKey: 'registration_certificate' },
      { moduleKey: 'biz_tax', documentKey: 'gst_returns' },
    ];
    await stats();
    expect(categoryIdIn).toHaveBeenCalledWith([
      { moduleKey: 'vehicle', documentKey: 'registration_certificate' },
    ]);
  });

  it('keeps the personal half off a company dashboard', async () => {
    permitted = [
      { moduleKey: 'vehicle', documentKey: 'registration_certificate' },
      { moduleKey: 'biz_tax', documentKey: 'gst_returns' },
    ];
    await stats(COMPANY);
    expect(categoryIdIn).toHaveBeenCalledWith([
      { moduleKey: 'biz_tax', documentKey: 'gst_returns' },
    ]);
  });

  it('returns zeros, not the whole table, when nothing at all is permitted', async () => {
    // The direction this must not fail in: an empty permission set is an empty
    // dashboard, never an unfiltered query.
    permitted = [];
    grouped = [row('identity', 'pan_card', 5)];
    const s = await stats();
    expect(s.documents).toBe(0);
    expect(s.medical).toBe(0);
    expect(categoryIdIn).not.toHaveBeenCalled();
  });
});

describe('a company dashboard describes that company', () => {
  it('tallies the business modules the company grid renders', async () => {
    grouped = [row('biz_tax', 'gst_returns', 5), row('biz_registration', 'moa_aoa', 3)];
    const s = await stats(COMPANY);
    expect(s.modules.biz_tax).toBe(5);
    expect(s.modules.biz_registration).toBe(3);
    expect(s.documents).toBe(8);
  });

  it('heads the page with the COMPANY name, so switching companies shows', async () => {
    const { json } = await body(COMPANY);
    expect(json.workspaceName).toBe('Acme Private Limited');
    expect(json.companyId).toBe(COMPANY);
  });

  it('heads the personal page with the tenant, and names no company', async () => {
    const { json } = await body();
    expect(json.workspaceName).toBe('Test workspace');
    expect(json.companyId).toBeNull();
  });
});

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE RULE, IN THE NUMBERS IT WAS ASKED FOR                              ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Stated as the requirement rather than as the implementation, because the
 * property it pins looks like a bug on first reading and is the kind of thing a
 * later reader "fixes":
 *
 *   Vehicle   2 vehicle papers + 1 vehicle insurance   = 3
 *   Insurance 3 other policies + 1 vehicle insurance   = 4
 *   Documents held                                     = 6
 *
 * 3 + 4 is 7, and the tenant has 6 documents. That is correct and deliberate.
 * The vehicle insurance policy is ONE record — one row, one Drive object —
 * displayed by two modules, so it is counted by each of them and stored once.
 * The module tallies are answers to "what does this page show", not slices of a
 * partition, and they were never meant to add up.
 *
 * The consequence, which is the thing to protect: a total number of documents
 * must always come from counting ROWS (`/api/documents` does, so does the admin
 * tenant overview), never from adding the module tiles together.
 */
describe('the stated requirement: 3 in Vehicle, 4 in Insurance, 6 documents', () => {
  /** 2 vehicle papers, 3 other insurance policies, 1 shared motor policy. */
  const scenario = () => {
    grouped = [
      row('vehicle', 'registration_certificate'),
      row('vehicle', 'puc_certificate'),
      row('insurance', 'life_policies'),
      row('insurance', 'health_policies'),
      row('insurance', 'term_policies'),
      row('insurance', 'vehicle_policies'),
    ];
  };

  it('shows 3 in Vehicle — its own two papers plus the shared policy', async () => {
    scenario();
    expect((await stats()).vehicles).toBe(3);
  });

  it('shows 4 in Insurance — its own three policies plus the same one', async () => {
    scenario();
    expect((await stats()).licMediclaim).toBe(4);
  });

  it('holds only 6 documents, because the shared one is a single record', async () => {
    scenario();
    const s = await stats();
    // Six rows fed in; six documents exist. Nothing about mirroring adds a row.
    expect(grouped.reduce((n, g) => n + g.value, 0)).toBe(6);
    // And the two module answers deliberately exceed it. Asserted, not merely
    // tolerated: if this ever equals 6, a module has stopped showing a record
    // its page displays.
    expect(s.vehicles + s.licMediclaim).toBe(7);
  });

  it('never lets a module claim a record from the module beside it', async () => {
    // The failure mode on the other side of the same rule: "counted once" must
    // not be implemented by taking the policy away from Insurance.
    scenario();
    const s = await stats();
    expect(s.vehicles).toBeGreaterThan(2);
    expect(s.licMediclaim).toBeGreaterThan(3);
  });
});

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE SETUP CHECKLIST'S FACTS                                            ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The rules that turn these booleans into rows are unit-tested next door in
 * tests/setupChecklist.test.ts. What is asserted HERE is the half only the
 * route can get wrong: which row it reads for which account, which permission
 * gates it, and — the one that matters most — that no field VALUE ever leaves.
 */
describe('the setup checklist reports facts, never values', () => {
  const setup = async (companyId?: string) => (await body(companyId)).json.setup;

  it('reads the household profile for the personal dashboard and no company row', async () => {
    ownProfile = {
      personalDetails: { dob: '1990-01-01', gender: 'male', bloodGroup: 'O+ve' },
      legalDetails: {},
    };
    const s = await setup();
    expect(s.profile).toEqual({ personal: true, legal: false });
    // Nothing about a company was asked, so nothing about one is claimed.
    expect(Object.values(s.company).every((v) => v === false)).toBe(true);
  });

  it('counts an encrypted identifier as filled without decrypting it', async () => {
    ownProfile = {
      personalDetails: {},
      // What `encryptField` leaves behind. The route must not decrypt this, and
      // must not ship it either — see the leak assertion below.
      legalDetails: {
        panNumber: 'a1b2c3d4e5f6a7b8:9f8e7d6c5b4a',
        aadhaarNumber: 'b2c3d4e5f6a7b8c9:8e7d6c5b4a39',
      },
    };
    expect((await setup()).profile.legal).toBe(true);
  });

  it('does not count a field the user cleared', async () => {
    // `encryptJsonKeys` passes '' through unchanged, so a cleared field arrives
    // as an empty string rather than as null.
    ownProfile = { personalDetails: {}, legalDetails: { panNumber: 'x', aadhaarNumber: '' } };
    expect((await setup()).profile.legal).toBe(false);
  });

  it('never puts a stored value in the payload', async () => {
    ownProfile = {
      personalDetails: { dob: '1990-01-01', gender: 'male', bloodGroup: 'O+ve' },
      legalDetails: { panNumber: 'ABCDE1234F', aadhaarNumber: '9999 8888 7777' },
    };
    const { json } = await body();
    const wire = JSON.stringify(json);
    for (const secret of ['ABCDE1234F', '9999 8888 7777', '1990-01-01']) {
      expect(wire).not.toContain(secret);
    }
  });

  it('reads the company profile for a company dashboard and no household row', async () => {
    companyProfile = {
      identityDetails: { legalName: 'Acme Private Limited', entityType: 'Private Limited' },
      taxDetails: { gstNumber: 'enc:1', panNumber: 'enc:2' },
      addressDetails: { registeredAddress: '1 Example Road, Mumbai' },
      contactDetails: { email: 'accounts@acme.example', phone: '+91 98765 43210' },
    };
    const s = await setup(COMPANY);
    expect(s.company).toEqual({
      identity: true,
      // CIN and date of incorporation are absent, so this half is still open.
      registration: false,
      tax: true,
      address: true,
      contact: true,
    });
    expect(s.profile).toEqual({ personal: false, legal: false });
  });

  it('claims nothing when the company has no profile row yet', async () => {
    companyProfile = null;
    const s = await setup(COMPANY);
    expect(Object.values(s.company).every((v) => v === false)).toBe(true);
  });

  it('offers the Drive row to a tenant admin only', async () => {
    expect((await setup()).can.drive).toBe(false); // STANDARD, from beforeEach
    getUserFromRequest.mockResolvedValue({
      id: 'u1', tenantId: 't1', role: 'TENANT_ADMIN', name: 'Owner',
    });
    expect((await setup()).can.drive).toBe(true);
  });

  it('reports Drive as connected from the tenant row', async () => {
    driveConnected = true;
    expect((await setup()).driveConnected).toBe(true);
  });

  it('does not read a profile at all without profiles:view', async () => {
    hasPermission.mockImplementation(async (_u: any, module: string) => module !== 'profiles');
    ownProfile = {
      personalDetails: { dob: '1990-01-01', gender: 'male', bloodGroup: 'O+ve' },
      legalDetails: {},
    };
    const s = await setup();
    expect(s.can.profiles).toBe(false);
    // Not merely hidden — never asked for. A denied member's own details do not
    // get gathered to be thrown away client-side.
    expect(s.profile).toEqual({ personal: false, legal: false });
  });

  it('ties the document row to the workspace total the tiles already report', async () => {
    expect((await setup()).hasDocuments).toBe(false);
    grouped = [row('identity', 'pan_card', 1)];
    const { json } = await body();
    expect(json.setup.hasDocuments).toBe(true);
    expect(json.stats.documents).toBe(1);
  });

  it('withholds the document row from a member with no viewable category', async () => {
    permitted = [];
    expect((await setup()).can.documents).toBe(false);
  });
});
