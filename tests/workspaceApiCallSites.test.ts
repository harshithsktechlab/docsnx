/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   EVERY MODULE-ENDPOINT CALL CARRIES ITS WORKSPACE                       ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `/api/modules/*` and `/api/records/*` are gated by `gateCompany`
 * (src/lib/records/handler.ts). The company is read from `?companyId=` and from
 * NOWHERE else — not a cookie, not the Referer — so a `biz_*` module asked for
 * without it is a 400 whose body reads
 *
 *     "This module belongs to a company. Choose one first."
 *
 * That is not a hypothetical. The pages were converted to carry the workspace
 * (`useWorkspaceApi`, `withCompany`, `SubCategoryWorkspace`'s `companyParam`)
 * and the SHARED FORM COMPONENTS were missed, so inside a company:
 *
 *   · the Document Manager's upload form rendered that sentence where its
 *     fields should be, for every business category;
 *   · the Add/Edit dialog on /business/<id>/modules/<m>/<d> did the same;
 *   · and its Save — a POST to the same gated path — could not write a business
 *     record at all.
 *
 * ── WHY A SOURCE-LEVEL ASSERTION ───────────────────────────────────────────
 * The shape of the bug is an ABSENT QUERY PARAMETER at one call site out of
 * fifteen. Rendering each form and inspecting the URL would prove the ones
 * somebody remembered to write a test for; the failure mode is the sixteenth
 * call site, added later, by someone who did not know the rule. So the sweep
 * below looks at every client file that reaches these endpoints — the same
 * reasoning tests/personalRouteCompanyScope.test.ts gives for reading routes
 * rather than exercising them.
 *
 * It is also the only shape available for two of the offenders:
 * `src/app/documents/page.js` is JSX inside a `.js` file, which vitest cannot
 * parse, so the component genuinely cannot be imported from here.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOT = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/**
 * The gated endpoint families.
 *
 * `/api/modules/` and `/api/records/` go through `withRecordScope`, which 400s
 * a business module asked for without a company — a LOUD failure.
 *
 * `/api/dashboard` is here for the opposite reason. It answers either account
 * happily, so a call site that forgets the workspace does not fail: it renders
 * the household's numbers inside a company, or counts a company's rows on the
 * household's page. That is the bug this endpoint shipped with, and it is
 * invisible in every way except being wrong, which is precisely what a
 * source-level sweep is for.
 */
const GATED_ENDPOINT = /\/api\/(?:modules|records)\/|\/api\/dashboard/;

/**
 * Any of the ways a call site may legitimately name its workspace.
 *
 * `useWorkspaceApi`/`useWorkspaceCompanyId`/`withCompany` are the helpers;
 * `companyParam` and `companyQuery` are the two hand-built query fragments that
 * predate them and are still correct. A file holding none of these has not
 * thought about the question at all, which is the state every offender was in.
 */
const NAMES_A_WORKSPACE =
  /useWorkspaceApi|useWorkspaceCompanyId|withCompany|companyParam|companyQuery/;

/** Every client source file, i.e. everything outside the route handlers. */
function clientFiles(): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const entry of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const next = `${rel}/${entry.name}`;
      // `src/app/api` IS the server. Its handlers read the company off the
      // request; they are the thing being protected, not a caller.
      if (next === 'src/app/api') continue;
      if (entry.isDirectory()) walk(next);
      else if (/\.(js|jsx|ts|tsx)$/.test(entry.name) && !/\.test\.[jt]sx?$/.test(entry.name)) {
        out.push(next);
      }
    }
  };
  walk('src/app');
  walk('src/components');
  return out;
}

describe('client calls to the company-gated endpoints', () => {
  const callers = clientFiles().filter((f) => {
    const src = read(f);
    // A mention in prose is not a call. Every real one goes through one of the
    // three senders, and the endpoint is the first thing in the template.
    return /(?:apiCall|apiRequest|postUpload|api)\(\s*(?:scoped\(|withCompany\()?\s*`\/api\/(?:modules|records)\//.test(src)
      || (GATED_ENDPOINT.test(src) && /await (?:apiCall|apiRequest|postUpload|api)\(\s*\n?\s*(?:scoped\()?`\/api\/(?:modules|records)\//.test(src));
  });

  it('finds the call sites at all', () => {
    // A guard on the guard: if the detection above stops matching, `it.each`
    // over an empty list reports green while asserting nothing.
    expect(callers.length, 'no client file appears to call /api/modules or /api/records')
      .toBeGreaterThan(4);
  });

  it.each(callers)('%s names the workspace it is filing into', (file) => {
    expect(
      read(file),
      `${file} calls a company-gated endpoint without ever naming a workspace — `
      + 'inside /business/<id>/... it will 400 with "This module belongs to a company."',
    ).toMatch(NAMES_A_WORKSPACE);
  });
});

/**
 * The eight call sites the bug was actually found in, pinned to the exact form
 * that fixes them.
 *
 * The sweep above proves a file knows about the workspace; these prove the
 * individual REQUEST carries it. Both are needed — a component can import
 * `withCompany` for one of its five calls and not the other four, which is
 * precisely what CategoryRecordForm would have looked like half-fixed.
 */
describe('the shared form components scope every request', () => {
  it.each([
    // The Document Manager's upload and edit forms.
    ['src/app/components/useCategoryFields.js', /await api\(`\/api\/modules\/\$\{moduleKey\}\/\$\{documentKey\}\/fields`\)/, 1],
    // The module page's Add/Edit dialog: spec, edit seed, autofill, save.
    ['src/app/components/CategoryRecordForm.jsx', /scoped\(\s*`?\/api\/modules\//, 0],
    // The "read it against the category you picked" pass.
    ['src/app/documents/page.js', /scoped\(`\/api\/modules\//, 1],
    // Power Scan's review grid, for a row re-filed into a new category.
    ['src/app/components/ScanRecordFields.jsx', /await api\(`\/api\/modules\//, 1],
    // "What does this category call its number?"
    ['src/app/components/useIdentifierField.js', /withCompany\(\s*`\/api\/modules\//, 1],
  ] as const)('%s', (file, pattern, minimum) => {
    const src = read(file);
    const scoped = (src.match(new RegExp(pattern.source, 'g')) ?? []).length;
    expect(scoped, `${file} has no scoped call matching ${pattern}`).toBeGreaterThanOrEqual(minimum || 1);

    // And nothing left behind: no sender may be handed a bare gated path.
    const bare = src.match(/(?:apiCall|apiRequest|postUpload)\(\s*`\/api\/(?:modules|records)\//g) ?? [];
    expect(bare, `${file} still has ${bare.length} unscoped call(s)`).toHaveLength(0);
  });

  it('CategoryRecordForm scopes ALL FIVE of its calls, the save included', () => {
    const src = read('src/app/components/CategoryRecordForm.jsx');
    // fields, :id (seed), autofill, and the POST/PUT — the last being one
    // `scoped()` wrapping a ternary, so FOUR call expressions covering five
    // endpoints. The count is exact rather than a floor: a fifth `scoped(`
    // would mean a call this list does not know about.
    expect((src.match(/scoped\(`/g) ?? []).length).toBe(3);
    expect((src.match(/scoped\(editing/g) ?? []).length).toBe(1);
    // The save is the one that silently could not write a business record.
    expect(src).toMatch(/scoped\(editing\s*\n?\s*\?\s*`\/api\/modules\//);
  });
});

/**
 * The other half of the contract: the endpoints really are gated, so the
 * parameter above is load-bearing rather than decorative.
 */
describe('the endpoints these calls reach are company-gated', () => {
  it('every /api/modules route goes through the record gate', () => {
    for (const file of [
      'src/app/api/modules/[moduleKey]/[documentKey]/fields/route.ts',
      'src/app/api/modules/[moduleKey]/[documentKey]/route.ts',
      'src/app/api/modules/[moduleKey]/[documentKey]/[id]/route.ts',
      'src/app/api/modules/[moduleKey]/[documentKey]/autofill/route.ts',
    ]) {
      expect(read(file), `${file} does not pass through withCategory/withRecordScope`)
        .toMatch(/with(?:Category|RecordScope)\s*\(/);
    }
  });

  it('the gate refuses a business module with no company', () => {
    const src = read('src/lib/records/handler.ts');
    // The sentence in the bug report, and the condition that produces it.
    expect(src).toMatch(/const wantsCompany = scope\.startsWith\(BUSINESS_MODULE_PREFIX\)/);
    expect(src).toMatch(/if \(wantsCompany && !companyId\)/);
    expect(src).toMatch(/This module belongs to a company\. Choose one first\./);
    // And the company may only come from the query string — never the body.
    expect(src).toMatch(/new URL\(req\.url\)\.searchParams\.get\('companyId'\)/);
  });
});
