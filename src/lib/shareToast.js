'use client';

import { toast } from 'sonner';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   ONE HONEST SENTENCE PER SHARE OUTCOME                                 ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Every one of the twenty pages that share a record used to hold its own
 * variation of
 *
 *     if (res.success && res.method === 'copy') toast.success('… copied!');
 *
 * — which reports the ONE outcome nobody asked for and stays silent on all the
 * others. A share that failed said nothing at all, which is the "I tap it and
 * nothing happens" complaint; a share the member had no permission for said
 * "copied!", which reads as success while the document never left.
 *
 * So the result shape carries a `reason` and this turns it into the sentence.
 * One place, so the wording cannot drift across the twenty pages, and so adding
 * an outcome does not mean revisiting them.
 *
 * @param {{success: boolean, method: string|null, reason?: string,
 *          omitted?: number, hadFiles?: boolean}} result from `shareRecords`
 */
export function reportShareResult(result) {
  if (!result) return;
  const { success, method, reason, omitted } = result;

  if (success) {
    if (reason === 'no-permission') {
      // The details went out; the file did not. Said plainly, because the
      // member would otherwise believe they had sent the document.
      toast.warning('Details shared — you do not have permission to share the file itself.');
      return;
    }
    if (method === 'copy') {
      toast.success('Details copied to clipboard');
      return;
    }
    if (method === 'download') {
      toast.success('Saved to your device');
      return;
    }
    if (omitted > 0) {
      toast.warning(`Shared 1 of ${omitted + 1} pages — this browser would not accept the rest.`);
      return;
    }
    // A completed OS share needs no toast: the user watched the sheet open and
    // watched it close. Saying "shared!" on top of that is noise.
    return;
  }

  // The user closed the share sheet, or closed the gate. Their decision, not a
  // failure, and silence is the right response to it.
  if (reason === 'aborted' || reason === 'dismissed') return;

  if (reason === 'no-permission') {
    toast.error('You do not have permission to share this document.');
    return;
  }
  if (reason === 'unsupported') {
    toast.error('This browser cannot share. Try Download instead.');
    return;
  }
  toast.error('Could not share this document');
}
