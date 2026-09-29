/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   POST /api/onboarding/workspace — naming the account                   ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * "Workspace Name" was the first field on the sign-up form: asked of a stranger
 * before they had seen the product, and unchangeable afterwards without a
 * platform operator. It is the onboarding wizard's first question now, and this
 * is where the answer lands.
 *
 * Three things are worth pinning: only the admin may rename, the row is
 * addressed by the id on the SESSION rather than anything in the body, and a
 * name too short to be useful is refused with a message keyed to the input.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let sessionUser: any;
const updates: any[] = [];
const audits: any[] = [];
let tenantScope: string | undefined;

vi.mock('@/lib/db', () => ({
  db: {},
  withTenant: async (tenantId: string, cb: any) => {
    // The RLS scope the route opened. A write made outside one — or inside one
    // opened for somebody else's tenant — is the whole class of bug this
    // wrapper exists to prevent.
    tenantScope = tenantId;
    return cb({
      update: () => ({
        set: (values: any) => ({
          where: async (predicate: any) => {
            updates.push({ values, predicate });
          },
        }),
      }),
    });
  },
}));

vi.mock('@/lib/auth', () => ({
  getUserFromRequest: vi.fn(async () => sessionUser),
}));

vi.mock('@/lib/audit', async () => ({
  writeAudit: vi.fn(async (entry: any) => { audits.push(entry); }),
  ...(await vi.importActual<any>('@/lib/auditActions')),
}));

const { POST } = await import('@/app/api/onboarding/workspace/route');

const TENANT = '11111111-1111-1111-1111-111111111111';

function post(body: unknown) {
  return new Request('https://docsnx.test/api/onboarding/workspace', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  updates.length = 0;
  audits.length = 0;
  tenantScope = undefined;
  sessionUser = {
    id: 'user-1',
    tenantId: TENANT,
    role: 'TENANT_ADMIN',
  };
});

describe('who may name the workspace', () => {
  it('refuses a caller with no session', async () => {
    sessionUser = null;
    const res = await POST(post({ name: 'Menon Household' }));
    expect(res.status).toBe(401);
    expect(updates).toHaveLength(0);
  });

  it('refuses a member', async () => {
    // A member can exist before setup is finished — the wizard's Members step
    // creates them — and is held on /onboarding too. Renaming the account they
    // were added to is not theirs to do.
    sessionUser.role = 'STANDARD';
    const res = await POST(post({ name: 'Menon Household' }));
    expect(res.status).toBe(401);
    expect(updates).toHaveLength(0);
  });
});

describe('the name itself', () => {
  it('saves a good one, scoped to the session’s tenant', async () => {
    const res = await POST(post({ name: '  Menon Household  ' }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ success: true, name: 'Menon Household' });

    expect(updates).toHaveLength(1);
    // Trimmed, and stamped — `updatedAt` is mandatory on every model.
    expect(updates[0].values.name).toBe('Menon Household');
    expect(updates[0].values.updatedAt).toBeInstanceOf(Date);
    expect(tenantScope).toBe(TENANT);
  });

  it('refuses a name of one character, keyed to the input', async () => {
    const res = await POST(post({ name: 'X' }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.fieldErrors.name).toBe('Workspace name is too short');
    expect(updates).toHaveLength(0);
  });

  it('refuses whitespace, which trims to nothing', async () => {
    const res = await POST(post({ name: '   ' }));
    expect(res.status).toBe(400);
    expect(updates).toHaveLength(0);
  });

  it('refuses a name past the column’s 255 characters', async () => {
    const res = await POST(post({ name: 'A'.repeat(256) }));
    expect(res.status).toBe(400);
    expect(updates).toHaveLength(0);
  });

  it('writes an audit row naming what it was called', async () => {
    await POST(post({ name: 'Menon Household' }));
    expect(audits).toHaveLength(1);
    expect(audits[0].tenantId).toBe(TENANT);
    expect(audits[0].action).toBe('tenant.update');
    expect(audits[0].details).toContain('Menon Household');
  });
});

describe('the tenant it writes to', () => {
  it('ignores a tenantId in the body and uses the session’s', async () => {
    // The rule the whole product runs on: a tenant id from the request is not
    // evidence of anything.
    const res = await POST(post({
      name: 'Menon Household',
      tenantId: '99999999-9999-9999-9999-999999999999',
    }));
    expect(res.status).toBe(200);
    // The RLS scope, and the values written, both come from the session only.
    expect(tenantScope).toBe(TENANT);
    expect(Object.keys(updates[0].values).sort()).toEqual(['name', 'updatedAt']);
    expect(audits[0].tenantId).toBe(TENANT);
  });
});
