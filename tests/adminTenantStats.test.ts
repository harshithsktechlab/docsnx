/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   Super-admin tenant statistics: the module keys, and what may leak      ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The workspace list reported `Docs 0 · Creds 0 · Other 0` for every tenant on
 * the platform, and had for as long as the taxonomy refactor had been shipped.
 * Three independent causes, all of one shape — a literal the code believed was
 * a module key:
 *
 *   - it counted `category_module_key = 'documents'`, which is not a module;
 *   - it grouped on 'medical', 'bank_info', 'trading', 'vehicles',
 *     'lic_mediclaim' and 'investments', the PRE-taxonomy names;
 *   - it never queried `passwords` at all, so "Creds" read `undefined || 0`.
 *
 * None of it threw. A `WHERE` on a value no row holds is a perfectly valid
 * query that returns zero, so the panel was confidently, silently wrong — and a
 * unit test of the route as written would have asserted the same zeros.
 *
 * So the guard is not "does the route return 5". It is that no query anywhere
 * under /api/admin/tenants may filter or group on a hardcoded module key that
 * `DOCUMENT_CATEGORY_MODULES` does not contain. That is the defect class, and
 * it catches the next rename as well as this one.
 *
 * The second half guards the payload. These routes are the only place in the
 * product that reads across every tenant at once, and the rows they touch carry
 * password hashes, OTPs, an encrypted provider key and a live Google OAuth
 * grant. A `select()` with no column list would ship all of it.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { DOCUMENT_CATEGORY_MODULES, UNCATEGORIZED } from '@/lib/documentCategories';
import { PASSWORD_MODULE_KEY } from '@/lib/vault/vaultNaming';

const ROUTES_DIR = path.join(__dirname, '..', 'src', 'app', 'api', 'admin', 'tenants');

/**
 * Comments are stripped before every scan below.
 *
 * These checks look for stale keys in QUERIES, and a comment recording which
 * keys went stale is exactly the note the next reader needs. A scanner that
 * cannot tell the two apart bans writing the bug down.
 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function routeFiles(): { rel: string; text: string }[] {
  const out: { rel: string; text: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (entry.name.endsWith('.ts')) {
        out.push({
          rel: path.relative(path.join(__dirname, '..'), full),
          text: stripComments(fs.readFileSync(full, 'utf8')),
        });
      }
    }
  };
  walk(ROUTES_DIR);
  return out;
}

/** Every value that is legitimately a `documents.category_module_key`. */
const LIVE_MODULE_KEYS = new Set<string>([
  ...DOCUMENT_CATEGORY_MODULES.map((m) => m.moduleKey),
  UNCATEGORIZED.moduleKey,
  PASSWORD_MODULE_KEY,
]);

describe('super-admin tenant stats: module keys', () => {
  it('never compares categoryModuleKey against a key the taxonomy does not define', () => {
    // Matches `eq(documents.categoryModuleKey, 'x')` and the `by.get('x')` shape
    // the old grouped map used — the two ways a stale key got into these files.
    const patterns = [
      /categoryModuleKey\s*,\s*['"]([^'"]+)['"]/g,
      /\bby\.get\(\s*['"]([^'"]+)['"]\s*\)/g,
    ];

    const offenders: string[] = [];
    for (const { rel, text } of routeFiles()) {
      for (const pattern of patterns) {
        for (const m of text.matchAll(pattern)) {
          if (!LIVE_MODULE_KEYS.has(m[1])) offenders.push(`${rel}: "${m[1]}"`);
        }
      }
    }

    expect(offenders, 'stale module key in a super-admin tenant query').toEqual([]);
  });

  it('does not resurrect the pre-taxonomy record-table names as counts', () => {
    // The six keys that made the old breakdown read zero. Named explicitly so
    // that a copy-paste from an old branch fails loudly rather than quietly.
    const RETIRED = ['medical', 'bank_info', 'trading', 'vehicles', 'lic_mediclaim', 'investments'];

    for (const { rel, text } of routeFiles()) {
      for (const key of RETIRED) {
        expect(text.includes(`'${key}'`), `${rel} still references retired module key "${key}"`).toBe(false);
      }
    }
  });

  it('counts credentials from the passwords table, not from documents', () => {
    const listRoute = routeFiles().find((f) => f.rel.endsWith('api/admin/tenants/route.ts'))!;

    // `passwords` was imported and then never used — the import alone looked
    // like the count existed. Require the actual query.
    expect(listRoute.text).toMatch(/\.from\(passwords\)/);
  });
});

describe('super-admin tenant stats: payload', () => {
  it('never selects whole rows from tables that carry secrets', () => {
    // `db.select().from(users)` / `.from(tenants)` takes every column, including
    // password_hash, the email OTP, the encrypted api_key and the Drive tokens.
    const offenders: string[] = [];
    for (const { rel, text } of routeFiles()) {
      for (const m of text.matchAll(/db\.select\(\s*\)\s*\.from\(\s*(users|tenants|payments)\s*\)/g)) {
        offenders.push(`${rel}: select().from(${m[1]})`);
      }
    }
    expect(offenders, 'unrestricted select over a secret-bearing table').toEqual([]);
  });

  it('reports the tenant AI key as a boolean and never ships the key itself', () => {
    for (const { rel, text } of routeFiles()) {
      // The stored value is ciphertext. It is useless to a browser, it is the
      // thing an attacker wants, and shipping it is what let the edit form push
      // it back through PUT to be encrypted a second time.
      const shipsKey = /apiKey:\s*(tenant|t|updatedTenant)\.apiKey\b/.test(text);
      expect(shipsKey, `${rel} puts the encrypted tenant API key in a response`).toBe(false);
    }
  });

  it('filters soft-deleted rows out of every tenant count', () => {
    const listRoute = routeFiles().find((f) => f.rel.endsWith('api/admin/tenants/route.ts'))!;

    // A tenant whose members were erased must not still be reported at 4/6
    // seats, and an erased admin must not remain the workspace's contact.
    for (const table of ['users', 'passwords']) {
      expect(
        listRoute.text.includes(`isNull(${table}.deletedAt)`),
        `member/record counts must exclude soft-deleted ${table}`,
      ).toBe(true);
    }

    // `documents` takes the stronger predicate: `visibleDocument()` excludes
    // tombstones AND half-written 'pending' rows, both of which would overstate
    // what the tenant actually holds. tests/documentDeletion.test.ts owns the
    // rule; this only pins that the count is not left unguarded.
    expect(
      listRoute.text.includes('visibleDocument()') || listRoute.text.includes('isNull(documents.deletedAt)'),
      'record counts must exclude deleted documents',
    ).toBe(true);
  });
});
