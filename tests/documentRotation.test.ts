/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE TURN GIVEN TO A SCAN (drizzle/0085) — saved on the document        ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * A display preference remembered per document: quarter turns only, editable by
 * whoever may edit the document, scoped to the caller's tenant and workspace.
 * The stored bytes are never touched.
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { documents } from '@/db/schema';

const ROOT = path.join(__dirname, '..');

describe('the 0085 migration', () => {
  it('adds a checked, defaulted column additively and is journalled', () => {
    const sql = fs.readFileSync(path.join(ROOT, 'drizzle/0085_document_rotation.sql'), 'utf8');
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS "rotation" smallint NOT NULL DEFAULT 0/);
    expect(sql).toMatch(/CHECK \("rotation" IN \(0, 90, 180, 270\)\)/);
    const journal = JSON.parse(fs.readFileSync(path.join(ROOT, 'drizzle/meta/_journal.json'), 'utf8'));
    const tags = journal.entries.map((e: { tag: string }) => e.tag);
    expect(tags).toContain('0085_document_rotation');
    // Later than everything before it, or drizzle-kit would skip it.
    const mine = journal.entries.find((e: { tag: string }) => e.tag === '0085_document_rotation');
    const before = journal.entries.filter((e: { idx: number }) => e.idx < mine.idx);
    expect(mine.when).toBeGreaterThan(Math.max(...before.map((e: { when: number }) => e.when)));
  });

  it('is mirrored in the Drizzle schema', () => {
    expect(getTableColumns(documents).rotation?.name).toBe('rotation');
  });
});

const doc = {
  id: 'doc-1',
  title: 'Passport scan',
  rotation: 0,
  categoryModuleKey: 'identity',
  categoryDocumentKey: 'passport',
  holder: { name: 'Asha' },
};

const findFirst = vi.fn();
const returning = vi.fn();
const set = vi.fn(() => ({ where: () => ({ returning }) }));
const tx = { update: () => ({ set }) };
vi.mock('@/lib/db', () => ({
  db: { query: { documents: { findFirst: (...a: any[]) => findFirst(...a) } } },
  withTenant: async (_t: string, cb: any) => cb(tx),
}));
const getUser = vi.fn();
vi.mock('@/lib/auth', () => ({ getUserFromRequest: (...a: any[]) => getUser(...a) }));
vi.mock('@/lib/planGate', () => ({ requireActivePlan: () => null }));
const writeAudit = vi.fn(async () => undefined);
vi.mock('@/lib/audit', () => ({
  writeAudit: (...a: any[]) => (writeAudit as any)(...a),
  ACTIONS: { documents: { update: 'documents.update' } },
  auditSentence: () => 'Updated a document',
  categoryPhrase: () => 'Passport',
}));
const canReachRecord = vi.fn();
vi.mock('@/lib/records/handler', () => ({
  canReachRecord: (...a: any[]) => canReachRecord(...a),
}));
vi.mock('@/lib/records/documentVisibility', () => ({ visibleDocument: () => undefined }));
vi.mock('@/lib/records/companyScope', () => ({
  inCompanyOf: () => undefined,
  resolveUtilityCompany: vi.fn(async () => ({ companyId: null })),
}));
vi.mock('@/lib/routeError', () => ({
  serverError: () => new Response(JSON.stringify({ error: 'boom' }), { status: 500 }),
}));

const { PUT } = await import('@/app/api/documents/[id]/rotation/route');

const call = (body: unknown) => PUT(
  new Request('http://localhost/api/documents/doc-1/rotation', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }),
  { params: Promise.resolve({ id: 'doc-1' }) },
);

beforeEach(() => {
  vi.clearAllMocks();
  getUser.mockResolvedValue({ id: 'u1', tenantId: 't1' });
  findFirst.mockResolvedValue({ ...doc });
  canReachRecord.mockResolvedValue(true);
  returning.mockResolvedValue([{ id: 'doc-1' }]);
});

describe('PUT /api/documents/[id]/rotation', () => {
  it('refuses a caller who is not signed in', async () => {
    getUser.mockResolvedValue(null);
    expect((await call({ rotation: 90 })).status).toBe(401);
    expect(set).not.toHaveBeenCalled();
  });

  it('answers 404 for a document outside the caller’s tenant or workspace', async () => {
    findFirst.mockResolvedValue(undefined);
    expect((await call({ rotation: 90 })).status).toBe(404);
    expect(set).not.toHaveBeenCalled();
  });

  it('refuses a caller who may not edit the document', async () => {
    canReachRecord.mockResolvedValue(false);
    expect((await call({ rotation: 90 })).status).toBe(403);
    expect(canReachRecord).toHaveBeenCalledWith(expect.anything(), 'documents', expect.anything(), 'edit');
    expect(set).not.toHaveBeenCalled();
  });

  it.each([45, 360, -90, '90', null])('rejects %s as not a quarter turn', async (rotation) => {
    expect((await call({ rotation })).status).toBe(400);
    expect(set).not.toHaveBeenCalled();
  });

  it.each([0, 90, 180, 270])('saves %s and audits it', async (rotation) => {
    if (rotation === 0) findFirst.mockResolvedValue({ ...doc, rotation: 90 });
    const res = await call({ rotation });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, rotation });
    expect(set).toHaveBeenCalledWith({ rotation });
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 't1', entityType: 'documents', entityId: 'doc-1' }),
      tx,
    );
  });

  it('writes and audits nothing when the turn is unchanged', async () => {
    findFirst.mockResolvedValue({ ...doc, rotation: 180 });
    const res = await call({ rotation: 180 });

    expect(res.status).toBe(200);
    expect(set).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });
});
