/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   EVERY SEAL NAMES THE ACCOUNT IT IS SEALED FOR                          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `companyId` is bound into THREE things at write time — the `vault_json_files`
 * pointer, the Drive folder (`vaultScopePath`), and the AAD of both the JSON
 * store (`storeAad`) and every page of the file (`fileAad`). Omitting it does
 * not raise and does not warn. It seals a company's record into the household's
 * vault, and every later read — which takes the company off the ROW — looks in
 * the other account, finds no pointer, and reports a record with no fields.
 *
 * That is exactly what happened: `createRecord`'s attachment branch called
 * `uploadRecords` without it while the no-attachment branch beside it passed it
 * correctly. A business upload landed in the Document Manager as a row with no
 * Number, no fields, and actions that opened nothing — and the record's bytes
 * were unreadable, because the reader used a company AAD on personal
 * ciphertext.
 *
 * Source-level, and deliberately so: the failure is a MISSING ARGUMENT. There is
 * nothing to observe at runtime without a live Drive grant, and the omission is
 * plain in the source — the same reasoning as `holderContract.test.ts`, which
 * guards a route that forgets `holderFrom`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

/**
 * Strip comments, so a guard cannot be satisfied by PROSE.
 *
 * Written after this test passed with the bug deliberately reintroduced: the
 * call site carries a long comment explaining why `companyId` matters, and
 * `/\bcompanyId\b/` matched that comment happily while the property itself was
 * gone. A guard that its own subject can talk its way past is worse than none.
 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
}

/**
 * Every call to `fn(` in `src`, as the text from the opening paren to its
 * matching close. Brace/paren counting rather than a regex: these calls span
 * twenty lines and nest object and array literals, so `\(([^)]*)\)` stops at
 * the first inner `)` and would pass a call that omits everything after it.
 */
function callsTo(src: string, fn: string): string[] {
  const out: string[] = [];
  const needle = `${fn}(`;
  let from = 0;
  for (;;) {
    const start = src.indexOf(needle, from);
    if (start === -1) return out;
    // Skip the declaration itself — `export async function uploadRecords(`.
    const preceding = src.slice(Math.max(0, start - 40), start);
    if (/\bfunction\s+$/.test(preceding)) {
      from = start + needle.length;
      continue;
    }
    let depth = 0;
    let i = start + needle.length - 1;
    for (; i < src.length; i += 1) {
      if (src[i] === '(') depth += 1;
      else if (src[i] === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    out.push(stripComments(src.slice(start, i + 1)));
    from = i + 1;
  }
}

/** The modules that may seal a record, and therefore must name its account. */
const SEALING_MODULES = [
  'src/lib/records/handler.ts',
  'src/lib/records/upload.ts',
  'src/lib/vault/vaultUpload.ts',
  'src/lib/vault/vaultStore.ts',
];

describe('a record is sealed into the account it belongs to', () => {
  for (const path of SEALING_MODULES) {
    const src = read(path);

    for (const fn of ['storeRecordInVault', 'uploadRecords']) {
      const calls = callsTo(src, fn);
      if (calls.length === 0) continue;

      it(`${path}: every ${fn}() names a companyId`, () => {
        const silent = calls.filter((call) => !/\bcompanyId\b/.test(call));
        // Named rather than counted: a failure here has to say WHICH call,
        // because the whole point is that the omission is invisible.
        expect(
          silent.map((c) => c.slice(0, 120)),
          `${fn}() in ${path} seals a record without saying which account it belongs to`,
        ).toEqual([]);
      });
    }
  }

  it('covers the call that actually broke — createRecord with an attachment', () => {
    // A guard that matched nothing would pass forever. This pins the specific
    // call site down, so a refactor that moves the upload out of `createRecord`
    // fails here rather than silently stopping being checked.
    const calls = callsTo(read('src/lib/records/handler.ts'), 'uploadRecords');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/\bcompanyId\b/);
  });

  it('the personal case is expressed as a company of null, never as silence', () => {
    // `uploadRecords` reads `source.companyId ?? null`, so a MISSING key and an
    // explicit null are the same thing to it — which is precisely why the
    // handler's omission read as "personal" instead of failing.
    expect(read('src/lib/records/upload.ts')).toMatch(/companyId:\s*source\.companyId\s*\?\?\s*null/);
  });
});

describe('the AAD keeps the two accounts apart', () => {
  // If either of these stopped binding companyId, a company file dropped into
  // the personal folder would open cleanly — the failure the explicit `?? null`
  // in both AADs exists to prevent.
  it('a JSON store is sealed against its account', () => {
    const src = read('src/lib/vault/vaultRecords.ts');
    const aad = src.slice(src.indexOf('function storeAad'));
    expect(aad.slice(0, 600)).toMatch(/companyId:\s*companyId\s*\?\?\s*null/);
  });

  it('a document file is sealed against its account', () => {
    const src = read('src/lib/vault/vaultFiles.ts');
    const aad = src.slice(src.indexOf('function fileAad'));
    expect(aad.slice(0, 600)).toMatch(/companyId:\s*companyId\s*\?\?\s*null/);
  });
});
