import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';
import { prepareClientRow } from '@/lib/clients/clientData';

const USER = { id: 'u1', tenantId: 't1', role: 'TENANT_ADMIN' };
let gate: any;
let conflict: string | null;
const inserted: any[] = [];
/** What the list query returns, newest first, as the database would hand it over. */
let listRows: any[] = [];
const audits: any[] = [];

vi.mock('@/lib/clients/clientGate', () => ({
  clientTypeFromRequest: (req: Request) => {
    const t = new URL(req.url).searchParams.get('type');
    return t === 'individual' || t === 'company' ? t : null;
  },
  gateClients: vi.fn(async () => gate),
}));
vi.mock('@/lib/clients/clientConflicts', () => ({ findClientConflict: vi.fn(async () => conflict) }));
vi.mock('@/lib/audit', async () => ({
  ...(await vi.importActual<any>('@/lib/auditActions')),
  writeAudit: vi.fn(async (e: any) => { audits.push(e); }),
}));
vi.mock('@/lib/db', () => {
  const tx: any = {
    insert: () => ({
      values: (v: any) => {
        inserted.push(v);
        return { returning: async () => [{ ...v, id: 'new-client', isActive: true, createdAt: new Date('2026-01-01') }] };
      },
    }),
    select: () => ({ from: () => ({ where: () => ({ orderBy: async () => listRows }) }) }),
  };
  return { db: tx, withTenant: async (_t: string, fn: any) => fn(tx) };
});

const settings = {
  selectable: new Set(['identity-pan_card', 'insurance-health_policies']),
  replaced: [] as any[],
};
vi.mock('@/lib/clients/clientSettings', () => ({
  selectableDocumentKeys: vi.fn(async () => settings.selectable),
  replaceEnabledDocumentKeys: vi.fn(async (...a: any[]) => { settings.replaced.push(a); return { added: ['identity-pan_card'], removed: [], unchanged: 0 }; }),
  listConfigurable: vi.fn(async () => [{ moduleKey: 'identity', moduleName: 'Identity', items: [{ documentKey: 'identity-pan_card', documentName: 'PAN Card', enabled: true }] }]),
}));

const clients = await import('@/app/api/clients/route');
const subs = await import('@/app/api/clients/subcategories/route');

const post = (url: string, body: unknown, method = 'POST') =>
  new Request(`http://x${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(() => {
  listRows = [];
  gate = { user: USER, companyId: 'co-1', companyName: 'Acme Advisory' };
  conflict = null;
  inserted.length = 0;
  audits.length = 0;
  settings.replaced.length = 0;
});

describe('GET /api/clients', () => {
  it('requires a client type', async () => {
    const res = await clients.GET(new Request('http://x/api/clients?companyId=co-1'));
    expect(res.status).toBe(400);
  });

  it('passes a gate refusal straight through', async () => {
    gate = { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
    const res = await clients.GET(new Request('http://x/api/clients?type=company&companyId=co-1'));
    expect(res.status).toBe(403);
  });

  it('lists for the gated company', async () => {
    const res = await clients.GET(new Request('http://x/api/clients?type=individual&companyId=co-1'));
    expect(res.status).toBe(200);
    expect((await res.json()).clients).toEqual([]);
  });

  describe('as a list by name', () => {
    const row = (id: string, name: string) => ({
      id, clientType: 'individual', displayName: name, isActive: true,
      details: prepareClientRow(name, { mobile: '9876543210' }).details,
    });
    const get = async (qs = 'type=individual&companyId=co-1') =>
      (await (await clients.GET(new Request(`http://x/api/clients?${qs}`))).json()).clients.map((c: any) => c.displayName);

    it('comes back A to Z, not newest first', async () => {
      // The database hands them over newest first.
      listRows = [row('3', 'Shree Ram'), row('2', 'Ram Das'), row('1', 'Anita Rao')];
      expect(await get()).toEqual(['Anita Rao', 'Ram Das', 'Shree Ram']);
    });

    it('ignores case and accents, and puts numbers in natural order', async () => {
      listRows = [row('1', 'zoya Khan'), row('2', 'Client 10'), row('3', 'élan Pillai'), row('4', 'Client 2'), row('5', 'Adam')];
      expect(await get()).toEqual(['Adam', 'Client 2', 'Client 10', 'élan Pillai', 'zoya Khan']);
    });

    it('keeps the database order for two clients with the same name (a stable tie-break)', async () => {
      listRows = [row('newer', 'Ram Das'), row('older', 'Ram Das')];
      const ids = (await (await clients.GET(new Request('http://x/api/clients?type=individual&companyId=co-1'))).json()).clients.map((c: any) => c.id);
      expect(ids).toEqual(['newer', 'older']);
    });

    it('orders a search result the same way', async () => {
      listRows = [row('2', 'Ram Das'), row('1', 'Ramesh')];
      expect(await get('type=individual&companyId=co-1&q=ram')).toEqual(['Ram Das', 'Ramesh']);
    });
  });
});

describe('POST /api/clients', () => {
  it('creates a client sealed, hashed, scoped to the PROVEN company, and audits it without identifiers', async () => {
    const res = await clients.POST(post('/api/clients?companyId=EVIL', {
      clientType: 'individual', displayName: 'Rajesh Kumar',
      details: { panNumber: 'abcpk1234f', mobile: '9876543210' },
    }));
    expect(res.status).toBe(201);
    const row = inserted[0];
    // The company comes from the gate, never from the query or the body.
    expect(row.companyId).toBe('co-1');
    expect(row.tenantId).toBe('t1');
    expect(row.details.panNumber).not.toContain('ABCPK1234F');
    expect(row.panHash).toBeTruthy();
    expect(row.nameNorm).toBe('rajesh kumar');
    // The response carries the plaintext the owner typed; the audit line must not.
    const body = await res.json();
    expect(body.client.details.panNumber).toBe('ABCPK1234F');
    const line = JSON.stringify(audits[0]);
    expect(line).not.toMatch(/ABCPK1234F/i);
    expect(audits[0].details).toContain('Rajesh Kumar');
    expect(audits[0].action).toBe('biz_client_individual.create');
  });

  it('rejects an invalid PAN, an unknown key and a missing name with 400', async () => {
    for (const body of [
      { clientType: 'individual', displayName: 'X', details: { panNumber: 'nope' } },
      { clientType: 'individual', displayName: 'X', details: { gstNumber: '27ABCDE1234F1Z5' } },
      { clientType: 'individual', displayName: '   ', details: {} },
      { clientType: 'alien', displayName: 'X' },
      { clientType: 'company', displayName: 'X', tenantId: 'other' },
    ]) {
      const res = await clients.POST(post('/api/clients', body));
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(inserted).toHaveLength(0);
  });

  it('answers 409 with the conflict message and writes nothing', async () => {
    conflict = 'You already have a individual client named "Rajesh Kumar".';
    const res = await clients.POST(post('/api/clients', { clientType: 'individual', displayName: 'Rajesh Kumar' }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('Rajesh Kumar');
    expect(inserted).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });
});

describe('/api/clients/subcategories', () => {
  it('GET lists the configurable groups', async () => {
    const res = await subs.GET(new Request('http://x/api/clients/subcategories?type=individual&companyId=co-1'));
    const body = await res.json();
    expect(body.groups[0].items[0].documentName).toBe('PAN Card');
    expect(body.enabledCount).toBe(1);
  });

  it('PUT refuses a key that is not a real subcategory for the type — all or nothing', async () => {
    const res = await subs.PUT(post('/api/clients/subcategories?type=individual&companyId=co-1',
      { keys: ['identity-pan_card', 'identity-made_up'] }, 'PUT'));
    expect(res.status).toBe(400);
    expect(settings.replaced).toHaveLength(0);
  });

  it('PUT dedupes, saves the exact set for the proven company and audits the counts', async () => {
    const res = await subs.PUT(post('/api/clients/subcategories?type=individual&companyId=co-1',
      { keys: ['identity-pan_card', 'identity-pan_card', 'insurance-health_policies'] }, 'PUT'));
    expect(res.status).toBe(200);
    expect(settings.replaced[0]).toEqual(['t1', 'co-1', 'individual', ['identity-pan_card', 'insurance-health_policies']]);
    expect(audits[0].entityType).toBe('client_subcategory_settings');
    expect(audits[0].details).toContain('1 added, 0 removed');
  });

  it('PUT with an empty list is valid: it clears the selection', async () => {
    const res = await subs.PUT(post('/api/clients/subcategories?type=company&companyId=co-1', { keys: [] }, 'PUT'));
    expect(res.status).toBe(200);
    expect(settings.replaced[0][3]).toEqual([]);
  });

  it('needs a type', async () => {
    const res = await subs.PUT(post('/api/clients/subcategories?companyId=co-1', { keys: [] }, 'PUT'));
    expect(res.status).toBe(400);
  });
});
