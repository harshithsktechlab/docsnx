/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE MODULE FILES LIST SAYS WHAT THE DOCUMENT MANAGER SAYS              ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * A PAN card reached through the sidebar is the same record as the one reached
 * through /documents. For a while the two lists disagreed about it in both
 * directions:
 *
 *   · the sub-category workspace had no Number column at all, because
 *     `project()` was never handed the category's spec and so could not say
 *     which of the record's fields was its number;
 *   · its "Belongs to" read `holder?.name || (isGlobal ? 'All members' : '—')`,
 *     which is a member answer — and a company's records carry a null
 *     `holder_id` by design (records/holderScope.ts), so every business row
 *     claimed to belong to "All members".
 *
 * Both are now `documentDisplay`, the same function `/api/documents` derives its
 * Number and Holder columns from. That is the invariant here: not that the
 * projection has SOME answer, but that it has the SAME answer, from the same
 * record and the same spec. Two implementations is how they drifted before.
 *
 * `listRecords` is exercised rather than `project()` — the projection is private
 * on purpose, and testing through the front door also covers the spec lookup
 * and the company join that feed it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fieldsFor } from '@/lib/documentCategoryFields';
import { documentDisplay } from '@/lib/records/docMetadata';
import { identifierSpecs } from '@/lib/records/handler';

const ACME = '22222222-2222-4222-8222-222222222222';

/** Rows the fake query returns, and the Drive record each one has. */
let rows: any[] = [];
let stored: Record<string, any> = {};

vi.mock('@/lib/auth', () => ({
  getUserFromRequest: vi.fn(),
  hasPermission: vi.fn(async () => true),
  hasCompanyAccess: vi.fn(async () => true),
}));

vi.mock('@/lib/vault/vaultRecords', () => ({
  readJsonStore: vi.fn(async (ctx: any) => {
    const mine = rows.filter((r) => (r.companyId ?? null) === (ctx.companyId ?? null));
    return { store: { records: Object.fromEntries(mine.map((r) => [r.id, stored[r.id] ?? {}])) } };
  }),
}));

/**
 * The REAL compiled spec, not a stub.
 *
 * The whole question is whether the number the list shows is the one the
 * category declares, so substituting a hand-written spec would test the
 * plumbing while assuming the answer. `loadCategoryFieldSpec` normally reads the
 * stored row and layers operator overrides on top; `fieldsFor` is the same
 * dictionary that row is seeded from.
 */
vi.mock('@/lib/records/categorySpec', () => ({
  loadCategoryFieldSpec: vi.fn(async (_db: any, key: any) => fieldsFor(key)),
}));

/** Self-referential, so a future join does not break this file. See listRecordsCeiling. */
vi.mock('@/lib/db', () => {
  const chain: any = {
    select: () => chain,
    from: () => chain,
    leftJoin: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: async () => rows,
  };
  return { db: {}, withTenant: vi.fn(async (_t: string, cb: any) => cb(chain)) };
});

const { listRecords } = await import('@/lib/records/handler');

const ctxFor = (moduleKey: string, documentKey: string, companyId: string | null) => ({
  user: { id: 'u1', tenantId: 't1', tenant: { id: 't1' } },
  module: moduleKey,
  keys: [{ moduleKey, documentKey }],
  companyId,
}) as any;

/** A pointer row as the list query returns it, joins included. */
const row = (over: Record<string, any>) => ({
  id: 'r1',
  userId: 'u1',
  holderId: null,
  holderName: null,
  isGlobal: false,
  title: 'A record',
  categoryId: 'cat-1',
  companyId: null,
  companyName: null,
  fileDriveId: null,
  filePath: null,
  fileName: null,
  mimeType: null,
  fileSize: 0,
  pageCount: 0,
  status: 'active',
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
  ...over,
});

beforeEach(() => { rows = []; stored = {}; });

describe('a company’s record, in its module’s Files list', () => {
  beforeEach(() => {
    rows = [row({
      categoryModuleKey: 'biz_registration',
      categoryDocumentKey: 'pan_card',
      companyId: ACME,
      companyName: 'HSKTechlab',
      title: 'PAN — HSKTechlab',
    })];
    stored = { r1: { open: {}, masked: { pan_number: '••••234F' } } };
  });

  it('carries the masked number under the label the category gave it', async () => {
    const { records } = await listRecords(
      ctxFor('biz_registration', 'pan_card', ACME), { filters: { documentKey: 'pan_card' } });

    expect(records[0].display.number).toBe('••••234F');
    expect(records[0].display.numberLabel).toBe('PAN');
  });

  it('names the COMPANY as who it belongs to, not "All members"', async () => {
    // The bug: `holder_id` is null on every business row by design, so the old
    // expression fell through to the global-record answer.
    const { records } = await listRecords(
      ctxFor('biz_registration', 'pan_card', ACME), {});

    expect(records[0].display.holderName).toBe('HSKTechlab');
  });

  it('falls back to the generic number a record was filed with', async () => {
    // What a record filed before the business taxonomy had its own fields looks
    // like: the number went into the only box the form offered.
    stored = { r1: { open: {}, masked: { reference_number: '••••156R' } } };
    const { records } = await listRecords(
      ctxFor('biz_registration', 'pan_card', ACME), {});

    expect(records[0].display.number).toBe('••••156R');
    expect(records[0].display.numberKey).toBe('reference_number');
  });
});

describe('a household record, unchanged', () => {
  it('still names the assigned member', async () => {
    rows = [row({
      categoryModuleKey: 'identity',
      categoryDocumentKey: 'pan_card',
      holderId: 'm1',
      holderName: 'Ravi Kumar',
    })];
    stored = { r1: { open: {}, masked: { pan_number: '••••234F' } } };

    const { records } = await listRecords(ctxFor('identity', 'pan_card', null), {});
    expect(records[0].display.holderName).toBe('Ravi Kumar');
    expect(records[0].display.number).toBe('••••234F');
    expect(records[0].display.numberLabel).toBe('PAN Number');
  });

  it('says "All members" for a record deliberately filed against nobody', async () => {
    rows = [row({
      categoryModuleKey: 'identity', categoryDocumentKey: 'pan_card', isGlobal: true,
    })];
    const { records } = await listRecords(ctxFor('identity', 'pan_card', null), {});
    expect(records[0].display.holderName).toBe('All members');
  });
});

describe('a record with no number to show', () => {
  it('answers null rather than throwing, and the column renders a dash', async () => {
    rows = [row({ categoryModuleKey: 'identity', categoryDocumentKey: 'pan_card' })];
    stored = { r1: { open: {}, masked: {} } };

    const { records } = await listRecords(ctxFor('identity', 'pan_card', null), {});
    expect(records[0].display.number).toBeNull();
    expect(records[0].display.numberLabel).toBeNull();
  });

  it('survives a pre-taxonomy row that has no category at all', async () => {
    // No pair means no spec anywhere. `specForRow` answers with an empty list
    // rather than looking one up under `undefined/undefined`.
    rows = [row({ categoryModuleKey: null, categoryDocumentKey: null, categoryId: null })];
    const { records } = await listRecords(ctxFor('identity', 'pan_card', null), {});
    expect(records[0].display.number).toBeNull();
  });
});

describe('the two lists cannot disagree', () => {
  it('derives the same display the Document Manager derives, for one record', async () => {
    // The Document Manager calls `documentDisplay` itself, from the row and the
    // category spec (/api/documents). The module list now reaches the same
    // function through `project()`. Same inputs, same answer — asserted rather
    // than assumed, because the previous divergence was invisible until someone
    // opened both screens.
    const meta = { open: { issuing_authority: 'GSTN' }, masked: { arn_number: '••••7788' } };
    rows = [row({
      categoryModuleKey: 'biz_tax',
      categoryDocumentKey: 'gst_returns',
      companyId: ACME,
      companyName: 'HSKTechlab',
    })];
    stored = { r1: meta };

    const { records } = await listRecords(ctxFor('biz_tax', 'gst_returns', ACME), {});
    const managerAnswer = documentDisplay(
      { holder: null, isGlobal: false, companyId: ACME, companyName: 'HSKTechlab' },
      meta,
      identifierSpecs(fieldsFor({ moduleKey: 'biz_tax', documentKey: 'gst_returns' })),
    );

    expect(records[0].display).toEqual(managerAnswer);
    expect(managerAnswer.numberLabel).toBe('ARN');
  });
});
