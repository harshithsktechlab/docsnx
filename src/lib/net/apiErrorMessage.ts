/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   ONE SENTENCE PER FAILURE, FOR THE WHOLE PRODUCT                        ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The platform already wrote good failure messages. It just threw them away.
 *
 * `vaultErrors.ts` puts a precise, actionable sentence under BOTH `message` and
 * `error` — and left a comment explaining that `error` is duplicated precisely
 * because "every form in this app reads `json.error` and falls back to a
 * generic line". `storageLimitResponse` does the same, and says so. `dbErrors`
 * turns a constraint violation into "This mobile number is already registered".
 * `AI_ERROR_MESSAGES` classifies eleven distinct AI failures off the provider's
 * own wording. All of it existed. And then the page did:
 *
 *     } catch (err) { setError('Network error fetching medical records'); }
 *
 * — which, because `res.json()` throws on any proxy HTML page, is where a
 * carefully-worded 507 and a carefully-worded 503 both ended up.
 *
 * This is the one function that decides which of those sentences a user sees,
 * so the decision is made once instead of 253 times, and so adding a new server
 * error code does not mean revisiting every page.
 *
 * ── THE RULE THE PAGES GOT BACKWARDS ───────────────────────────────────────
 * A specific sentence from the server ALWAYS beats a generic one from the
 * client. The pages had it the other way round: `json.error || 'Failed to
 * fetch'` is right, but it was reached only when `res.json()` succeeded AND
 * the body had an `error` key AND the request had not thrown — three conditions
 * that a 502, a 413 and an offline phone all fail.
 *
 * ── WHAT MUST NEVER APPEAR IN THE RETURN VALUE ─────────────────────────────
 * `json.detail` (vault `detail` names tenant ids, category keys and Drive file
 * ids and is documented as operator-facing), any stack, and any raw provider
 * blob. Only `error`, `message`, `fieldErrors` and the enumerated codes below
 * are ever read.
 */

import { AI_ERROR_MESSAGES, aiErrorMessageFor } from '@/lib/aiErrors';
import { isOutOfSpaceBody, outOfSpaceMessage } from '@/lib/storagePressure';
import { MAX_UPLOAD_BYTES } from '@/lib/records/uploadTypes';
import type { ApiOutcome } from './outcome';

/** The vault codes, duplicated as a runtime set because the type is erased. */
const VAULT_CODES = new Set([
  'DRIVE_NOT_CONNECTED', 'DRIVE_UNAVAILABLE', 'DRIVE_QUOTA_EXCEEDED',
  'VAULT_FILE_MISSING', 'VAULT_STALE_FILE', 'VAULT_LOCKED',
  'VAULT_KEY_UNAVAILABLE', 'VAULT_DECRYPT_FAILED', 'VAULT_LOCKED_CLIENT',
]);

export interface MessageOptions {
  /**
   * What was being acted on, as a noun: 'medical record', 'document'.
   * Used where the failure is generic enough that the subject is the only thing
   * distinguishing it — "The medical record could not be saved".
   */
  subject?: string;
  /**
   * What was being done, as a gerund: 'saving', 'loading', 'deleting'.
   * Defaults to a neutral phrasing rather than guessing.
   */
  action?: string;
  /**
   * The verb, when the caller knows it.
   *
   * Only one branch reads it, and it is the branch where guessing wrong is
   * most costly: a connection that dies AFTER the request went out. For a
   * write, the server may well have finished, so the honest advice is "look
   * before you send it again". For a GET that advice is nonsense — nothing was
   * written, there is nothing to check for, and telling someone their read
   * "may have completed and been charged" is alarming and untrue.
   */
  method?: string;
}

/** Title + description, the two lines a toast wants. `description` may be ''. */
export interface ApiErrorParts {
  title: string;
  description: string;
}

const MB = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

/**
 * The full message as one string, for an inline form banner.
 *
 * Forms get one line because that is what their layout has room for; toasts get
 * the two-part split below. Same content, one source.
 */
export function apiErrorMessage(outcome: ApiOutcome, options: MessageOptions = {}): string {
  const { title, description } = apiErrorParts(outcome, options);
  return description ? `${title} ${description}` : title;
}

/**
 * The message split into what happened and what to do about it.
 *
 * Ordered most-specific first. Every branch above the last is a case where the
 * platform knows something real about the failure; the last is the only place a
 * generic sentence is allowed, and it still names the operation.
 */
export function apiErrorParts(outcome: ApiOutcome, options: MessageOptions = {}): ApiErrorParts {
  const subject = options.subject || 'request';
  const action = options.action || 'completing this';

  if (outcome.ok) return { title: '', description: '' };

  // ── Transport: the four things `fetch` cannot tell a caller apart ────────
  if (outcome.kind === 'offline') {
    return {
      title: 'You are offline.',
      description: `Reconnect and try again — nothing has been lost.`,
    };
  }

  if (outcome.kind === 'network') {
    if (outcome.stage === 'uploading') {
      const far = outcome.totalBytes
        ? ` at ${Math.round((outcome.sentBytes / outcome.totalBytes) * 100)}%`
        : '';
      const seconds = Math.max(1, Math.round(outcome.elapsedMs / 1000));
      return {
        title: `The upload stopped${far} after ${seconds}s.`,
        description: 'On a phone that is usually a switch between Wi-Fi and mobile data. '
          + 'Nothing was saved — try again.',
      };
    }
    // A safe method changes nothing, so there is nothing to check for and no
    // risk in retrying. Only the writes get the careful wording below.
    const verb = (options.method || '').toUpperCase();
    if (verb === 'GET' || verb === 'HEAD') {
      return {
        title: 'The connection dropped before the server answered.',
        description: 'Nothing was changed. Try again.',
      };
    }
    // Past the point of no return: the server may well have finished. Worded so
    // nobody assumes nothing happened and files a second copy of the same thing.
    return outcome.wasHidden
      ? {
          title: 'The connection was cut when the app went into the background.',
          description: 'A phone that locks its screen suspends the page. Keep this screen '
            + 'open, and check the list before saving the same thing again.',
        }
      : {
          title: 'The connection dropped while the server was still working.',
          description: 'Check the list before saving the same thing again, in case it finished.',
        };
  }

  if (outcome.kind === 'timeout') {
    return {
      title: `The server did not answer within ${duration(outcome.elapsedMs)}.`,
      description: outcome.stage === 'uploading'
        ? 'Try again, or with a smaller file.'
        : 'Try again in a moment. If it keeps happening, the server is under load.',
    };
  }

  /**
   * The browser could not read the file it was about to send; the server was
   * reachable in the same moment (see the probe in `postUpload`). This sentence
   * exists because the previous one blamed Wi-Fi — so it must not mention the
   * network at all, and it must name the one action that actually fixes it.
   */
  if (outcome.kind === 'unreadable') {
    return {
      title: 'Your phone would not let DocsNX read this file.',
      description: 'This happens with files opened from Google Drive, WhatsApp or “Recent”. '
        + 'Save it to your phone first (Files → Downloads, or “Make available offline” in '
        + 'Drive), then pick it from there.',
    };
  }

  // ── kind === 'http': something answered ─────────────────────────────────
  const { status, json } = outcome;

  // A deliberate client-side abort. Nothing failed; the caller superseded it.
  if (status === 0) return { title: '', description: '' };

  // 1. An AI failure, in the AI vocabulary. Checked FIRST because these bodies
  //    also carry a plain `error` — the same sentence, usually — and because
  //    the code is the only thing that distinguishes "out of credits" from
  //    "model retired", which have completely different fixes.
  const ai = aiErrorMessageFor(json);
  if (ai) return splitFirstSentence(ai);

  // 2. Out of space, either wall. Delegated so the toast and this agree.
  if (isOutOfSpaceBody(status, json)) {
    const { title, description } = outOfSpaceMessage(json);
    return { title, description };
  }

  // 3. A vault failure. The sentence is already written and already actionable;
  //    the reconnect path is the only thing worth adding.
  if (json?.status && VAULT_CODES.has(json.status)) {
    return {
      title: String(json.message || json.error || 'The vault could not be reached.'),
      description: json.reconnectUrl
        ? 'Open Settings to reconnect Google Drive.'
        : (json.retryable ? 'Try again in a moment.' : ''),
    };
  }
  // The same shape from the upload path, which uses `DRIVE_NOT_CONNECTED` at 400.
  if (json?.status === 'DRIVE_NOT_CONNECTED') {
    return {
      title: String(json.message || json.error),
      description: 'Open Settings to reconnect Google Drive.',
    };
  }

  // 4. A field-level validation failure. The form attaches these to the
  //    controls; this is what a caller with nowhere to put them shows instead.
  if (json?.fieldErrors && typeof json.fieldErrors === 'object') {
    const messages = Object.values(json.fieldErrors as Record<string, unknown>)
      .filter((v): v is string => typeof v === 'string' && v.length > 0);
    if (messages.length) {
      return {
        title: messages[0],
        description: messages.length > 1 ? `And ${messages.length - 1} more to fix.` : '',
      };
    }
  }

  // 5. The server's own sentence. THE step every page skipped when the body did
  //    not parse or the request threw. Everything below this line only runs
  //    when the server said nothing usable.
  const serverSaid = typeof json?.error === 'string' ? json.error
    : typeof json?.message === 'string' ? json.message
    : null;
  if (serverSaid) {
    // A 5xx that did name itself still deserves the reference, so support can
    // find the matching journal line from a screenshot.
    const reference = typeof json?.reference === 'string' ? json.reference : null;
    if (status >= 500 && reference) {
      return { title: serverSaid, description: `Reference ${reference}` };
    }
    if (status === 429) {
      return { title: serverSaid, description: retryAfterSentence(json) };
    }
    return splitFirstSentence(serverSaid);
  }

  // 6. Status-only. These are the bodies that never parsed — nginx's HTML error
  //    pages — plus the handful of routes that answer with no body at all.
  switch (status) {
    case 401:
      return {
        title: 'Your session has expired.',
        description: 'Sign in again, then retry — your work on this page is not lost.',
      };
    case 403:
      return {
        title: `You do not have permission to do this.`,
        description: 'Ask a tenant admin to grant access, or switch to an account that has it.',
      };
    case 404:
      return {
        title: `That ${subject} no longer exists.`,
        description: 'It may have been deleted. Refresh the list to see what is there now.',
      };
    case 409:
      return {
        title: `That ${subject} conflicts with one already saved.`,
        description: 'Refresh to see the current version before changing it again.',
      };
    case 402:
      return {
        title: 'This needs AI credits, and the balance is empty.',
        description: 'Upgrade the plan or buy a credits add-on to continue.',
      };
    case 413:
      // nginx's own wall. The picker refuses oversized files before this, so
      // reaching it means something got past — still worth the real number.
      return {
        title: 'That file is too large to upload.',
        description: `The limit is ${MB(MAX_UPLOAD_BYTES)} per file. Attach a smaller scan, or split it into parts.`,
      };
    case 429:
      return {
        title: 'Too many attempts.',
        description: retryAfterSentence(json) || 'Wait a few minutes before trying again.',
      };
    case 502:
    case 504:
      return {
        title: 'The server took too long and the connection was cut.',
        description: 'Try again, or with less data at once.',
      };
    case 503:
      return {
        title: 'The service is temporarily unavailable.',
        description: 'This is at our end. Try again in a minute.',
      };
    default:
      break;
  }

  if (status >= 500) {
    const reference = typeof json?.reference === 'string' ? json.reference : null;
    return {
      title: `Something failed at our end while ${action}.`,
      description: reference
        ? `Nothing was changed. Quote reference ${reference} to support.`
        : 'Nothing was changed. Try again, and tell support if it keeps happening.',
    };
  }

  return {
    title: `The ${subject} could not be ${pastTense(action)}.`,
    description: `The server refused it (HTTP ${status}).`,
  };
}

/**
 * Retained under its original name and signature.
 *
 * `postUpload`'s six callers import `uploadErrorMessage` from
 * `records/uploadRequest`, which now re-exports this. `subject` is the second
 * positional argument there, not an options object.
 */
export function uploadErrorMessage(outcome: ApiOutcome, subject = 'upload'): string {
  return apiErrorMessage(outcome, { subject, action: `sending this ${subject}` });
}

/** "Wait 4 minutes before trying again." from a 429 body's Retry-After. */
function retryAfterSentence(json: any): string {
  const seconds = Number(json?.retryAfter ?? json?.retryAfterSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 90) return `Wait ${Math.ceil(seconds)} seconds before trying again.`;
  return `Wait ${Math.ceil(seconds / 60)} minutes before trying again.`;
}

/**
 * Splits a server sentence into a title and the advice that follows it.
 *
 * The server messages are written as one or two sentences — "Google Drive is
 * not connected — reconnect it to view your records." — and a toast reads far
 * better with the second half in the description. Split on the FIRST terminator
 * only, and only when what follows is substantial enough to stand alone;
 * otherwise the whole thing is the title.
 */
function splitFirstSentence(message: string): ApiErrorParts {
  const trimmed = message.trim();
  // `[\s\S]` rather than `.` with the `s` flag: this project's target predates it.
  const match = trimmed.match(/^([\s\S]+?[.!?])\s+(\S[\s\S]*)$/);
  if (match && match[2].length > 12) {
    return { title: match[1], description: match[2] };
  }
  return { title: trimmed, description: '' };
}

/** 'saving' → 'saved'. Only ever applied to the gerunds this module accepts. */
function pastTense(action: string): string {
  const verb = action.split(' ')[0];
  return verb.endsWith('ing') ? `${verb.slice(0, -3)}ed` : 'completed';
}

/**
 * An elapsed time in the unit a person would use for it.
 *
 * The two transports time out an order of magnitude apart — 45s for a list
 * query, 330s for an upload — so a single unit is wrong for one of them.
 * Rounding 45 seconds to "1 minutes" was the specific bug this avoids.
 */
function duration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 90) return `${seconds} seconds`;
  return `${Math.round(seconds / 60)} minutes`;
}
