'use client';

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import FilePreviewPane from '@/components/records/FilePreviewPane';

/**
 * Preview modal for a record's attachment — the dialog around the one pane.
 *
 * ── WHAT THIS USED TO DO, AND WHY IT NEVER WORKED ──────────────────────────
 * It pointed an <img>/<iframe> straight at `getFileUrl(filePath)`. The frame is
 * refused outright — `X-Frame-Options: DENY` (next.config.mjs) applies to every
 * route — so no PDF ever appeared, and the branch was chosen by a companion
 * helper that read the file type off the END OF THE PATH. A vault path is
 * `/api/records/<scope>/<id>/file`, which has no extension anywhere in it, so
 * that helper answered `application/octet-stream` for every record in the vault
 * and the modal fell to "No preview available" on all of them.
 *
 * `FilePreviewPane` fetches the bytes with `render=1` and picks its renderer
 * from what the route actually served, which is the only account of the file
 * that is reliably true. That helper is gone; pass the record's own `mimeType`
 * column if you have it — it is a hint for nothing but is harmless — and its
 * `pageCount`, which is what lets a multi-page scan be paged through.
 *
 * `doc` is `{ name, filePath, mimeType, pageCount }` or null when closed.
 */
export default function DocumentPreviewDialog({ doc, onClose, fallbackAction = null }) {
  return (
    <Dialog open={!!doc} onOpenChange={(open) => !open && onClose()}>
      {doc && (
        <DialogContent aria-describedby={undefined} className="max-w-4xl max-h-[90vh] flex flex-col py-6 border-border/50 bg-card/95 backdrop-blur-md">
          <DialogHeader className="p-0 pb-4 border-b border-border/30">
            <DialogTitle className="text-lg font-bold truncate">Preview: {doc.name}</DialogTitle>
          </DialogHeader>
          <FilePreviewPane
            className="mt-4 min-h-[350px] max-h-[70vh] flex-1"
            source={{
              kind: 'record',
              filePath: doc.filePath,
              mimeType: doc.mimeType,
              name: doc.name,
              pageCount: doc.pageCount,
            }}
            emptyMessage={`No preview available for ${doc.name}`}
            fallbackAction={fallbackAction}
          />
        </DialogContent>
      )}
    </Dialog>
  );
}
