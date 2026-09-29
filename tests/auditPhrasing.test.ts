/**
 * Guards on HOW the audit trail is worded.
 *
 * Every mutation writes a row, and before `auditSentence` existed each of the
 * ~75 call sites wrote its own sentence. The result was a trail a tenant admin
 * could not read: "Uploaded", "Added", "Created" and "Saved" all meant create,
 * eight sites dumped a raw `JSON.stringify` blob into the Details column, and
 * the three lines produced by uploading a Form 16, deleting it and re-uploading
 * it named a category by its internal taxonomy pair and a member by a UUID.
 *
 * Unit-testing one route cannot catch that — each line is individually fine and
 * only the SET is inconsistent. So this scans every `writeAudit()` call in the
 * tree at once, which is the only vantage point from which drift is visible.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SRC = path.join(__dirname, '..', 'src');

/** One `writeAudit({ ... })` call, with the file and line it came from. */
interface AuditCall {
  file: string;
  line: number;
  /** The `details:` value as written in the source, sans trailing comma. */
  details: string;
}

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) out.push(full);
    }
  };
  walk(SRC);
  return out;
}

/**
 * The `details:` value of every writeAudit call, extracted by brace-matching
 * from the `writeAudit(` token.
 *
 * A regex over the whole file cannot do this: the values are multi-line and
 * contain nested braces, template literals and object literals of their own.
 * Counting braces from the call's opening paren is crude but exact enough, and
 * an extraction that fails is reported rather than silently skipped — a call
 * this cannot see is a call the guard does not cover.
 */
function auditCalls(): { calls: AuditCall[]; unparsed: string[] } {
  const calls: AuditCall[] = [];
  const unparsed: string[] = [];

  for (const file of sourceFiles()) {
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(path.join(__dirname, '..'), file);

    // The writer itself, not a caller: it declares writeAudit and re-exports
    // the builder, and every mention inside it is one of those two.
    if (rel === path.join('src', 'lib', 'audit.ts')) continue;

    let from = 0;
    for (;;) {
      const at = text.indexOf('writeAudit(', from);
      if (at === -1) break;
      from = at + 'writeAudit('.length;

      // `writeAudit()` with nothing between the parens is prose — a doc comment
      // pointing at the helper, not a call.
      if (text[at + 'writeAudit('.length] === ')') continue;

      let depth = 0;
      let end = -1;
      for (let i = at + 'writeAudit'.length; i < text.length; i++) {
        const ch = text[i];
        if (ch === '(') depth++;
        else if (ch === ')') { depth--; if (depth === 0) { end = i; break; } }
      }
      if (end === -1) { unparsed.push(`${rel}: unbalanced writeAudit( call`); continue; }

      const body = text.slice(at, end);
      const line = text.slice(0, at).split('\n').length;

      // Shorthand: the sentence was built into a local `details` const just
      // above the call. Read THAT, so a hand-rolled string cannot hide behind
      // a variable name.
      const shorthand = /(^|[\s,{])details\s*,/.test(body);
      if (shorthand) {
        const decl = text.lastIndexOf('const details =', at);
        if (decl === -1) { unparsed.push(`${rel}:${line} passes \`details\` with no local declaration`); continue; }
        calls.push({ file: rel, line, details: text.slice(decl + 'const details ='.length, at).trim() });
        continue;
      }

      const key = body.indexOf('details:');
      if (key === -1) { unparsed.push(`${rel}:${line} has no details:`); continue; }

      // The value runs to the comma that closes it at the same nesting depth.
      let d = 0;
      let stop = body.length;
      for (let i = key + 'details:'.length; i < body.length; i++) {
        const ch = body[i];
        if ('([{`'.includes(ch)) d++;
        else if (')]}'.includes(ch)) d--;
        else if (ch === ',' && d <= 0) { stop = i; break; }
      }
      calls.push({ file: rel, line, details: body.slice(key + 'details:'.length, stop).trim() });
    }
  }
  return { calls, unparsed };
}

const { calls, unparsed } = auditCalls();

describe('the audit trail speaks one language', () => {
  it('finds every writeAudit call in the tree', () => {
    expect(unparsed, `could not read these calls:\n  ${unparsed.join('\n  ')}`).toEqual([]);
    // A floor, not an exact count — routes get added. If this drops sharply the
    // extractor above has broken and the assertions below are vacuous.
    expect(calls.length).toBeGreaterThan(60);
  });

  it('builds every details string with auditSentence()', () => {
    const offenders = calls
      .filter((c) => !c.details.startsWith('auditSentence('))
      // `opts.details` is a pass-through: planProvisioning takes the sentence
      // from its caller, and those callers are checked here like any other.
      .filter((c) => c.details !== 'opts.details')
      .map((c) => `${c.file}:${c.line} — ${c.details.slice(0, 60)}`);

    expect(
      offenders,
      'these write a hand-rolled audit sentence instead of calling auditSentence():\n  '
        + offenders.join('\n  '),
    ).toEqual([]);
  });

  it('names each record in a bulk action rather than counting them', () => {
    // `bulk-delete` always wrote one row per document — "collapsing them would
    // lose which records were removed". `bulk-download` did not, and its line
    // read "Downloaded 2 documents as a ZIP archive": it could answer neither
    // WHICH two nor WHOSE. Both routes now write per-document rows, and a
    // details string built from a bare count is how that regresses.
    const BULK = ['bulk-delete', 'bulk-download'];
    const offenders = calls
      .filter((c) => BULK.some((route) => c.file.includes(route)))
      .filter((c) => !/name:/.test(c.details))
      .map((c) => `${c.file}:${c.line} — ${c.details.slice(0, 60)}`);

    expect(
      offenders,
      'these audit a bulk action without naming the record:\n  ' + offenders.join('\n  '),
    ).toEqual([]);
  });

  it('calls a documents row a "document" on every route that touches one', () => {
    // The same row is reachable from the Documents Manager AND from its
    // sub-category workspace. Uploading it as a "document" and deleting it as a
    // "record" is exactly the inconsistency this file exists to prevent.
    const offenders = calls
      .filter((c) => /kind: 'record'/.test(c.details))
      .map((c) => `${c.file}:${c.line}`);

    expect(
      offenders,
      'these call a documents row a "record"; the trail uses one noun:\n  ' + offenders.join('\n  '),
    ).toEqual([]);
  });

  it('never puts a raw id, a module key or a JSON blob in front of a reader', () => {
    const BANNED: [RegExp, string][] = [
      [/JSON\.stringify/, 'a JSON blob — say it in words'],
      [/\buser ID\b/i, 'a raw user id — name the person'],
      [/\$\{id\}|\$\{\w*[iI]d\}/, 'a raw id — name the record'],
      [/\$\{moduleKey\}\/\$\{documentKey\}/, 'a taxonomy pair — use categoryPhrase()'],
      [/\$\{module\}|\$\{mod\}|\$\{MODULE\}/, 'a module key — use categoryPhrase()'],
    ];

    const offenders: string[] = [];
    for (const c of calls) {
      for (const [pattern, why] of BANNED) {
        if (pattern.test(c.details)) offenders.push(`${c.file}:${c.line} — ${why}`);
      }
    }

    expect(offenders, `these audit lines are unreadable:\n  ${offenders.join('\n  ')}`).toEqual([]);
  });
});
