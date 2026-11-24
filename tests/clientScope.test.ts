import { describe, it, expect, vi, beforeEach } from 'vitest';

const CID = '123e4567-e89b-42d3-a456-426614174000';
const USER = { id: 'u1', tenantId: 't1' };
let rows: any[] = [];
let enabled: string[] = [];
/** Whether the company keeps this kind of client at all, and whether it has chosen. */
let kind = { enabled: true, chosen: true };

vi.mock('@/lib/db', () => ({
  withTenant: async (_t: string, fn: any) => fn({
    select: () => ({ from: () => ({ where: () => ({ limit: async () => rows }) }) }),
  }),
}));
vi.mock('@/db/schema', () => ({ clients: new Proxy({}, { get: (_t, p) => ({ __col: String(p) }) }) }));
vi.mock('drizzle-orm', () => ({ and: (...a: any[]) => a, eq: (c: any, v: any) => [c, v], isNull: (c: any) => c }));
vi.mock('@/lib/clients/clientSettings', () => ({ loadEnabledDocumentKeys: vi.fn(async () => enabled) }));
vi.mock('@/lib/clients/clientTypes', () => ({
  typeEnabledFor: vi.fn(async () => kind),
  typeNotEnabledMessage: (type: string, chosen: boolean) => (chosen ? `This company does not keep ${type} clients.` : 'Choose which kinds of client this company keeps first.'),
}));

const {
  clientBelongsToScope, keysForClientAction, contextForClient, clientIdFromRequest, gateClientScope,
} = await import('@/lib/clients/clientScope');

const KEYS = [
  { moduleKey: 'biz_client_individual', documentKey: 'identity-pan_card' },
  { moduleKey: 'biz_client_individual', documentKey: 'identity-passport' },
  { moduleKey: 'biz_client_individual', documentKey: 'uncategorized' },
];

beforeEach(() => { rows = [{ id: CID, clientType: 'individual' }]; enabled = ['identity-pan_card']; kind = { enabled: true, chosen: true }; });

describe('clientBelongsToScope', () => {
  it('is true only for a live client of this company whose type the scope serves', async () => {
    expect(await clientBelongsToScope(USER, 'co', CID, 'biz_client_individual')).toBe(true);
    // An individual client is not reachable through the company-client scope.
    expect(await clientBelongsToScope(USER, 'co', CID, 'biz_client_company')).toBe(false);
  });

  it('is false when the row is not found (another company or tenant, or deleted)', async () => {
    rows = [];
    expect(await clientBelongsToScope(USER, 'co', CID, 'biz_client_individual')).toBe(false);
  });

  it('is false for a malformed id and for a scope that is not a client scope', async () => {
    expect(await clientBelongsToScope(USER, 'co', 'not-a-uuid', 'biz_client_individual')).toBe(false);
    expect(await clientBelongsToScope(USER, 'co', CID, 'biz_tax')).toBe(false);
  });
});

describe('keysForClientAction', () => {
  it('narrows an ADD to the ticked subcategories plus the catch-all', async () => {
    const keys = await keysForClientAction(USER, 'co', 'individual', 'add', KEYS);
    expect(keys.map((k) => k.documentKey)).toEqual(['identity-pan_card', 'uncategorized']);
  });

  it('allows nothing for a KIND the company has not turned on, however much is ticked', async () => {
    kind = { enabled: false, chosen: true };
    expect(await keysForClientAction(USER, 'co', 'individual', 'add', KEYS)).toEqual([]);
    // ...and still lets what exists be read.
    expect(await keysForClientAction(USER, 'co', 'individual', 'view', KEYS)).toHaveLength(3);
  });

  it('allows NOTHING — not even Others — until at least one subcategory is ticked', async () => {
    enabled = [];
    expect(await keysForClientAction(USER, 'co', 'individual', 'add', KEYS)).toEqual([]);
    // ...yet existing documents stay viewable and editable.
    expect(await keysForClientAction(USER, 'co', 'individual', 'view', KEYS)).toHaveLength(3);
    expect(await keysForClientAction(USER, 'co', 'individual', 'edit', KEYS)).toHaveLength(3);
  });

  it('keeps everything for view / edit, so an un-ticked type stays readable', async () => {
    for (const action of ['view', 'edit', 'delete']) {
      expect(await keysForClientAction(USER, 'co', 'individual', action, KEYS)).toHaveLength(3);
    }
  });
});

describe('contextForClient', () => {
  const base = { scope: 'biz_client_individual', keys: KEYS, companyId: 'co' as string | null };

  it('returns the context narrowed and carrying the lower-cased client', async () => {
    const ctx = await contextForClient(USER, base, CID.toUpperCase());
    expect(ctx.clientId).toBe(CID);
    expect(ctx.keys).toHaveLength(2);
  });

  it('refuses in words: no company, no client, a client that is not this company\'s', async () => {
    await expect(contextForClient(USER, { ...base, companyId: null }, CID)).rejects.toThrow(/company workspace/);
    await expect(contextForClient(USER, base, undefined)).rejects.toThrow(/Choose which client/);
    rows = [];
    await expect(contextForClient(USER, base, CID)).rejects.toThrow(/not available/);
  });

  it('says the KIND is not kept (not "configure") when it is turned off or not chosen yet', async () => {
    kind = { enabled: false, chosen: true };
    await expect(contextForClient(USER, base, CID)).rejects.toThrow(/does not keep individual clients/);
    kind = { enabled: false, chosen: false };
    await expect(contextForClient(USER, base, CID)).rejects.toThrow(/Choose which kinds of client/);
  });

  it('refuses, telling the user to configure first, when nothing is ticked for the type', async () => {
    enabled = [];
    await expect(contextForClient(USER, base, CID)).rejects.toThrow(/Configure subcategories/);
  });
});

describe('gateClientScope (the request form)', () => {
  const req = (qs: string) => new Request(`http://x/api/modules/m/d?${qs}`);

  it('reads clientId from the query and treats malformed as present-but-bad', () => {
    expect(clientIdFromRequest(req(`clientId=${CID}`))).toBe(CID);
    expect(clientIdFromRequest(req(''))).toBeNull();
    expect(clientIdFromRequest(req('clientId=zzz'))).toBeUndefined();
  });

  it('400s without a client or with a bad one, 403s for a foreign one, passes the keys on success', async () => {
    const run = (qs: string, action = 'view') => gateClientScope(req(qs), USER, 'biz_client_individual', 'co', action, KEYS);
    expect(((await run('')) as any).error.status).toBe(400);
    expect(((await run('clientId=zzz')) as any).error.status).toBe(400);
    rows = [];
    expect(((await run(`clientId=${CID}`)) as any).error.status).toBe(403);
    rows = [{ id: CID, clientType: 'individual' }];
    const ok: any = await run(`clientId=${CID}`, 'add');
    expect(ok.clientId).toBe(CID);
    expect(ok.keys).toHaveLength(2);
  });

  it('answers an ADD for a kind that is not kept with its own 409 code', async () => {
    kind = { enabled: false, chosen: true };
    const run = (action: string) => gateClientScope(req(`clientId=${CID}`), USER, 'biz_client_individual', 'co', action, KEYS) as Promise<any>;
    const refused = await run('add');
    expect(refused.error.status).toBe(409);
    expect((await refused.error.json()).code).toBe('CLIENT_TYPE_NOT_ENABLED');
  });

  it('answers an ADD for an unconfigured client type with a readable 409, but still lets it be viewed', async () => {
    enabled = [];
    const run = (action: string) => gateClientScope(req(`clientId=${CID}`), USER, 'biz_client_individual', 'co', action, KEYS) as Promise<any>;
    const refused = await run('add');
    expect(refused.error.status).toBe(409);
    expect((await refused.error.json()).code).toBe('CLIENT_NOT_CONFIGURED');
    const viewed = await run('view');
    expect(viewed.keys).toHaveLength(3);
  });
});
