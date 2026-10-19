// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Linking tenant_ai_usages rows to the record the member saved.
 *
 * The ids arrive from the browser, so what matters is what the helper refuses:
 * malformed ids, oversized lists, a missing tenant — and that the write it does
 * make is scoped to the tenant and to rows not linked yet. The WHERE clause is
 * built with drizzle's operators; it is captured and inspected for the columns
 * it constrains rather than executed.
 */

let updates: { set: any; where: any }[] = [];
let docRows: any[] = [];

vi.mock('../src/lib/db', () => ({
  db: {
    update: vi.fn(() => ({
      set: (set: any) => ({
        where: (where: any) => {
          updates.push({ set, where });
          return Object.assign(Promise.resolve(undefined), { returning: async () => [{ id: 'x' }] });
        },
      }),
    })),
    select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: async () => docRows }) }) })),
  },
}));

let mod: typeof import('../src/lib/aiUsageLink');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const DOC = '33333333-3333-4333-8333-333333333333';

/** Every column name a drizzle SQL object references, flattened. */
function columnsIn(node: any, out = new Set<string>(), seen = new Set<any>()): Set<string> {
  if (!node || typeof node !== 'object' || seen.has(node)) return out;
  seen.add(node);
  if (typeof node.name === 'string' && node.table) out.add(node.name);
  for (const v of Object.values(node)) {
    if (Array.isArray(v)) v.forEach((x) => columnsIn(x, out, seen));
    else if (v && typeof v === 'object' && v !== node.table) columnsIn(v, out, seen);
  }
  return out;
}

beforeEach(async () => {
  vi.clearAllMocks();
  updates = [];
  docRows = [];
  mod = await import('../src/lib/aiUsageLink');
});

describe('cleanUsageIds', () => {
  it('keeps distinct UUIDs and drops everything else', () => {
    expect(mod.cleanUsageIds([A, A.toUpperCase(), 'nope', 5, null, B])).toEqual([A, B]);
  });
  it('reads the JSON string a multipart form carries', () => {
    expect(mod.cleanUsageIds(JSON.stringify([A, B]))).toEqual([A, B]);
  });
  it('accepts a single id and ignores broken JSON', () => {
    expect(mod.cleanUsageIds(A)).toEqual([A]);
    expect(mod.cleanUsageIds('[oops')).toEqual([]);
  });
  it('caps the list', () => {
    const many = Array.from({ length: 50 }, (_, i) => `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`);
    expect(mod.cleanUsageIds(many)).toHaveLength(20);
  });
});

describe('linkAiUsage', () => {
  it('writes nothing for no usable ids or no tenant', async () => {
    expect(await mod.linkAiUsage('t-1', ['bad'], { documentId: DOC })).toBe(0);
    expect(await mod.linkAiUsage('', [A], { documentId: DOC })).toBe(0);
    expect(updates).toHaveLength(0);
  });

  it('sets the target and scopes the write to the tenant and to unlinked rows', async () => {
    await mod.linkAiUsage('t-1', [A, B], { documentId: DOC });
    expect(updates).toHaveLength(1);
    expect(updates[0].set).toEqual({ documentId: DOC });
    const cols = columnsIn(updates[0].where);
    for (const c of ['tenant_id', 'id', 'document_id', 'todo_id', 'contact_id']) expect(cols.has(c)).toBe(true);
  });

  it('links todos and contacts to their own columns', async () => {
    await mod.linkAiUsage('t-1', [A], { todoId: DOC });
    await mod.linkAiUsage('t-1', [B], { contactId: DOC });
    expect(updates.map((u) => u.set)).toEqual([{ todoId: DOC }, { contactId: DOC }]);
  });
});

describe('linkAiUsageToExistingDocument', () => {
  it("links nothing when the record is not this tenant's", async () => {
    docRows = [];
    expect(await mod.linkAiUsageToExistingDocument('t-1', [A], DOC)).toBe(0);
    expect(updates).toHaveLength(0);
  });

  it('links when the record exists', async () => {
    docRows = [{ id: DOC }];
    await mod.linkAiUsageToExistingDocument('t-1', [A], DOC);
    expect(updates[0].set).toEqual({ documentId: DOC });
  });

  it('ignores a malformed record id', async () => {
    expect(await mod.linkAiUsageToExistingDocument('t-1', [A], 'not-a-uuid')).toBe(0);
  });
});
