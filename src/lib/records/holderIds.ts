/**
 * Cleaning a request's `holderIds` (drizzle/0066). Pure — no db import — so
 * client bundles that pull in src/lib/recordRequest.ts stay server-free.
 */
/** A holder id that is malformed, foreign, or not a member. Routes answer 400. */
export class InvalidHolderError extends Error {
  constructor(message = 'Invalid holder ID') {
    super(message);
    this.name = 'InvalidHolderError';
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Hard cap: a household is never this big, and it bounds the IN lists. */
export const MAX_HOLDERS = 50;

/**
 * A request's `holderIds` cleaned up: strings only, sentinels dropped, de-duped
 * in the order given (the first is the primary). Returns `undefined` when the
 * field was not sent at all, so callers can tell "not sent" from "All members"
 * (`[]`). Throws on a malformed id so the caller's 400 fires.
 */
export function normalizeHolderIds(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined;
  const list = Array.isArray(raw) ? raw : [raw];
  const out: string[] = [];
  for (const v of list) {
    if (typeof v !== 'string') continue;
    const id = v.trim();
    if (!id || id === 'all' || id === 'none') continue;
    if (!UUID_RE.test(id)) throw new InvalidHolderError();
    if (!out.includes(id)) out.push(id);
  }
  if (out.length > MAX_HOLDERS) throw new InvalidHolderError('Too many members');
  return out;
}

