/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   ANY FILE UPLOAD, WITH THE FAILURE STILL ATTACHED                      ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Every upload screen in this product used a bare `fetch` in a `try`, and every
 * way one could fail arrived at the user as a single sentence — "Could not
 * reach DocsNX" on Power Scan, "Network error uploading document" in the
 * document manager. A rejected `fetch` carries a `TypeError` and nothing else:
 * no status, no timing, no indication of whether a single byte was ever sent.
 * So a phone that lost its radio mid-upload, a phone whose screen locked while
 * the server worked, a reverse proxy that hung up, and a genuinely offline
 * device were four different problems wearing one message. None could be told
 * apart from the report, the server logs, or the console.
 *
 * ── AND ONE OF THEM WAS NOT A NETWORK PROBLEM AT ALL ───────────────────────
 * `res.json()` was called with no `.catch()`. nginx refuses an oversized body
 * with `413` and an HTML page; `JSON.parse` throws a `SyntaxError` on it; the
 * throw lands in the very same `catch` as a dropped connection. So "your file
 * is too large" was displayed as "Network error uploading document", sending
 * people to check their wifi for a problem that had nothing to do with it. A
 * 502/504 did the same. Parsing defensively, HERE, is what stops that class of
 * lie for every caller at once.
 *
 * ── THE DISTINCTION `fetch` CANNOT EXPRESS ─────────────────────────────────
 * UPLOADING vs WAITING. `fetch` exposes no upload progress, so there is no
 * moment at which "the body finished going out" is observable.
 * `XMLHttpRequest` fires `upload.onload` at exactly that point, and that single
 * boundary answers both questions worth asking:
 *
 *   · Did the server ever start work?  Failing while UPLOADING means no — the
 *     request is safe to retry automatically, and nothing was spent or stored.
 *     Failing while WAITING means it may well have completed and been charged,
 *     so a silent retry would bill the tenant twice for one batch.
 *
 *   · What should the user be told?  "The upload stopped at 42%" and "the
 *     connection dropped while we were reading your documents" are different
 *     sentences with different next actions, and only one is ever true.
 *
 * This returns a description of what happened rather than throwing. A network
 * failure is an ordinary, expected outcome of using a phone on a train;
 * modelling it as an exception is what produced the `catch` blocks that
 * flattened four causes into one string in the first place.
 */

/**
 * The outcome shape and the failure beacon moved to `@/lib/net/outcome` when
 * the other 253 requests in the app needed them too — see that file's header.
 * Re-exported here so the six screens importing them from this path are
 * unchanged, and because `UploadOutcome` is genuinely the right name at an
 * upload call site even though the union is now general.
 */
export type { UploadStage, UploadOutcome } from '@/lib/net/outcome';

import type { UploadOutcome, UploadStage } from '@/lib/net/outcome';
import { reportClientFailure } from '@/lib/net/outcome';

export interface PostUploadOptions {
  /**
   * The verb. POST unless told otherwise.
   *
   * Every EDIT path in the product sends a multipart body with `PUT` — the
   * create paths were converted to this helper and the edits were not, so
   * replacing a document's file still reported nginx's 413 as a network error
   * on exactly the screens where the create beside it got it right.
   */
  method?: 'POST' | 'PUT' | 'PATCH';
  /** Called as the body goes out. `percent` is -1 while the total is unknown. */
  onUploadProgress?: (percent: number, sentBytes: number, totalBytes: number) => void;
  /** Called once the body is fully sent and the wait for the AI begins. */
  onUploadComplete?: () => void;
  /**
   * Deliberately longer than nginx's `proxy_read_timeout` on this vhost (300s).
   * If the proxy is going to give up first, let it — a real 504 produces a
   * specific message, where our own abort could only produce a vague one.
   */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 330_000;

/**
 * POST a scan batch and report precisely how it went.
 *
 * `XMLHttpRequest` rather than `fetch` for the upload-progress boundary
 * described above; it is the only API in the platform that exposes it. Cookies
 * ride along on a same-origin XHR exactly as they do on a same-origin `fetch`,
 * so the auth contract is unchanged.
 */
export function postUpload(
  url: string,
  formData: FormData,
  options: PostUploadOptions = {},
): Promise<UploadOutcome> {
  const {
    method = 'POST', onUploadProgress, onUploadComplete, timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;

  // Asked before anything is attempted: a device in airplane mode should be
  // told that, not told the upload failed at 0%.
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    // Returns before the promise below, so it never reaches `finish`.
    const outcome: UploadOutcome = { ok: false, kind: 'offline' };
    reportClientFailure(url, outcome, method);
    return Promise.resolve(outcome);
  }

  return new Promise<UploadOutcome>((resolve) => {
    const xhr = new XMLHttpRequest();
    const startedAt = Date.now();

    let stage: UploadStage = 'uploading';
    let sentBytes = 0;
    let totalBytes = 0;
    /**
     * Whether the page was ever backgrounded while this request was in flight.
     *
     * A locked screen or an app switch is a leading cause of exactly this
     * failure on mobile, and it is the one cause the user can do something
     * about immediately. Worth a sentence of its own in the message, so it is
     * worth a boolean here.
     */
    let wasHidden = false;

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') wasHidden = true;
    };
    document.addEventListener('visibilitychange', onVisibility);

    const finish = (outcome: UploadOutcome) => {
      document.removeEventListener('visibilitychange', onVisibility);
      // Every failure, in one place, so no branch below can forget to report.
      reportClientFailure(url, outcome, method);
      resolve(outcome);
    };

    const elapsedMs = () => Date.now() - startedAt;

    xhr.upload.onprogress = (event) => {
      sentBytes = event.loaded;
      totalBytes = event.lengthComputable ? event.total : 0;
      onUploadProgress?.(
        event.lengthComputable ? Math.round((event.loaded / event.total) * 100) : -1,
        sentBytes,
        totalBytes,
      );
    };

    // The boundary this whole module exists for.
    xhr.upload.onload = () => {
      stage = 'waiting';
      onUploadComplete?.();
    };

    xhr.onload = () => {
      // Parsed here rather than by the caller because a 502/504 from the proxy
      // is an HTML page: `JSON.parse` on it throws, and that throw used to
      // reach the user as "Unexpected token '<'".
      const body = xhr.responseText ?? '';
      let json: any = null;
      try {
        json = JSON.parse(body);
      } catch {
        json = null;
      }
      if (xhr.status >= 200 && xhr.status < 300 && json) {
        finish({ ok: true, status: xhr.status, json });
        return;
      }
      finish({ ok: false, kind: 'http', status: xhr.status, json, body });
    };

    const failedConnection = () => {
      // Re-asked at failure time, not at start time: "went offline mid-scan" is
      // the common case on a phone and deserves the clearer message.
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        finish({ ok: false, kind: 'offline' });
        return;
      }

      const network = (): UploadOutcome => ({
        ok: false, kind: 'network', stage,
        sentBytes, totalBytes, elapsedMs: elapsedMs(), wasHidden,
      });

      /**
       * ── ZERO BYTES OUT IS NOT A NETWORK FAILURE UNTIL PROVEN ──────────────
       * `onerror` before a single byte of the body went out has two causes
       * that Chrome reports identically as `status 0`: the connection failed,
       * or the browser could not READ the body it was about to send. On
       * Android the second is common — a `content://` file from Drive or
       * WhatsApp whose owning app refuses the bytes at send time — and for two
       * weeks it was described to a user as a Wi-Fi problem while her failure
       * beacons were landing on the server in the same second.
       *
       * So ask the one question that separates them: can this page reach the
       * origin RIGHT NOW? A tiny same-origin GET, four seconds, no cache. If
       * it lands, the network is fine and the body was the problem. If it does
       * not, the network really did fail and the original wording stands.
       *
       * `?nocache=1` is what the service worker keys a NetworkOnly route on
       * (src/sw.ts): `/api/auth/me` is otherwise NetworkFirst with a cache
       * fallback, and a cached answer would make an unreachable server look
       * reachable — the exact confusion this probe exists to resolve.
       */
      if (stage === 'uploading' && sentBytes === 0 && typeof fetch === 'function') {
        const elapsed = elapsedMs();
        fetch('/api/auth/me?nocache=1', {
          method: 'GET',
          cache: 'no-store',
          credentials: 'same-origin',
          signal: AbortSignal.timeout(4000),
        })
          .then(() => finish({ ok: false, kind: 'unreadable', elapsedMs: elapsed }))
          .catch(() => finish(network()));
        return;
      }

      finish(network());
    };

    xhr.onerror = failedConnection;
    // A navigation away, or the browser discarding the request under memory
    // pressure — indistinguishable from a dropped connection, and the same
    // advice applies.
    xhr.onabort = failedConnection;

    xhr.ontimeout = () => {
      finish({ ok: false, kind: 'timeout', stage, elapsedMs: elapsedMs(), wasHidden });
    };

    xhr.open(method, url);
    xhr.timeout = timeoutMs;
    // Left as text so the non-JSON proxy pages above can be inspected rather
    // than silently becoming null.
    xhr.responseType = 'text';
    // Content-Type is deliberately NOT set: the browser has to add the
    // multipart boundary itself, and setting it by hand strips that.
    xhr.send(formData);
  });
}

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  WHAT TO TELL SOMEONE WHOSE UPLOAD DID NOT COME BACK                    ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Moved to `@/lib/net/apiErrorMessage` and re-exported here unchanged.
 *
 * It lived in this file while uploads were the only requests that classified
 * their failures. Now that every request does, keeping the wording here would
 * mean an upload and a save describing one dropped connection two ways — which
 * is the exact drift this module was written to end, one layer up.
 */
export { uploadErrorMessage } from '@/lib/net/apiErrorMessage';
