/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   /api/companies/<id>/profile — the company's own identity               ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Two things are asserted here and they are easy to confuse:
 *
 *  1. THE GATE IS TWO-PART. `hasCompanyAccess` says WHICH company, and
 *     `hasPermission(…, 'profiles', …)` says WHAT may be done to it. The member
 *     routes that decide who may reach a company are TENANT_ADMIN-only and are
 *     deliberately a different shape, so a copy-paste that made this admin-only
 *     would lock out every accountant the page was built for — and nothing else
 *     in the suite would notice, because an admin passes either way.
 *
 *  2. THE TAX IDS ARE CIPHERTEXT AT REST. GST, PAN and TAN go in encrypted and
 *     come back plaintext. A route that skipped the encrypt still round-trips
 *     perfectly through its own GET, so only a test that looks at what was
 *     WRITTEN can tell the difference.
 *
 * And the standing rule underneath both: the tenant comes from the session. The
 * predicate is asserted rather than assumed because `company_profiles` carries
 * its own `tenant_id` precisely so RLS can police it, and a query that omitted
 * it would rely on RLS alone — which AGENTS.md §6 says is half the answer.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getUserFromRequest = vi.fn();
const hasCompanyAccess = vi.fn();
const hasPermission = vi.fn();
const writeAudit = vi.fn();

/** What the next SELECT returns, and everything that was written. */
const state: {
  company: any[];
  profile: any[];
  inserted: any[];
  conflictSet: any[];
  wheres: string[][];
} = { company: [], profile: [], inserted: [], conflictSet: [], wheres: [] };
const openedWith: string[] = [];

/**
 * Column names a drizzle `where` touches, e.g. ['company_id', 'tenant_id'].
 *
 * The same walker `tests/todos.test.ts` uses. A drizzle predicate is a cyclic
 * object graph (a column points at its table, which points back), so it cannot
 * simply be stringified.
 */
function columnsOf(node: any, depth = 0, out: string[] = []): string[] {
  if (!node || typeof node !== 'object' || depth > 10) return out;
  if (typeof node.name === 'string' && node.table) out.push(node.name);
  for (const chunk of node.queryChunks ?? []) columnsOf(chunk, depth + 1, out);
  if (Array.isArray(node)) for (const c of node) columnsOf(c, depth + 1, out);
  return out;
}

vi.mock('@/lib/auth', () => ({
  getUserFromRequest: (...a: any[]) => getUserFromRequest(...a),
  hasCompanyAccess: (...a: any[]) => hasCompanyAccess(...a),
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
vi.mock('@/lib/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/audit')>()),
  writeAudit: (...a: any[]) => writeAudit(...a),
}));

vi.mock('@/lib/db', () => {
  // Two SELECTs run per request — the company (for its name) and the profile.
  // Answered by which TABLE was asked, not by call order: the two live in
  // separate `withTenant` blocks, so a counter would reset between them.
  let table = '';
  const chain: any = {
    select: () => chain,
    from: (t: any) => {
      // Drizzle keeps the table name on a symbol-keyed property. Found by
      // DESCRIPTION rather than by `Symbol.for`, so this keeps working whether
      // the symbol is registered globally or not.
      const key = t && Object.getOwnPropertySymbols(t)
        .find((sy) => sy.description === 'drizzle:Name');
      table = (key && t[key]) || '';
      return chain;
    },
    where: (w: any) => {
      state.wheres.push(columnsOf(w));
      return chain;
    },
    limit: async () => (table === 'companies' ? state.company : state.profile),
    insert: () => ({
      values: (v: any) => {
        state.inserted.push(v);
        const ret = { returning: async () => [{ id: 'profile-1', ...v }] };
        return {
          ...ret,
          onConflictDoUpdate: ({ set }: any) => {
            state.conflictSet.push(set);
            return { returning: async () => [{ id: 'profile-1', ...v, ...set }] };
          },
        };
      },
    }),
  };
  return {
    db: {},
    withTenant: vi.fn(async (tenantId: string, cb: any) => {
      openedWith.push(tenantId);
      return await cb(chain);
    }),
  };
});

const { GET, PUT } = await import('@/app/api/companies/[id]/profile/route');
const { decryptField, isCiphertext } = await import('@/lib/fieldCrypto');

const COMPANY = '3f4e0b2a-0000-4000-8000-000000000001';
const ADMIN = { id: 'u1', tenantId: 'tenant-a', role: 'TENANT_ADMIN', isExpired: false };
const MEMBER = { ...ADMIN, id: 'u2', role: 'STANDARD' };
const params = (id = COMPANY) => Promise.resolve({ id });

const get = (id = COMPANY) =>
  GET(new Request(`http://localhost/api/companies/${id}/profile`), { params: params(id) });

const put = (body: unknown, id = COMPANY) => PUT(
  new Request(`http://localhost/api/companies/${id}/profile`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }),
  { params: params(id) },
);

beforeEach(() => {
  vi.clearAllMocks();
  state.company = [{ id: COMPANY, name: 'Acme Traders' }];
  state.profile = [];
  state.inserted = [];
  state.conflictSet = [];
  state.wheres = [];
  openedWith.length = 0;
  getUserFromRequest.mockResolvedValue(ADMIN);
  hasCompanyAccess.mockResolvedValue(true);
  hasPermission.mockResolvedValue(true);
});

describe('the gate is company access AND the profiles permission', () => {
  it('401s an anonymous caller', async () => {
    getUserFromRequest.mockResolvedValue(null);
    expect((await get()).status).toBe(401);
  });

  it('403s a member who cannot reach the company', async () => {
    getUserFromRequest.mockResolvedValue(MEMBER);
    hasCompanyAccess.mockResolvedValue(false);
    const res = await get();
    expect(res.status).toBe(403);
    // Never a 404: telling a member that a company does not exist, separately
    // from telling them it is not theirs, is an enumeration oracle.
    expect(await res.json()).toEqual({ error: 'Forbidden' });
  });

  it('403s a member who can reach the company but lacks profiles.view', async () => {
    getUserFromRequest.mockResolvedValue(MEMBER);
    hasPermission.mockResolvedValue(false);
    expect((await get()).status).toBe(403);
    expect(hasPermission).toHaveBeenCalledWith(MEMBER, 'profiles', 'view');
  });

  it('asks for the EDIT verb on a write, not the view one', async () => {
    getUserFromRequest.mockResolvedValue(MEMBER);
    await put({ contactDetails: { email: 'a@b.example' } });
    expect(hasPermission).toHaveBeenCalledWith(MEMBER, 'profiles', 'edit');
  });

  it('403s a read-only member on PUT while letting them GET', async () => {
    getUserFromRequest.mockResolvedValue(MEMBER);
    hasPermission.mockImplementation(async (_u: any, _m: string, action: string) => action === 'view');
    expect((await get()).status).toBe(200);
    expect((await put({ taxDetails: { gstNumber: 'X' } })).status).toBe(403);
  });

  it('403s a malformed id before it can reach a uuid column', async () => {
    // `companies.id` is a uuid column: a non-uuid is a Postgres type error
    // mid-request, i.e. a 500 on what is really a bad value in a URL.
    const res = await get('not-a-uuid');
    expect(res.status).toBe(403);
    expect(hasCompanyAccess).not.toHaveBeenCalled();
  });

  it('403s when the company row is gone even though access said yes', async () => {
    state.company = [];
    expect((await get()).status).toBe(403);
  });
});

describe('tenant scoping', () => {
  it('opens every transaction with the SESSION tenant', async () => {
    await get();
    expect(openedWith.length).toBeGreaterThan(0);
    expect(openedWith.every((t) => t === 'tenant-a')).toBe(true);
  });

  it('carries a tenant predicate on the profile query, not RLS alone', async () => {
    await get();
    // The profile SELECT is the second one — the first reads the company for
    // its name. Both must name the tenant: RLS is the other half of the answer,
    // never the whole of it (AGENTS.md §6).
    expect(state.wheres[1]).toContain('tenant_id');
    expect(state.wheres[1]).toContain('company_id');
    expect(state.wheres[0]).toContain('tenant_id');
  });

  it('writes the session tenant, never one from the body', async () => {
    await put({ tenantId: 'tenant-b', contactDetails: { email: 'a@b.example' } } as any);
    // `.strict()` on the schema means an unknown key is a 400 rather than a
    // silently ignored one — which is the stronger answer.
    expect(state.inserted.every((v) => v.tenantId === 'tenant-a')).toBe(true);
  });
});

describe('the profile row', () => {
  it('is created empty on first read so the form has something to PUT against', async () => {
    state.profile = [];
    const res = await get();
    expect(res.status).toBe(200);
    expect(state.inserted).toHaveLength(1);
    expect(state.inserted[0]).toMatchObject({ companyId: COMPANY, tenantId: 'tenant-a' });
  });

  it('is not recreated when one already exists', async () => {
    state.profile = [{ id: 'profile-1', companyId: COMPANY, taxDetails: {} }];
    await get();
    expect(state.inserted).toHaveLength(0);
  });

  it('leaves a section the client did not send alone', async () => {
    // The page saves one tab at a time. An update that blanked the other three
    // would make two admins editing different tabs overwrite each other.
    await put({ contactDetails: { email: 'a@b.example' } });
    const set = state.conflictSet[0];
    expect(set).toHaveProperty('contactDetails');
    expect(set).not.toHaveProperty('taxDetails');
    expect(set).not.toHaveProperty('identityDetails');
    expect(set).not.toHaveProperty('addressDetails');
  });

  it('400s an unknown field rather than persisting it into the jsonb', async () => {
    const res = await put({ identityDetails: { legalName: 'Acme', sneaky: 'x' } });
    expect(res.status).toBe(400);
  });
});

describe('the tax identifiers are ciphertext at rest', () => {
  it('encrypts GST, PAN and TAN on the way in', async () => {
    await put({ taxDetails: { gstNumber: '27ABCDE1234F1Z5', panNumber: 'ABCDE1234F', tanNumber: 'MUMA12345B' } });
    const stored = state.conflictSet[0].taxDetails;
    for (const [key, plain] of Object.entries({
      gstNumber: '27ABCDE1234F1Z5', panNumber: 'ABCDE1234F', tanNumber: 'MUMA12345B',
    })) {
      expect(stored[key], key).not.toBe(plain);
      expect(isCiphertext(stored[key]), key).toBe(true);
      expect(decryptField(stored[key]), key).toBe(plain);
    }
  });

  it('leaves the plaintext identity section alone', async () => {
    // CIN is a public register entry. Encrypting it would buy nothing and make
    // the field unsearchable — see COMPANY_TAX_KEYS.
    await put({ identityDetails: { legalName: 'Acme Traders Private Limited', registrationNumber: 'U74999MH2015PTC123456' } });
    expect(state.conflictSet[0].identityDetails).toEqual({
      legalName: 'Acme Traders Private Limited',
      registrationNumber: 'U74999MH2015PTC123456',
    });
  });

  it('decrypts them again on the way out', async () => {
    const { encryptField } = await import('@/lib/fieldCrypto');
    state.profile = [{
      id: 'profile-1',
      companyId: COMPANY,
      taxDetails: { gstNumber: encryptField('27ABCDE1234F1Z5'), panNumber: null },
    }];
    const body = await (await get()).json();
    expect(body.profile.taxDetails.gstNumber).toBe('27ABCDE1234F1Z5');
  });

  it('does not double-encrypt a value that was never edited', async () => {
    const { encryptField } = await import('@/lib/fieldCrypto');
    const already = encryptField('27ABCDE1234F1Z5')!;
    await put({ taxDetails: { gstNumber: already } });
    expect(state.conflictSet[0].taxDetails.gstNumber).toBe(already);
  });

  it('keeps a cleared field cleared instead of turning it into a ciphertext', async () => {
    await put({ taxDetails: { gstNumber: '' } });
    expect(state.conflictSet[0].taxDetails.gstNumber).toBe('');
  });
});

describe('the audit line', () => {
  it('names the company and never a field value', async () => {
    await put({ taxDetails: { gstNumber: '27ABCDE1234F1Z5' } });
    expect(writeAudit).toHaveBeenCalledTimes(1);
    const entry = writeAudit.mock.calls[0][0];
    expect(entry.tenantId).toBe('tenant-a');
    expect(entry.entityType).toBe('company_profiles');
    expect(entry.details).toContain('Acme Traders');
    // Audit rows are not encrypted and are never purged.
    expect(entry.details).not.toContain('27ABCDE1234F1Z5');
  });

  it('writes nothing on a read', async () => {
    await get();
    expect(writeAudit).not.toHaveBeenCalled();
  });
});
