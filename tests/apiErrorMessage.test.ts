/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE MESSAGES THE APP USED TO THROW AWAY                                ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Every case here is one a page previously reported as "Network error <verb>ing
 * X" or `alert('Failed to delete')`. The assertions are deliberately about the
 * CONTENT of the sentence — that it names the real cause and the real fix —
 * because a test that only checks a string is non-empty would have passed
 * against the code this replaces.
 */
import { describe, it, expect } from 'vitest';
import { apiErrorMessage, apiErrorParts, uploadErrorMessage } from '@/lib/net/apiErrorMessage';
import { AI_ERROR_CODES } from '@/lib/aiErrors';
import { MAX_UPLOAD_BYTES } from '@/lib/records/uploadTypes';
import type { ApiOutcome } from '@/lib/net/outcome';

const http = (status: number, json: any = null, body = ''): ApiOutcome =>
  ({ ok: false, kind: 'http', status, json, body });

// ───────────────────────────────────────────────────────────────────────────
describe('transport failures are told apart', () => {
  it('says offline when the device knows it is offline', () => {
    const { title } = apiErrorParts({ ok: false, kind: 'offline' });
    expect(title).toMatch(/offline/i);
    // The reassurance matters: people re-submit forms after a failure.
    expect(apiErrorMessage({ ok: false, kind: 'offline' })).toMatch(/nothing has been lost/i);
  });

  it('names how far an upload got, and that nothing was saved', () => {
    const msg = apiErrorMessage({
      ok: false, kind: 'network', stage: 'uploading',
      sentBytes: 42, totalBytes: 100, elapsedMs: 9_000, wasHidden: false,
    });
    expect(msg).toContain('42%');
    expect(msg).toContain('9s');
    expect(msg).toMatch(/nothing was saved/i);
  });

  it('warns that a failure PAST the upload may already have completed', () => {
    const msg = apiErrorMessage({
      ok: false, kind: 'network', stage: 'waiting',
      sentBytes: 100, totalBytes: 100, elapsedMs: 30_000, wasHidden: false,
    });
    // The distinction the whole stage flag exists for: do not tell someone to
    // just retry when the server may have finished and charged for it.
    expect(msg).toMatch(/check the list/i);
    expect(msg).not.toMatch(/nothing was saved/i);
  });

  it('blames the locked screen when the page was backgrounded', () => {
    const msg = apiErrorMessage({
      ok: false, kind: 'network', stage: 'waiting',
      sentBytes: 1, totalBytes: 1, elapsedMs: 1_000, wasHidden: true,
    });
    expect(msg).toMatch(/background/i);
  });

  it('reports a timeout in seconds, not as "1 minutes"', () => {
    // The 45s apiRequest ceiling rounded to minutes was the specific bug.
    const msg = apiErrorMessage({
      ok: false, kind: 'timeout', stage: 'waiting', elapsedMs: 45_000, wasHidden: false,
    });
    expect(msg).toContain('45 seconds');
    expect(msg).not.toMatch(/minute/);
  });

  it('reports a long upload timeout in minutes', () => {
    const msg = apiErrorMessage({
      ok: false, kind: 'timeout', stage: 'uploading', elapsedMs: 330_000, wasHidden: false,
    });
    expect(msg).toMatch(/6 minutes/);
    expect(msg).toMatch(/smaller file/i);
  });

  it('says nothing at all for a request the caller aborted', () => {
    // A superseded search keystroke is not a failure and must not toast.
    expect(apiErrorParts(http(0)).title).toBe('');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('a proxy error page is not a network error', () => {
  it('reads a 413 with an unparseable body as a size problem', () => {
    // nginx answers an oversized body with 413 and HTML. `res.json()` threw on
    // it, and the throw was reported as "Network error uploading document".
    const msg = apiErrorMessage(http(413, null, '<html>413 Request Entity Too Large</html>'));
    expect(msg).toMatch(/too large/i);
    expect(msg).toContain(`${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB`);
    expect(msg).not.toMatch(/network|connection|offline/i);
  });

  it('reads a 502 HTML page as the server, not the connection', () => {
    const msg = apiErrorMessage(http(502, null, '<html>502 Bad Gateway</html>'));
    expect(msg).toMatch(/server took too long/i);
    expect(msg).not.toMatch(/wi-?fi|offline|your connection/i);
  });

  it('reads a 504 the same way', () => {
    expect(apiErrorMessage(http(504, null, '<html>'))).toMatch(/server took too long/i);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('AI failures keep their own vocabulary', () => {
  it('tells a tenant out of credits to buy credits, not to type it in by hand', () => {
    // Previously: alert('AI could not detect structured values. Try filling
    // manually.') — which describes a model that read the document and found
    // nothing, for a tenant whose balance is simply empty.
    const msg = apiErrorMessage(http(402, { errorCode: AI_ERROR_CODES.INSUFFICIENT_CREDITS }));
    expect(msg).toMatch(/credits/i);
    expect(msg).toMatch(/upgrade|add-on/i);
    expect(msg).not.toMatch(/could not detect/i);
  });

  it('tells an admin to change the model when the provider retired it', () => {
    const msg = apiErrorMessage(http(500, { errorCode: AI_ERROR_CODES.MODEL_NOT_FOUND }));
    expect(msg).toMatch(/no longer available/i);
    expect(msg).toMatch(/AI Settings/);
  });

  it('does not promise a key rotation that has already been tried and failed', () => {
    // The message read "Switching to next available key..." at the point where
    // every key had already been tried. It described work that was over.
    const msg = apiErrorMessage(http(503, { errorCode: AI_ERROR_CODES.QUOTA_EXHAUSTED }));
    expect(msg).not.toMatch(/switching to next/i);
    expect(msg).toMatch(/add another key|try again tomorrow/i);
  });

  it('prefers the AI code over a generic error string in the same body', () => {
    const msg = apiErrorMessage(
      http(503, { errorCode: AI_ERROR_CODES.MODEL_OVERLOADED, error: 'AI processing failed' }),
    );
    expect(msg).toMatch(/heavy load/i);
    expect(msg).not.toBe('AI processing failed');
  });

  it('ignores an errorCode that is not one of ours', () => {
    const msg = apiErrorMessage(http(500, { errorCode: 'WAT', error: 'Specific server sentence.' }));
    expect(msg).toContain('Specific server sentence.');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('out of space, either wall', () => {
  it('names the figures and the plan remedy', () => {
    const msg = apiErrorMessage(http(507, {
      status: 'STORAGE_LIMIT_EXCEEDED',
      currentBytes: 1024 ** 3, limitBytes: 1024 ** 3, isGoogleDrive: false,
    }));
    expect(msg).toMatch(/storage limit reached/i);
    expect(msg).toContain('1.00 GB of 1.00 GB used');
    expect(msg).toMatch(/add storage to your plan/i);
  });

  it('sends a BYOD tenant to their own Drive instead of selling them an upgrade', () => {
    const msg = apiErrorMessage(http(507, {
      status: 'DRIVE_QUOTA_EXCEEDED', currentBytes: 15 * 1024 ** 3, limitBytes: 15 * 1024 ** 3,
    }));
    expect(msg).toMatch(/google drive is full/i);
    expect(msg).toMatch(/free up space in google drive/i);
    expect(msg).not.toMatch(/add storage to your plan/i);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('vault failures keep the sentence the server wrote', () => {
  it('passes a DRIVE_NOT_CONNECTED message through and points at Settings', () => {
    const { title, description } = apiErrorParts(http(400, {
      status: 'DRIVE_NOT_CONNECTED',
      message: 'Google Drive is not connected — reconnect it to view your records.',
      error: 'Google Drive is not connected — reconnect it to view your records.',
      reconnectUrl: '/settings?connect=google',
    }));
    expect(title).toMatch(/not connected/i);
    expect(description).toMatch(/settings/i);
  });

  it('offers a retry only for the codes the server marked retryable', () => {
    const retryable = apiErrorParts(http(503, {
      status: 'DRIVE_UNAVAILABLE', message: 'Google Drive is temporarily unavailable.',
      retryable: true,
    }));
    expect(retryable.description).toMatch(/try again/i);

    const notRetryable = apiErrorParts(http(409, {
      status: 'VAULT_FILE_MISSING', message: 'This record’s data file is missing.',
      retryable: false,
    }));
    expect(notRetryable.description).toBe('');
  });

  it('never leaks the operator-facing detail field', () => {
    const msg = apiErrorMessage(http(500, {
      status: 'VAULT_DECRYPT_FAILED',
      message: 'Stored data failed its integrity check.',
      detail: 'tenant=abc category=medical driveFileId=1xYz',
    }));
    expect(msg).not.toContain('driveFileId');
    expect(msg).not.toContain('tenant=abc');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('the ordinary statuses each get their own answer', () => {
  it('401 tells the user to sign in, not that the fetch failed', () => {
    const msg = apiErrorMessage(http(401, null));
    expect(msg).toMatch(/session has expired/i);
    expect(msg).toMatch(/sign in/i);
  });

  it('403 names permission and who can grant it', () => {
    expect(apiErrorMessage(http(403, null))).toMatch(/permission/i);
  });

  it('404 says the record is gone rather than that loading failed', () => {
    const msg = apiErrorMessage(http(404, null), { subject: 'medical record' });
    expect(msg).toMatch(/medical record no longer exists/i);
  });

  it('429 converts Retry-After into a wait the user can act on', () => {
    const msg = apiErrorMessage(http(429, { retryAfter: 600 }));
    expect(msg).toMatch(/10 minutes/);
  });

  it('429 uses seconds for a short window', () => {
    expect(apiErrorMessage(http(429, { retryAfter: 30 }))).toMatch(/30 seconds/);
  });

  it('surfaces a 5xx reference so a screenshot becomes a grep', () => {
    const { description } = apiErrorParts(
      http(500, { error: 'Something failed at our end while saving this record.', reference: 'K3P9QZ' }),
      { action: 'saving' },
    );
    expect(description).toContain('K3P9QZ');
  });

  it('still says nothing was changed when a 5xx carried no body at all', () => {
    const msg = apiErrorMessage(http(500, null), { action: 'saving this record' });
    expect(msg).toMatch(/failed at our end while saving this record/i);
    expect(msg).toMatch(/nothing was changed/i);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('the server sentence beats any generic fallback', () => {
  it('shows what the route said rather than a status phrase', () => {
    // dbErrors.DUPLICATE_PHONE_MESSAGE, as a route would send it.
    const msg = apiErrorMessage(
      http(409, { error: 'This mobile number is already registered to another account.' }),
      { subject: 'member' },
    );
    expect(msg).toContain('already registered to another account');
    expect(msg).not.toMatch(/conflicts with one already saved/);
  });

  it('reads fieldErrors when there is nowhere to attach them', () => {
    const { title, description } = apiErrorParts(http(400, {
      fieldErrors: { file: 'invoice.heic is 31 MB — the limit is 25 MB per file.', title: 'Required' },
    }));
    expect(title).toContain('31 MB');
    expect(description).toMatch(/1 more/);
  });

  it('splits a two-sentence server message into title and advice', () => {
    const { title, description } = apiErrorParts(http(400, {
      error: 'That file type is not supported. Attach a PDF or a photo instead.',
    }));
    expect(title).toBe('That file type is not supported.');
    expect(description).toBe('Attach a PDF or a photo instead.');
  });

  it('keeps a single short sentence whole', () => {
    const { title, description } = apiErrorParts(http(400, { error: 'Missing required fields' }));
    expect(title).toBe('Missing required fields');
    expect(description).toBe('');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('uploadErrorMessage keeps working for its six existing callers', () => {
  it('still takes subject as a positional argument', () => {
    const msg = uploadErrorMessage({ ok: false, kind: 'offline' }, 'medical record');
    expect(msg).toMatch(/offline/i);
  });

  it('returns an empty string for a success, as it always did', () => {
    expect(uploadErrorMessage({ ok: true, status: 200, json: {} })).toBe('');
  });
});
