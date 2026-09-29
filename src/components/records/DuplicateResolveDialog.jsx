'use client';

import Link from 'next/link';
import { AlertCircle, Copy, ExternalLink, Loader2, RefreshCw } from 'lucide-react';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ALL_NAV_MODULES, subCategoryPath } from '@/lib/moduleRegistry';
import { useWorkspaceCompanyId } from '@/lib/net/useWorkspaceApi';
import FilePreviewPane, { formatBytes } from '@/components/records/FilePreviewPane';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   "THIS ALREADY EXISTS" — SHOWN, NOT JUST SAID                          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The prompt every upload path raises when a write duplicates a record the
 * tenant already holds. It used to be a sentence and a link that opened the
 * matched record in another tab; nobody can judge "is this scan fresher than
 * what is on file?" from a title, so both documents are rendered side by side
 * and the user picks between things they can see.
 *
 * ── THE THREE ANSWERS ──────────────────────────────────────────────────────
 *   · KEEP THE EXISTING ONE — nothing is written. The safe default, so it is
 *     also what closing the dialog does.
 *   · KEEP THE NEW ONE      — the upload overwrites the matched record in
 *     place. One record, latest bytes. (Was "Update it".)
 *   · KEEP BOTH             — the upload is filed as a separate record under
 *     the numbered title the server has already resolved and NAMED here.
 *     Offered only when the server says so: a match on a declared identifier —
 *     a passport, policy or account number — cannot be forked, because two
 *     records claiming one identifier can never be told apart afterwards.
 *
 * ── SOMETIMES THERE IS ONLY ONE ────────────────────────────────────────────
 * An EDIT can answer none of them. It names the record it is writing onto, and
 * a collision with a DIFFERENT record is refused however it is confirmed — so
 * `keepNewAllowed: false` comes back and the prompt drops to a single answer
 * plus the link to the record the clash has to be settled on. Offering "keep
 * the new one" there re-posted the same write and re-opened this dialog on the
 * same 409, which is a loop, not a choice.
 *
 * ── THE SENTENCE IS THE SERVER'S ───────────────────────────────────────────
 * `match.error` says WHICH record and WHY it matched. Rendering our own here is
 * how users were once told their titles clashed while they were looking at two
 * different titles.
 *
 * `match` is the 409 body (`duplicateConflictPayload` in records/handler.ts).
 * `newFile` is the browser `File` being uploaded, when the caller still holds
 * one — a bulk scan may not, and the "uploading now" pane says so rather than
 * pretending.
 */
/**
 * "Module › Sub-category" for a taxonomy pair, or null.
 *
 * Resolved HERE rather than passed in: sixteen pages render this dialog, and
 * threading a label through every one of them to show a line of text is how a
 * detail like this ends up shown on two screens and missing on fourteen.
 *
 * `ALL_NAV_MODULES` excludes the catch-all deliberately (it is not a sidebar
 * entry), so an uncategorised record falls back to its raw keys rather than
 * rendering blank — "other / uncategorized" is still the honest answer, and it
 * is exactly the case where the user most needs to see where a scan landed.
 */
function categoryLabelOf(moduleKey, documentKey) {
  if (!moduleKey || !documentKey) return null;
  const mod = ALL_NAV_MODULES.find((m) => m.key === moduleKey);
  const sub = mod?.subCategories?.find((s) => s.documentKey === documentKey);
  if (!mod || !sub) return `${moduleKey} / ${documentKey}`;
  return `${mod.name} \u203a ${sub.name}`;
}

/** The filing line under a title. Muted, so it reads as provenance. */
function CategoryLine({ label }) {
  if (!label) return null;
  return (
    <span className="truncate text-xs font-medium text-muted-foreground/80" title={label}>
      {label}
    </span>
  );
}

export default function DuplicateResolveDialog({
  open,
  match,
  newFile,
  newTitle,
  busy = false,
  onKeepExisting,
  onKeepNew,
  onKeepBoth,
}) {
  /**
   * Which workspace this upload is happening in — read from the route, so the
   * dialog needs no prop from the fifteen pages that render it.
   *
   * ABOVE the early return, because it is a hook: the `!match` case must not
   * change how many run. And load-bearing for the link below — without it,
   * resolving a duplicate inside a company opened the HOUSEHOLD's copy of the
   * matched record.
   */
  const companyId = useWorkspaceCompanyId();

  if (!match) return null;

  const existingFile = match.existingFile || null;
  // Absent on a body from a caller that predates the flag, which means the
  // ordinary two-or-three-answer prompt — only an explicit false withdraws it.
  const keepNew = match.keepNewAllowed !== false;
  const keepBoth = Boolean(match.keepBothAllowed) && typeof onKeepBoth === 'function';
  const existingCategory = categoryLabelOf(match.existingModuleKey, match.existingDocumentKey);
  const newCategory = categoryLabelOf(match.newModuleKey, match.newDocumentKey);
  /**
   * Two different KINDS of document should no longer be able to collide on a
   * shared number — arm 1 is scoped to one sub-category. So when the two sides
   * disagree the cause is almost always a misclassified scan, and saying so is
   * more use than making the user infer it from two labels.
   */
  const misfiled = Boolean(existingCategory && newCategory && existingCategory !== newCategory);
  const prefix = companyId ? `/business/${companyId}` : '';
  const workspace = match.existingModuleKey && match.existingDocumentKey
    ? `${prefix}${subCategoryPath(match.existingModuleKey, match.existingDocumentKey)}?tab=files&search=${encodeURIComponent(match.existingTitle || '')}`
    : null;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !busy) onKeepExisting(); }}>
      <DialogContent
        aria-describedby={undefined}
        className="flex max-h-[92vh] w-[calc(100%-1.5rem)] flex-col gap-4 overflow-y-auto border-border/50 bg-popover/95 shadow-glass backdrop-blur sm:max-w-3xl"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5 text-lg font-bold text-foreground">
            <AlertCircle className="flex-shrink-0 text-amber-500" size={22} />
            <span>Duplicate Document Found</span>
          </DialogTitle>
        </DialogHeader>

        <p className="text-sm leading-relaxed text-muted-foreground">
          {match.error || `'${match.existingTitle}' already exists in this category.`}{' '}
          Compare them below and choose what to keep.
        </p>

        {/* Two different kinds of document can no longer collide on a shared
            number, so a mismatch here means the upload was filed somewhere it
            does not belong — usually a scan the classifier read wrongly. The
            user can act on that; they cannot act on "duplicate found". */}
        {misfiled && (
          <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-foreground">
            These two are filed under <strong>different sub-categories</strong>. If this
            upload is not the same document, close this and change its sub-category
            before saving — keeping the new one would overwrite the record on file.
          </p>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          {/* ── On file ───────────────────────────────────────────────── */}
          <section className="flex flex-col gap-2 rounded-xl border border-border/40 bg-card p-3">
            <header className="flex flex-col gap-0.5">
              <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">
                Already on file
              </span>
              <span className="truncate text-sm font-semibold text-foreground" title={match.existingTitle}>
                {match.existingTitle || 'Untitled record'}
              </span>
              <CategoryLine label={existingCategory} />
              <span className="truncate text-xs text-muted-foreground">
                {[
                  existingFile?.fileName,
                  formatBytes(existingFile?.fileSize),
                  existingFile?.updatedAt
                    ? `updated ${new Date(existingFile.updatedAt).toLocaleDateString()}`
                    : '',
                ].filter(Boolean).join(' · ') || 'No stored file'}
              </span>
            </header>
            <FilePreviewPane
              className="h-[320px]"
              source={existingFile ? {
                kind: 'record',
                filePath: existingFile.filePath,
                mimeType: existingFile.mimeType,
                name: match.existingTitle,
                // Without this the stored half shows sheet one of a scanned
                // agreement with no way to the rest — and "is this scan fresher
                // than what is on file?" is exactly the question a later page
                // usually answers.
                pageCount: existingFile.pageCount,
              } : null}
              // Absent for two very different reasons, and the user is owed the
              // difference: the record may own no file at all, or it may be one
              // this member may file into but not read.
              emptyMessage="This record cannot be previewed here."
            />
            {workspace ? (
              <Link
                className="inline-flex items-center gap-1.5 self-start text-xs font-medium text-primary underline-offset-4 hover:underline"
                href={workspace}
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLink size={13} />
                <span>Open in its workspace</span>
              </Link>
            ) : null}
          </section>

          {/* ── Uploading now ─────────────────────────────────────────── */}
          <section className="flex flex-col gap-2 rounded-xl border border-primary/30 bg-primary/5 p-3">
            <header className="flex flex-col gap-0.5">
              <span className="text-xs font-bold uppercase tracking-wider text-primary">
                Uploading now
              </span>
              <span className="truncate text-sm font-semibold text-foreground" title={newTitle || newFile?.name}>
                {newTitle || newFile?.name || 'This upload'}
              </span>
              <CategoryLine label={newCategory} />
              <span className="truncate text-xs text-muted-foreground">
                {[newFile?.name, formatBytes(newFile?.size)].filter(Boolean).join(' · ')
                  || 'No file to preview'}
              </span>
            </header>
            <FilePreviewPane
              className="h-[320px]"
              source={newFile ? { kind: 'file', file: newFile } : null}
              emptyMessage="The scanned pages are not available on this screen."
            />
          </section>
        </div>

        {/* Above the action bar, not below it: the bar is the last thing in
            every other dialog, and the copy keeping both would file is named
            HERE — a caption tucked under one button made that button taller
            than its neighbours and left the three answers off one line. */}
        <p className="text-xs leading-relaxed text-muted-foreground">
          {keepNew ? (
            <>
              Keeping the new one <strong className="text-foreground">replaces the record on
              file permanently</strong> — its stored file is overwritten in place, there is no
              second copy and no earlier version to go back to.
              {!keepBoth && ' Both records would claim the same number, so they cannot be kept side by side.'}
              {keepBoth && (match.keepBothTitle ? (
                <>
                  {' '}Keeping both files this upload separately, as{' '}
                  <strong className="text-foreground">
                    &ldquo;{match.keepBothTitle}&rdquo;
                  </strong>.
                </>
              ) : ' Keeping both files this upload separately, under its own name.')}
            </>
          ) : (
            <>
              These changes would give this record something{' '}
              <strong className="text-foreground">another record already claims</strong>, and merging
              two records is not something this form can decide. Open the one on file and settle it
              there.
            </>
          )}
        </p>

        <DialogFooter className="flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end">
          <Button variant="secondary" onClick={onKeepExisting} disabled={busy}>
            Keep the existing one
          </Button>
          {keepBoth && (
            <Button variant="outline" className="gap-1.5" onClick={onKeepBoth} disabled={busy}>
              <Copy size={15} />
              <span>Keep both</span>
            </Button>
          )}
          {keepNew && (
            <Button className="gap-1.5" onClick={onKeepNew} disabled={busy}>
              {busy ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
              <span>Keep the new one</span>
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
