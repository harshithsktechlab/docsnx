/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   NOTHING IS EVER FILED UNDER A MIRROR ADDRESS                           ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * A mirrored category (src/lib/categoryMirrors.ts) is a second way to ADDRESS
 * another module's category, never a second place to put a record. If a write
 * ever slipped through under the alias, the row would be invisible everywhere:
 * reads canonicalise away from it, so no module would list it, and its bytes
 * would be sealed into a Drive folder nothing opens.
 *
 * `resolveCategory` is the choke point every write path already passes
 * through — /api/documents, its autofill, the AI bulk scan and `createRecord` —
 * so these assert the guarantee there, once, rather than route by route.
 *
 * The fake executor decodes the parameters bound into the Drizzle predicate,
 * which is what lets a test see WHICH category was looked up rather than only
 * what came back. That is the whole question here.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/db', () => ({ db: {} }));

const { resolveCategory } = await import('@/lib/documentCategoryResolver');

const ALIAS = {
  id: '11111111-1111-4111-8111-111111111111',
  moduleKey: 'vehicle', documentKey: 'insurance_cross_ref',
  moduleName: 'Vehicle', documentName: 'Vehicle insurance',
};
const CANONICAL = {
  id: '22222222-2222-4222-8222-222222222222',
  moduleKey: 'insurance', documentKey: 'vehicle_policies',
  moduleName: 'Insurance', documentName: 'Vehicle insurance',
};
const PAN = {
  id: '33333333-3333-4333-8333-333333333333',
  moduleKey: 'identity', documentKey: 'pan_card',
  moduleName: 'Identity', documentName: 'PAN Card',
};
const OTHERS = {
  id: '44444444-4444-4444-8444-444444444444',
  moduleKey: 'other', documentKey: 'uncategorized',
  moduleName: 'Others', documentName: 'Others',
};
const TABLE = [ALIAS, CANONICAL, PAN, OTHERS];

/** Every literal bound into a Drizzle predicate, in order. */
function boundParams(node: any, out: any[] = []): any[] {
  if (!node) return out;
  if (Array.isArray(node)) { node.forEach((n) => boundParams(n, out)); return out; }
  if (node.queryChunks) return boundParams(node.queryChunks, out);
  if (node.value !== undefined && node.encoder) out.push(node.value);
  return out;
}

/**
 * A `document_categories` that answers by id or by (module_key, document_key),
 * and records every lookup it was asked to make.
 */
function executor() {
  const asked: Array<string[]> = [];
  const run = (predicate: any) => {
    const params = boundParams(predicate).filter((p) => typeof p === 'string');
    asked.push(params);
    const row = TABLE.find((r) => params.includes(r.id))
      ?? TABLE.find((r) => params.includes(r.moduleKey) && params.includes(r.documentKey));
    return row ? [row] : [];
  };
  return {
    asked,
    select: () => ({
      from: () => ({
        where: (predicate: any) => {
          const rows = run(predicate);
          // `byKey` ends with .limit(1); the id branch does too. Both awaited.
          return Object.assign(Promise.resolve(rows), { limit: async () => rows });
        },
      }),
    }),
  } as any;
}

describe('resolveCategory — the write choke point', () => {
  it('files a record posted at a mirror ADDRESS under the category that owns it', async () => {
    const ex = executor();
    const resolved = await resolveCategory(ex, null, {
      moduleKey: 'vehicle', documentKey: 'insurance_cross_ref',
    });
    expect(resolved).toMatchObject({
      id: CANONICAL.id, moduleKey: 'insurance', documentKey: 'vehicle_policies',
    });
    // It never even asked about the alias — the pair is rewritten before the
    // lookup, so there is no window in which the alias row could be returned.
    expect(ex.asked.flat()).not.toContain('insurance_cross_ref');
  });

  it('rewrites a mirror categoryId to the canonical row’s id', async () => {
    // The picker no longer offers a mirror, but an id can also arrive from an
    // older client or a script, and `documents.category_id` is what the Drive
    // folder and the AAD are derived from. It must never be the alias's.
    const ex = executor();
    const resolved = await resolveCategory(ex, ALIAS.id, null);
    expect(resolved!.id).toBe(CANONICAL.id);
    expect(resolved!.moduleKey).toBe('insurance');
  });

  it('leaves an ordinary category exactly as it found it', async () => {
    const ex = executor();
    expect(await resolveCategory(ex, PAN.id, null)).toMatchObject({ id: PAN.id });
    expect(await resolveCategory(executor(), null, {
      moduleKey: 'identity', documentKey: 'pan_card',
    })).toMatchObject({ id: PAN.id });
  });

  it('still refuses an id that names nothing, rather than falling back', async () => {
    // Unchanged by mirroring, and load-bearing: a silent fallback would turn a
    // typo into a mis-filed document instead of a 400.
    expect(await resolveCategory(executor(), '55555555-5555-4555-8555-555555555555', null))
      .toBeNull();
    expect(await resolveCategory(executor(), 'not-a-uuid', null)).toBeNull();
  });

  it('still lands an unresolvable pair in the catch-all', async () => {
    const resolved = await resolveCategory(executor(), null, {
      moduleKey: 'nope', documentKey: 'not_a_key',
    });
    expect(resolved).toMatchObject({ moduleKey: 'other', documentKey: 'uncategorized' });
  });
});
