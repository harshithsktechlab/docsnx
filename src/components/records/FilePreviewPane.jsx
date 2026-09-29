'use client';

import { useEffect, useState } from 'react';
import { AlertCircle, ChevronLeft, ChevronRight, FileText, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { fetchRecordBlob } from '@/lib/sharePrintHelper';
import { canDisplayPdf, previewKind } from '@/lib/records/inlineRender';

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
}) {
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const [servedType, setServedType] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

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
  }, [renderable, isFile, file, filePath, page]);

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

  const kind = previewKind(servedType);

  if (kind === 'image') {
    return (
      <div className={frame}>
        <div className={centred}>
          <img src={url} alt={name} className="max-h-full max-w-full rounded-lg object-contain shadow" />
        </div>
        {pager}
      </div>
    );
  }

  if (kind === 'pdf') {
    return (
      <div className={frame}>
        <iframe
          src={`${url}#toolbar=0`}
          title={`Preview: ${name}`}
          className="h-full w-full flex-1 rounded-lg border-none shadow"
        />
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

/** Bytes as something a person reads without counting zeroes. */
export function formatBytes(bytes) {
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
