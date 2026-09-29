import { execFileSync, execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import mammoth from 'mammoth';
import WordExtractor from 'word-extractor';
import * as xlsx from 'xlsx';

/**
 * Checks if a command-line tool is available in the system PATH.
 * @param {string} cmd 
 * @returns {boolean}
 */
function isCommandAvailable(cmd: string): boolean {
  try {
    const isWin = process.platform === 'win32';
    const checkCmd = isWin ? `where ${cmd}` : `which ${cmd}`;
    execSync(checkCmd, { stdio: 'ignore' });
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE THREE BINARIES EVERY SCAN QUIETLY DEPENDS ON                       ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `pdftoppm` (poppler-utils), `convert` (ImageMagick) and `soffice`
 * (LibreOffice) are what turn an upload into the page images the model actually
 * reads. Without them this module still answers — it hands back the original
 * bytes — so nothing fails, nothing 500s, and the only symptom is that every
 * document is read WORSE. That is the worst shape a dependency can fail in, and
 * it is exactly what happened: the Dockerfile installed the first two,
 * production ran from a systemd unit on a host where neither was ever
 * installed, and PDFs went to the model unrasterised for as long as nobody read
 * the logs closely.
 *
 * `soffice` is the newest of the three and the one most likely to be missing on
 * a host that predates it. It is only reached for an office document with no
 * extractable text; when it is absent that document is reported unreadable
 * rather than guessed at.
 *
 * So the absence is stated once, loudly, at first use rather than as a line
 * buried in each fallback branch. Cached: this runs on every upload, and
 * `which` is a subprocess.
 */
let toolingChecked = false;
let hasPdftoppm = false;
let hasConvert = false;
let hasSoffice = false;

function checkTooling(): void {
  if (toolingChecked) return;
  toolingChecked = true;
  hasPdftoppm = isCommandAvailable('pdftoppm');
  hasConvert = isCommandAvailable('convert');
  hasSoffice = isCommandAvailable('soffice');

  if (!hasPdftoppm) {
    console.warn(
      '⚠️  [documentProcessor] pdftoppm (poppler-utils) is NOT installed. PDFs will be '
      + 'sent to the AI unrasterised, page splitting and the page cap are inert, and OCR '
      + 'accuracy WILL suffer. Install it: apt-get install -y poppler-utils',
    );
  }
  if (!hasConvert) {
    console.warn(
      '⚠️  [documentProcessor] ImageMagick `convert` is NOT installed. Uploaded images '
      + 'skip normalisation and are sent to the AI as-is, and HEIC/TIFF/BMP uploads '
      + 'cannot be read at all. Install it: apt-get install -y imagemagick',
    );
  }
  if (!hasSoffice) {
    console.warn(
      '⚠️  [documentProcessor] LibreOffice (`soffice`) is NOT installed. A .docx or .xlsx '
      + 'whose content is a scanned image carries no extractable text and cannot be '
      + 'rasterised, so nothing in it will be read. Install it: '
      + 'apt-get install -y libreoffice-writer libreoffice-calc',
    );
  }
}

/**
 * Is the page-image pipeline actually available on this host?
 *
 * Exported so a health check or a startup preflight can ask the same question
 * this module answers internally, rather than re-deriving it.
 */
export function rasterisationTooling(): {
  pdftoppm: boolean; convert: boolean; soffice: boolean;
} {
  checkTooling();
  return { pdftoppm: hasPdftoppm, convert: hasConvert, soffice: hasSoffice };
}

/** Prefix for every scan scratch directory, so the sweeper can recognise them. */
const SCAN_DIR_PREFIX = 'docsnx-scan-';

/** How long a scratch directory may live before the sweeper reclaims it. */
const SCAN_DIR_TTL_MS = 60 * 60 * 1000;

/**
 * A private scratch directory for one scan.
 *
 * Under os.tmpdir(), never `public/` and never `UPLOAD_DIR`: page images are
 * decrypted user documents, and the previous behaviour left them in an
 * HTTP-reachable folder indefinitely with no cleanup of any kind.
 */
export function createScanScratchDir(): string {
  const dir = path.join(os.tmpdir(), `${SCAN_DIR_PREFIX}${randomUUID()}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * The scan scratch DIRECTORY `filePath` belongs to, or null if it is not in one.
 *
 * Exported because the directory's existence is load-bearing, not incidental:
 * the two things that delete a scan's pages delete different amounts, and that
 * is the only way to tell them apart afterwards.
 *
 *   · a page SEALED onto Drive is `unlinkSync`-ed one file at a time by
 *     `discardScratchPage` (records/upload.ts) — the directory survives.
 *   · a scan nobody came back for is `rmSync(dir, { recursive: true })`-ed
 *     whole by `sweepStaleScanDirs` below.
 *
 * So a save body naming pages that will not read means "these were already
 * written to your vault" when this directory is still there, and "your scan
 * expired" when it is not. `scratchPagesState` in records/upload.ts is what
 * asks; see the note there for why the difference matters to the user.
 */
export function scanScratchDirFor(filePath: string | null | undefined): string | null {
  if (!filePath) return null;
  const resolved = path.resolve(filePath);
  const root = path.resolve(os.tmpdir());
  if (!resolved.startsWith(root + path.sep)) return null;
  const first = resolved.slice(root.length + 1).split(path.sep)[0];
  return first.startsWith(SCAN_DIR_PREFIX) ? path.join(root, first) : null;
}

/** True if `filePath` sits inside a scan scratch directory. */
export function isScanScratchPath(filePath: string | null | undefined): boolean {
  return scanScratchDirFor(filePath) !== null;
}

/**
 * Removes scratch directories older than the TTL.
 *
 * The scan -> review -> save flow spans two requests, so a scan's pages cannot
 * be deleted when the first one returns. This collects the ones whose user
 * never came back, which would otherwise accumulate plaintext documents on the
 * server forever.
 */
export function sweepStaleScanDirs(now: number = Date.now()): number {
  const root = os.tmpdir();
  let removed = 0;
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.startsWith(SCAN_DIR_PREFIX)) continue;
    const full = path.join(root, entry);
    try {
      if (now - fs.statSync(full).mtimeMs < SCAN_DIR_TTL_MS) continue;
      fs.rmSync(full, { recursive: true, force: true });
      removed += 1;
    } catch (error) {
      console.error(`Failed to sweep scan scratch dir ${full}:`, error);
    }
  }
  return removed;
}

/** One processed page as every caller consumes it. */
export interface ProcessedPage {
  filePath: string;
  fileName: string;
  mimeType: string;
  originalName: string;
  pageNumber: number;
  totalPages: number;
  extractedText?: string | null;
  /** False when this entry is the original file rather than a page image. */
  rasterised?: boolean;
  /**
   * Nothing here can be read: no text was extractable and no page image could
   * be produced. Callers must NOT send an unreadable page to a model — see
   * `rasteriseOfficeDocument` below for what that used to cost.
   */
  unreadable?: boolean;
}

/**
 * Images that are one document page and nothing more.
 *
 * HEIC/HEIF are here rather than in `MULTI_FRAME_IMAGES` deliberately: the
 * format can hold a burst, but a photographed document is one frame and the
 * others are the same shot again.
 */
const SINGLE_FRAME_IMAGES = ['.png', '.jpg', '.jpeg', '.webp', '.heic', '.heif', '.bmp', '.gif'];

/** Images that can hold several document pages — a scanner's default output. */
const MULTI_FRAME_IMAGES = ['.tif', '.tiff'];

/**
 * The three formats a model reads as raw bytes.
 *
 * This is what decides whether a failed `convert` may fall back to handing over
 * the original file. For a JPEG that is harmless — the fallback is the same
 * picture, unnormalised. For a TIFF or a BMP it is an unreadable blob billed as
 * an image, which is worse than an honest "could not read this": the model
 * answers anyway, from nothing.
 */
const MODEL_READS_RAW = ['.png', '.jpg', '.jpeg', '.webp'];

/** A collision-proof filename stem inside a scratch dir. */
function uniquePrefix(kind: string): string {
  return `${Date.now()}_${Math.floor(Math.random() * 1000000)}_${kind}`;
}

/**
 * The `prefix-N.jpg` files a rasteriser just wrote, in page order.
 *
 * Numeric sort, not lexicographic: pdftoppm pads the index to the width of the
 * page count, so a 100-page PDF yields `-001` … `-100` while a 9-page one
 * yields `-1` … `-9`, and string order gets the second one wrong the moment it
 * reaches ten.
 */
function collectGeneratedPages(uploadDir: string, prefix: string): string[] {
  const index = (fileName: string): number => {
    const n = parseInt(fileName.slice(prefix.length + 1, -'.jpg'.length), 10);
    return Number.isNaN(n) ? 0 : n;
  };
  return fs.readdirSync(uploadDir)
    .filter((f) => f.startsWith(`${prefix}-`) && f.endsWith('.jpg'))
    .sort((a, b) => index(a) - index(b));
}

/** Generated page filenames → the page entries callers consume. */
function pageEntries(
  uploadDir: string,
  fileNames: string[],
  baseName: string,
  originalName: string,
): ProcessedPage[] {
  return fileNames.map((fileName, idx) => ({
    filePath: path.join(uploadDir, fileName),
    fileName: `${baseName} (Page ${idx + 1}).jpg`,
    mimeType: 'image/jpeg',
    originalName,
    pageNumber: idx + 1,
    totalPages: fileNames.length,
    rasterised: true,
  }));
}

/**
 * A PDF on disk → one JPEG per page, or `null` if it could not be split.
 *
 * Shared by the `.pdf` branch and by the office-document fallback, which routes
 * a text-free .docx through LibreOffice into a PDF and then through here. The
 * settings are argued for at the call in `processUpload`; they live in one
 * place so a scanned Word file is read at exactly the same fidelity as the same
 * scan uploaded as a PDF.
 */
function rasterisePdf(
  pdfPath: string,
  uploadDir: string,
  baseName: string,
  originalName: string,
): ProcessedPage[] | null {
  if (!hasPdftoppm) return null;
  const prefix = uniquePrefix('page');
  try {
    /**
     * 200 DPI, quality 90 — not 150/85.
     *
     * What these pages are for is reading small print: a PAN number, a policy
     * number, the expiry printed along the edge of a card. 150 DPI is a viewing
     * resolution; the extra pixels are the difference between a digit the model
     * reads and a digit it guesses, and the cost is a JPEG a few hundred KB
     * larger on a call already dominated by the model's own latency.
     *
     * execFileSync with an argument array: the filename never reaches a shell,
     * so a name containing shell metacharacters cannot alter the command.
     */
    execFileSync('pdftoppm', [
      '-jpeg', '-jpegopt', 'quality=90', '-r', '200',
      pdfPath, path.join(uploadDir, prefix),
    ]);
  } catch (err) {
    console.error('PDF splitting failed:', err);
    return null;
  }
  const files = collectGeneratedPages(uploadDir, prefix);
  return files.length > 0 ? pageEntries(uploadDir, files, baseName, originalName) : null;
}

/**
 * How long LibreOffice gets to convert one document.
 *
 * It is a full office suite starting cold. Left unbounded, a file it cannot
 * parse holds the request open until the client gives up — and the user is
 * sitting in front of a spinner on an upload that was never going to finish.
 */
const SOFFICE_TIMEOUT_MS = 90_000;

/**
 * One office document on disk → a PDF beside it, or `null`.
 *
 * Exported because there are now two reasons to want it. This module wants the
 * PDF so it can rasterise a scan hidden inside a .docx; `previewRender` wants
 * the PDF itself, because a browser has a viewer for a PDF and none for a
 * .docx. Neither may re-derive the invocation: the private profile dir below is
 * the difference between converting and hanging forever, and that is not
 * something to learn twice.
 *
 * `outDir` must be a scratch directory the caller owns — soffice writes its
 * profile there too.
 */
export function convertToPdf(sourcePath: string, outDir: string): string | null {
  checkTooling();
  if (!hasSoffice) return null;

  // A private profile dir, and NOT optional: under systemd `soffice` has no
  // writable HOME, and without this it blocks forever building a first-run
  // profile it is not allowed to write.
  const profileDir = path.join(outDir, 'lo-profile');
  try {
    execFileSync('soffice', [
      '--headless',
      '--norestore',
      `-env:UserInstallation=file://${profileDir}`,
      '--convert-to', 'pdf',
      '--outdir', outDir,
      sourcePath,
    ], { timeout: SOFFICE_TIMEOUT_MS, stdio: 'ignore' });
  } catch (err) {
    console.error(`LibreOffice could not convert ${path.basename(sourcePath)}:`, err);
    return null;
  }

  // soffice names its output after the INPUT's stem, in --outdir.
  const converted = path.join(
    outDir,
    `${path.basename(sourcePath, path.extname(sourcePath))}.pdf`,
  );
  if (!fs.existsSync(converted)) {
    console.error(
      `LibreOffice reported success but wrote no PDF for ${path.basename(sourcePath)}`,
    );
    return null;
  }
  return converted;
}

/**
 * An office document with no extractable text → page images, or `null`.
 *
 * This is the scanned-page-pasted-into-Word case, and it is common: someone
 * photographs a bill, drops the picture into a .docx because that is the file
 * type they know how to email, and uploads that. `mammoth` reports no text —
 * correctly, there is none — and before this the empty string fell through to
 * the base64 branch, so a .docx was handed to the model AS AN IMAGE. It read
 * nothing, said nothing, and the user got an empty form with no reason given.
 *
 * LibreOffice renders it to PDF, which the same rasteriser above then splits,
 * so the scan is read exactly as it would have been uploaded directly.
 */
function rasteriseOfficeDocument(
  sourcePath: string,
  uploadDir: string,
  baseName: string,
  originalName: string,
): ProcessedPage[] | null {
  if (!hasSoffice || !hasPdftoppm) return null;

  const converted = convertToPdf(sourcePath, uploadDir);
  if (!converted) return null;

  return rasterisePdf(converted, uploadDir, baseName, originalName);
}

/**
 * Processes an uploaded file:
 * - PDF: split into individual high-quality compressed JPEGs (pdftoppm).
 * - Multi-frame image (TIFF): split into one JPEG per frame, like a PDF's pages.
 * - Single image (PNG, JPEG, WebP, HEIC, BMP, GIF): normalised to one JPEG.
 * - Office/text document: text extracted; if there is none, rasterised via
 *   LibreOffice so a scan inside a .docx is still read.
 *
 * Falls back to the original file where a model can still read it, and marks
 * the page `unreadable` where it cannot.
 *
 * @param {File} file - Next.js/Browser File object
 */
export async function processUpload(file: File | any): Promise<ProcessedPage[]> {
  // Says once, loudly, if the page-image pipeline is missing on this host. See
  // checkTooling(): the fallbacks below are silent by design, which is why the
  // absence has to be announced somewhere that is not a fallback.
  checkTooling();

  // A per-call scratch directory under the OS temp dir — NEVER public/ and
  // never UPLOAD_DIR. pdftoppm and convert are subprocesses that need real
  // files, so some disk is unavoidable; what is avoidable is leaving user
  // documents in an HTTP-reachable directory forever, which is what the old
  // `/uploads/` behaviour did.
  const uploadDir = createScanScratchDir();

  // Nothing is stored durably here. `processUpload` used to call
  // saveUploadedFile(file) with no tenant, which forced the local-disk branch
  // for every scan on every tenant. Persistence now happens only after the user
  // confirms, via storeRecordInVault, which encrypts onto their own Drive.
  const tempId = Date.now() + '_' + Math.floor(Math.random() * 100000);
  const safeName = file.name.replace(/[^a-zA-Z0-9.]/g, '_');
  const tempOriginalPath = path.join(uploadDir, `temp_${tempId}_${safeName}`);
  const fileBuffer = Buffer.from(await file.arrayBuffer());
  fs.writeFileSync(tempOriginalPath, fileBuffer);

  /**
   * A SECOND copy that outlives this call.
   *
   * The fallback paths below (no pdftoppm, no convert, unknown type) return the
   * original file as the page. `tempOriginalPath` is the subprocess working
   * copy and is deleted in the `finally`, so returning it handed the caller a
   * path to a file that no longer existed — `ENOENT` in /api/ai/scan. They must
   * be different files.
   */
  const originalPath = path.join(uploadDir, `original_${tempId}_${safeName}`);
  fs.writeFileSync(originalPath, fileBuffer);

  const fileExt = path.extname(file.name).toLowerCase();
  const baseName = path.basename(file.name, fileExt);

  const processedPages: ProcessedPage[] = [];

  try {
    if (fileExt === '.pdf') {
      const pages = rasterisePdf(tempOriginalPath, uploadDir, baseName, file.name);
      if (pages) {
        console.log(`Successfully split PDF into ${pages.length} page images.`);
        return pages;
      }

      /**
       * Fallback: the WHOLE pdf as one "page".
       *
       * `rasterised: false` is the honest part. `totalPages: 1` is a lie the
       * callers used to repeat to the user — "read the first 1 of 1 pages" for
       * a thirty-page agreement — because nothing here knows the real count
       * without poppler. The flag lets a caller say nothing rather than say
       * something false, and lets it treat the single entry as the entire
       * document rather than as page one of it.
       */
      processedPages.push({
        filePath: originalPath,
        fileName: file.name,
        mimeType: file.type || 'application/pdf',
        originalName: file.name,
        pageNumber: 1,
        totalPages: 1,
        rasterised: false,
      });

    } else if (MULTI_FRAME_IMAGES.includes(fileExt)) {
      /**
       * A TIFF is usually a SCANNED DOCUMENT, not a picture.
       *
       * Which means it can hold ten pages, and treating it as one image read
       * page one and silently discarded the rest. `%03d` in the output name
       * makes ImageMagick write one JPEG per frame, and from there this is the
       * PDF branch: the same collect-and-sort, the same page numbering, so a
       * ten-page TIFF and the same document as a PDF arrive identical.
       */
      if (hasConvert) {
        const prefix = uniquePrefix('frame');
        try {
          console.log(`Splitting ${fileExt} frames using convert: ${tempOriginalPath}`);
          execFileSync('convert', [
            tempOriginalPath, '-quality', '92',
            path.join(uploadDir, `${prefix}-%03d.jpg`),
          ]);

          const frames = collectGeneratedPages(uploadDir, prefix);
          if (frames.length > 0) {
            console.log(`Successfully split ${fileExt} into ${frames.length} page images.`);
            return pageEntries(uploadDir, frames, baseName, file.name);
          }
        } catch (err) {
          console.error(`${fileExt} frame splitting failed:`, err);
        }
      }

      // No raw fallback: see MODEL_READS_RAW. A TIFF handed to a model as bytes
      // is not read, and a page that says so is worth more than one that lies.
      processedPages.push({
        filePath: originalPath,
        fileName: file.name,
        mimeType: file.type || 'image/tiff',
        originalName: file.name,
        pageNumber: 1,
        totalPages: 1,
        rasterised: false,
        unreadable: true,
      });

    } else if (SINGLE_FRAME_IMAGES.includes(fileExt)) {
      if (hasConvert) {
        try {
          const compressedName = `${uniquePrefix('compressed')}_${baseName.replace(/[^a-zA-Z0-9]/g, '_')}.jpg`;
          const compressedFullPath = path.join(uploadDir, compressedName);

          console.log(`Compressing image using convert: ${tempOriginalPath} -> ${compressedFullPath}`);
          // 92, not 85. The same argument as the PDF DPI above: this image is
          // going to be read for the digits printed on it, and JPEG artefacts
          // land hardest on exactly the small high-contrast glyphs an
          // identifier is made of.
          //
          // `[0]` pins the first frame. It matters for an animated GIF, and for
          // a HEIC burst: without it ImageMagick writes one JPEG per frame under
          // names this branch never looks for, and the page it returns is
          // missing. A document is the first frame.
          execFileSync('convert', [`${tempOriginalPath}[0]`, '-quality', '92', compressedFullPath]);

          processedPages.push({
            filePath: compressedFullPath,
            fileName: file.name,
            mimeType: 'image/jpeg',
            originalName: file.name,
            pageNumber: 1,
            totalPages: 1,
            rasterised: true,
          });
          
          console.log(`Successfully compressed image to ${compressedName}`);
          return processedPages;
        } catch (err) {
          console.error('Image compression failed:', err);
        }
      } else {
        console.warn('ImageMagick convert is not available. Falling back to original image.');
      }

      /**
       * Fallback — but only where the model can still read the bytes.
       *
       * A JPEG or PNG that missed normalisation is the same picture, slightly
       * bigger. A HEIC, BMP or GIF is a format the vision endpoints do not
       * reliably decode, so handing one over produces an answer drawn from
       * nothing at all. Those are marked unreadable instead, and the caller
       * tells the user rather than filling the form with invention.
       */
      const readable = MODEL_READS_RAW.includes(fileExt);
      processedPages.push({
        filePath: originalPath,
        fileName: file.name,
        mimeType: file.type,
        originalName: file.name,
        pageNumber: 1,
        totalPages: 1,
        ...(readable ? {} : { rasterised: false, unreadable: true }),
      });

    } else {
      // Non-PDF and non-image files (documents, sheets, text)
      let extractedText: string | null = null;
      
      try {
        if (fileExt === '.docx') {
          const result = await mammoth.extractRawText({ buffer: fileBuffer });
          extractedText = result.value;
        } else if (fileExt === '.doc') {
          const extractor = new WordExtractor();
          const extracted = await extractor.extract(tempOriginalPath);
          extractedText = extracted.getBody();
        } else if (fileExt === '.xlsx' || fileExt === '.xls') {
          const workbook = xlsx.read(fileBuffer, { type: 'buffer' });
          extractedText = workbook.SheetNames.map(sheetName => {
            const sheet = workbook.Sheets[sheetName];
            return `--- Sheet: ${sheetName} ---\n` + xlsx.utils.sheet_to_csv(sheet);
          }).join('\n\n');
        } else if (['.txt', '.csv', '.json', '.md'].includes(fileExt)) {
          extractedText = fileBuffer.toString('utf-8');
        }
      } catch (err) {
        console.error(`Failed to extract text from ${fileExt} file:`, err);
      }

      if (extractedText && extractedText.trim()) {
        processedPages.push({
          filePath: originalPath,
          fileName: file.name,
          mimeType: file.type,
          originalName: file.name,
          pageNumber: 1,
          totalPages: 1,
          extractedText,
        });
        return processedPages;
      }

      /**
       * ── NO TEXT IN IT. THAT IS NOT THE SAME AS NOTHING IN IT ───────────────
       *
       * An xlsx of empty cells has no text and no content. A .docx holding one
       * photographed bill has no text and ALL of its content. They are
       * indistinguishable from here, and the previous behaviour resolved the
       * ambiguity the worst possible way: `extractedText: ''` is falsy, so
       * every caller fell through to its base64 branch and posted the raw
       * .docx to the model AS AN IMAGE. It read nothing and said nothing; the
       * user got an empty form and no reason for it.
       *
       * So render it and look. LibreOffice → PDF → the same page images a
       * direct upload of that scan would have produced.
       */
      const rendered = rasteriseOfficeDocument(tempOriginalPath, uploadDir, baseName, file.name);
      if (rendered) {
        console.log(`Rasterised text-free ${fileExt} into ${rendered.length} page images.`);
        return rendered;
      }

      // Nothing extractable and nothing renderable — LibreOffice is absent, the
      // conversion failed, or the document really is empty. Say so rather than
      // sending an office file to a vision model.
      processedPages.push({
        filePath: originalPath,
        fileName: file.name,
        mimeType: file.type,
        originalName: file.name,
        pageNumber: 1,
        totalPages: 1,
        extractedText: null,
        rasterised: false,
        unreadable: true,
      });
    }

    return processedPages;
  } finally {
    // The scratch directory is NOT removed here: the page images must outlive
    // this request. The scan -> review -> save flow spans two HTTP calls, and
    // /api/ai/scan/save reads these files to encrypt them onto the tenant's
    // Drive. sweepStaleScanDirs() below collects them afterwards.
    //
    // The original upload is dropped immediately though — the pages carry
    // everything the AI and the save step need.
    if (fs.existsSync(tempOriginalPath)) {
      try {
        fs.unlinkSync(tempOriginalPath);
      } catch (e) {
        console.error('Failed to cleanup temp original:', e);
      }
    }
  }
}
