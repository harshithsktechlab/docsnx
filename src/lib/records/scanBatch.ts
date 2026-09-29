/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   POWER SCAN SAVES A BATCH ALL-OR-NOTHING                                ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * A scan used to be saved record by record, and a batch with one bad row came
 * back half-written. The member fixed that row, pressed Save again, and every
 * row the first pass HAD written was now reported as "already exists", because
 * each one matched itself.
 *
 * Now `/api/ai/scan/save` runs in three steps, and this module holds the pieces
 * they share:
 *
 *   1. `check`: every record is judged before anything is written. That covers
 *      fields, permission, category, pages and duplicates against the vault,
 *      and `findBatchCollisions` below for duplicates WITHIN the batch, which
 *      the vault cannot see because none of it is stored yet.
 *   2. The write, which stops at its first failure.
 *   3. `rollback`: the records that write created are taken back out, so the
 *      batch is once again entirely unsaved. Each created record comes back
 *      with a `rollbackToken`, and only a token this server signed can undo a
 *      record. The browser is never trusted to name what to delete.
 */
import jwt from 'jsonwebtoken';
import { isGenericFileName } from './uploadTypes';
import type { DuplicateReason } from './duplicateMatch';

// ── In-batch duplicates ────────────────────────────────────────────────────

/** One record of the batch, reduced to what the duplicate arms compare. */
export interface BatchCandidate {
  /** Resolved category id. Arms 3 and 4 are scoped to it. */
  categoryId: string | null;
  /** Canonical `moduleKey/documentKey`. Arm 1 is scoped to it. */
  categoryPair: string | null;
  title: string;
  fileName: string | null;
  /** Blind indexes of the fields that identify a record of this category. */
  identifierHashes: Record<string, string>;
  /** `sourceHashFor` over this record's own pages. */
  sourceHash: string | null;
}

export interface BatchCollision {
  /** The EARLIER row of the batch this one duplicates. */
  withIndex: number;
  reason: DuplicateReason;
}

/**
 * Which rows of the batch duplicate an earlier row of the same batch.
 *
 * These are the same four arms, in the same order, as `resolveDuplicate`
 * (duplicateMatch.ts), because this predicts what `createRecord` would refuse
 * once the earlier row is written. Only the LATER row of a pair is flagged,
 * since the write runs in order and the earlier row is the one that lands
 * first. Rows the check refused for another reason should be passed as `null`.
 */
export function findBatchCollisions(
  candidates: ReadonlyArray<BatchCandidate | null>,
): Map<number, BatchCollision> {
  const out = new Map<number, BatchCollision>();
  const norm = (t: string) => t.trim().toLowerCase();

  candidates.forEach((row, i) => {
    if (!row) return;
    for (let j = 0; j < i; j += 1) {
      const earlier = candidates[j];
      if (!earlier) continue;

      // Arm 1: a shared identifier, within one category.
      if (row.categoryPair && row.categoryPair === earlier.categoryPair) {
        const clash = Object.entries(row.identifierHashes)
          .some(([key, hash]) => hash && earlier.identifierHashes[key] === hash);
        if (clash) { out.set(i, { withIndex: j, reason: 'dedupeField' }); return; }
      }
      // Arm 2: the same pages, in any category.
      if (row.sourceHash && row.sourceHash === earlier.sourceHash) {
        out.set(i, { withIndex: j, reason: 'fileContent' }); return;
      }
      // Arms 3 & 4: title, then source filename, within one category.
      if (row.categoryId && row.categoryId === earlier.categoryId) {
        if (norm(row.title) && norm(row.title) === norm(earlier.title)) {
          out.set(i, { withIndex: j, reason: 'title' }); return;
        }
        if (row.fileName && !isGenericFileName(row.fileName)
            && row.fileName === earlier.fileName) {
          out.set(i, { withIndex: j, reason: 'fileName' }); return;
        }
      }
    }
  });
  return out;
}

/** What an in-batch collision tells the member, row by row. */
export function batchCollisionMessage(reason: DuplicateReason, otherTitle: string): string {
  const other = `'${otherTitle || 'another record'}'`;
  switch (reason) {
    case 'dedupeField': return `Has the same number as ${other} in this scan. Correct it, or remove one of them.`;
    case 'fileContent': return `Has the same pages as ${other} in this scan.`;
    case 'title': return `Has the same title as ${other} in this scan, in the same category.`;
    default: return `Comes from the same file as ${other} in this scan, in the same category.`;
  }
}

// ── Rollback tokens ─────────────────────────────────────────────────────────

const ROLLBACK_TYP = 'scan_rollback';
/** A rollback follows a failed write within seconds. An hour is generous. */
const ROLLBACK_TTL = '1h';

export type RollbackKind = 'record' | 'todo' | 'contact';

export interface RollbackClaim {
  kind: RollbackKind;
  /** The record scope a `record` was written into. Selects its permission context. */
  scope: string;
  id: string;
  tenantId: string;
  userId: string;
  companyId: string | null;
}

export function signRollbackToken(claim: RollbackClaim): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET environment variable is missing.');
  return jwt.sign({ ...claim, typ: ROLLBACK_TYP }, secret, { expiresIn: ROLLBACK_TTL });
}

/**
 * The claim inside a token, or null. The token must also belong to THIS user,
 * tenant and workspace, which the caller checks against its own session and
 * never against anything else in the request.
 */
export function verifyRollbackToken(raw: unknown): RollbackClaim | null {
  if (typeof raw !== 'string' || !raw) return null;
  const secret = process.env.JWT_SECRET;
  if (!secret) return null;
  try {
    const d = jwt.verify(raw, secret) as Partial<RollbackClaim> & { typ?: string };
    // A session cookie is signed with the same secret, so the `typ` check is
    // what stops one of those from being accepted here.
    if (d?.typ !== ROLLBACK_TYP) return null;
    if (d.kind !== 'record' && d.kind !== 'todo' && d.kind !== 'contact') return null;
    if (typeof d.id !== 'string' || typeof d.tenantId !== 'string'
        || typeof d.userId !== 'string' || typeof d.scope !== 'string') return null;
    return {
      kind: d.kind, scope: d.scope, id: d.id, tenantId: d.tenantId,
      userId: d.userId, companyId: typeof d.companyId === 'string' ? d.companyId : null,
    };
  } catch {
    return null;
  }
}
