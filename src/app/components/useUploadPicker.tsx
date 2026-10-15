'use client';

import { useRef, useState, type ChangeEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Camera, FolderOpen } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import MultiPageCapture, { type MultiPageCaptureHandle } from '@/app/components/MultiPageCapture';
import { UPLOAD_ACCEPT_ATTRIBUTE } from '@/lib/records/uploadTypes';
import { stashPendingFiles } from '@/lib/pendingUpload';
import { utilityNavPath } from '@/lib/moduleRegistry';

/**
 * ── THE ONE UPLOAD BUTTON ──────────────────────────────────────────────────
 *
 * "Upload Document" and "Power Scan" used to be two buttons, and the user had
 * to know in advance which kind of upload they were about to do. Now they pick
 * files and the count decides: one opens the Document Manager's form with it
 * attached, more than one opens Power Scan with them all loaded.
 *
 * Shared by the bottom nav's `+` (Shell) and the Document Manager's header, so
 * the two cannot drift apart.
 *
 * `open()` must run inside the tap handler itself — iOS only opens a file
 * dialog from a user gesture. Render `input` once, anywhere in the tree.
 *
 * `openCamera()` is the page-by-page camera scan (`MultiPageCapture`); its
 * result takes the same two roads — one combined document to the form, several
 * separate documents to Power Scan. `openChooser()` offers both, for the
 * bottom nav's `+` where the phone's own chooser shoots only one photo.
 */
export default function useUploadPicker(companyId?: string | null) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);

  const captureRef = useRef<MultiPageCaptureHandle>(null);
  const [chooserOpen, setChooserOpen] = useState(false);

  const open = () => inputRef.current?.click();
  const openCamera = () => captureRef.current?.start();
  const openChooser = () => setChooserOpen(true);

  // Navigate first, then stash: if the destination is the page we are already
  // on, the push is a no-op and the stash's listener is what wakes it; if it is
  // another page, that page takes the files on mount.
  const route = (picked: File[]) => {
    const target = picked.length === 1 ? '/documents' : '/documents/bulk-scan';
    router.push(utilityNavPath(target, companyId));
    stashPendingFiles(picked);
  };

  const onChange = (e: ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files || []);
    // Clearing `value` lets the same file be picked again next time.
    e.target.value = '';
    if (picked.length === 0) return;
    route(picked);
  };

  const input = (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={UPLOAD_ACCEPT_ATTRIBUTE}
        onChange={onChange}
        className="hidden"
        aria-hidden
        tabIndex={-1}
      />
      <MultiPageCapture
        ref={captureRef}
        onOneDocument={(file) => route([file])}
        onSeparate={route}
      />
      <Dialog open={chooserOpen} onOpenChange={setChooserOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Upload</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 py-4">
            {/* Each button opens its picker inside this same tap — iOS needs that. */}
            <button
              type="button"
              onClick={() => { setChooserOpen(false); openCamera(); }}
              className="flex items-center gap-3 rounded-xl border border-border p-4 text-left transition-colors hover:bg-muted"
            >
              <Camera className="h-5 w-5 flex-shrink-0 text-primary" />
              <span>
                <span className="block text-sm font-bold text-foreground">Scan with camera</span>
                <span className="block text-xs text-muted-foreground">Take one or more pages, then upload together</span>
              </span>
            </button>
            <button
              type="button"
              onClick={() => { setChooserOpen(false); open(); }}
              className="flex items-center gap-3 rounded-xl border border-border p-4 text-left transition-colors hover:bg-muted"
            >
              <FolderOpen className="h-5 w-5 flex-shrink-0 text-primary" />
              <span>
                <span className="block text-sm font-bold text-foreground">Choose files</span>
                <span className="block text-xs text-muted-foreground">PDFs, photos and other documents</span>
              </span>
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );

  return { open, openCamera, openChooser, input };
}
