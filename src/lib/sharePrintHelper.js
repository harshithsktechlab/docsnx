/**
 * Client-side utility for Sharing, Printing, and Exporting records to PDF
 */

import { canDisplayPdf, previewKind } from '@/lib/records/inlineRender';
import { extensionForMime } from '@/lib/records/uploadTypes';

/**
 * Resolves a dynamic API URL for uploaded files served securely from the backend.
 * @param {string} filePath - File path stored in database (e.g. /uploads/filename)
 * @returns {string} Fully qualified or relative URL to access the file
 */
export function getFileUrl(filePath) {
  if (!filePath) return '';
  if (filePath.startsWith('/uploads/')) {
    const filename = filePath.substring('/uploads/'.length);
    return `/api/uploads/${filename}`;
  }
  return filePath;
}

/**
 * Fetches a record's decrypted bytes in a form the browser can draw.
 *
 * Vault files cannot be rendered by pointing an <img>/<iframe> straight at
 * `filePath`: next.config.mjs stamps `X-Frame-Options: DENY` onto every route,
 * and the file route itself replies with `default-src 'none'; … sandbox`, so
 * the browser refuses to display the response in a frame. A blob: URL carries
 * no headers at all, so it renders — and it lets the caller show the route's
 * JSON error instead of a silently blank box.
 *
 * ── WHY `render` EXISTS ────────────────────────────────────────────────────
 * With `{ render: true }` the ROUTE decides what comes back: a .docx arrives as
 * a PDF, a HEIC as a JPEG, an SVG flattened to a PNG. That is the only way the
 * twelve accepted-but-unviewable types are viewable at all, and it is why the
 * returned `mimeType` matters — it describes what was SERVED, which for half
 * the vault is not what the record's `mimeType` column says. Callers pick their
 * renderer from the returned value, never from the column.
 *
 * WHAT SURVIVES: the fetch is still authenticated, tenant-scoped and permission
 * -checked by the route, and `render=1` is gated on `view` like any read.
 *
 * WHAT DOES NOT: createObjectURL keeps only the MIME type. `sandbox`, the CSP,
 * `nosniff`, `no-store` and the forced `Content-Disposition: attachment` for SVG
 * are all dropped, and the blob inherits the CALLING DOCUMENT'S ORIGIN. So the
 * caller — not this function — owns deciding what is safe to render: framing a
 * blob of an uploaded .html would run its scripts at the app origin. Callers
 * must allowlist the types they render (see previewKind in inlineRender.ts).
 *
 * Text comes back as a STRING and no object URL is made for it, for that exact
 * reason: text is rendered through React, never framed.
 *
 * The caller owns any returned `url` and must URL.revokeObjectURL() it.
 *
 * ── `asImage`, FOR A CLIENT WITH NO PDF VIEWER ─────────────────────────────
 * Every phone. See `canDisplayPdf` — this asks the route to rasterise the page
 * rather than send a PDF the browser will only offer to download. The route
 * answers with `X-Preview-Page-Count`, which is the ONLY account of how many
 * sheets a single stored PDF holds; the record's own `pageCount` says 1.
 *
 * @param {string} filePath - `filePath` as stored on the record
 * @param {{page?: number, render?: boolean, asImage?: boolean}} [options]
 * @returns {Promise<{mimeType: string, url?: string, text?: string, pageCount?: number}>}
 */
export async function fetchRecordBlob(filePath, options = {}) {
  const { page, render, asImage } = options;
  const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost';
  // Built as a URL rather than concatenated so a path that already carries a
  // query string keeps it.
  const url = new URL(getFileUrl(filePath), origin);
  if (render) url.searchParams.set('render', '1');
  if (render && asImage) url.searchParams.set('as', 'image');
  // Omitted for page one: legacy /uploads/* is a static handler that knows
  // nothing about pages, and every existing link expects the bare form.
  if (page && page > 1) url.searchParams.set('page', String(page));

  const res = await fetch(url.toString());
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    if (body.status === 'VAULT_FILE_MISSING') {
      throw new Error('This record has no stored file yet.');
    }
    throw new Error(body.message || body.error || 'Could not open this file.');
  }

  const mimeType = res.headers.get('Content-Type') || 'application/octet-stream';
  const counted = Number(res.headers.get('X-Preview-Page-Count'));
  const pageCount = Number.isFinite(counted) && counted > 0 ? counted : undefined;

  if (mimeType.split(';')[0].trim() === 'text/plain') {
    return { mimeType, pageCount, text: await res.text() };
  }
  return { mimeType, pageCount, url: URL.createObjectURL(await res.blob()) };
}

/**
 * Shares ONE record — the file itself where the device can carry it.
 *
 * ── WHY THIS NO LONGER SHARES A LINK ───────────────────────────────────────
 * It used to put `origin + /api/records/<scope>/<id>/file` into the share sheet.
 * On WhatsApp that arrives as an opaque URL the recipient cannot open: the route
 * demands a session cookie, an active plan, membership of the SAME tenant and
 * `view` on the record's category. Someone outside the tenant gets a 401, and
 * the vault path carries no title or extension, so the message reads as a
 * meaningless "encrypted link". Sharing a link that only works for people who
 * already have the app open on that record is sharing nothing.
 *
 * So this now does exactly what `shareRecords` does — fetch the decrypted bytes
 * through the app's own route and hand real `File` objects to the share sheet —
 * and simply delegates to it. Everything below the delegation (the file fetch,
 * the text sheet, the clipboard) lives in one place for the single and the bulk
 * case alike.
 *
 * @param {string} title - Title of the record
 * @param {Array<{label: string, value: any}>} fields - Key-value details of the record
 * @param {string} [detailsText] - Long description or notes
 * @param {string} [filePath] - Attached file path if present
 * @param {{fileName?: string, mimeType?: string, pageCount?: number}} [fileMeta]
 *        What the attachment IS. Every module's API already returns these three
 *        on the record; without them a shared vault file lands as an
 *        extensionless blob that WhatsApp will not preview.
 * @returns {Promise<{success: boolean, method: 'share-files'|'share'|'copy'|null, reason?: 'aborted'}>}
 */
export async function shareRecord(title, fields, detailsText, filePath, fileMeta) {
  return shareRecords([{
    title,
    fields,
    details: detailsText,
    filePath,
    fileName: fileMeta?.fileName,
    mimeType: fileMeta?.mimeType,
    pageCount: fileMeta?.pageCount,
  }]);
}

/**
 * How many pages one record may contribute to a print job.
 *
 * Each page is a separate fetch that re-decrypts from Drive, so an unbounded
 * loop over a two-hundred-page agreement holds the browser for minutes with no
 * sign of progress. Fifty covers every household document there is; beyond it
 * the sheet says what was left out rather than quietly printing a fraction.
 */
const MAX_PRINT_PAGES = 50;

/**
 * Every page of one record, in a form the browser will PRINT.
 *
 * ── WHY THIS DECIDES `asImage` RATHER THAN THE CALLER ──────────────────────
 * Printing has the same problem previewing does: no phone can frame a PDF, so
 * `iframe.src = <pdf blob>` sends a blank job to the printer with no error
 * anywhere. Where `canDisplayPdf()` says no, the route rasterises and every
 * page composes into an ordinary HTML document instead — which is the only way
 * a phone prints a stored PDF at all.
 *
 * A PDF therefore comes back from here ONLY when this client can display one,
 * and it always comes back alone: it is the whole job on its own.
 *
 * @param {string} filePath
 * @param {{pageCountHint?: number}} [options] What the record claims, which is
 *        a floor — a PDF stored whole is one vault page holding many sheets,
 *        and only the route's own count knows how many.
 * @returns {Promise<Array<{mimeType: string, url?: string, text?: string}>>}
 */
async function fetchPreviewPages(filePath, options = {}) {
  const asImage = !canDisplayPdf();
  const pages = [];
  let total = Math.max(1, Number(options.pageCountHint) || 1);

  for (let page = 1; page <= Math.min(total, MAX_PRINT_PAGES); page += 1) {
    const got = await fetchRecordBlob(filePath, { page, render: true, asImage });
    if (got.pageCount && got.pageCount > total) total = got.pageCount;
    pages.push(got);
    if (previewKind(got.mimeType) === 'pdf') return [got];
  }

  if (total > MAX_PRINT_PAGES) {
    pages.push({
      mimeType: 'text/plain',
      text: `… ${total - MAX_PRINT_PAGES} further page(s) are not included in this `
        + 'print. Download the document to print it in full.',
    });
  }
  return pages;
}

/** One fetched page as a sheet in a composed print document. */
function printablePage(page) {
  const kind = previewKind(page.mimeType);
  if (kind === 'image') return `<div class="sheet"><img src="${page.url}" alt="" /></div>`;
  if (kind === 'text') return `<div class="sheet"><pre>${escapeHtml(page.text)}</pre></div>`;
  return '';
}

/**
 * Prints a record cleanly using browser's native print engine in an isolated iframe.
 * If filePath is present, prints the file itself.
 *
 * ── WHY THE BYTES AND NOT THE URL ──────────────────────────────────────────
 * This used to set `iframe.src = getFileUrl(filePath)`, which never printed
 * anything: `X-Frame-Options: DENY` refuses the file route in a frame, so the
 * job went to the printer blank. It also guessed image-vs-PDF from the path
 * extension, and a vault path — `/api/records/<scope>/<id>/file` — has none, so
 * every vault record took the PDF branch whatever it held.
 *
 * Fetching with `render=1` answers both: the bytes come back as a blob the
 * frame will accept, already converted to something printable (a .docx prints
 * as its rendered PDF), and the SERVED content type says which branch to take.
 *
 * @param {string} title - Title of the record
 * @param {Array<{label: string, value: any}>} fields - Key-value details of the record
 * @param {string} [detailsText] - Long description or notes
 * @param {string} [filePath] - Attached file path if present
 * @returns {Promise<{success: boolean, error?: string}>}
 *          Reported rather than only logged: a preview the server declines to
 *          render answers 415 with a reason worth showing, and the caller is
 *          the only one holding a toast.
 */
export async function printRecord(title, fields, detailsText, filePath) {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return { success: false, error: 'Printing is not available here.' };
  }

  if (hasAttachment(filePath)) {
    let pages;
    try {
      pages = await fetchPreviewPages(filePath);
    } catch (err) {
      console.error('Could not open the attached file for printing:', err);
      return { success: false, error: err.message };
    }
    if (pages.length === 0) {
      return { success: false, error: 'Could not open this file.' };
    }

    // Create temporary iframe for printing the file directly
    const iframe = document.createElement('iframe');
    iframe.style.position = 'fixed';
    iframe.style.right = '0';
    iframe.style.bottom = '0';
    iframe.style.width = '0';
    iframe.style.height = '0';
    iframe.style.border = '0';
    document.body.appendChild(iframe);

    const release = () => {
      if (iframe.parentNode) document.body.removeChild(iframe);
      // Decrypted bytes — not left alive until the page unloads.
      pages.forEach((p) => { if (p.url) URL.revokeObjectURL(p.url); });
    };

    // A PDF is its own job — it cannot be composed into a host document that
    // browsers will print. `fetchPreviewPages` only ever returns one when this
    // client HAS a viewer for it, so framing it here is safe by construction.
    if (previewKind(pages[0].mimeType) === 'pdf') {
      iframe.src = pages[0].url;
      iframe.onload = () => {
        iframe.contentWindow.focus();
        iframe.contentWindow.print();
        setTimeout(release, 1000);
      };
      return { success: true };
    }

    // Otherwise every page composes into one document, each on its own sheet —
    // which is how a phone prints a PDF at all, since it has no viewer to frame.
    const doc = iframe.contentWindow.document;
    doc.write(`
      <html>
        <head><style>
          body { margin: 0; }
          .sheet { page-break-after: always; text-align: center; }
          .sheet:last-child { page-break-after: auto; }
          .sheet img { max-width: 100%; max-height: 100vh; object-fit: contain; }
          pre { white-space: pre-wrap; word-break: break-word; padding: 24px;
                font-size: 12px; text-align: left; }
        </style></head>
        <body>${pages.map(printablePage).join('')}</body>
      </html>
    `);
    doc.close();
    iframe.contentWindow.focus();
    setTimeout(() => {
      iframe.contentWindow.print();
      setTimeout(release, 1000);
    }, 500);
    return { success: true };
  }

  let fieldsHtml = '';
  fields.forEach(f => {
    if (f && f.value !== undefined && f.value !== null && f.value !== '') {
      fieldsHtml += `
        <div class="field">
          <div class="label">${f.label}</div>
          <div class="value">${f.value}</div>
        </div>
      `;
    }
  });

  let detailsHtml = '';
  if (detailsText) {
    detailsHtml += `
      <div class="section" style="margin-top: 24px;">
        <div class="section-title">Details & Notes</div>
        <div class="details">${detailsText}</div>
      </div>
    `;
  }

  const htmlContent = `
    <h1>${title}</h1>
    <div class="section">
      <div class="section-title">Record Details</div>
      <div class="grid">
        ${fieldsHtml}
      </div>
    </div>
    ${detailsHtml}
  `;

  // Create temporary iframe for printing text content
  const iframe = document.createElement('iframe');
  iframe.style.position = 'fixed';
  iframe.style.right = '0';
  iframe.style.bottom = '0';
  iframe.style.width = '0';
  iframe.style.height = '0';
  iframe.style.border = '0';
  document.body.appendChild(iframe);

  const doc = iframe.contentWindow.document;
  doc.write(`
    <html>
      <head>
        <title>${title}</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            color: #1e293b;
            padding: 40px;
            line-height: 1.6;
            background: #fff;
          }
          h1 {
            color: #0f172a;
            border-bottom: 2px solid #e2e8f0;
            padding-bottom: 12px;
            font-size: 22px;
            margin-bottom: 24px;
            font-weight: 800;
          }
          .section {
            margin-bottom: 24px;
          }
          .section-title {
            font-size: 11px;
            font-weight: 700;
            text-transform: uppercase;
            color: #64748b;
            letter-spacing: 0.05em;
            margin-bottom: 12px;
          }
          .grid {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 16px;
            margin-bottom: 20px;
          }
          .field {
            margin-bottom: 12px;
          }
          .label {
            font-size: 10px;
            color: #64748b;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.02em;
            margin-bottom: 2px;
          }
          .value {
            font-size: 14px;
            font-weight: 600;
            color: #0f172a;
          }
          .details {
            background-color: #f8fafc;
            border: 1px solid #e2e8f0;
            padding: 16px;
            border-radius: 8px;
            white-space: pre-wrap;
            font-size: 13px;
            color: #334155;
          }
          @media print {
            body { padding: 20px; }
          }
        </style>
      </head>
      <body>
        ${htmlContent}
      </body>
    </html>
  `);
  doc.close();

  iframe.contentWindow.focus();
  setTimeout(() => {
    iframe.contentWindow.print();
    // Clean up after print dialog is closed
    setTimeout(() => {
      if (iframe.parentNode) {
        document.body.removeChild(iframe);
      }
    }, 1000);
  }, 500);

  return { success: true };
}

/**
 * Triggers the download of the uploaded document if present, or exports the record details as a text file.
 * @param {string} title - Title of the record
 * @param {Array<{label: string, value: any}>} fields - Key-value details of the record
 * @param {string} [detailsText] - Long description or notes
 * @param {string} [filePath] - Attached file path if present
 */
export async function downloadRecord(title, fields, detailsText, filePath) {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  if (filePath && filePath !== 'n/a' && filePath !== 'null' && filePath !== 'undefined') {
    const fileUrl = getFileUrl(filePath);
    const a = document.createElement('a');
    a.href = fileUrl;
    const parts = filePath.split('/');
    a.download = parts[parts.length - 1] || 'document';
    a.target = '_blank';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    return;
  }

  // Generate PDF using jsPDF
  try {
    const { jsPDF } = await import('jspdf');
    const doc = new jsPDF();
    let yPos = 20;
    
    doc.setFontSize(16);
    doc.setFont('helvetica', 'bold');
    doc.text(title.toUpperCase(), 14, yPos);
    yPos += 15;
    
    doc.setFontSize(10);
    doc.setFont('helvetica', 'bold');
    doc.text('Record Details', 14, yPos);
    yPos += 8;
    
    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    fields.forEach(f => {
      if (f && f.value !== undefined && f.value !== null && f.value !== '') {
        doc.text(`${f.label}: ${f.value}`, 14, yPos);
        yPos += 7;
        if (yPos > 280) {
          doc.addPage();
          yPos = 20;
        }
      }
    });

    if (detailsText) {
      yPos += 5;
      doc.setFont('helvetica', 'bold');
      doc.text('Notes / Details:', 14, yPos);
      yPos += 7;
      doc.setFont('helvetica', 'normal');
      
      const splitDetails = doc.splitTextToSize(detailsText, 180);
      doc.text(splitDetails, 14, yPos);
      yPos += (splitDetails.length * 6);
    }

    yPos += 15;
    if (yPos > 280) {
      doc.addPage();
      yPos = 20;
    }
    doc.setFontSize(8);
    doc.text(`Generated by DocsNX on ${new Date().toLocaleString()}`, 14, yPos);

    const cleanTitle = title.toLowerCase().replace(/[^a-z0-9]/g, '_');
    doc.save(`docsnx_${cleanTitle}_record.pdf`);
  } catch (error) {
    console.error('Failed to generate PDF:', error);
  }
}


/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   MULTI-RECORD SHARE & PRINT                                            ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The single-record helpers above take one title and one field list, and the
 * Documents list can now act on a filtered SELECTION. Rather than overload them
 * with array branches — `shareRecord` already carries four positional arguments
 * whose order has been got wrong before — these are separate entry points that
 * take the selection as one array of items.
 *
 * An `item` is
 * `{ id, title, fields, details, filePath, fileName, mimeType, pageCount }`,
 * exactly what the page already computes for the single-record buttons.
 *
 * `shareRecord` above is now a thin wrapper over `shareRecords` — one item —
 * because sharing a record and sharing a selection of one differ in nothing but
 * the argument shape, and the single path was the one still sharing a dead link.
 */

/** HTML-escape a value before it goes into the print document. */
function escapeHtml(value) {
  if (value === undefined || value === null) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** One record as plain text, for the share sheet and the clipboard fallback. */
function recordAsText(item) {
  let out = `--- ${item.title} ---\n`;
  (item.fields || []).forEach((f) => {
    if (f && f.value !== undefined && f.value !== null && f.value !== '') {
      out += `${f.label}: ${f.value}\n`;
    }
  });
  if (item.details) {
    out += `\nNotes/Details:\n${item.details}\n`;
  }
  return out;
}

/**
 * A stored `filePath` that actually points at something.
 *
 * The string sentinels are not paranoia: several module pages interpolate a
 * missing path into their record objects, and `'undefined'`/`'null'`/`'n/a'`
 * have all been seen in the column.
 */
function hasAttachment(filePath) {
  return Boolean(filePath)
    && filePath !== 'n/a'
    && filePath !== 'null'
    && filePath !== 'undefined';
}

/**
 * The name one shared file should carry.
 *
 * Sanitised the way `safeEntryName` in the bulk-download route sanitises ZIP
 * entries: `fileName` is user-supplied, and the share sheet hands it to the
 * receiving app which may well write it straight to disk.
 *
 * ── THE EXTENSION COMES FROM WHAT WAS SERVED ───────────────────────────────
 * Not from the record's `mimeType` column. The file route's own comments spell
 * out why the column cannot be trusted about the bytes: a PDF stored split
 * serves `image/jpeg` pages under an `application/pdf` record, and a HEIC was
 * normalised to JPEG at upload. Naming a JPEG `.pdf` is worse than leaving it
 * bare — the receiving app opens it and fails.
 *
 * `extensionForMime` is derived from `ACCEPTED_UPLOAD_TYPES`, so it covers all
 * eighteen types the vault stores. The nine-entry map this replaced left
 * `.docx`, `.xlsx`, `.txt`, `.csv` and `.bmp` extensionless, and Chrome's Web
 * Share refuses a file whose extension it does not recognise — which is why
 * every office document fell through to the clipboard.
 */
function fileNameFor(item, page, servedType, pageCount) {
  const raw = (item.fileName || item.title || 'document');
  const base = String(raw).split(/[\\/]/).pop() || 'document';
  let name = base
    .replace(/[\x00-\x1f<>:"|?*]/g, '_')
    .replace(/^\.+/, '')
    .trim() || 'document';

  const dot = name.lastIndexOf('.');
  let stem = dot > 0 ? name.slice(0, dot) : name;
  let ext = dot > 0 ? name.slice(dot) : '';
  // A stored name whose extension disagrees with the bytes is corrected, for
  // the same reason a missing one is filled: the receiving app acts on the name.
  const served = extensionForMime(servedType);
  if (served && served !== ext.toLowerCase()) ext = served;
  if (!ext) ext = extensionForMime(item.mimeType);
  // Pages are separate files in the share sheet, so they need separate names —
  // three attachments all called "aadhaar.jpg" is what the receiving app sees
  // otherwise.
  if (pageCount > 1) stem = `${stem}-${page}`;
  return `${stem}${ext}`;
}

/**
 * Every page of one record, as `File` objects holding DECRYPTED bytes.
 *
 * ── WHY EVERY PAGE ─────────────────────────────────────────────────────────
 * A scanned document is stored as pages (`pageCount`), each served by the same
 * route under `?page=N`. Fetching only page one — which is all this did while it
 * was inlined in `shareRecords` — silently shares the first sheet of a
 * three-sheet agreement, which is worse than failing.
 *
 * ── WHY `download=1` ───────────────────────────────────────────────────────
 * The file route gates a plain read on `view` and `?download=1` on `share`,
 * because taking a COPY out is what `share` governs. A file handed to the OS
 * share sheet is a copy leaving the app, so it asks for the permission that
 * matches. A member with view-only loses the file and still gets the text sheet.
 *
 * A failed page is skipped rather than thrown: one unreachable page must not
 * sink a share the rest of which is fine. But it is COUNTED — a 403 on every
 * page is a member without `share`, not a broken network, and reporting the two
 * identically is what made "you may not share this" look like "sharing is
 * broken".
 *
 * ── WHY THE PAGES GO IN PARALLEL ───────────────────────────────────────────
 * Every one of these decrypts from Drive, and `NEVER_CACHED` in src/sw.ts
 * forces them past the service worker to the network. Run in series, a
 * five-page scan cost five round-trips before the share sheet could open — long
 * enough for the browser to withdraw the user activation `navigator.share()`
 * requires, which is the whole reason Share fell back to the clipboard. Four at
 * a time keeps that under the limit without opening a connection per page.
 *
 * @returns {Promise<{files: File[], denied: number, failed: number}>}
 */
const PAGE_FETCH_CONCURRENCY = 4;

async function fetchRecordFiles(item) {
  if (!hasAttachment(item.filePath)) return { files: [], denied: 0, failed: 0 };

  const pageCount = Math.max(1, Number(item.pageCount) || 1);
  const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost';
  const pages = Array.from({ length: pageCount }, (_, i) => i + 1);
  const results = new Array(pageCount).fill(null);
  let denied = 0;
  let failed = 0;

  const fetchPage = async (page) => {
    try {
      // Built as a URL rather than concatenated so a path that already carries
      // a query string keeps it.
      const url = new URL(getFileUrl(item.filePath), origin);
      url.searchParams.set('download', '1');
      // Omitted for page one: legacy /uploads/* is a static handler that knows
      // nothing about pages, and every existing link expects the bare form.
      if (page > 1) url.searchParams.set('page', String(page));

      const res = await fetch(url.toString());
      if (!res.ok) {
        // 403 is the file route's `share` gate, and the only status here that
        // describes the MEMBER rather than the request.
        if (res.status === 403) denied += 1;
        else failed += 1;
        return;
      }
      // The type the route SERVED, which is the only account of what these
      // bytes are — see fileNameFor.
      const servedType = (res.headers?.get('Content-Type') || '').split(';')[0].trim();
      const blob = await res.blob();
      const type = servedType || blob.type || item.mimeType || 'application/octet-stream';
      results[page - 1] = new File([blob], fileNameFor(item, page, type, pageCount), { type });
    } catch {
      // Network failure on one page; the text fallback still describes the
      // record in full.
      failed += 1;
    }
  };

  // Pages are claimed off one shared cursor, so a slow page holds up only its
  // own worker rather than a whole batch.
  let next = 0;
  const workers = Array.from(
    { length: Math.min(PAGE_FETCH_CONCURRENCY, pages.length) },
    async () => {
      while (next < pages.length) {
        const page = pages[next];
        next += 1;
        await fetchPage(page);
      }
    },
  );
  await Promise.all(workers);

  // Order matters: page two must not arrive in the share sheet ahead of page
  // one because it happened to decrypt faster.
  return { files: results.filter(Boolean), denied, failed };
}

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   WHY SHARING IS SPLIT INTO PREPARE AND PERFORM                         ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `navigator.share()` requires TRANSIENT USER ACTIVATION. Chrome withdraws it
 * about five seconds after the click; WebKit wants the call in the same task as
 * the gesture altogether. Fetching the file first — which is the only way to
 * share the document rather than a link nobody outside the tenant can open —
 * spends that budget: each page decrypts from Drive and `NEVER_CACHED` in
 * src/sw.ts forces it to the network.
 *
 * So a small image shared fine and a PDF did not, at random, depending on how
 * long the fetch took. And the failure was invisible: `share()` throws
 * `NotAllowedError`, which is not `AbortError`, so it fell through to the text
 * sheet — which threw the same error for the same reason — and landed on the
 * clipboard. "Details copied to clipboard" was the sound of the activation
 * having expired.
 *
 * Splitting the two lets the bytes be fetched WITHOUT spending the gesture, and
 * lets the share be retried on a FRESH one:
 *
 *   prepareShare()  — all the network work. Slow. No activation required.
 *   performShare()  — nothing but the `navigator.share()` call. No awaits in
 *                     front of it, so it is safe to run straight out of a click
 *                     handler on any engine.
 *
 * `shareRecords` runs them back to back, which is one tap and is what happens
 * whenever the fetch was quick. When the activation is gone by then, the
 * prepared payload goes to the SHARE GATE — a dialog whose button calls
 * `performShare` directly, with the bytes already in hand. The OS sheet then
 * opens every time, with the real document, which is the point.
 */

/**
 * The registered gate, if the app mounted one. `src/components/ShareGate.jsx`.
 *
 * A module-level slot rather than a prop threaded through twenty pages: every
 * one of them calls `shareRecord` and none of them should have to know that a
 * retry exists. Where nothing is registered — SSR, unit tests — sharing behaves
 * as it would without one, so this is additive.
 *
 * @param {(payload: object, reason: 'needs-gesture'|'unsupported') => Promise<object|null>} fn
 * @returns {() => void} unregister
 */
let shareGate = null;

export function setShareGate(fn) {
  shareGate = fn;
  return () => { if (shareGate === fn) shareGate = null; };
}

/** Does this browser do Web Share Level 2 (files) at all? */
function canShareFiles() {
  return typeof navigator !== 'undefined'
    && typeof navigator.share === 'function'
    && typeof navigator.canShare === 'function';
}

/** Does it do Web Share at all — text, at least? */
export function canShareNatively() {
  return typeof navigator !== 'undefined' && typeof navigator.share === 'function';
}

/**
 * Everything a share needs, fetched. Slow, and safe to run before the gesture.
 *
 * @param {Array} items
 * @returns {Promise<{title: string, text: string, files: File[], denied: number,
 *                    failed: number, withAttachments: number}>}
 */
export async function prepareShare(items) {
  const title = items.length === 1 ? items[0].title : `${items.length} documents`;
  const text = items.map(recordAsText).join('\n');

  const files = [];
  let denied = 0;
  let failed = 0;
  let withAttachments = 0;

  /**
   * Fetch the document when the browser can SHARE files — and also when it can
   * do no sharing at all, because that is exactly when the gate's only useful
   * offer is "save the file". Skipping the fetch there left a Firefox or Linux
   * user with "copy the details" as their whole answer, for a record whose
   * whole point is the attachment.
   *
   * Skipped only in the narrow legacy case — `share()` without `canShare()` —
   * where the sheet takes text and nothing else, so bytes would be fetched to
   * be thrown away.
   */
  if (canShareFiles() || !canShareNatively()) {
    // Records in series, pages within a record in parallel. A bulk share of
    // forty documents must not open forty connections at once.
    for (const item of items) {
      if (!hasAttachment(item.filePath)) continue;
      withAttachments += 1;
      const got = await fetchRecordFiles(item);
      files.push(...got.files);
      denied += got.denied;
      failed += got.failed;
    }
  }

  return { title, text, files, denied, failed, withAttachments };
}

/**
 * The largest set of these files the browser says it will take.
 *
 * `canShare()` refuses by count, by total size and by type, and calling
 * `share()` on a set it would reject throws — so it is asked first, and asked
 * about narrowing sets rather than given up on at the first no. Some engines
 * accept `{files}` but reject `{files, title}`; some cap the count. Dropping to
 * the text sheet at the first refusal is what sent a perfectly shareable
 * document to the clipboard.
 *
 * @returns {{data: object, omitted: number}|null}
 */
function shareableFileSet(files, title) {
  if (!canShareFiles() || files.length === 0) return null;

  const candidates = [
    { data: { files, title }, omitted: 0 },
    { data: { files }, omitted: 0 },
  ];
  // Last resort for a multi-page record the browser will not take whole: one
  // page shared is better than none, and the caller is told what was left out
  // rather than being allowed to think it sent the lot.
  if (files.length > 1) {
    candidates.push({ data: { files: [files[0]] }, omitted: files.length - 1 });
  }

  for (const candidate of candidates) {
    try {
      if (navigator.canShare(candidate.data)) return candidate;
    } catch {
      // A malformed set — treat as a no and try the next.
    }
  }
  return null;
}

/**
 * The share itself. MUST be reachable from a click handler with no await before
 * it — see the block comment above.
 *
 * @param {object} payload from `prepareShare`
 * @returns {Promise<{success: boolean, method?: string, reason?: string, omitted?: number}>}
 *          `reason: 'needs-gesture'` means the activation had expired and the
 *          identical call will succeed on a fresh one. It is deliberately NOT
 *          followed by the text attempt here: that would throw for the same
 *          reason and turn a recoverable share into a clipboard copy.
 */
export async function performShare(payload) {
  const { title, text, files } = payload;

  const set = shareableFileSet(files, title);
  if (set) {
    try {
      await navigator.share(set.data);
      return { success: true, method: 'share-files', omitted: set.omitted };
    } catch (err) {
      if (err.name === 'AbortError') return { success: false, reason: 'aborted' };
      if (err.name === 'NotAllowedError') return { success: false, reason: 'needs-gesture' };
      console.warn('File share failed, falling back to text:', err);
    }
  }

  if (canShareNatively()) {
    try {
      await navigator.share({ title, text });
      return { success: true, method: 'share' };
    } catch (err) {
      if (err.name === 'AbortError') return { success: false, reason: 'aborted' };
      if (err.name === 'NotAllowedError') return { success: false, reason: 'needs-gesture' };
      console.warn('Text share failed:', err);
    }
  }

  return { success: false, reason: 'unsupported' };
}

/** The details on the clipboard — the last resort, and now never a silent one. */
export async function copyShareText(payload) {
  if (typeof navigator === 'undefined' || !navigator.clipboard) {
    return { success: false, method: null, reason: 'failed' };
  }
  try {
    await navigator.clipboard.writeText(payload.text);
    return { success: true, method: 'copy' };
  } catch (err) {
    console.error('Failed to copy selection to clipboard:', err);
    return { success: false, method: null, reason: 'failed' };
  }
}

/**
 * ── WARM-UP ────────────────────────────────────────────────────────────────
 * Started on `pointerdown`, consumed by the `click` that follows. The fetch is
 * then already in flight — often already finished — by the time the handler
 * runs, so the one-tap path wins far more often and the gate stays rare.
 *
 * ONE entry, with a short life. These are DECRYPTED documents held in memory;
 * a cache of them keyed by record would be a plaintext store of everything the
 * user hovered over. A pointerdown that never becomes a click drops its bytes
 * on the next warm-up or after the timeout, whichever comes first.
 */
const WARM_TTL_MS = 30000;
let warmEntry = null;

/**
 * Identifies a selection, so a warm-up is only consumed by the share it was for.
 *
 * `filePath` FIRST, and not `id`: the single-record path builds its item inside
 * `shareRecord` and never sets an id, while the list pages' `asShareItem` does.
 * Keying on the id therefore made the warm-up unreachable from exactly the
 * button that warmed it. The path is unique per record and present on both.
 */
function warmKey(items) {
  return items.map((i) => i.filePath || i.id || i.title).join('|');
}

function dropWarm() {
  if (warmEntry?.timer) clearTimeout(warmEntry.timer);
  warmEntry = null;
}

export function warmShare(items) {
  // Same condition `prepareShare` fetches under: warming for a browser that
  // will only ever take text would decrypt bytes nothing can use.
  if (!items || items.length === 0) return;
  if (!canShareFiles() && canShareNatively()) return;
  // Nothing to warm for a record with no attachment: `prepareShare` would do no
  // network work, and holding a payload for it only risks a stale hit.
  if (!items.some((i) => hasAttachment(i.filePath))) return;
  const key = warmKey(items);
  if (warmEntry?.key === key) return;
  dropWarm();
  const entry = {
    key,
    // Rejection is handled at consumption; an unhandled rejection here would be
    // reported as an error the user never asked about.
    promise: prepareShare(items).catch(() => null),
    timer: setTimeout(() => { if (warmEntry === entry) dropWarm(); }, WARM_TTL_MS),
  };
  warmEntry = entry;
}

/** The warm payload for this selection, if there is one. Consumes it. */
async function takeWarm(items) {
  if (!warmEntry || warmEntry.key !== warmKey(items)) return null;
  const { promise } = warmEntry;
  dropWarm();
  return promise;
}

/**
 * Share several records.
 *
 * Hands over the FILES themselves — that is what "share these documents" means
 * to the person doing it. File bytes are fetched through the app's own
 * decrypting route, so what gets shared is plaintext the recipient can actually
 * open, never the Drive ciphertext and never the authenticated link that only
 * works for someone already looking at the record.
 *
 * @param {Array} items
 * @returns {Promise<{success: boolean, method: 'share-files'|'share'|'copy'|null,
 *                    reason?: string, omitted?: number, denied?: number,
 *                    failed?: number, hadFiles?: boolean}>}
 *          `reason` is one of `aborted` (the user closed the sheet — not a
 *          failure), `dismissed` (closed the gate), `no-permission` (the member
 *          lacks `share` on the file), `unsupported` (no Web Share here) or
 *          `failed`. Every caller reports this through `reportShareResult`.
 */
export async function shareRecords(items) {
  if (!items || items.length === 0) {
    return { success: false, method: null, reason: 'failed' };
  }

  const payload = (await takeWarm(items)) || (await prepareShare(items));
  // `denied` on every attachment and nothing fetched is a permission answer,
  // and saying so beats "could not share".
  const noPermission = payload.files.length === 0
    && payload.denied > 0
    && payload.failed === 0;

  let result = await performShare(payload);

  // The activation expired during the fetch, or this browser has no share sheet
  // at all. Both are recoverable by asking the user for one more tap — which is
  // what the gate is — rather than quietly copying text they did not ask for.
  if (result.reason === 'needs-gesture' || result.reason === 'unsupported') {
    const gated = shareGate ? await shareGate(payload, result.reason) : null;
    if (gated) result = gated;
    else if (result.reason === 'unsupported') result = await copyShareText(payload);
  }

  const outcome = {
    success: Boolean(result.success),
    method: result.method ?? null,
    omitted: result.omitted || 0,
    denied: payload.denied,
    failed: payload.failed,
    hadFiles: payload.files.length > 0,
  };
  if (!result.success) {
    // `needs-gesture` never escapes: it describes a retry that was available,
    // and where no gate took it there is nothing for the caller to say beyond
    // that the share did not happen.
    const reason = result.reason === 'needs-gesture' ? 'failed' : result.reason;
    outcome.reason = noPermission ? 'no-permission' : (reason || 'failed');
  } else if (payload.denied > 0 && payload.files.length === 0) {
    // The details went out but the file itself was withheld — worth saying,
    // because otherwise the member believes they sent the document.
    outcome.reason = 'no-permission';
  }
  return outcome;
}

/**
 * Print several records as ONE job.
 *
 * Twelve selected documents must not mean twelve print dialogs. Everything that
 * can be composed into a single HTML document is: each record contributes its
 * detail sheet, followed by any pages that can be rendered inline, each on its
 * own sheet of paper.
 *
 * ── WHY PDFs ARE DIFFERENT ─────────────────────────────────────────────────
 * A PDF cannot be embedded into a host document in a way browsers will print —
 * an <embed> renders on screen but is skipped or blanked by the print engine.
 * So a selected PDF contributes its detail sheet with a note, and is then
 * printed in its own job afterwards. Stating that in the output beats silently
 * omitting the pages.
 *
 * ── WHAT DECIDES THE BRANCH ────────────────────────────────────────────────
 * The type the ROUTE served, not the record's `mimeType` column. The column is
 * the original upload's type and is wrong about the bytes for half the vault: a
 * PDF stored split is JPEG pages, and a .docx fetched with `render=1` arrives
 * as a PDF. Branching on the column printed a page image through the PDF path
 * and skipped office documents entirely.
 *
 * @param {Array} items
 */
export async function printRecords(items) {
  if (typeof window === 'undefined' || !items || items.length === 0) return;

  const objectUrls = [];
  const deferredPdfs = [];
  let bodyHtml = '';

  for (const item of items) {
    const fieldsHtml = (item.fields || [])
      .filter((f) => f && f.value !== undefined && f.value !== null && f.value !== '')
      .map((f) => `
        <div class="field">
          <div class="label">${escapeHtml(f.label)}</div>
          <div class="value">${escapeHtml(f.value)}</div>
        </div>`)
      .join('');

    let pagesHtml = '';

    if (hasAttachment(item.filePath)) {
      // Every page, not just the first: a three-sheet agreement printed as one
      // sheet is worse than not printing it. `fetchPreviewPages` owns the loop,
      // the page cap and — crucially — the `asImage` decision, so a phone gets
      // page images it can actually compose rather than a PDF it cannot frame.
      let fetched = [];
      try {
        fetched = await fetchPreviewPages(item.filePath, { pageCountHint: item.pageCount });
      } catch (err) {
        pagesHtml = `<p class="note">The attached file could not be opened: ${escapeHtml(err.message)}</p>`;
      }

      if (fetched.length === 1 && previewKind(fetched[0].mimeType) === 'pdf') {
        // A PDF cannot be embedded into a host document in a way browsers will
        // print, so it goes in its own job and the sheet says so. Only reachable
        // on a client that HAS a PDF viewer — see fetchPreviewPages.
        URL.revokeObjectURL(fetched[0].url);
        deferredPdfs.push(item);
        pagesHtml = '<p class="note">This document prints as a separate job after this one.</p>';
      } else {
        for (const page of fetched) {
          if (page.url) objectUrls.push(page.url);
          if (previewKind(page.mimeType) === 'image') {
            pagesHtml += `<div class="page-image"><img src="${page.url}" alt="" /></div>`;
          } else if (previewKind(page.mimeType) === 'text') {
            pagesHtml += `<pre class="page-text">${escapeHtml(page.text)}</pre>`;
          }
        }
      }
    }

    bodyHtml += `
      <section class="record">
        <h1>${escapeHtml(item.title)}</h1>
        <div class="grid">${fieldsHtml}</div>
        ${pagesHtml}
      </section>`;
  }

  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  document.body.appendChild(iframe);

  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    if (iframe.parentNode) document.body.removeChild(iframe);
    // These hold DECRYPTED bytes. An iframe whose onload never fires would
    // otherwise keep them alive until the page unloads.
    objectUrls.forEach((u) => URL.revokeObjectURL(u));
    // Each remaining PDF gets its own job, once the combined one is away.
    deferredPdfs.forEach((item) => printRecord(item.title, item.fields, undefined, item.filePath));
  };
  const failsafe = setTimeout(cleanup, 60000);

  const doc = iframe.contentWindow.document;
  doc.write(`
    <html>
      <head>
        <title>${escapeHtml(items.length === 1 ? items[0].title : `${items.length} documents`)}</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
                 color: #1e293b; padding: 32px; line-height: 1.6; background: #fff; }
          .record { page-break-after: always; }
          .record:last-child { page-break-after: auto; }
          h1 { color: #0f172a; border-bottom: 2px solid #e2e8f0; padding-bottom: 10px;
               font-size: 20px; margin: 0 0 20px; font-weight: 800; }
          .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px 24px; }
          .field { break-inside: avoid; }
          .label { font-size: 10px; font-weight: 700; text-transform: uppercase;
                   color: #64748b; letter-spacing: 0.05em; }
          .value { font-size: 14px; font-weight: 600; }
          .note { margin-top: 16px; font-size: 12px; color: #64748b; font-style: italic; }
          .page-image { page-break-before: always; text-align: center; }
          .page-image img { max-width: 100%; max-height: 95vh; }
          .page-text { page-break-before: always; white-space: pre-wrap; word-break: break-word;
                       font-size: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
        </style>
      </head>
      <body>${bodyHtml}</body>
    </html>
  `);
  doc.close();

  iframe.onload = () => {
    clearTimeout(failsafe);
    iframe.contentWindow.focus();
    iframe.contentWindow.print();
    // Give the print dialog time to take its snapshot before the blob URLs it
    // rendered from are revoked.
    setTimeout(cleanup, 1000);
  };
}
