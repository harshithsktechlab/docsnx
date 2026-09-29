/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   EVERY MODULE LINK CARRIES ITS WORKSPACE                                ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The navigation twin of tests/workspaceApiCallSites.test.ts. That file pins the
 * REQUEST side — `/api/modules/*` asked for without a company 400s, loudly. This
 * one pins the LINK side, which fails silently instead: `/modules/<m>/<d>` is a
 * real page in the personal workspace, so a company link that loses its
 * `/business/<companyId>` prefix does not 404. It renders perfectly, showing the
 * HOUSEHOLD's records, and the only signal is the address bar.
 *
 * That is the bug this file exists for. Inside a company, opening a module in
 * the sidebar and clicking any sub-category walked the user into the personal
 * account: `ModuleFlyout.jsx` was handed paths that `navModulesFrom` had already
 * prefixed, ignored them, and rebuilt bare ones from `subCategoryPath(...)`. The
 * same omission hid in two more places — the compiled fallback list the rail
 * shows before `/api/document-categories` answers, and the duplicate-upload
 * dialog's link to the record it matched.
 *
 * ── TWO HALVES, AND WHY BOTH ───────────────────────────────────────────────
 * The unit half proves the BUILDER prefixes both of its branches. The sweep
 * proves no component quietly builds a path of its own instead of using what the
 * builder returned — which is what every one of the three offenders did, and
 * what the sixteenth call site added next year will do unless something fails.
 *
 * Source-level for the sweep, for the reason workspaceApiCallSites gives: the
 * failure is an ABSENT PREFIX at one call site out of many, and several of the
 * files are JSX that vitest cannot import at all.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { navModulesFrom } from '@/lib/usePermittedCategories';
import { NAV_MODULES, BUSINESS_NAV_MODULES } from '@/lib/moduleRegistry';

const ROOT = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/**
 * The file with its comments removed.
 *
 * Every assertion below is about what a file DOES, and this repo explains itself
 * at length — the flyout's own header names `subCategoryPath` in the course of
 * explaining why it no longer calls it. Matching prose would fail exactly the
 * files that documented the rule best.
 */
const code = (p: string) => read(p)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '');

const COMPANY = '3f4e0b2a-0000-4000-8000-000000000001';
const PREFIX = `/business/${COMPANY}`;

/** One permitted row, in the shape `/api/document-categories` returns. */
const row = (moduleKey: string, documentKey: string, moduleNo = 1) => ({
  id: `${moduleKey}:${documentKey}`,
  moduleNo,
  moduleKey,
  documentKey,
  moduleName: moduleKey,
  documentName: documentKey,
});

describe('navModulesFrom prefixes a company rail', () => {
  it('prefixes both the module and every sub-category', () => {
    const mods = navModulesFrom(
      [row('biz_tax', 'gst_return'), row('biz_tax', 'itr'), row('biz_registration', 'coi', 2)],
      BUSINESS_NAV_MODULES,
      'business',
      PREFIX,
    );
    expect(mods.length).toBe(2);
    for (const m of mods) {
      expect(m.path, m.key).toBe(`${PREFIX}/modules/${m.key}`);
      for (const s of m.subCategories) {
        expect(s.path, `${m.key}/${s.documentKey}`)
          .toBe(`${PREFIX}/modules/${m.key}/${s.documentKey}`);
      }
    }
  });

  /**
   * The window this file's second bug lived in.
   *
   * `categories` is null until the fetch lands and stays null if it fails, and
   * the fallback used to be returned verbatim — so the first paint of a company
   * rail offered fourteen links into the household, and a member whose fetch
   * failed had nothing else.
   */
  it('prefixes the compiled fallback too, not just the fetched list', () => {
    const mods = navModulesFrom(null, BUSINESS_NAV_MODULES, 'business', PREFIX);
    expect(mods.length).toBe(BUSINESS_NAV_MODULES.length);
    for (const m of mods) {
      expect(m.path, m.key).toBe(`${PREFIX}/modules/${m.key}`);
      for (const s of m.subCategories) {
        expect(s.path, `${m.key}/${s.documentKey}`)
          .toBe(`${PREFIX}/modules/${m.key}/${s.documentKey}`);
      }
    }
  });

  it('does not mutate the shared constant it was handed', () => {
    // BUSINESS_NAV_MODULES is module scope: a mutating prefix would leak into
    // the personal rail, into MoreScreen, and into the next company.
    const before = JSON.stringify(BUSINESS_NAV_MODULES);
    navModulesFrom(null, BUSINESS_NAV_MODULES, 'business', PREFIX);
    navModulesFrom([row('biz_tax', 'gst_return')], BUSINESS_NAV_MODULES, 'business', PREFIX);
    expect(JSON.stringify(BUSINESS_NAV_MODULES)).toBe(before);
  });

  it('leaves the personal rail exactly as it was', () => {
    for (const built of [
      navModulesFrom(null, NAV_MODULES),
      navModulesFrom(null, NAV_MODULES, 'personal', ''),
    ]) {
      expect(built.length).toBe(NAV_MODULES.length);
      for (const m of built) {
        expect(m.path, m.key).toBe(`/modules/${m.key}`);
        for (const s of m.subCategories) {
          expect(s.path).toBe(`/modules/${m.key}/${s.documentKey}`);
        }
      }
    }
  });
});

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   NOBODY REBUILDS A MODULE PATH WITHOUT A PREFIX                         ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `subCategoryPath()` and `MODULE_BASE` are the two ways to name a module route
 * from scratch. Both are correct with a workspace in front of them and wrong
 * without one, so the rule this asserts is: a client file that uses either must
 * also name a workspace somewhere — the `prefix` idiom its siblings use, or the
 * hook that answers it.
 *
 * The alternative — and the better one where it is available — is not to build a
 * path at all: `ModuleFlyout` now renders the `path` it is handed and imports
 * neither symbol, so it passes this sweep by having nothing to check.
 */
const BUILDS_A_MODULE_PATH = /subCategoryPath\(|MODULE_BASE\}?\//;
const NAMES_A_WORKSPACE =
  /useWorkspaceCompanyId|useWorkspaceApi|companyId|utilityNavPath|pathPrefix/;

function clientFiles(): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const entry of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const next = `${rel}/${entry.name}`;
      // The server names its own workspace from the request, not from a link.
      if (next === 'src/app/api') continue;
      if (entry.isDirectory()) walk(next);
      else if (/\.(js|jsx|ts|tsx)$/.test(entry.name) && !/\.test\.[jt]sx?$/.test(entry.name)) {
        out.push(next);
      }
    }
  };
  walk('src/app');
  walk('src/components');
  walk('src/lib');
  return out;
}

describe('client files that build a module route', () => {
  // `moduleRegistry` and `usePermittedCategories` are where the two builders
  // LIVE — the prefix is their parameter, not something they should mention.
  const BUILDERS = ['src/lib/moduleRegistry.js', 'src/lib/usePermittedCategories.ts'];
  const builders = clientFiles()
    .filter((f) => !BUILDERS.includes(f))
    .filter((f) => BUILDS_A_MODULE_PATH.test(code(f)));

  it('finds the call sites at all', () => {
    // A guard on the guard: an empty list would report green while asserting
    // nothing, which is how a sweep rots.
    expect(builders.length, 'no client file appears to build a module path')
      .toBeGreaterThan(2);
  });

  it.each(builders)('%s names the workspace it is linking into', (file) => {
    expect(
      code(file),
      `${file} builds a /modules/... path without ever naming a workspace — inside `
      + '/business/<id>/... that link opens the household\'s records and says nothing.',
    ).toMatch(NAMES_A_WORKSPACE);
  });
});

/**
 * The three sites the bug was found in, pinned to the exact shape that fixes
 * each. The sweep above proves a file knows the question exists; these prove the
 * individual LINK carries the answer.
 */
describe('the three offenders', () => {
  it('ModuleFlyout renders the path it is handed and builds none', () => {
    const src = code('src/app/components/ModuleFlyout.jsx');
    expect(src, 'the flyout imports a path builder again').not.toMatch(BUILDS_A_MODULE_PATH);
    expect(src).toMatch(/const path = sub\.path;/);
    expect(src, 'the header link must use the prefixed modulePath prop')
      .toMatch(/go\(modulePath\)/);
  });

  it('Shell hands the flyout the module path, prefixed', () => {
    const src = code('src/app/components/Shell.js');
    expect(src, 'openModule must carry the row\'s own path').toMatch(/path: item\.path,/);
    expect(src).toMatch(/modulePath=\{openModule\?\.path\}/);
  });

  it('the duplicate dialog links into the workspace it is uploading in', () => {
    const src = code('src/components/records/DuplicateResolveDialog.jsx');
    expect(src).toMatch(/useWorkspaceCompanyId/);
    expect(src).toMatch(/\$\{prefix\}\$\{subCategoryPath\(/);
  });
});
