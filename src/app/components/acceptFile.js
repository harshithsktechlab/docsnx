'use client';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE PICKER GUARD THE LEGACY PAGES NEVER HAD                            ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `FilePicker` checks what it is handed before passing it up. The fourteen
 * module pages predate it: each owns a styled drop-zone wrapped around a bare
 * `<input type="file">` with no `accept` and no check, so they took anything
 * and let the server refuse it — or, before the server checked either, stored
 * it. The same file was accepted on one page and rejected on another.
 *
 * Replacing those drop-zones with `FilePicker` would redesign fourteen screens
 * to fix a validation bug. This is the same guard, shaped to drop into the
 * handler each page already has.
 *
 * `accept` on the input still matters and is set alongside every use of this:
 * it is what keeps the wrong file out of the dialog in the first place. This is
 * what catches the drag-and-drop, which ignores `accept` entirely.
 */
import { toast } from 'sonner';
import { prepareUploadFile } from '@/lib/records/fileSnapshot';

/**
 * The chosen file, or null — having already said why not.
 *
 * Clears the input on a refusal so the control does not sit there displaying a
 * filename the page did not accept, and so re-picking the SAME file after
 * fixing it still fires a change event.
 *
 * ── ASYNC, BECAUSE THIS IS WHERE A FILE IS MADE UPLOADABLE ────────────────
 * `prepareUploadFile` (src/lib/records/fileSnapshot.ts) does everything a
 * picked file needs before a page may hold it: checks the type, READS THE
 * BYTES into memory while the phone will still hand them over, re-encodes a
 * large camera photo, and checks the size that will actually be sent. Fourteen
 * module pages go through this one function, which is why the work lives here
 * — each of those steps has been the reason an upload failed on a phone and
 * not on a laptop, and fixing them here fixes all fourteen screens at once.
 *
 * The file is read and the input cleared SYNCHRONOUSLY, before the first await:
 * clearing `value` discards `files`, and after an await the event's input may
 * have been reset or unmounted.
 *
 * @param {{ target: HTMLInputElement }} event
 * @returns {Promise<File|null>}
 */
export async function acceptedFileFrom(event) {
  const input = event?.target || null;
  const chosen = input?.files?.[0] || null;
  if (!chosen) return null;

  const result = await prepareUploadFile(chosen);
  if (!result.ok) {
    toast.error(result.error);
    if (input) input.value = '';
    return null;
  }
  return result.file;
}
