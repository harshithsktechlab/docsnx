// @vitest-environment node
/**
 * resolveClientDocumentScope — the one gate for "list / bulk-act on ONE client's documents".
 * The client is read from the database for the PROVEN company; the permission is the
 * client TYPE's module; the keys are that module's categories the member may act on.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const CID = '123e4567-e89b-42d3-a456-426614174000';
const USER = { id: 'u1', tenantId: 't1' };
let rows: any[] = [];
const hasPermission = vi.fn();

vi.mock('@/lib/db', () => ({
  withTenant: async (_t: string, fn: any) => fn({
    select: () => ({ from: () => ({ where: () => ({ limit: async () => rows }) }) }),
  }),
}));
vi.mock('@/db/schema', () => ({ clients: new Proxy({}, { get: (_t, p) => ({ __col: String(p) }) }) }));
vi.mock('drizzle-orm', () => ({ and: (...a: any[]) => a, eq: (c: any, v: any) => [c, v], isNull: (c: any) => c }));
vi.mock('@/lib/auth', () => ({ hasPermission: (...a: any[]) => hasPermission(...a) }));
vi.mock('@/lib/taxonomyRegistry', () => ({
  activeCategoryKeys: async () => [
    { moduleKey: 'biz_client_individual', documentKey: 'identity-pan_card' },
    { moduleKey: 'biz_client_individual', documentKey: 'uncategorized' },
    { moduleKey: 'biz_client_company', documentKey: 'tax-gst' },
    { moduleKey: 'biz_tax', documentKey: 'gst' },
  ],
}));

const { resolveClientDocumentScope } = await import('@/lib/clients/clientDocumentScope');
const status = (r: any) => r.error?.status;

beforeEach(() => {
  rows = [{ id: CID, clientType: 'individual', displayName: 'Ram Das' }];
  hasPermission.mockReset().mockResolvedValue(true);
});

describe('resolveClientDocumentScope', () => {
  it('returns the client and ONLY that client type\'s categories', async () => {
    const r: any = await resolveClientDocumentScope(USER, 'co', CID, 'view');

    expect(r).toMatchObject({ clientId: CID, clientName: 'Ram Das', type: 'individual' });
    expect(r.keys.map((k: any) => k.documentKey)).toEqual(['identity-pan_card', 'uncategorized']);
  });

  it('is a 400 without a company workspace, and for a malformed id (no query run)', async () => {
    expect(status(await resolveClientDocumentScope(USER, null, CID, 'view'))).toBe(400);
    expect(status(await resolveClientDocumentScope(USER, 'co', 'not-a-uuid', 'view'))).toBe(400);
  });

  it('is a 403 for a client that is not found (another company, tenant, or deleted)', async () => {
    rows = [];
    expect(status(await resolveClientDocumentScope(USER, 'co', CID, 'view'))).toBe(403);
  });

  it('is a 403 without permission on the client type\'s module', async () => {
    hasPermission.mockResolvedValue(false);
    expect(status(await resolveClientDocumentScope(USER, 'co', CID, 'view'))).toBe(403);
    expect(hasPermission.mock.calls[0].slice(1)).toEqual(['biz_client_individual', 'view']);
  });

  it('drops a category the member is denied, and is a 403 when none is left', async () => {
    hasPermission.mockImplementation(async (_u, _m, _a, key) => key !== 'identity-pan_card');
    const r: any = await resolveClientDocumentScope(USER, 'co', CID, 'view');
    expect(r.keys.map((k: any) => k.documentKey)).toEqual(['uncategorized']);

    hasPermission.mockImplementation(async (_u, _m, _a, key) => key === undefined);
    expect(status(await resolveClientDocumentScope(USER, 'co', CID, 'view'))).toBe(403);
  });

  it('uses the company client module for a company client', async () => {
    rows = [{ id: CID, clientType: 'company', displayName: 'Acme' }];
    const r: any = await resolveClientDocumentScope(USER, 'co', CID, 'delete');
    expect(r.keys).toEqual([{ moduleKey: 'biz_client_company', documentKey: 'tax-gst' }]);
  });
});
