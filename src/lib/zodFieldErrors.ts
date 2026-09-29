/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   A ZOD REJECTION, KEYED BY THE FIELD THAT CAUSED IT                     ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `fieldErrors` is the shape the whole product already speaks: a route answers
 * `400 { error, fieldErrors }`, the form drops each message onto the input it
 * names, and `apiErrorMessage` (src/lib/net/apiErrorMessage.ts) knows what to
 * show when the caller has nowhere to put them. It is documented in
 * src/lib/records/fieldValidation.ts, where the record forms use it.
 *
 * What routes did instead was `parsed.error.issues[0].message` — one sentence,
 * no field, and in zod 4 that sentence can be raw machine wording: a `null`
 * posted for an optional string produces "Invalid input: expected string,
 * received null", which is exactly what a person signing up for a personal
 * account was shown. The message needs somewhere to land as much as it needs
 * to be readable.
 *
 * ── FIRST ISSUE PER FIELD WINS ─────────────────────────────────────────────
 * Zod reports every failing rule. A form shows one message per input, and the
 * first is the one to show: zod evaluates a chain in the order it was written,
 * so it is the most fundamental complaint about the value ("Name is too short"
 * before "must be at most 255 characters"), not an arbitrary pick.
 */
import type { ZodError } from 'zod';

/**
 * Issues that belong to no single field — the object-level `.refine()` calls
 * that judge a COMBINATION of values and were given no `path`. There is no
 * input to attach them to, so a form renders these as its banner.
 */
export const FORM_LEVEL_KEY = '_form';

/** `field → message`. Empty object means the error carried nothing usable. */
export function zodFieldErrors(error: ZodError): Record<string, string> {
  const fieldErrors: Record<string, string> = {};

  for (const issue of error.issues) {
    // `path[0]` rather than the whole path: these are flat payloads, and a
    // nested key joined with dots would match no input on any form.
    const key = issue.path.length > 0 ? String(issue.path[0]) : FORM_LEVEL_KEY;
    if (!issue.message) continue;
    if (fieldErrors[key]) continue;
    fieldErrors[key] = issue.message;
  }

  return fieldErrors;
}

/**
 * The sentence to put in `error` alongside them.
 *
 * Prefers a real message over the generic line, because a single-field failure
 * reads better as its own complaint than as "correct the highlighted fields" —
 * and a caller with no field UI at all (curl, the PWA's older bundle) then still
 * learns what was wrong.
 */
export function firstFieldError(
  fieldErrors: Record<string, string>,
  fallback = 'Please correct the highlighted fields',
): string {
  const messages = Object.values(fieldErrors).filter(Boolean);
  return messages.length === 1 ? messages[0] : fallback;
}
