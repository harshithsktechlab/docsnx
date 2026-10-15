/**
 * A document's own text, read at SAVE time for the keyword index.
 *
 * Most of what people search for by content — a bank statement's month, an
 * address on a bill — sits in files that already carry a text layer: statements
 * downloaded from net banking are text PDFs, and office files are text by
 * definition. Those are read here, on the server, with no AI call.
 *
 * Scanned images have no text layer; their words come from the AI read instead
 * (`searchKeywords` in `extractCategoryFields`) and arrive as `contentText`.
 *
 * Nothing here is stored. The text is handed to `storeRecordInVault`, which
 * hashes it into tokens and drops it. Every failure — a locked PDF, a missing
 * `pdftotext`, a corrupt sheet — yields '' rather than failing the save: the
 * index is a convenience, the record is not.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import path from 'path';
import mammoth from 'mammoth';
import WordExtractor from 'word-extractor';
import * as xlsx from 'xlsx';

const run = promisify(execFile);

/** Characters kept — far more than the token cap needs, bounded all the same. */
const MAX_CHARS = 60_000;
/** PDF pages read. A statement's period and address are on page one. */
const MAX_PDF_PAGES = 30;

interface FileLike {
  name: string;
  type?: string;
  size?: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

async function withTempFile<T>(bytes: Buffer, ext: string, fn: (p: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docsnx-text-'));
  const file = path.join(dir, `source${ext}`);
  try {
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    return await fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function pdfText(bytes: Buffer): Promise<string> {
  return withTempFile(bytes, '.pdf', async (file) => {
    const { stdout } = await run('pdftotext', ['-q', '-l', String(MAX_PDF_PAGES), file, '-'], {
      timeout: 20_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  });
}

export async function extractSearchText(file: FileLike | null | undefined): Promise<string> {
  if (!file || !file.size) return '';
  const ext = path.extname(file.name || '').toLowerCase();
  const mime = (file.type || '').toLowerCase();
  try {
    const bytes = Buffer.from(await file.arrayBuffer());
    let text = '';
    if (ext === '.pdf' || mime === 'application/pdf') {
      text = await pdfText(bytes);
    } else if (ext === '.docx') {
      text = (await mammoth.extractRawText({ buffer: bytes })).value;
    } else if (ext === '.doc') {
      text = await withTempFile(bytes, '.doc', async (p) => (await new WordExtractor().extract(p)).getBody());
    } else if (ext === '.xlsx' || ext === '.xls') {
      const workbook = xlsx.read(bytes, { type: 'buffer' });
      text = workbook.SheetNames.map((name) => xlsx.utils.sheet_to_csv(workbook.Sheets[name])).join('\n');
    } else if (['.txt', '.csv', '.md', '.json'].includes(ext) || mime.startsWith('text/')) {
      text = bytes.toString('utf-8');
    }
    return text.slice(0, MAX_CHARS);
  } catch {
    // Locked, corrupt or tool missing — the record saves without content tokens.
    return '';
  }
}
