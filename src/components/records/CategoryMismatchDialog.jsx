'use client';

import { FileQuestion, Loader2 } from 'lucide-react';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   "THIS DOES NOT LOOK LIKE A <X>" — ONE QUESTION, TWO ANSWERS            ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Raised when the AI read a document the user had filed under a category and
 * found it belongs somewhere else. The body is the `mismatch` object
 * `/api/modules/:m/:d/autofill` answers with.
 *
 *   · YES — use the category the AI found. The form switches and reads the
 *           document against it.
 *   · NO  — keep the user's module, but file it under that module's Other.
 *
 * ── IT CANNOT BE DISMISSED ─────────────────────────────────────────────────
 * Unlike the duplicate prompt there is no "do nothing" answer: the document
 * has to end up somewhere, and both ways of closing it by accident (Esc, a
 * click outside, the corner X) would leave the form on a category the AI has
 * just said is wrong. So the corner X is hidden and the other two are ignored;
 * the user answers.
 *
 * ── WHEN THEY CANNOT SAY YES ───────────────────────────────────────────────
 * `detectedPermitted: false` — the AI found a category this member may not add
 * to. Offering Yes would only fail on the next request, so the button is not
 * shown and the sentence says why.
 */
export default function CategoryMismatchDialog({
  open,
  mismatch,
  busy = false,
  onYes,
  onNo,
}) {
  if (!mismatch) return null;

  const { selected, detected, otherCategory } = mismatch;
  const canSwitch = mismatch.detectedPermitted !== false;
  const label = (c) => [c?.moduleName, c?.documentName].filter(Boolean).join(' › ');

  return (
    <Dialog open={open} onOpenChange={() => { /* answered with a button, never dismissed */ }}>
      <DialogContent
        aria-describedby="category-mismatch-body"
        className="max-w-md [&>[data-dialog-close]]:hidden"
        onEscapeKeyDown={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5">
            <FileQuestion className="flex-shrink-0 text-amber-500" size={22} />
            <span>This may be the wrong category</span>
          </DialogTitle>
        </DialogHeader>

        <div id="category-mismatch-body" className="flex flex-col gap-3 py-5 text-sm leading-relaxed text-muted-foreground">
          <p>
            You selected <strong className="text-foreground">{label(selected)}</strong>, but this
            document looks like <strong className="text-foreground">{label(detected)}</strong>.
          </p>
          {canSwitch ? (
            <p>Do you want to save it under {label(detected)} and continue?</p>
          ) : (
            <p>
              You do not have permission to add documents to {label(detected)}, so it will be filed
              under <strong className="text-foreground">{label(otherCategory)}</strong> instead.
            </p>
          )}
          {canSwitch && (
            <p className="text-xs">
              If you say no, it is filed under <strong className="text-foreground">{label(otherCategory)}</strong>.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={onNo} disabled={busy}>
            {canSwitch ? `No, file under ${otherCategory?.moduleName ?? 'Other'} › Other` : 'OK, file under Other'}
          </Button>
          {canSwitch && (
            <Button className="gap-1.5" onClick={onYes} disabled={busy}>
              {busy && <Loader2 size={15} className="animate-spin" />}
              <span>Yes, use {detected?.documentName}</span>
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
