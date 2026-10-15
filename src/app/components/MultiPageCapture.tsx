'use client';

import {
  forwardRef, useEffect, useImperativeHandle, useRef, useState, type ChangeEvent,
} from 'react';
import {
  Camera, ChevronLeft, ChevronRight, FileText, Files, ImagePlus, Loader2, Trash2,
} from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { downscaleForScan } from '@/lib/records/imageDownscale';
import { buildPdfFromImages, CapturePageError } from '@/lib/records/imagesToPdf';
import { MAX_SCAN_FILES, MAX_SCAN_PAGES } from '@/lib/records/uploadTypes';

/**
 * ── SHOOT A PAPER DOCUMENT PAGE BY PAGE ────────────────────────────────────
 *
 * A phone's "Take Photo" returns ONE picture and closes, so a five-page paper
 * document used to need five uploads. This sheet keeps the camera coming back:
 * shoot, "Add page", shoot again, reorder or drop a bad one, then Done.
 *
 * Done with several pages asks one question, because the sheet cannot know:
 *  - ONE document  → the pages become one PDF (`buildPdfFromImages`) and go to
 *                    the normal single-file form via `onOneDocument`.
 *  - DIFFERENT ones → the photos go to Power Scan via `onSeparate`, whose AI
 *                    already groups pages into records and lets the user fix
 *                    the grouping before anything is saved.
 *
 * `start()` (via ref) must be called from inside a tap handler — iOS opens the
 * camera only from a user gesture — so the sheet itself opens when the first
 * photo arrives, and cancelling the camera leaves nothing behind.
 */

export type MultiPageCaptureHandle = { start: () => void };

type Props = {
  onOneDocument: (file: File, pageCount: number) => void;
  onSeparate: (files: File[]) => void;
};

type Page = { id: string; file: File; url: string };

let nextId = 0;

const MultiPageCapture = forwardRef<MultiPageCaptureHandle, Props>(
  function MultiPageCapture({ onOneDocument, onSeparate }, ref) {
    const cameraRef = useRef<HTMLInputElement>(null);
    const galleryRef = useRef<HTMLInputElement>(null);
    const [pages, setPages] = useState<Page[]>([]);
    const [open, setOpen] = useState(false);
    const [choosing, setChoosing] = useState(false);
    const [busy, setBusy] = useState('');
    const [error, setError] = useState('');

    useImperativeHandle(ref, () => ({ start: () => cameraRef.current?.click() }), []);

    // Object URLs pin the photo's bytes in memory until revoked.
    const pagesRef = useRef(pages);
    pagesRef.current = pages;
    useEffect(() => () => pagesRef.current.forEach((p) => URL.revokeObjectURL(p.url)), []);

    const room = MAX_SCAN_PAGES - pages.length;
    const full = room <= 0;

    const addFiles = async (e: ChangeEvent<HTMLInputElement>) => {
      const picked = Array.from(e.target.files || []).filter((f) => f.size > 0);
      // Synchronous, before any await: clearing `value` discards `files`.
      e.target.value = '';
      if (picked.length === 0) return;
      setOpen(true);
      setChoosing(false);
      setError('');
      const accepted = picked.slice(0, Math.max(0, room));
      if (accepted.length < picked.length) {
        setError(`A document can have at most ${MAX_SCAN_PAGES} pages.`);
      }
      setBusy('Adding page…');
      try {
        const added: Page[] = [];
        // Serial: each decode holds a full camera bitmap (see `downscaleBatch`).
        for (const f of accepted) {
          const file = await downscaleForScan(f);
          added.push({ id: `p${nextId++}`, file, url: URL.createObjectURL(file) });
        }
        setPages((prev) => [...prev, ...added]);
      } finally {
        setBusy('');
      }
    };

    const remove = (id: string) => {
      setPages((prev) => {
        const gone = prev.find((p) => p.id === id);
        if (gone) URL.revokeObjectURL(gone.url);
        return prev.filter((p) => p.id !== id);
      });
      setChoosing(false);
      setError('');
    };

    const move = (index: number, by: -1 | 1) => {
      setPages((prev) => {
        const to = index + by;
        if (to < 0 || to >= prev.length) return prev;
        const next = [...prev];
        [next[index], next[to]] = [next[to], next[index]];
        return next;
      });
    };

    const reset = () => {
      pages.forEach((p) => URL.revokeObjectURL(p.url));
      setPages([]);
      setChoosing(false);
      setError('');
      setBusy('');
      setOpen(false);
    };

    const finishAsOne = async () => {
      const files = pages.map((p) => p.file);
      if (files.length === 1) {
        onOneDocument(files[0], 1);
        reset();
        return;
      }
      setBusy('Preparing document…');
      setError('');
      try {
        const pdf = await buildPdfFromImages(files);
        onOneDocument(pdf, files.length);
        reset();
      } catch (err) {
        setBusy('');
        setError(err instanceof CapturePageError
          ? err.message
          : 'Could not combine the pages. Try again, or remove a page and retake it.');
      }
    };

    const finishAsSeparate = () => {
      onSeparate(pages.map((p) => p.file));
      reset();
    };

    const done = () => {
      if (pages.length === 1) finishAsOne();
      else setChoosing(true);
    };

    return (
      <>
        <input
          ref={cameraRef}
          type="file"
          accept="image/*"
          capture="environment"
          onChange={addFiles}
          className="hidden"
          aria-hidden
          tabIndex={-1}
        />
        <input
          ref={galleryRef}
          type="file"
          accept="image/*"
          multiple
          onChange={addFiles}
          className="hidden"
          aria-hidden
          tabIndex={-1}
        />

        <Dialog open={open} onOpenChange={(o) => { if (!o && !busy) reset(); }}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>
                {choosing ? 'What did you scan?' : `Scan pages (${pages.length})`}
              </DialogTitle>
              <p className="text-xs text-muted-foreground">
                {choosing
                  ? `${pages.length} pages captured.`
                  : 'Take a photo of each page. Reorder or remove pages before you continue.'}
              </p>
            </DialogHeader>

            <div className="overflow-y-auto py-4">
              {choosing ? (
                <div className="grid gap-3">
                  <button
                    type="button"
                    onClick={finishAsOne}
                    disabled={Boolean(busy)}
                    className="flex items-start gap-3 rounded-xl border-2 border-primary bg-primary/5 p-4 text-left transition-colors hover:bg-primary/10 disabled:opacity-60"
                  >
                    <FileText className="mt-0.5 h-5 w-5 flex-shrink-0 text-primary" />
                    <span>
                      <span className="block text-sm font-bold text-foreground">
                        One document ({pages.length} pages)
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        All pages are saved together as one PDF.
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={finishAsSeparate}
                    disabled={Boolean(busy) || pages.length > MAX_SCAN_FILES}
                    className="flex items-start gap-3 rounded-xl border border-border p-4 text-left transition-colors hover:bg-muted disabled:opacity-60"
                  >
                    <Files className="mt-0.5 h-5 w-5 flex-shrink-0 text-muted-foreground" />
                    <span>
                      <span className="block text-sm font-bold text-foreground">
                        Different documents — sort them for me
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {pages.length > MAX_SCAN_FILES
                          ? `Power Scan takes up to ${MAX_SCAN_FILES} photos at a time. Remove some pages to use it.`
                          : 'Power Scan reads every photo and files each document separately. You review before anything is saved.'}
                      </span>
                    </span>
                  </button>
                </div>
              ) : (
                <ol className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  {pages.map((p, i) => (
                    <li key={p.id} className="relative overflow-hidden rounded-xl border border-border bg-muted">
                      {/* eslint-disable-next-line @next/next/no-img-element -- local object URL */}
                      <img src={p.url} alt={`Page ${i + 1}`} className="aspect-[3/4] w-full object-cover" />
                      <span className="absolute left-2 top-2 rounded-md bg-black/60 px-1.5 py-0.5 text-2xs font-bold text-white">
                        {i + 1}
                      </span>
                      <div className="absolute inset-x-0 bottom-0 flex items-center justify-between bg-black/50 p-1">
                        <Button
                          type="button" variant="ghost" size="icon"
                          className="h-8 w-8 text-white hover:bg-white/20"
                          disabled={i === 0 || Boolean(busy)}
                          onClick={() => move(i, -1)}
                          aria-label={`Move page ${i + 1} earlier`}
                        >
                          <ChevronLeft size={16} />
                        </Button>
                        <Button
                          type="button" variant="ghost" size="icon"
                          className="h-8 w-8 text-white hover:bg-destructive/60"
                          disabled={Boolean(busy)}
                          onClick={() => remove(p.id)}
                          aria-label={`Remove page ${i + 1}`}
                        >
                          <Trash2 size={15} />
                        </Button>
                        <Button
                          type="button" variant="ghost" size="icon"
                          className="h-8 w-8 text-white hover:bg-white/20"
                          disabled={i === pages.length - 1 || Boolean(busy)}
                          onClick={() => move(i, 1)}
                          aria-label={`Move page ${i + 1} later`}
                        >
                          <ChevronRight size={16} />
                        </Button>
                      </div>
                    </li>
                  ))}
                  <li>
                    <button
                      type="button"
                      onClick={() => cameraRef.current?.click()}
                      disabled={full || Boolean(busy)}
                      className={cn(
                        'flex aspect-[3/4] w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-primary/50 text-primary transition-colors',
                        'hover:bg-primary/5 disabled:cursor-not-allowed disabled:opacity-50',
                      )}
                    >
                      <Camera size={28} />
                      <span className="text-sm font-semibold">Add page</span>
                    </button>
                  </li>
                </ol>
              )}

              {busy && (
                <p className="mt-3 flex items-center justify-center gap-2 text-xs text-muted-foreground">
                  <Loader2 size={14} className="animate-spin" /> {busy}
                </p>
              )}
              {error && <p className="mt-3 text-center text-xs font-medium text-danger-text">{error}</p>}
              {!choosing && full && (
                <p className="mt-3 text-center text-xs text-muted-foreground">
                  Maximum of {MAX_SCAN_PAGES} pages reached.
                </p>
              )}
            </div>

            <DialogFooter>
              {choosing ? (
                <Button type="button" variant="ghost" onClick={() => setChoosing(false)} disabled={Boolean(busy)}>
                  Back to pages
                </Button>
              ) : (
                <>
                  <Button type="button" variant="ghost" onClick={reset} disabled={Boolean(busy)}>
                    Cancel
                  </Button>
                  <Button
                    type="button" variant="secondary"
                    onClick={() => galleryRef.current?.click()}
                    disabled={full || Boolean(busy)}
                  >
                    <ImagePlus size={15} className="mr-1.5" /> From gallery
                  </Button>
                  <Button type="button" onClick={done} disabled={pages.length === 0 || Boolean(busy)}>
                    Done ({pages.length} {pages.length === 1 ? 'page' : 'pages'})
                  </Button>
                </>
              )}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </>
    );
  },
);

export default MultiPageCapture;
