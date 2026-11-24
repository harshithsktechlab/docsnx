import { describe, it, expect, vi, beforeEach } from 'vitest';

let kind = { enabled: true, chosen: true };
let permitted = true;

vi.mock('@/lib/auth', () => ({
  getUserFromRequest: vi.fn(async () => ({ id: 'u1', tenantId: 't1', role: 'STANDARD' })),
  hasPermission: vi.fn(async () => permitted),
}));
vi.mock('@/lib/records/companyScope', () => ({ resolveUtilityCompany: async () => ({ companyId: 'co-1' }) }));
vi.mock('@/lib/db', () => ({
  withTenant: async (_t: string, fn: any) => fn({
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ name: 'Redpluto Analytics' }] }) }) }),
  }),
}));
vi.mock('@/db/schema', () => ({ companies: new Proxy({}, { get: (_t, p) => ({ __col: String(p) }) }) }));
vi.mock('drizzle-orm', () => ({ and: (...a: any[]) => a, eq: (c: any, v: any) => [c, v], isNull: (c: any) => c }));
vi.mock('@/lib/clients/clientTypes', () => ({
  typeEnabledFor: vi.fn(async () => kind),
  typeNotEnabledMessage: (type: string, chosen: boolean) => (chosen ? `This company does not keep ${type} clients.` : 'Choose which kinds of client this company keeps first.'),
}));

const { gateClients } = await import('@/lib/clients/clientGate');
const req = () => new Request('http://x/api/clients?companyId=co-1');

beforeEach(() => { kind = { enabled: true, chosen: true }; permitted = true; });

describe('gateClients — the kind must be one the company keeps', () => {
  it('passes a kept kind', async () => {
    const g: any = await gateClients(req(), 'individual', 'view');
    expect(g.companyId).toBe('co-1');
    expect(g.error).toBeUndefined();
  });

  it('refuses a kind that is turned off, with its own code and sentence', async () => {
    kind = { enabled: false, chosen: true };
    const g: any = await gateClients(req(), 'company', 'view');
    expect(g.error.status).toBe(409);
    const body = await g.error.json();
    expect(body.code).toBe('CLIENT_TYPE_NOT_ENABLED');
    expect(body.error).toContain('does not keep company clients');
  });

  it('refuses everything while nothing has been chosen yet', async () => {
    kind = { enabled: false, chosen: false };
    const g: any = await gateClients(req(), 'individual', 'add');
    expect(g.error.status).toBe(409);
    expect((await g.error.json()).error).toContain('Choose which kinds of client');
  });

  it('still answers 403 first for a member without permission — it never reveals the setting', async () => {
    permitted = false;
    kind = { enabled: false, chosen: true };
    const g: any = await gateClients(req(), 'company', 'view');
    expect(g.error.status).toBe(403);
  });
});
