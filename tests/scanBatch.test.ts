/**
 * Power Scan's all-or-nothing save: the in-batch duplicate rules and the
 * rollback tokens. See src/lib/records/scanBatch.ts.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import {
  findBatchCollisions,
  signRollbackToken,
  verifyRollbackToken,
  type BatchCandidate,
} from '@/lib/records/scanBatch';

const row = (over: Partial<BatchCandidate> = {}): BatchCandidate => ({
  categoryId: 'cat-1',
  categoryPair: 'identity/pan_card',
  title: 'PAN card',
  fileName: 'Family_KYC_2026.pdf',
  identifierHashes: {},
  sourceHash: null,
  ...over,
});

describe('findBatchCollisions', () => {
  it('flags only the LATER row of a pair, pointing at the earlier one', () => {
    const out = findBatchCollisions([row(), row({ fileName: 'other.pdf' })]);
    expect([...out.keys()]).toEqual([1]);
    expect(out.get(1)).toEqual({ withIndex: 0, reason: 'title' });
  });

  it('matches titles trimmed and case-insensitively, within one category only', () => {
    expect(findBatchCollisions([row(), row({ title: '  pan CARD ', fileName: null })]).get(1)?.reason)
      .toBe('title');
    expect(findBatchCollisions([row(), row({ categoryId: 'cat-2', fileName: null })]).size).toBe(0);
  });

  it('ranks a shared identifier above everything else, as resolveDuplicate does', () => {
    const out = findBatchCollisions([
      row({ identifierHashes: { pan_number: 'h1' }, sourceHash: 's' }),
      row({ identifierHashes: { pan_number: 'h1' }, sourceHash: 's' }),
    ]);
    expect(out.get(1)?.reason).toBe('dedupeField');
  });

  it('does not compare identifiers across categories', () => {
    const out = findBatchCollisions([
      row({ identifierHashes: { number: 'h1' }, title: 'A', fileName: null }),
      row({ identifierHashes: { number: 'h1' }, title: 'B', fileName: null, categoryPair: 'vehicle/rc', categoryId: 'cat-9' }),
    ]);
    expect(out.size).toBe(0);
  });

  it('matches the same pages across categories', () => {
    const out = findBatchCollisions([
      row({ sourceHash: 'x', title: 'A', fileName: null }),
      row({ sourceHash: 'x', title: 'B', fileName: null, categoryId: 'cat-2', categoryPair: 'other/x' }),
    ]);
    expect(out.get(1)?.reason).toBe('fileContent');
  });

  it('matches a shared source file name in one category, but never a generic one', () => {
    expect(findBatchCollisions([row({ title: 'A' }), row({ title: 'B' })]).get(1)?.reason)
      .toBe('fileName');
    expect(findBatchCollisions([
      row({ title: 'A', fileName: 'image.jpg' }),
      row({ title: 'B', fileName: 'image.jpg' }),
    ]).size).toBe(0);
  });

  it('skips rows the check already refused (null)', () => {
    expect(findBatchCollisions([null, row(), null]).size).toBe(0);
  });

  it('lets distinct records through', () => {
    expect(findBatchCollisions([
      row({ title: 'A', fileName: 'a.pdf', identifierHashes: { n: '1' }, sourceHash: 'p' }),
      row({ title: 'B', fileName: 'b.pdf', identifierHashes: { n: '2' }, sourceHash: 'q' }),
    ]).size).toBe(0);
  });
});

describe('rollback tokens', () => {
  beforeAll(() => { process.env.JWT_SECRET ||= 'test-secret-for-scan-batch'; });

  const claim = {
    kind: 'record' as const, scope: 'documents', id: 'doc-1',
    tenantId: 't-1', userId: 'u-1', companyId: null,
  };

  it('round-trips a claim this server signed', () => {
    expect(verifyRollbackToken(signRollbackToken(claim))).toEqual(claim);
  });

  it('refuses a token signed with the same secret for something else (a session cookie)', () => {
    const session = jwt.sign({ ...claim, typ: 'session' }, process.env.JWT_SECRET!);
    expect(verifyRollbackToken(session)).toBeNull();
  });

  it('refuses a tampered or foreign token', () => {
    const token = signRollbackToken(claim);
    expect(verifyRollbackToken(`${token}x`)).toBeNull();
    expect(verifyRollbackToken(jwt.sign({ ...claim, typ: 'scan_rollback' }, 'other-secret'))).toBeNull();
    expect(verifyRollbackToken(undefined)).toBeNull();
    expect(verifyRollbackToken({ id: 'doc-1' })).toBeNull();
  });

  it('refuses an expired token', () => {
    const old = jwt.sign(
      { ...claim, typ: 'scan_rollback', iat: Math.floor(Date.now() / 1000) - 7200 },
      process.env.JWT_SECRET!,
      { expiresIn: '1h' },
    );
    expect(verifyRollbackToken(old)).toBeNull();
  });
});
