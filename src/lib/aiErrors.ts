/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE AI FAILURE VOCABULARY, ON BOTH SIDES OF THE WIRE                   ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * These three maps used to live in `aiKeyManager.ts` (codes + messages) and
 * `records/autofillRun.ts` (statuses). Both of those pull `db`, `openai` and
 * `@google/genai`, so neither can be imported from a client component — which
 * is why `src/app/documents/bulk-scan/page.js` carried its OWN copy of the
 * message map. That copy covered eight of the eleven codes, so a retired model
 * (`MODEL_NOT_FOUND`), an exhausted credit balance (`INSUFFICIENT_CREDITS`) and
 * anything unclassified fell through to `json.error` — and the fifteen record
 * pages, which had no map at all, reported every one of them as
 *
 *     alert('AI could not detect structured values. Try filling manually.')
 *
 * i.e. "the model read your document and found nothing", for a tenant who had
 * simply run out of credits. Nothing about that sentence is true and nothing in
 * it leads to the fix.
 *
 * A leaf module — no `db`, no provider SDK, no `next/server` — so the page and
 * the route can hold the same sentence rather than two that drift.
 *
 * ── WHY THE WORDING CHANGED IN THE MOVE ────────────────────────────────────
 * Two of these messages described work that had ALREADY been tried by the time
 * anyone read them. `getErrorMessage` is called from exactly one place
 * (`executeWithRotation`'s final throw, aiKeyManager.ts) and `ai.js` reads the
 * map only in a `catch` — so every one of these strings is TERMINAL. Promising
 * "Switching to next available key..." to someone whose scan has just failed
 * describes a retry that is already over, and leaves them waiting for a result
 * that is never coming instead of adding a key. They now say what is true at
 * the moment they are shown.
 */

// ─── Error Codes ──────────────────────────────────────────────────────────────

export const AI_ERROR_CODES = {
  QUOTA_EXHAUSTED:     'QUOTA_EXHAUSTED',
  RATE_LIMITED:        'RATE_LIMITED',
  INVALID_KEY:         'INVALID_KEY',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  MODEL_OVERLOADED:    'MODEL_OVERLOADED',
  MODEL_NOT_FOUND:     'MODEL_NOT_FOUND',
  NETWORK_ERROR:       'NETWORK_ERROR',
  ALL_KEYS_EXHAUSTED:  'ALL_KEYS_EXHAUSTED',
  NO_KEYS_CONFIGURED:  'NO_KEYS_CONFIGURED',
  INSUFFICIENT_CREDITS: 'INSUFFICIENT_CREDITS',
  UNKNOWN:             'UNKNOWN',
};

export type AiErrorCode = keyof typeof AI_ERROR_CODES;

export const AI_ERROR_MESSAGES: Record<string, string> = {
  // Terminal, not in-progress: rotation has already been round every key by the
  // time this is read. See the note above.
  QUOTA_EXHAUSTED:     '⚠️ The AI key ran out of quota, and the automatic switch to the other keys did not find a working one. Add another key in AI Settings, or try again tomorrow.',
  RATE_LIMITED:        '🚦 The AI service is rate-limiting us and every key was refused. Wait a few minutes and try again.',
  INVALID_KEY:         '🔑 Invalid or expired API key. Please update your API keys in AI Settings.',
  // Both are provider-side and both are already retried with backoff before the
  // message is built, so they promise a wait rather than an action.
  SERVICE_UNAVAILABLE: '🔧 The AI provider is unavailable right now. We already retried automatically — please try again in a minute.',
  MODEL_OVERLOADED:    '🤖 The AI model is under heavy load right now. We already retried automatically — please try again in a minute.',
  // Names the fix, because the fix is a config change an admin can make: the
  // provider retired the model id stored on the key or the tenant.
  MODEL_NOT_FOUND:     '🧩 The configured AI model is no longer available from the provider. Update the model in AI Settings.',
  NETWORK_ERROR:       '📡 DocsNX could not reach the AI provider. This is a problem at our end, not with your connection — please try again in a minute.',
  ALL_KEYS_EXHAUSTED:  '⚠️ All AI API keys have reached their daily quota. Please add more keys in AI Settings or try again tomorrow.',
  NO_KEYS_CONFIGURED:  '🔧 No AI API keys are configured. Please add at least one key in AI Settings (Super Admin).',
  INSUFFICIENT_CREDITS: '💳 Insufficient AI Credits. Please upgrade your plan or purchase an add-on to continue using this feature.',
  UNKNOWN:             '❌ An unexpected AI processing error occurred. Please try again.',
};

/**
 * HTTP status for each way an AI call can fail. Mirrors /api/ai/scan.
 *
 * Read by the two autofill routes and by `/api/ai/scan`. Anything absent is a
 * 500 — deliberately, because an unclassified AI failure IS a fault at our end
 * and should be logged as one.
 */
export const AI_STATUS: Record<string, number> = {
  [AI_ERROR_CODES.QUOTA_EXHAUSTED]: 503,
  [AI_ERROR_CODES.ALL_KEYS_EXHAUSTED]: 503,
  [AI_ERROR_CODES.RATE_LIMITED]: 429,
  [AI_ERROR_CODES.INVALID_KEY]: 500,
  [AI_ERROR_CODES.SERVICE_UNAVAILABLE]: 503,
  [AI_ERROR_CODES.MODEL_OVERLOADED]: 503,
  [AI_ERROR_CODES.MODEL_NOT_FOUND]: 500,
  [AI_ERROR_CODES.NETWORK_ERROR]: 503,
  [AI_ERROR_CODES.NO_KEYS_CONFIGURED]: 500,
  [AI_ERROR_CODES.INSUFFICIENT_CREDITS]: 402,
};

/**
 * The sentence for a code, or null when the body is not an AI failure at all.
 *
 * Null rather than the UNKNOWN string on purpose: `apiErrorMessage` has to be
 * able to tell "this is an AI failure we have no wording for" from "this is not
 * an AI failure", and only the first should be answered with the AI fallback.
 * Handed a whole response body so a caller never has to remember which key the
 * code arrives under.
 */
export function aiErrorMessageFor(body: any): string | null {
  const code = body?.errorCode;
  if (typeof code !== 'string' || !code) return null;
  if (!(code in AI_ERROR_CODES)) return null;
  return AI_ERROR_MESSAGES[code] || AI_ERROR_MESSAGES.UNKNOWN;
}
