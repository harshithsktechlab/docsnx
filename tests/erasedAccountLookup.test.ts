/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   findErasedAccount — how a deleted account is found and described      ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Login and forgot-password consult this on a miss so the person who erased
 * their workspace and forgot is told so instead of "Invalid credentials".
 * What is pinned here:
 *
 *   • an email matches the cleartext column, lower-cased;
 *   • a mobile number, in any spelling, matches `phone_dial_index` through the
 *     SAME normalisation and keyed hash the erasure routes write — drift on
 *     either side and the lookup silently never matches;
 *   • junk that is neither never reaches the database;
 *   • the newest erasure wins;
 *   • the sentence names the date, and differs by role;
 *   • the 410 body carries the flag the pages branch on and nothing sensitive.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let rows: any[] = [];
let captured: { predicate: any; orderBy: any } = { predicate: null, orderBy: null };

vi.mock('@/lib/db', () => {
  const chain: any = {
    from: () => chain,
    where: (predicate: any) => { captured.predicate = predicate; return chain; },
    orderBy: (o: any) => { captured.orderBy = o; return chain; },
    limit: () => Promise.resolve(rows),
  };
  return { db: { select: () => chain } };
});

const { findErasedAccount, erasedAccountMessage, erasedAccountResponse } = await import('@/lib/account/erasedAccountLookup');
const { blindIndex } = await import('@/lib/fieldCrypto');
const { deletedAccounts } = await import('@/db/schema');

/** Drizzle's `eq(column, value)` keeps both operands in `queryChunks`. */
function predicateParts(predicate: any): { column: string; value: unknown } {
  const chunks = predicate.queryChunks as any[];
  const column = chunks.find((c) => c && typeof c === 'object' && 'name' in c && 'table' in c);
  const param = chunks.find((c) => c && typeof c === 'object' && 'encoder' in c);
  return { column: column?.name, value: param?.value };
}

const ERASED = { erasedAt: new Date('2026-09-21T09:21:36Z'), role: 'TENANT_ADMIN', tenantName: 'dev5 workspace' };

beforeEach(() => {
  rows = [];
  captured = { predicate: null, orderBy: null };
});

describe('findErasedAccount — which row it asks for', () => {
  it('matches an email on the cleartext column, lower-cased and trimmed', async () => {
    rows = [ERASED];
    const found = await findErasedAccount('  Dev5.HSKTechLab@Gmail.com ');
    expect(found).toEqual(ERASED);
    expect(predicateParts(captured.predicate)).toEqual({ column: 'email', value: 'dev5.hsktechlab@gmail.com' });
  });

  it('matches a mobile number on phone_dial_index through blindIndex(toDialString(...))', async () => {
    rows = [ERASED];
    // The same key the erasure routes write for `users.phone_dial = '919876543210'`.
    const expected = blindIndex('919876543210');
    for (const spelling of ['+919876543210', '9876543210', '+91 98765 43210']) {
      captured = { predicate: null, orderBy: null };
      await findErasedAccount(spelling);
      expect(predicateParts(captured.predicate)).toEqual({ column: 'phone_dial_index', value: expected });
    }
  });

  it('never puts the number itself in the query', async () => {
    rows = [];
    await findErasedAccount('+919876543210');
    const { value } = predicateParts(captured.predicate);
    expect(String(value)).not.toContain('9876543210');
  });

  it('answers null for blank or undiallable input without touching the database', async () => {
    for (const junk of ['', '   ', null, undefined, '12', 'abc']) {
      captured = { predicate: null, orderBy: null };
      await expect(findErasedAccount(junk as any)).resolves.toBeNull();
      expect(captured.predicate).toBeNull();
    }
  });

  it('asks for the newest erasure first', async () => {
    rows = [ERASED];
    await findErasedAccount('dev5.hsktechlab@gmail.com');
    // `desc(column)` renders as `<column> desc`.
    const chunks = captured.orderBy.queryChunks as any[];
    expect(chunks.some((c) => c === deletedAccounts.erasedAt)).toBe(true);
    expect(chunks.some((c) => c?.value?.[0] === ' desc')).toBe(true);
  });

  it('answers null when nothing was retained under that identifier', async () => {
    rows = [];
    await expect(findErasedAccount('nobody@example.test')).resolves.toBeNull();
  });
});

describe('erasedAccountMessage — what the person reads', () => {
  it('tells an admin they deleted it, with the date, and where to go next', () => {
    const msg = erasedAccountMessage(ERASED as any);
    expect(msg).toContain('permanently deleted on 21/09/2026');
    expect(msg).toContain('create a new account');
    expect(msg).not.toContain('admin');
  });

  it('tells a member their workspace was deleted by its admin, naming the workspace', () => {
    const msg = erasedAccountMessage({ ...ERASED, role: 'STANDARD' } as any);
    expect(msg).toContain('"dev5 workspace"');
    expect(msg).toContain('deleted by its admin on 21/09/2026');
  });

  it('copes with a retained row that has no workspace name', () => {
    const msg = erasedAccountMessage({ ...ERASED, role: 'STANDARD', tenantName: null } as any);
    expect(msg.startsWith('The workspace this account belonged to')).toBe(true);
  });
});

describe('erasedAccountResponse — the 410', () => {
  it('is 410 Gone with the flag the pages branch on, the date and the identifier — nothing else', async () => {
    const res = erasedAccountResponse(ERASED as any, 'dev5.hsktechlab@gmail.com');
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body).toEqual({
      error: erasedAccountMessage(ERASED as any),
      accountErased: true,
      erasedAt: '2026-09-21T09:21:36.000Z',
      role: 'TENANT_ADMIN',
      identifier: 'dev5.hsktechlab@gmail.com',
    });
  });
});
