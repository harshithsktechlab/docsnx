'use client';

/**
 * The client half of "your credits for this workspace ran out — use the other
 * pool?".
 *
 * An AI request whose workspace pool cannot pay, while the OTHER pool could,
 * comes back as HTTP 402 `CREDIT_POOL_EMPTY` (see `choosePool` in
 * src/lib/aiKeyManager.ts). Nothing has been spent. `apiRequest` and
 * `postUpload` — the two helpers every screen's requests go through — call
 * `retryAfterBorrow` on that answer: it asks the member through one global
 * dialog, records the consent (POST /api/billing/credits/borrow) and replays the
 * SAME request once. Declining, or a failed consent, hands the original failure
 * back untouched, so a caller sees exactly what it saw before this existed.
 *
 * One place, so the roughly fifteen screens that can start an AI action need no
 * code of their own.
 */

export type BorrowPool = 'personal' | 'business';

export interface BorrowOffer {
  /** The pool that would be spent. */
  from: BorrowPool;
  /** What this call costs, if the server said. */
  required?: number;
  /** What that pool holds. */
  otherBalance?: number;
}

type Prompt = (offer: BorrowOffer, answer: (yes: boolean) => void) => void;

let prompt: Prompt | null = null;
let pending: { from: BorrowPool; promise: Promise<boolean> } | null = null;

/** Called by the mounted dialog. Returns the unregister function. */
export function registerBorrowPrompt(fn: Prompt): () => void {
  prompt = fn;
  return () => { if (prompt === fn) prompt = null; };
}

/**
 * Asks once. Requests that fail together — a Power Scan fires several — share
 * one question instead of stacking dialogs, and all follow the answer.
 */
export function askToBorrow(offer: BorrowOffer): Promise<boolean> {
  if (!prompt) return Promise.resolve(false);
  if (pending && pending.from === offer.from) return pending.promise;

  const show = prompt;
  const promise = new Promise<boolean>((resolve) => {
    show(offer, (yes) => { pending = null; resolve(yes); });
  });
  pending = { from: offer.from, promise };
  return promise;
}

/** Whether a response body is the "other pool could pay" answer. */
export function offerFrom(body: any): BorrowOffer | null {
  if (!body || body.errorCode !== 'CREDIT_POOL_EMPTY') return null;
  if (body.borrowFrom !== 'personal' && body.borrowFrom !== 'business') return null;
  return {
    from: body.borrowFrom,
    required: typeof body.required === 'number' ? body.required : undefined,
    otherBalance: typeof body.otherBalance === 'number' ? body.otherBalance : undefined,
  };
}

/** Records the member's consent. Plain `fetch`: going through `apiRequest` would recurse. */
async function recordConsent(from: BorrowPool): Promise<boolean> {
  try {
    const res = await fetch('/api/billing/credits/borrow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * If `body` is a CREDIT_POOL_EMPTY answer: ask, record the consent and run
 * `retry` once. Returns the retried result, or `null` when the member declined
 * (or the consent could not be recorded), in which case the caller keeps the
 * failure it already has.
 */
export async function retryAfterBorrow<T>(body: any, retry: () => Promise<T>): Promise<T | null> {
  const offer = offerFrom(body);
  if (!offer) return null;
  if (!(await askToBorrow(offer))) return null;
  if (!(await recordConsent(offer.from))) return null;
  return retry();
}
