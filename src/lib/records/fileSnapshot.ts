import {
  isAcceptedUpload, isWithinUploadSize, uploadSizeError, uploadTypeError,
} from './uploadTypes';
import { downscaleForScan } from './imageDownscale';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   READ THE BYTES NOW, WHILE THE PHONE WILL STILL LET US                 ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * A `File` from `<input type="file">` is a HANDLE, not a copy. The browser
 * reads its bytes when a request is sent, not when it is picked. On a desktop
 * that distinction never matters — the handle points at a real file on a real
 * filesystem. On Android it is the whole problem.
 *
 * A file picked from Google Drive, WhatsApp, DigiLocker, "Recent" or the
 * Downloads provider reaches Chrome as a `content://` document. Chrome can read
 * its METADATA at once — so the picker cheerfully shows "10th marksheet.pdf ·
 * 0.12 MB" — but the BYTES are streamed from the owning app only when the
 * upload starts. If that app refuses (its temporary read grant has lapsed, the
 * Drive file is not available offline, the app has been put to sleep), Chrome
 * aborts the request with `net::ERR_UPLOAD_FILE_CHANGED`: `xhr.onerror`,
 * `status 0`, zero bytes sent, inside a second. At the XHR layer that is
 * indistinguishable from a dropped connection — so for two weeks a user was
 * told "usually a switch between Wi-Fi and mobile data" about a phone whose
 * network was fine. Every request WITHOUT a file body reached the server; the
 * one WITH it never left the device. Three attempts, three failure beacons
 * delivered, zero uploads.
 *
 * ── THE FIX IS A COPY, TAKEN AT PICK TIME ──────────────────────────────────
 * `arrayBuffer()` reads the bytes NOW, while the grant is fresh and the owning
 * app is awake, and `new File([bytes], …)` is an in-memory Blob nothing can
 * revoke between picking and sending. If even that read is refused, the
 * failure surfaces HERE — at the picker, with the file's name and something
 * the user can actually do about it — instead of a minute later as a lie about
 * their wifi.
 *
 * Nothing on the server can address this. This is the only place it can be
 * fixed, and it runs for every upload path in the product.
 */

/**
 * The read itself was refused. Distinct from a wrong type or an oversized
 * file because the advice is different: the file is fine, the place it was
 * picked from is not.
 */
export class UnreadableFileError extends Error {
  readonly fileName: string;
  constructor(fileName: string, cause?: unknown) {
    super(unreadableFileMessage(fileName));
    this.name = 'UnreadableFileError';
    this.fileName = fileName;
    if (cause !== undefined) (this as any).cause = cause;
  }
}

/**
 * What to tell someone whose phone would not hand over the bytes.
 *
 * Names the mechanism the user can see ("opened from Drive / WhatsApp /
 * Recent") and the one action that fixes it. Deliberately does NOT mention the
 * network: this message exists precisely because the previous one did.
 */
export function unreadableFileMessage(fileName?: string): string {
  const which = fileName ? `“${fileName}”` : 'this file';
  return `Your phone would not let DocsNX read ${which}. This happens with files `
    + 'opened from Google Drive, WhatsApp or “Recent”. Save it to your phone first '
    + '(Files → Downloads, or “Make available offline” in Drive), then pick it from there.';
}

/**
 * Above this the size check will refuse the file whatever we do, so there is
 * no reason to hold it in memory first. Matches nginx's `client_max_body_size`
 * — nothing bigger can be sent at all.
 */
const SNAPSHOT_CEILING = 100 * 1024 * 1024;

/**
 * An in-memory copy of `file`, or `file` itself when a copy is pointless.
 *
 * Throws `UnreadableFileError` — and ONLY that — when the bytes cannot be read.
 * Every other failure mode (no `arrayBuffer` on this platform, a file too big
 * to bother with) falls through to the original handle, which is exactly what
 * the caller would have had anyway.
 */
export async function snapshotFile(file: File): Promise<File> {
  if (!file || typeof file.arrayBuffer !== 'function') return file;
  if (file.size > SNAPSHOT_CEILING) return file;

  let bytes: ArrayBuffer;
  try {
    bytes = await file.arrayBuffer();
  } catch (cause) {
    // `NotReadableError`, `NotFoundError`, `SecurityError` — the provider said
    // no. Whatever the DOMException's name, the user's next action is the same.
    throw new UnreadableFileError(file.name, cause);
  }

  // A read that "succeeded" with nothing in it is the same refusal wearing a
  // different face: some providers return an empty stream rather than throw.
  if (bytes.byteLength === 0 && file.size > 0) {
    throw new UnreadableFileError(file.name);
  }

  return new File([bytes], file.name, {
    type: file.type,
    lastModified: file.lastModified,
  });
}

export type PreparedUpload =
  | { ok: true; file: File }
  | { ok: false; error: string };

/**
 * Everything that has to happen to a picked file before a page may hold it.
 *
 * ── ORDER IS LOAD-BEARING ─────────────────────────────────────────────────
 *  1. TYPE     — cheap, and a refused type must not be read or decoded.
 *  2. SNAPSHOT — read the bytes now, per the note at the top of this file.
 *  3. DOWNSCALE — a phone photo is 3–12 MB; re-encode it before measuring it.
 *  4. SIZE     — against the bytes that will actually be sent, not the bytes
 *                that arrived. A 30 MB photo that re-encodes to 600 KB must not
 *                be refused for a size it no longer has.
 *
 * Returns a value rather than throwing: a refused file is an ordinary outcome
 * of a file picker, not an exception, and the caller has one `if` to write
 * instead of a `try` around three different error types.
 */
export async function prepareUploadFile(file: File): Promise<PreparedUpload> {
  if (!isAcceptedUpload(file)) {
    return { ok: false, error: uploadTypeError(file) };
  }

  let held: File;
  try {
    held = await snapshotFile(file);
  } catch (err) {
    if (err instanceof UnreadableFileError) return { ok: false, error: err.message };
    throw err;
  }

  const prepared = await downscaleForScan(held);

  if (!isWithinUploadSize(prepared)) {
    return { ok: false, error: uploadSizeError(prepared) };
  }
  return { ok: true, file: prepared };
}

export interface PreparedBatch {
  /** Files that passed, in the order given. */
  accepted: File[];
  /** One message per refused file, in the order given. */
  refused: { file: File; error: string }[];
}

/**
 * A whole selection, prepared one at a time.
 *
 * Serial on purpose, for the same reason `downscaleBatch` is: each step holds
 * a copy of the file in memory, and fifteen at once is how a mid-range phone
 * runs out. The type filter has usually already run by the time a batch gets
 * here, but it is cheap and this must be safe to call on a raw drop.
 */
export async function prepareUploadBatch(files: File[]): Promise<PreparedBatch> {
  const out: PreparedBatch = { accepted: [], refused: [] };
  for (const file of files) {
    const result = await prepareUploadFile(file);
    if (result.ok) out.accepted.push(result.file);
    else out.refused.push({ file, error: result.error });
  }
  return out;
}
