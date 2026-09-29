/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   WHAT HAPPENED TO A REQUEST — ONE SHAPE, FOR EVERY REQUEST              ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * These types and the beacon below were written for file uploads
 * (src/lib/records/uploadRequest.ts) and applied to six screens. The other
 * fifty-five hold 253 bare `fetch` calls in `try` blocks, and every one of them
 * ends the same way:
 *
 *     } catch (err) { setError('Network error fetching medical records'); }
 *
 * That `catch` fires for a device in airplane mode, a connection that dropped
 * mid-flight, a request we abandoned, a 502 whose HTML page made `res.json()`
 * throw a SyntaxError, and a genuine bug in the handler above it. Five causes,
 * five different next actions, one sentence — and the one it picks is wrong
 * more often than it is right, because a user whose wifi is fine goes and
 * checks their wifi.
 *
 * So the distinction moves down here, where every caller gets it, rather than
 * being re-derived (or not) fifty-five times.
 *
 * ── A FAILURE IS A VALUE, NOT AN EXCEPTION ─────────────────────────────────
 * Losing signal on a train is an ordinary outcome of using a phone, not an
 * exceptional one. Modelling it as a throw is what produced the catch blocks
 * that flattened five causes into one string in the first place: a `catch` can
 * only ever see "something went wrong", so that is all it can say.
 */

/**
 * Whether the request body had finished going out when it failed.
 *
 * Only observable over `XMLHttpRequest` (`upload.onload`), so only `postUpload`
 * sets it. It is the difference between "nothing reached the server, retry
 * freely" and "this may have completed and been charged, look before retrying".
 */
export type RequestStage = 'uploading' | 'waiting';

/** Retained under its original name; `postUpload`'s callers still use it. */
export type UploadStage = RequestStage;

export type ApiOutcome<T = any> =
  /** 2xx with a body that parsed. The only success. */
  | { ok: true; status: number; json: T }
  /** The device knows it has no connection. Nothing was attempted. */
  | { ok: false; kind: 'offline' }
  /**
   * The connection died. The browser reports `status === 0` and nothing else —
   * the rest of these fields are what make that actionable.
   */
  | {
      ok: false; kind: 'network'; stage: RequestStage;
      sentBytes: number; totalBytes: number; elapsedMs: number; wasHidden: boolean;
    }
  /** We gave up waiting. */
  | { ok: false; kind: 'timeout'; stage: RequestStage; elapsedMs: number; wasHidden: boolean }
  /**
   * The browser could not READ the request body — the network was fine.
   *
   * Only `postUpload` produces this, and only after proving it: `onerror` fired
   * before a single byte went out, AND a probe to the same origin succeeded in
   * the same moment. That combination has exactly one cause on Android — a
   * `content://` file (Drive, WhatsApp, "Recent") whose owning app refused to
   * hand over the bytes at send time, which Chrome reports as a bare network
   * failure (`ERR_UPLOAD_FILE_CHANGED`). For two weeks a user was told to check
   * her Wi-Fi about it while her beacons were landing on the server.
   *
   * `snapshotFile` at pick time is the fix; this is what keeps the message
   * truthful for anything that still gets past it.
   */
  | { ok: false; kind: 'unreadable'; elapsedMs: number }
  /**
   * The server (or something between) answered, and it was not a 2xx — OR it
   * was a 2xx whose body did not parse.
   *
   * `json` is null exactly when the body was not JSON, which is the signature
   * of a reverse-proxy error page: nginx answers an oversized body with a 413
   * HTML page and a gateway timeout with a 504 one. Both used to reach the user
   * as "Network error", because `res.json()` threw and the throw landed in the
   * same catch as a dropped connection. Parsing defensively HERE is what stops
   * that class of lie for every caller at once.
   */
  | { ok: false; kind: 'http'; status: number; json: any | null; body: string };

/** The upload-flavoured alias the existing six callers import. */
export type UploadOutcome = ApiOutcome;

/** True when the failure is worth an automatic retry without asking the user. */
export function isRetryable(outcome: ApiOutcome): boolean {
  if (outcome.ok) return false;
  if (outcome.kind === 'offline') return false;
  // Only safe before the body finished going out: past that point the server
  // may have completed the work, and a silent retry would repeat it.
  if (outcome.kind === 'network' || outcome.kind === 'timeout') {
    return outcome.stage === 'uploading';
  }
  // The body could not be read. Sending it again reads the same body.
  if (outcome.kind === 'unreadable') return false;
  return outcome.status === 502 || outcome.status === 503 || outcome.status === 504;
}

/**
 * Tell the server what the user is about to be told.
 *
 * A failure that never reaches nginx leaves no trace anywhere on the host, so
 * the only record of it used to be a user's paraphrase of a toast. One line in
 * the journal turns the next report into a grep. See
 * src/app/api/client-errors/route.ts for what it will and will not accept —
 * notably that there is no free-text field, so nothing here can carry a
 * filename, a form value or a member's data into a plaintext log.
 *
 * Fire-and-forget in every sense: `keepalive` so it survives the page being
 * navigated away from mid-failure, and every error swallowed. This runs on a
 * screen that is already showing the user something has gone wrong; it must
 * never be able to add a second problem to it.
 *
 * ── WHAT IS DELIBERATELY NOT REPORTED ──────────────────────────────────────
 * 4xx answers other than 408/429. A 401 on a stale tab, a 403 from the
 * permission matrix and a 404 on a deleted record are all the system working
 * correctly, and reporting them would bury the transport failures this exists
 * to surface under a hundred times their volume — on a host whose root disk
 * runs close to full.
 */
export function reportClientFailure(
  route: string,
  outcome: ApiOutcome,
  method?: string,
): void {
  if (outcome.ok) return;
  if (outcome.kind === 'http') {
    const s = outcome.status;
    const worthReporting = s === 0 || s === 408 || s === 429 || s >= 500;
    if (!worthReporting) return;
  }
  try {
    const body: Record<string, unknown> = { route: normalizeRoute(route), cause: outcome.kind };
    if (method && method !== 'GET') body.method = method;
    if (outcome.kind === 'network' || outcome.kind === 'timeout') {
      body.stage = outcome.stage;
      body.elapsedMs = outcome.elapsedMs;
      body.wasHidden = outcome.wasHidden;
    }
    if (outcome.kind === 'network') {
      body.sentBytes = outcome.sentBytes;
      body.totalBytes = outcome.totalBytes;
    }
    if (outcome.kind === 'unreadable') body.elapsedMs = outcome.elapsedMs;
    if (outcome.kind === 'http') body.status = outcome.status;

    void fetch('/api/client-errors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* Reporting a failure must never become one. */
  }
}

/**
 * The endpoint shape, with the identifiers and the query string removed.
 *
 * `/api/medical/8f3c…-…` and `/api/medical/1a2b…-…` are the same route failing
 * twice, and the point of the journal line is to be aggregatable. A uuid in it
 * also makes the log line a record identifier, which is exactly the kind of
 * thing this endpoint refuses to accept — so it is stripped before it is sent,
 * not only where it is logged.
 */
function normalizeRoute(route: string): string {
  return route
    .split('?')[0]
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:id')
    .replace(/\/\d+(?=\/|$)/g, '/:n')
    .slice(0, 120);
}
