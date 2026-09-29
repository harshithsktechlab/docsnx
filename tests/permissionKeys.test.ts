import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { PERMISSION_MODULE_KEYS } from '../src/lib/moduleRegistry.js';
import { SCAN_CATEGORY_MODULE } from '@/lib/records/scanCategoryModule';

/**
 * Guards the registry/route contract.
 *
 * `hasPermission` (src/lib/auth.ts) looks a module key up against the rows
 * seeded from DEFAULT_USER_PERMISSIONS and returns false when nothing matches.
 * A route asking for a key the registry never defines therefore 403s every
 * STANDARD user — silently, because TENANT_ADMIN short-circuits to true before
 * the lookup. Three modules shipped that way (rentals, emergency-contacts,
 * invoices), which is what this test exists to prevent.
 *
 * It missed two more, because it only scanned API routes and only matched
 * LITERAL keys. `emergency-contacts/page.js` looked up `'emergency'` and
 * `rentals/page.js` looked up `'contracts'` — neither a real key — so the Share
 * button was permanently hidden for every STANDARD user with no error anywhere.
 * The page scan below is what closes that gap.
 */

const APP_DIR = path.join(__dirname, '..', 'src', 'app');
const API_DIR = path.join(APP_DIR, 'api');
const CALL_RE = /hasPermission\(\s*[A-Za-z_$][\w$]*\s*,\s*['"]([^'"]+)['"]/g;
/** How every client page asks the same question: `p.module === '<key>'`. */
const PAGE_RE = /\.module\s*===\s*['"]([^'"]+)['"]/g;

function pageFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return pageFiles(full);
    return /^page\.(tsx|jsx|ts|js)$/.test(entry.name) ? [full] : [];
  });
}

function routeFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return routeFiles(full);
    return /^route\.(ts|js)$/.test(entry.name) ? [full] : [];
  });
}

describe('permission module keys', () => {
  const usages = routeFiles(API_DIR).flatMap((file) => {
    const source = fs.readFileSync(file, 'utf8');
    return [...source.matchAll(CALL_RE)].map((m) => ({
      key: m[1],
      file: path.relative(path.join(__dirname, '..'), file),
    }));
  });

  it('finds hasPermission calls to check', () => {
    expect(usages.length).toBeGreaterThan(20);
  });

  it('every key a route asks for is registered', () => {
    const registered = new Set(PERMISSION_MODULE_KEYS);
    const unknown = usages.filter((u) => !registered.has(u.key));

    expect(
      unknown.map((u) => `${u.file} -> '${u.key}'`),
      'these keys are not in PERMISSION_MODULE_KEYS, so STANDARD users get 403'
    ).toEqual([]);
  });

  it('registry keys are unique', () => {
    expect(PERMISSION_MODULE_KEYS.length).toBe(new Set(PERMISSION_MODULE_KEYS).size);
  });
});

describe('permission module keys used by client pages', () => {
  const usages = pageFiles(APP_DIR).flatMap((file) => {
    const source = fs.readFileSync(file, 'utf8');
    return [...source.matchAll(PAGE_RE)].map((m) => ({
      key: m[1],
      file: path.relative(path.join(__dirname, '..'), file),
    }));
  });

  it('finds the permission lookups the pages perform', () => {
    // If this drops to zero the regex has stopped matching and the test below
    // is silently passing over nothing.
    expect(usages.length).toBeGreaterThan(10);
  });

  it('only asks for keys the registry defines', () => {
    const known = new Set<string>(PERMISSION_MODULE_KEYS);
    const unknown = usages.filter((u) => !known.has(u.key));
    expect(
      unknown.map((u) => `${u.file}: '${u.key}'`),
      'a page checking an undefined key hides its own buttons, silently',
    ).toEqual([]);
  });
});

describe('the dynamic call sites', () => {
  it('gate on a taxonomy module the registry defines', async () => {
    // Two call sites pass a VARIABLE to hasPermission, so the literal scan above
    // cannot see them: the generic record handler, and the bulk-scan importer's
    // per-category map. Both draw from sets asserted here instead.
    //
    // The handler no longer passes a SCOPE — since 0023 a scope is a page, not a
    // permission key, and since 0024 the question is asked per sub-category. So
    // what has to be registered is every taxonomy module a scope can reach.
    const { RECORD_SCOPE_KEYS, scopeCategories } = await import('@/lib/records/registry');
    const known = new Set<string>(PERMISSION_MODULE_KEYS);
    const reached = new Set(
      RECORD_SCOPE_KEYS.flatMap((s: string) => scopeCategories(s).map((c) => c.moduleKey)));
    expect(
      [...reached].filter((m) => !known.has(m)),
      'a taxonomy module with no permission key denies every STANDARD user',
    ).toEqual([]);

    // The scan importer maps to a SCOPE — it picks a page to file into, and the
    // per-category permission is resolved inside the handler. Its two
    // non-record targets (`todos`, `emergency_contacts`) are plain permission
    // keys with their own branch, so each entry must be one or the other.
    //
    // Imported rather than regexed out of the save route: the map moved to
    // src/lib/records/scanCategoryModule.ts when the bulk-scan review screen
    // needed the same answer, and asserting the real values beats asserting the
    // text of whichever file happens to hold them.
    const mapped = Object.values(SCAN_CATEGORY_MODULE);
    expect(mapped.length).toBeGreaterThan(10);
    const scopes = new Set<string>(RECORD_SCOPE_KEYS);
    expect(
      mapped.filter((k) => !scopes.has(k) && !known.has(k)),
      'a scan category mapped to neither a scope nor a permission key drops its records',
    ).toEqual([]);
  });
});
