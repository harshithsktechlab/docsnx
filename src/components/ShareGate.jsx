'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, Download, Loader2, Share2 } from 'lucide-react';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  canShareNatively, copyShareText, performShare, setShareGate,
} from '@/lib/sharePrintHelper';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE SHARE GATE — one tap that gets the OS sheet open                  ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `navigator.share()` needs TRANSIENT USER ACTIVATION, and fetching the
 * document first spends it: every page decrypts from Drive, and src/sw.ts
 * forces those requests past the service worker to the network. Chrome
 * withdraws the activation about five seconds after the click, so a small image
 * shared fine and a PDF did not — at random, depending on the connection. The
 * thrown `NotAllowedError` then fell through to the text sheet, which failed
 * identically, and the record's details landed on the clipboard instead. That
 * is the whole of the "share works sometimes" bug.
 *
 * The bytes are in hand by the time this opens. The button below calls
 * `performShare` with NO await in front of it, so it runs inside the
 * activation its own click creates — which is also the only form WebKit
 * reliably accepts, since it wants the call in the same task as the gesture.
 *
 * ── AND WHERE THERE IS NO SHARE SHEET AT ALL ───────────────────────────────
 * Firefox on the desktop and Chrome on Linux implement no Web Share. Silently
 * copying text there is what made Share look broken rather than unavailable, so
 * `reason === 'unsupported'` says so plainly and offers the two things that DO
 * work: save the file, or copy the details. Nothing is copied until asked for.
 *
 * Mounted once, in src/app/layout.js. It registers itself with the helper, so
 * the twenty pages that call `shareRecord` need to know nothing about it; where
 * it is absent — SSR, unit tests — sharing behaves as it would without a gate.
 */
export default function ShareGate() {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  // The pending share's `resolve`. Held in a ref so settling it never depends on
  // a render having happened first.
  const resolveRef = useRef(null);

  /** Settle the awaiting `shareRecords` call and close. Idempotent. */
  const settle = useCallback((result) => {
    const resolve = resolveRef.current;
    resolveRef.current = null;
    setState(null);
    setBusy(false);
    if (resolve) resolve(result);
  }, []);

  useEffect(() => setShareGate((payload, reason) => new Promise((resolve) => {
    // A second share while one is open: settle the first as dismissed rather
    // than dropping its promise, which would hang the page that is awaiting it.
    if (resolveRef.current) resolveRef.current({ success: false, reason: 'dismissed' });
    resolveRef.current = resolve;
    setState({ payload, reason });
  })), [settle]);

  // Closing the dialog — Escape, the X, the overlay — is an answer: the user
  // decided not to share. It must not be reported as a failure, and it must not
  // copy anything they did not ask for.
  const onOpenChange = (open) => {
    if (!open && !busy) settle({ success: false, reason: 'dismissed' });
  };

  if (!state) return null;
  const { payload, reason } = state;
  const fileCount = payload.files.length;
  const unsupported = reason === 'unsupported' || !canShareNatively();

  /** The retry, inside the click's own activation. No await before the call. */
  const onShare = () => {
    setBusy(true);
    performShare(payload)
      .then(settle)
      .catch(() => settle({ success: false, reason: 'failed' }));
  };

  const onCopy = () => {
    setBusy(true);
    copyShareText(payload).then(settle);
  };

  /**
   * The saved copy, when there is no sheet to send it to. Built from the `File`
   * already fetched, so this costs no second decrypt and needs no second
   * permission check — the bytes are here because `?download=1` allowed them.
   */
  const onDownload = () => {
    payload.files.forEach((file) => {
      const url = URL.createObjectURL(file);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Decrypted bytes — released as soon as the download has taken them.
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    });
    settle({ success: true, method: 'download' });
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader data-dialog-header>
          <DialogTitle>
            {unsupported ? 'Sharing is not available in this browser' : 'Ready to share'}
          </DialogTitle>
          <DialogDescription>
            {unsupported
              ? 'This browser has no share sheet. You can save the file or copy the details instead.'
              : fileCount > 0
                ? `${fileCount === 1 ? 'Your document is' : `${fileCount} files are`} ready. `
                  + 'Tap Share to choose where to send it.'
                : 'Tap Share to choose where to send these details.'}
          </DialogDescription>
        </DialogHeader>

        <DialogFooter data-dialog-footer className="gap-2 sm:gap-2">
          {!unsupported && (
            <Button onClick={onShare} disabled={busy} className="w-full sm:w-auto">
              {busy
                ? <Loader2 className="mr-2 size-4 animate-spin" />
                : <Share2 className="mr-2 size-4" />}
              Share
            </Button>
          )}
          {fileCount > 0 && (
            <Button variant="outline" onClick={onDownload} disabled={busy} className="w-full sm:w-auto">
              <Download className="mr-2 size-4" />
              {fileCount === 1 ? 'Save file' : `Save ${fileCount} files`}
            </Button>
          )}
          <Button variant="outline" onClick={onCopy} disabled={busy} className="w-full sm:w-auto">
            <Copy className="mr-2 size-4" />
            Copy details
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
