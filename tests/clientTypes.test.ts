import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * A fake tx behind the three shapes clientTypes.ts runs: the stored choice
 * (select … limit), the live-client count (select { n } … where) and the write.
 */
let stored: { individual: boolean; company: boolean } | null;
let liveClients: Record<string, number>;
const writes: { kind: 'insert' | 'update'; values: any }[] = [];

vi.mock('@/lib/db', () => ({
  withTenant: async (_t: string, fn: any) => fn({
    select: (shape: any) => ({
      from: () => ({
        where: (cond: any) => {
          const rows = 'n' in shape ? [{ n: liveClients[(globalThis as any).__asking] ?? 0 }] : null;
          return Object.assign(Promise.resolve(rows), {
            limit: async () => (stored ? [stored] : []),
          });
        },
      }),
    }),
    insert: () => ({ values: async (v: any) => { writes.push({ kind: 'insert', values: v }); } }),
    update: () => ({ set: (v: any) => ({ where: async () => { writes.push({ kind: 'update', values: v }); } }) }),
  }),
}));
vi.mock('@/db/schema', () => ({
  clients: new Proxy({}, { get: (_t, p) => ({ __col: String(p) }) }),
  clientTypeSettings: new Proxy({}, { get: (_t, p) => ({ __col: String(p) }) }),
}));
// `eq(clients.clientType, 'company')` is where the count learns which kind it is asked about.
vi.mock('drizzle-orm', () => ({
  and: (...a: any[]) => a,
  eq: (c: any, v: any) => { if (c?.__col === 'clientType') (globalThis as any).__asking = v; return [c, v]; },
  isNull: (c: any) => c,
  count: () => ({ n: true }),
}));

const { loadClientTypes, saveClientTypes, enabledTypes, isTypeEnabled, typeNotEnabledMessage, NOT_CHOSEN } =
  await import('@/lib/clients/clientTypes');

beforeEach(() => { stored = null; liveClients = {}; writes.length = 0; });

describe('loadClientTypes', () => {
  it('is NOT chosen when there is no row — nothing is inferred', async () => {
    const t = await (await import('@/lib/db')).withTenant('t1', (tx: any) => loadClientTypes(tx, 't1', 'co'));
    expect(t).toEqual(NOT_CHOSEN);
    expect(isTypeEnabled(t, 'individual')).toBe(false);
    expect(enabledTypes(t)).toEqual([]);
  });

  it('reads the stored choice, in tab order', async () => {
    stored = { individual: false, company: true };
    const t = await (await import('@/lib/db')).withTenant('t1', (tx: any) => loadClientTypes(tx, 't1', 'co'));
    expect(t).toEqual({ chosen: true, individual: false, company: true });
    expect(enabledTypes(t)).toEqual(['company']);
    stored = { individual: true, company: true };
    expect(enabledTypes(await (await import('@/lib/db')).withTenant('t1', (tx: any) => loadClientTypes(tx, 't1', 'co')))).toEqual(['individual', 'company']);
  });
});

describe('saveClientTypes', () => {
  it('stores a first choice as a new row', async () => {
    const r = await saveClientTypes('t1', 'co', { individual: true, company: false });
    expect(r).toMatchObject({ ok: true, types: { chosen: true, individual: true, company: false } });
    expect(writes).toEqual([{ kind: 'insert', values: expect.objectContaining({ tenantId: 't1', companyId: 'co', individualEnabled: true, companyEnabled: false }) }]);
  });

  it('changes an existing choice in place, never a second row', async () => {
    stored = { individual: true, company: false };
    const r = await saveClientTypes('t1', 'co', { individual: true, company: true });
    expect(r.ok).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ kind: 'update', values: { individualEnabled: true, companyEnabled: true } });
  });

  it('REFUSES to turn a kind off while it has live clients, and says how many', async () => {
    stored = { individual: true, company: true };
    liveClients = { individual: 2 };
    const r = await saveClientTypes('t1', 'co', { individual: false, company: true });
    expect(r).toMatchObject({ ok: false, blocked: { individual: 2 } });
    if (!r.ok) expect(r.error).toBe('You still have 2 individual clients. Remove those clients first, then turn this off.');
    expect(writes).toHaveLength(0);
  });

  it('uses the singular for one client, and names both kinds when both are in the way', async () => {
    stored = { individual: true, company: true };
    liveClients = { company: 1 };
    const one = await saveClientTypes('t1', 'co', { individual: true, company: false });
    if (!one.ok) expect(one.error).toBe('You still have 1 company client. Remove that client first, then turn this off.');
    liveClients = { individual: 3, company: 1 };
    // Both off is invalid to the route, but the rule itself reports both.
    const both = await saveClientTypes('t1', 'co', { individual: false, company: false });
    if (!both.ok) expect(both.error).toContain('3 individual clients and 1 company client');
  });

  it('protects clients that exist WITHOUT a stored choice (data from before this setting)', async () => {
    stored = null;
    liveClients = { company: 1 };
    const r = await saveClientTypes('t1', 'co', { individual: true, company: false });
    expect(r.ok).toBe(false);
    expect(writes).toHaveLength(0);
  });

  it('lets a kind with no clients be turned off', async () => {
    stored = { individual: true, company: true };
    liveClients = { individual: 4 };
    const r = await saveClientTypes('t1', 'co', { individual: true, company: false });
    expect(r.ok).toBe(true);
  });
});

describe('typeNotEnabledMessage', () => {
  it('differs for "not chosen yet" and "this kind is off"', () => {
    expect(typeNotEnabledMessage('company', false)).toContain('Choose which kinds of client');
    expect(typeNotEnabledMessage('company', true)).toContain('does not keep company clients');
    expect(typeNotEnabledMessage('individual', true)).toContain('Change client types');
  });
});
