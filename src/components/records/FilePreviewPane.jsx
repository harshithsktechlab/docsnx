'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  AlertCircle, ChevronLeft, ChevronRight, FileText, Loader2, RotateCcw, RotateCw, Save,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { fetchRecordBlob } from '@/lib/sharePrintHelper';
import { canDisplayPdf, previewKind } from '@/lib/records/inlineRender';
import { rotateImageUrl } from '@/lib/records/rotateImage';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   ONE DOCUMENT, RENDERED IN PLACE — from the vault or from the picker    ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Every preview in the app comes through here: the Document Manager, the
 * sub-category workspace, all eleven legacy module pages, and both halves of
 * the duplicate prompt. It was written for two of those and copied badly into
 * the rest — the copies pointed <img>/<iframe> straight at the file route,
 * which cannot work (see below), and guessed the file type from a path that
 * carries no extension.
 *
 * ── WHY A BLOB, ALWAYS ─────────────────────────────────────────────────────
 * Pointing an <iframe> at the file route gets refused outright: every route
 * carries `X-Frame-Options: DENY` (next.config.mjs) and the file route itself
 * replies `default-src 'none'; … sandbox`. Fetching the bytes and framing a
 * blob leaves all of that hardening in place and surfaces the route's own error
 * body instead of a blank box. A locally chosen `File` is framed the same way
 * for the same reason it is the only way that works for the stored half —
 * one code path, one set of states.
 *
 * ── WHY `render=1`, AND WHY THE RENDERER IS PICKED FROM THE RESPONSE ───────
 * The vault accepts eighteen file types and a browser draws six. `render=1`
 * asks the route for a form it CAN draw — a .docx comes back as a PDF, a HEIC
 * as a JPEG, an SVG flattened to a PNG — so what arrives is always one of
 * pdf / image / text, or a 415 saying why not.
 *
 * That is also why nothing here consults the record's `mimeType` column. The
 * column is the original upload's type and disagrees with the bytes constantly:
 * a PDF stored split is JPEG pages, a HEIC was normalised at upload. The served
 * `Content-Type` is the only thing that describes what is actually in hand.
 *
 * Text is the one kind NOT drawn from a blob URL — it is rendered as text
 * through React. A blob URL inherits this document's origin, so framing
 * uploaded bytes is only ever safe for the types the route promises.
 *
 * `source` is one of:
 *   · `{ kind: 'record', filePath, mimeType, name, fileSize, pageCount }` — a
 *     stored record. `filePath` is the servable path the API derived; a record
 *     with no stored bytes has none, and renders the card.
 *   · `{ kind: 'file', file }` — a browser `File` straight off the picker.
 *   · `null` — nothing to show at all.
 */
export default function FilePreviewPane({
  source,
  /** Overrides the wording of the "nothing to show" card. Optional. */
  emptyMessage = '',
  className = '',
  /** Rendered inside the card shown when there is nothing to display — the
   *  Document Manager offers a download there, which is the only way to read a
   *  .docx or .xlsx at all. */
  fallbackAction = null,
  /** The turn saved on the record (0 | 90 | 180 | 270, degrees clockwise). */
  rotation = 0,
  /**
   * Saves a new turn: `(degrees) => Promise`, rejecting on failure. Omit it and
   * the buttons still turn the image for this session, but nothing is
   * remembered — a picked `File` has no record to remember it on, and a member
   * who may only view one should not rewrite it for everyone else.
   */
  onRotate = /** @type {((degrees: number) => Promise<unknown>) | undefined} */ (undefined),
  /**
   * Makes a turn PERMANENT: `(degrees) => Promise<{ mode: 'file' | 'view' }>`,
   * rejecting on failure (see `applyRotation`). When given it replaces
   * `onRotate`: the buttons only turn a DRAFT, and a "Save rotation" button
   * rewrites the stored file so download and print come out upright too.
   * `mode: 'view'` means the type could not be rewritten and only the display
   * preference was kept.
   */
  onSaveRotation = /** @type {((degrees: number) => Promise<{ mode?: string } | void>) | undefined} */ (undefined),
  /** A modal with room to spare: give a PDF most of the viewport's height
   *  instead of the 350px minimum, which showed a whole page as a postage stamp. */
  tall = false,
}) {
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const [servedType, setServedType] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  // The bytes behind `url`, so a draft PDF turn can be made without fetching a
  // blob: URL back (which a connect-src policy may refuse).
  const [blob, setBlob] = useState(null);
  // Bumped after a save so the stored file is fetched again, now turned.
  const [reloadKey, setReloadKey] = useState(0);
  const [saving, setSaving] = useState(false);

  const isFile = source?.kind === 'file';
  const file = isFile ? source.file : null;
  const name = isFile ? (file?.name || 'This file') : (source?.name || 'This document');
  const filePath = source?.kind === 'record' ? source.filePath : null;
  const renderable = isFile ? Boolean(file) : Boolean(filePath);

  /**
   * ── EVERY PIECE OF PER-DOCUMENT STATE IS KEYED TO ITS DOCUMENT ────────────
   *
   * Not reset in an effect. An effect runs AFTER the render that already fired
   * the fetch, so opening a second record while the first was on page three
   * asked for page three of the new one — a 404 and a visible error flash
   * before the reset landed, and a pager still showing the previous document's
   * length. Deriving both from a key is synchronous: a new document is on page
   * one, with no inherited page count, before anything is requested.
   */
  const sourceKey = isFile ? `${file?.name}:${file?.size}` : (filePath || '');
  const [pageState, setPageState] = useState({ key: sourceKey, page: 1 });
  const page = pageState.key === sourceKey ? pageState.page : 1;

  /**
   * The page count the ROUTE reported, where it knew better than the record.
   *
   * A PDF stored whole is one vault page however many sheets are inside it, so
   * `source.pageCount` says 1 for a ten-page agreement and the pager never
   * appeared. Only the rasteriser can count them, and it says so in a header.
   */
  const [servedPages, setServedPages] = useState({ key: sourceKey, count: 0 });
  const servedPageCount = servedPages.key === sourceKey ? servedPages.count : 0;
  const pageCount = isFile
    ? 1
    : Math.max(servedPageCount, Number(source?.pageCount) || 0, 1);

  const goToPage = (next) => setPageState({
    key: sourceKey,
    page: Math.min(pageCount, Math.max(1, next)),
  });

  const kind = previewKind(servedType);

  /**
   * ── THE TURN: SAVED ON THE RECORD, KEYED TO ITS DOCUMENT ──────────────────
   *
   * Same keying as the page above, for the same reason: a turn made on one
   * document must not follow the member into the next. `rotation` is the saved
   * value; `turnState` only exists once they have pressed a button.
   */
  const saved = normaliseTurn(rotation);
  const [turnState, setTurnState] = useState({ key: sourceKey, deg: saved });
  const deg = turnState.key === sourceKey ? turnState.deg : saved;
  // The last value the server confirmed, to fall back to when a save fails.
  const confirmed = useRef({ key: sourceKey, deg: saved });
  // Saves go out one at a time, in order, so a fast double press cannot land
  // the older value last.
  const saveChain = useRef(Promise.resolve());
  if (confirmed.current.key !== sourceKey) confirmed.current = { key: sourceKey, deg: saved };

  // Set when the server could only keep the turn as a display preference (a
  // HEIC, a TIFF…): `deg` is then already saved, so there is nothing to offer.
  const [viewSaved, setViewSaved] = useState({ key: '', deg: 0 });
  const baseline = viewSaved.key === sourceKey ? viewSaved.deg : 0;
  const canSave = Boolean(onSaveRotation) && !isFile;
  const dirty = canSave && deg !== baseline;

  const save = async () => {
    if (!canSave || saving || !dirty) return;
    const forKey = sourceKey;
    const forDeg = deg;
    setSaving(true);
    try {
      const outcome = await onSaveRotation(forDeg);
      if (outcome?.mode === 'view') {
        setViewSaved({ key: forKey, deg: forDeg });
        toast.message('Saved for viewing only', {
          id: 'preview-rotation',
          description: 'This file type cannot be rotated permanently, so downloads stay as scanned.',
        });
      } else {
        setTurnState({ key: forKey, deg: 0 });
        setViewSaved({ key: forKey, deg: 0 });
        setReloadKey((k) => k + 1);
        toast.success('Rotation saved to the file', { id: 'preview-rotation' });
      }
    } catch (err) {
      toast.error(err?.message || 'Could not save the rotation', { id: 'preview-rotation' });
    } finally {
      setSaving(false);
    }
  };

  const turn = (delta) => {
    const next = normaliseTurn(deg + delta);
    setTurnState({ key: sourceKey, deg: next });
    // With a Save button the turn is a draft: nothing is remembered until it is
    // pressed. Without one, the old behaviour — remembered as it is made.
    if (!onRotate || onSaveRotation) return;
    const forKey = sourceKey;
    saveChain.current = saveChain.current
      .then(() => onRotate(next))
      .then(() => { confirmed.current = { key: forKey, deg: next }; })
      .catch(() => {
        toast.error('Could not save the rotation', { id: 'preview-rotation' });
        if (confirmed.current.key === forKey) {
          setTurnState({ key: forKey, deg: confirmed.current.deg });
        }
      });
  };

  // The turned image, made once per (image, turn). Until it is ready — or if
  // this browser cannot make it — the original is shown rather than nothing.
  const [turned, setTurned] = useState({ src: '', deg: 0, out: '' });
  useEffect(() => {
    if (kind !== 'image' || !url || deg === 0) return undefined;
    let cancelled = false;
    let made = '';
    rotateImageUrl(url, deg)
      .then((out) => {
        if (cancelled) {
          if (out !== url) URL.revokeObjectURL(out);
          return;
        }
        made = out;
        setTurned({ src: url, deg, out });
      })
      .catch(() => {
        if (!cancelled) toast.error('This image is too large to rotate here', { id: 'preview-rotation' });
      });
    return () => {
      cancelled = true;
      if (made && made !== url) URL.revokeObjectURL(made);
    };
  }, [kind, url, deg]);
  const shownUrl = deg !== 0 && turned.src === url && turned.deg === deg ? turned.out : url;

  // The same for a PDF, turned by setting each page's /Rotate (pdf-lib, loaded
  // only when a PDF is actually turned). The server uses the very same function
  // to make it permanent, so what is previewed here is what gets stored.
  const [turnedPdf, setTurnedPdf] = useState({ src: '', deg: 0, out: '' });
  useEffect(() => {
    if (kind !== 'pdf' || !url || !blob || deg === 0) return undefined;
    let cancelled = false;
    let made = '';
    (async () => {
      const { rotatePdfBytes } = await import('@/lib/records/rotatePdf');
      const out = await rotatePdfBytes(new Uint8Array(await blob.arrayBuffer()), deg);
      const objectUrl = URL.createObjectURL(new Blob([out], { type: 'application/pdf' }));
      if (cancelled) {
        URL.revokeObjectURL(objectUrl);
        return;
      }
      made = objectUrl;
      setTurnedPdf({ src: url, deg, out: objectUrl });
    })().catch(() => {
      if (!cancelled) toast.error('This PDF could not be rotated here', { id: 'preview-rotation' });
    });
    return () => {
      cancelled = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [kind, url, blob, deg]);
  const shownPdfUrl = deg !== 0 && turnedPdf.src === url && turnedPdf.deg === deg ? turnedPdf.out : url;

  useEffect(() => {
    if (!renderable) {
      setUrl('');
      setText('');
      setServedType('');
      setError('');
      setLoading(false);
      return undefined;
    }

    let revoked = false;
    let objectUrl = '';
    setError('');
    setText('');

    // A local file needs no round trip — and no decryption, because it has
    // never been sealed. Nor any conversion: what the picker just handed over
    // is what the browser will or will not draw, and the fallback card below
    // says so honestly.
    if (isFile) {
      const localType = file?.type || '';
      setServedType(localType);

      // Text is the one kind read rather than framed, here as much as for a
      // stored record — and it has to be read from the File itself. Handing the
      // text renderer nothing but an object URL drew an empty <pre>, so a .txt
      // or .csv on the "uploading now" side of the duplicate prompt was a blank
      // panel next to a perfectly legible one.
      if (previewKind(localType) === 'text') {
        setLoading(true);
        file.text()
          .then((body) => { if (!revoked) setText(body); })
          .catch(() => { if (!revoked) setError('This file could not be read.'); })
          .finally(() => { if (!revoked) setLoading(false); });
        return () => { revoked = true; };
      }

      objectUrl = URL.createObjectURL(file);
      setBlob(file);
      setUrl(objectUrl);
      setLoading(false);
      return () => {
        revoked = true;
        URL.revokeObjectURL(objectUrl);
        setUrl('');
      };
    }

    setLoading(true);
    // `asImage` where this browser has no PDF viewer — every phone, and the
    // installed PWA. See canDisplayPdf: without it a converted .docx arrives as
    // a PDF the browser will only offer to download, from a blob: URL that in a
    // PWA opens nothing at all.
    fetchRecordBlob(filePath, { page, render: true, asImage: !canDisplayPdf() })
      .then((made) => {
        // The dialog may already have closed; don't leak the URL we just made.
        if (revoked) {
          if (made.url) URL.revokeObjectURL(made.url);
          return;
        }
        objectUrl = made.url || '';
        setBlob(made.blob || null);
        setUrl(made.url || '');
        setText(made.text || '');
        setServedType(made.mimeType || '');
        if (made.pageCount) setServedPages({ key: sourceKey, count: made.pageCount });
      })
      .catch((err) => {
        if (!revoked) setError(err.message || 'Could not open this document.');
      })
      .finally(() => {
        if (!revoked) setLoading(false);
      });

    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setUrl('');
    };
  }, [renderable, isFile, file, filePath, page, reloadKey]);

  const frame = `flex flex-col overflow-hidden rounded-xl bg-background/25 p-3 ${className}`;
  const centred = 'flex flex-1 items-center justify-center overflow-auto';

  /** Prev/next, shown only when there is more than one page to move between. */
  const pager = pageCount > 1 ? (
    <div className="mt-2 flex shrink-0 items-center justify-center gap-3">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 gap-1 px-2"
        disabled={page <= 1 || loading}
        onClick={() => goToPage(page - 1)}
      >
        <ChevronLeft size={14} />
        <span className="text-xs">Prev</span>
      </Button>
      <span className="text-xs font-medium text-muted-foreground">
        Page {page} of {pageCount}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 gap-1 px-2"
        disabled={page >= pageCount || loading}
        onClick={() => goToPage(page + 1)}
      >
        <span className="text-xs">Next</span>
        <ChevronRight size={14} />
      </Button>
    </div>
  ) : null;

  /** Rotate left / right — images and PDFs; a text preview has nothing to turn.
   *  With `onSaveRotation`, a Save button appears once there is a turn to keep. */
  const turnBar = (
    <div className="mt-2 flex shrink-0 items-center justify-center gap-1">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 gap-1 px-2"
        aria-label="Rotate left"
        title="Rotate left"
        disabled={saving}
        onClick={() => turn(-90)}
      >
        <RotateCcw size={14} />
        <span className="text-xs">Rotate left</span>
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 gap-1 px-2"
        aria-label="Rotate right"
        title="Rotate right"
        disabled={saving}
        onClick={() => turn(90)}
      >
        <RotateCw size={14} />
        <span className="text-xs">Rotate right</span>
      </Button>
      {dirty && (
        <Button
          type="button"
          size="sm"
          className="ml-2 h-7 gap-1 px-3"
          disabled={saving}
          title="Rotate the stored file so downloads and prints are upright too"
          onClick={save}
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          <span className="text-xs">{saving ? 'Saving…' : 'Save rotation'}</span>
        </Button>
      )}
    </div>
  );

  if (!source) {
    return (
      <div className={frame}>
        <div className={centred}>
          <div className="flex flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground">
            <FileText size={36} className="text-faint" />
            <p className="text-xs">{emptyMessage || 'Nothing to preview.'}</p>
            {fallbackAction}
          </div>
        </div>
      </div>
    );
  }

  // Also spin on the first render after opening, before the effect has flipped
  // `loading` — otherwise the iframe flashes with an empty src.
  if (renderable && (loading || (!url && !text && !error))) {
    return (
      <div className={frame}>
        <div className={centred}>
          <div className="flex flex-col items-center gap-2 text-muted-foreground">
            <Loader2 size={28} className="animate-spin" />
            <p className="text-xs">{isFile ? 'Opening…' : 'Decrypting document…'}</p>
          </div>
        </div>
        {pager}
      </div>
    );
  }

  if (error) {
    return (
      <div className={frame}>
        <div className={centred}>
          <div className="flex flex-col items-center justify-center gap-2 p-6 text-center">
            <AlertCircle size={32} className="text-amber-500/70" />
            <p className="text-xs font-medium text-foreground">{error}</p>
            {fallbackAction}
          </div>
        </div>
        {pager}
      </div>
    );
  }

  if (kind === 'image') {
    return (
      <div className={frame}>
        <div className={centred}>
          <img src={shownUrl} alt={name} className="max-h-full max-w-full rounded-lg object-contain shadow" />
        </div>
        {turnBar}
        {pager}
      </div>
    );
  }

  if (kind === 'pdf') {
    return (
      <div
        className={frame}
        // A definite height, or `h-full` inside the min-height-only flex frame
        // resolves to the 350px minimum and the browser shrinks a whole page into
        // it. `view=FitH` opens at page width so text is legible, and the page
        // scrolls inside the frame.
        style={tall ? { height: 'max(380px, calc(100vh - 320px))', maxHeight: 'none' } : undefined}
      >
        <iframe
          src={`${shownPdfUrl}#toolbar=0&view=FitH`}
          title={`Preview: ${name}`}
          className="min-h-0 w-full flex-1 rounded-lg border-none shadow"
        />
        {turnBar}
        {pager}
      </div>
    );
  }

  if (kind === 'text') {
    return (
      <div className={frame}>
        {/* Rendered as TEXT, never framed: a blob URL inherits this origin. */}
        <pre className="flex-1 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-background/40 p-3 text-left font-mono text-xs text-foreground">
          {text}
        </pre>
        {pager}
      </div>
    );
  }

  return (
    <div className={frame}>
      <div className={centred}>
        <div className="flex flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground">
          <FileText size={36} className="text-faint" />
          <p className="text-xs font-medium text-foreground">{name}</p>
          <p className="text-xs">
            {emptyMessage || (servedType
              ? 'This file type cannot be shown here.'
              : 'This record has no stored file.')}
          </p>
          {fallbackAction}
        </div>
      </div>
      {pager}
    </div>
  );
}

/** Any number of degrees as one of 0 | 90 | 180 | 270. Junk is upright. */
function normaliseTurn(degrees) {
  const n = Math.round(Number(degrees) / 90);
  return Number.isFinite(n) ? (((n % 4) + 4) % 4) * 90 : 0;
}

/** Bytes as something a person reads without counting zeroes. */
export function formatBytes(bytes) {
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
