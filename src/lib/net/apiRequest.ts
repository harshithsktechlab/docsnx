'use client';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   EVERY OTHER REQUEST IN THE PRODUCT                                     ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `postUpload` (src/lib/records/uploadRequest.ts) fixed this for the six
 * screens that send files. This is the same contract for the other 253 calls —
 * the lists, the reads, the deletes, the JSON saves, the admin screens — which
 * were still each doing:
 *
 *     try {
 *       const res = await fetch('/api/medical');
 *       const json = await res.json();          // throws on any HTML page
 *       if (json.success) …
 *       else setError(json.error || 'Failed to fetch medical records');
 *     } catch (err) {
 *       setError('Network error fetching medical records');
 *     }
 *
 * Three separate faults in five lines, repeated 253 times:
 *
 *   1. `res.json()` with no catch. A 502 from nginx is an HTML page;
 *      `JSON.parse` throws a SyntaxError on it, and the SyntaxError lands in
 *      the `catch` labelled "Network error". The server being down was
 *      therefore reported as the user's connection being down.
 *   2. `res.ok` is never consulted. A 500 that DID return JSON takes the `else`
 *      branch and shows `json.error` — which is fine — but a 401 on a tab left
 *      open overnight shows "Failed to fetch medical records", when the true
 *      answer is "sign in again".
 *   3. Airplane mode, a dropped connection and a request that hung forever are
 *      all one sentence, and it is the wrong one for at least two of them.
 *
 * ── WHY `fetch` HERE AND `XMLHttpRequest` THERE ────────────────────────────
 * `postUpload` needs `upload.onload` — the moment the body finishes going out —
 * and XHR is the only API that exposes it. That boundary is what separates "the
 * server never started, retry freely" from "this may have completed, look
 * first". A request with no body, or a small JSON one, has no meaningful
 * uploading phase to distinguish, so `fetch` is the simpler correct choice and
 * `stage` is always 'waiting'.
 *
 * Never throws. A `catch` around a call to this therefore means a bug in the
 * calling handler, which is worth knowing and worth logging as such.
 */

import type { ApiOutcome } from './outcome';
import { reportClientFailure } from './outcome';
import { apiErrorMessage, type MessageOptions } from './apiErrorMessage';

export type { ApiOutcome } from './outcome';

/**
 * Long enough that a slow-but-working request is not killed, short enough that
 * a hung one does not leave a spinner up forever.
 *
 * Deliberately BELOW nginx's `proxy_read_timeout` (300s on this vhost) rather
 * than above it, which is the opposite of `postUpload`'s choice. The reasoning
 * differs because the requests do: an upload that trips 300s is genuinely still
 * working and a real 504 says something specific about it, whereas a list query
 * that has not answered in 45 seconds is not going to. Waiting five minutes to
 * tell someone their document list did not load is not patience, it is a
 * frozen screen.
 */
const DEFAULT_TIMEOUT_MS = 45_000;

export interface ApiRequestOptions extends RequestInit {
  /** Overrides the 45s default. Raise it for a route known to be slow. */
  timeoutMs?: number;
}

/**
 * Send a request and describe precisely how it went.
 *
 * @param url    a same-origin path, e.g. `/api/medical`
 * @param init   the usual `fetch` init, plus `timeoutMs`
 */
export async function apiRequest<T = any>(
  url: string,
  init: ApiRequestOptions = {},
): Promise<ApiOutcome<T>> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...rest } = init;
  const method = (rest.method || 'GET').toUpperCase();

  // Asked before anything is attempted: a device in airplane mode should be
  // told that, not told the server did not answer.
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    const outcome: ApiOutcome<T> = { ok: false, kind: 'offline' };
    reportClientFailure(url, outcome, method);
    return outcome;
  }

  const startedAt = Date.now();
  /**
   * Whether the page was ever backgrounded while this request was in flight.
   *
   * A locked screen or an app switch is a leading cause of exactly this failure
   * on mobile, and it is the one cause the user can act on immediately.
   */
  let wasHidden = false;
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') wasHidden = true;
  };
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility);
  }

  const controller = new AbortController();
  /** Distinguishes OUR abort from the caller's, which must not read as a timeout. */
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  // A caller that passed its own signal (a search box cancelling the previous
  // keystroke, say) keeps it: aborting either one aborts the request.
  const callerSignal = rest.signal;
  const onCallerAbort = () => controller.abort();
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener('abort', onCallerAbort);
  }

  const cleanup = () => {
    clearTimeout(timer);
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibility);
    }
    callerSignal?.removeEventListener('abort', onCallerAbort);
  };

  const finish = (outcome: ApiOutcome<T>): ApiOutcome<T> => {
    cleanup();
    // Every failure, in one place, so no branch below can forget to report.
    reportClientFailure(url, outcome, method);
    return outcome;
  };

  const elapsedMs = () => Date.now() - startedAt;

  try {
    const res = await fetch(url, { ...rest, signal: controller.signal });

    // Read as TEXT and parsed here rather than by the caller, because a 502/504
    // from the proxy is an HTML page: `JSON.parse` on it throws, and that throw
    // used to reach the user as a network error — or, worse, as the literal
    // string "Unexpected token '<'".
    const body = await res.text().catch(() => '');
    let json: any = null;
    try {
      json = body ? JSON.parse(body) : null;
    } catch {
      json = null;
    }

    if (res.ok && json !== null) {
      return finish({ ok: true, status: res.status, json: json as T });
    }
    // A 204, or a 200 with an empty body, is a success with nothing to say.
    if (res.ok && body === '') {
      return finish({ ok: true, status: res.status, json: null as T });
    }
    return finish({ ok: false, kind: 'http', status: res.status, json, body });
  } catch (error: any) {
    if (timedOut) {
      return finish({ ok: false, kind: 'timeout', stage: 'waiting', elapsedMs: elapsedMs(), wasHidden });
    }
    // The caller cancelled this deliberately — a superseded search, an unmounted
    // component. Not a failure, and reporting it would be noise; the caller
    // reads `ok === false` and does nothing, which is what it wants.
    if (error?.name === 'AbortError') {
      cleanup();
      return { ok: false, kind: 'http', status: 0, json: null, body: '' };
    }
    // Re-asked at failure time, not at start time: "went offline mid-request"
    // is the common case on a phone and deserves the clearer message.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return finish({ ok: false, kind: 'offline' });
    }
    return finish({
      ok: false, kind: 'network', stage: 'waiting',
      sentBytes: 0, totalBytes: 0, elapsedMs: elapsedMs(), wasHidden,
    });
  }
}

/**
 * `apiRequest` for a JSON body, so no call site has to remember the header.
 *
 * The missing `Content-Type` was a real bug class here, not a convenience:
 * a route reading `await req.json()` on a body sent without it still works in
 * Next, but the same body reaching a zod `.strict()` schema through a proxy
 * that rewrites it does not — and the resulting 400 said "Invalid input" with
 * no clue which field.
 */
export function apiJson<T = any>(
  url: string,
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  body?: unknown,
  init: ApiRequestOptions = {},
): Promise<ApiOutcome<T>> {
  return apiRequest<T>(url, {
    ...init,
    method,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE DROP-IN FOR THE 208 CALL SITES THAT ALL LOOK THE SAME              ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Two hundred and eight of the remaining `fetch` calls in this app are these
 * exact two lines, followed by branches on `res.ok`, `res.status` and
 * `json.success`:
 *
 *     const res = await fetch(url, init);
 *     const json = await res.json();
 *
 * Those branches are mostly RIGHT. `if (res.status === 409 && json.requiresConfirmation)`
 * is the duplicate prompt; `json.error || 'Update failed'` is the correct
 * precedence. What is wrong is narrower than it looks: when the transport fails
 * or the body is a proxy HTML page, neither `res` nor `json` ever exists, so
 * every one of those correct branches is skipped and control lands in a `catch`
 * that knows nothing.
 *
 * So this hands back the same two values, always defined — and when there is no
 * real body, a synthesised one carrying the honest sentence under `error`, the
 * key every one of those call sites already reads. Rewriting the branches was
 * the alternative, and rewriting 208 pieces of working conditional logic to fix
 * the path around them would have been the riskier change by a wide margin.
 *
 * ── WHAT A CALLER STILL HAS TO DECIDE ──────────────────────────────────────
 * Where the message goes. A form banner takes `json.error` as-is; a toast reads
 * better split in two, so a caller with somewhere to put a description should
 * pass `outcome` to `toastApiError` instead of toasting `json.error`.
 */
export interface ApiCallResult<T = any> {
  /** `ok` and `status` only — the two members call sites actually branch on. */
  res: { ok: boolean; status: number };
  /** The parsed body, or a synthesised `{ success: false, error }` for a failure. */
  json: any;
  /** The full outcome, for a caller that wants the two-part toast. */
  outcome: ApiOutcome<T>;
}

export async function apiCall<T = any>(
  url: string,
  init: ApiRequestOptions = {},
  options: MessageOptions = {},
): Promise<ApiCallResult<T>> {
  const outcome = await apiRequest<T>(url, init);
  const described = { method: init.method || 'GET', ...describeRequest(url, init.method), ...options };

  if (outcome.ok) {
    return { res: { ok: true, status: outcome.status }, json: outcome.json ?? {}, outcome };
  }

  const status = outcome.kind === 'http' ? outcome.status : 0;
  // A body that parsed is the route's own answer and belongs to the caller
  // untouched — its `fieldErrors`, its `requiresConfirmation`, its
  // `reconnectUrl`. Only its `error` is topped up, and only if it has none.
  if (outcome.kind === 'http' && outcome.json) {
    const json = outcome.json;
    if (typeof json.error !== 'string' || !json.error) {
      json.error = apiErrorMessage(outcome, described);
    }
    return { res: { ok: false, status }, json, outcome };
  }

  return {
    res: { ok: false, status },
    // `success: false` because that is the flag half these call sites branch on
    // before they ever look at `res.ok`.
    json: { success: false, error: apiErrorMessage(outcome, described) },
    outcome,
  };
}

/**
 * A subject and an action inferred from the request itself.
 *
 * Every call site could name its own — and the ones that read best do — but
 * requiring it would have meant inventing 208 phrases by hand as part of a
 * mechanical change, which is how a phrase ends up wrong. The URL and the verb
 * already carry the answer for the generic fallback, and the messages that
 * matter most (out of space, out of credits, session expired, file too large,
 * retired model) never consult either.
 *
 * `/api/bank-info` → "bank info"; `/api/modules/insurance/lic/:id` → "lic".
 * Id-looking and version-looking segments are skipped, because "loading 3f2a…"
 * is worse than the generic word it replaced.
 */
function describeRequest(url: string, method?: string): MessageOptions {
  const verb = (method || 'GET').toUpperCase();
  const action = verb === 'DELETE' ? 'deleting'
    : verb === 'GET' ? 'loading'
    : 'saving';

  const segments = url.split('?')[0].split('/').filter(Boolean);
  const meaningful = segments.filter(
    (seg) => seg !== 'api' && !/^[0-9a-f-]{8,}$/i.test(seg) && !/^\d+$/.test(seg),
  );
  const last = meaningful[meaningful.length - 1] || 'request';
  const subject = last.replace(/[-_]/g, ' ');

  return { subject, action: `${action} ${subject}` };
}

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   A DOWNLOAD, WHICH CANNOT BE READ AS TEXT                               ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `apiRequest` reads every body once, as text, so that a proxy's HTML error
 * page cannot throw. That is exactly wrong for a zip, a PDF or a backup
 * archive: the caller needs the `Response` itself, for `.blob()` and for the
 * `Content-Disposition` filename.
 *
 * So this classifies the failure the same way and hands back the untouched
 * `Response` on success. What it replaces:
 *
 *     const response = await fetch('/api/backup');
 *     if (!response.ok) throw new Error('Export failed');
 *
 * — where "Export failed" was the entire diagnosis for an expired session, a
 * tenant with no Drive grant, a 500, and a 504 on an export big enough to
 * outlast the proxy's patience. The throw was then caught and shown as itself,
 * so the user's only information was that something called an export did not
 * work.
 *
 * The failure branch still reads the body as text, because a failure body is
 * JSON or an HTML page — never the file.
 */
export type DownloadOutcome =
  | { ok: true; response: Response }
  | (ApiOutcome & { ok: false });

export async function apiDownload(
  url: string,
  init: ApiRequestOptions = {},
  options: MessageOptions = {},
): Promise<DownloadOutcome> {
  const { timeoutMs = 120_000, ...rest } = init;
  const method = (rest.method || 'GET').toUpperCase();

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    const outcome: ApiOutcome = { ok: false, kind: 'offline' };
    reportClientFailure(url, outcome, method);
    return outcome as DownloadOutcome;
  }

  const startedAt = Date.now();
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);

  try {
    const res = await fetch(url, { ...rest, signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) return { ok: true, response: res };

    // Not the file, so reading it is safe and is the only way to reach the
    // route's own sentence.
    const body = await res.text().catch(() => '');
    let json: any = null;
    try { json = body ? JSON.parse(body) : null; } catch { json = null; }
    if (json && typeof json.error !== 'string') {
      json.error = apiErrorMessage(
        { ok: false, kind: 'http', status: res.status, json, body },
        { ...describeRequest(url, method), ...options },
      );
    }
    const outcome: ApiOutcome = { ok: false, kind: 'http', status: res.status, json, body };
    reportClientFailure(url, outcome, method);
    return outcome as DownloadOutcome;
  } catch (error: any) {
    clearTimeout(timer);
    const elapsedMs = Date.now() - startedAt;
    if (timedOut) {
      const outcome: ApiOutcome = { ok: false, kind: 'timeout', stage: 'waiting', elapsedMs, wasHidden: false };
      reportClientFailure(url, outcome, method);
      return outcome as DownloadOutcome;
    }
    if (error?.name === 'AbortError') {
      return { ok: false, kind: 'http', status: 0, json: null, body: '' } as DownloadOutcome;
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      const outcome: ApiOutcome = { ok: false, kind: 'offline' };
      reportClientFailure(url, outcome, method);
      return outcome as DownloadOutcome;
    }
    const outcome: ApiOutcome = {
      ok: false, kind: 'network', stage: 'waiting',
      sentBytes: 0, totalBytes: 0, elapsedMs, wasHidden: false,
    };
    reportClientFailure(url, outcome, method);
    return outcome as DownloadOutcome;
  }
}
