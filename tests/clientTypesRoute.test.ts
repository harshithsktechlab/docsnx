import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

let gate: any;
let mayView = true;
const audits: any[] = [];
let saveResult: any;
const saves: any[] = [];

vi.mock('@/lib/clients/clientGate', () => ({
  gateClientWorkspace: vi.fn(async () => gate),
  canOnClientType: vi.fn(async () => mayView),
  FORBIDDEN: () => NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
}));
vi.mock('@/lib/db', () => ({ withTenant: async (_t: string, fn: any) => fn({}) }));
vi.mock('@/lib/audit', async () => ({
  ...(await vi.importActual<any>('@/lib/auditActions')),
  writeAudit: vi.fn(async (e: any) => { audits.push(e); }),
}));
vi.mock('@/lib/clients/clientTypes', () => ({
  loadClientTypes: vi.fn(async () => ({ chosen: true, individual: true, company: false })),
  saveClientTypes: vi.fn(async (...a: any[]) => { saves.push(a); return saveResult; }),
}));

const { GET, PUT } = await import('@/app/api/clients/types/route');

const ADMIN = { id: 'u1', tenantId: 't1', role: 'TENANT_ADMIN' };
const MEMBER = { id: 'u2', tenantId: 't1', role: 'STANDARD' };
const put = (body: unknown) => new Request('http://x/api/clients/types?companyId=co-1', {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

beforeEach(() => {
  gate = { user: ADMIN, companyId: 'co-1', companyName: 'Redpluto Analytics' };
  mayView = true;
  audits.length = 0;
  saves.length = 0;
  saveResult = { ok: true, before: { chosen: false, individual: false, company: false }, types: { chosen: true, individual: true, company: true } };
});

describe('GET /api/clients/types', () => {
  it('returns the choice, and tells an admin they may change it', async () => {
    const body = await (await GET(new Request('http://x/api/clients/types?companyId=co-1'))).json();
    expect(body).toMatchObject({ success: true, chosen: true, individual: true, company: false, canChange: true });
  });

  it('tells an ordinary member they may not', async () => {
    gate = { ...gate, user: MEMBER };
    expect((await (await GET(new Request('http://x/api/clients/types'))).json()).canChange).toBe(false);
  });

  it('is refused to someone who can view neither kind of client', async () => {
    mayView = false;
    expect((await GET(new Request('http://x/api/clients/types'))).status).toBe(403);
  });

  it('passes a gate refusal straight through', async () => {
    gate = { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
    expect((await GET(new Request('http://x/api/clients/types'))).status).toBe(403);
  });
});

describe('PUT /api/clients/types', () => {
  it('lets a workspace admin choose, for the PROVEN company, and audits the choice without any data', async () => {
    const res = await PUT(put({ individual: true, company: true }));
    expect(res.status).toBe(200);
    expect(saves[0]).toEqual(['t1', 'co-1', { individual: true, company: true }]);
    expect(audits[0]).toMatchObject({ entityType: 'client_type_settings', companyId: 'co-1' });
    expect(audits[0].details).toContain('Redpluto Analytics');
    expect(audits[0].details).toContain('individual and company clients');
  });

  it('refuses anyone who is not a workspace admin — and saves nothing', async () => {
    gate = { ...gate, user: MEMBER };
    const res = await PUT(put({ individual: true, company: false }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain('workspace admin');
    expect(saves).toHaveLength(0);
  });

  it('rejects an empty choice, an unknown key and a non-boolean with 400', async () => {
    for (const body of [
      { individual: false, company: false },
      { individual: true, company: false, tenantId: 'other' },
      { individual: 'yes', company: false },
      {},
      null,
    ]) {
      expect((await PUT(put(body))).status, JSON.stringify(body)).toBe(400);
    }
    expect(saves).toHaveLength(0);
  });

  it('answers 409 with the count and the sentence when a kind still has clients', async () => {
    saveResult = { ok: false, blocked: { individual: 2 }, error: 'You still have 2 individual clients. Remove those clients first, then turn this off.' };
    const res = await PUT(put({ individual: false, company: true }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain('2 individual clients');
    expect(body.code).toBe('CLIENTS_EXIST');
    expect(body.blocked).toEqual({ individual: 2 });
    expect(audits).toHaveLength(0);
  });
});
