/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   WORK THAT BELONGS BEHIND THE RESPONSE, NOT IN FRONT OF IT              ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * A document delete commits its tombstone in milliseconds and then purges the
 * record from Google Drive — a store rewrite plus one delete per file, one
 * document at a time. That purge used to be awaited before the route answered:
 * a bulk delete of two documents answered twelve seconds after the rows were
 * already gone (2026-09-24), and the Document Manager, which only drops the
 * rows when the answer lands, sat unchanged until the user refreshed.
 *
 * The purge is cleanup the user never waits on — it never throws, and its only
 * failure mode is an orphaned ciphertext object (see documentPurge.ts) — so it
 * runs after the response instead, via Next's `after()`.
 *
 * `after()` throws outside a request scope (a test calling a handler directly,
 * a script). There the task is simply started and not awaited: its synchronous
 * prefix still runs now, so a mocked purge is still observed as called.
 *
 * Kept out of documentPurge.ts on purpose: several suites mock that module
 * exhaustively, and a new export there would vanish from every one of them.
 */
import { after } from 'next/server';

export function runAfterResponse(label: string, task: () => Promise<unknown>): void {
  // The executor calls the task synchronously but turns a sync throw — or a
  // task that returns no promise — into something `.catch` can hold.
  const run = () => new Promise((resolve) => resolve(task())).catch((error) => {
    console.error(`[after-response] ${label} failed:`, error);
  });
  try {
    after(run);
  } catch {
    void run();
  }
}
