import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   EVERY MODULE'S REFUSAL IS ANSWERABLE                                   ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * "This already exists" is only useful if the user can answer it. The answer
 * lives in the 409 BODY — which record it matched, what it looks like, and
 * whether keeping both is on offer — and that body is built in exactly one
 * place (`conflictResponsePayload`, records/handler.ts).
 *
 * Fifteen legacy module routes used to assemble their own:
 *
 *     { error, requiresConfirmation: true, existingId }
 *
 * Three fields, none of which a prompt can render a choice from. Six pages
 * turned it into a browser `window.confirm` — OK or Cancel, so overwrite or
 * abandon — and the other nine dropped it into an error banner, which is no
 * answer at all. Keeping both was unreachable in every one of them, though the
 * write path had supported it all along.
 *
 * This is the guard against that drifting back: a route may not hand-build the
 * refusal, and a route that CREATES records must forward the third answer.
 */

const API = path.join(__dirname, '..', 'src', 'app', 'api');

/** The modules that still answer on their own legacy path. */
const LEGACY_MODULES = [
  'bank-info', 'credit-cards', 'employment-payroll',
  'investments', 'lic-mediclaim', 'loans-debt', 'medical', 'rentals',
  'tax-compliance', 'trading', 'utility-bills', 'vehicles', 'warranty',
  'wills-estate',
];

/** …and those of them that also have a dedicated edit route. */
const EDIT_ROUTES = [
  'bank-info', 'credit-cards', 'investments', 'lic-mediclaim', 'medical',
  'rentals', 'trading', 'vehicles', 'warranty',
];

const read = (p: string) => fs.readFileSync(p, 'utf8');
const createRoute = (m: string) => path.join(API, m, 'route.ts');
const editRoute = (m: string) => path.join(API, m, '[id]', 'route.ts');

describe('every legacy module answers a duplicate with the shared body', () => {
  const routes = [
    ...LEGACY_MODULES.map(createRoute),
    ...EDIT_ROUTES.map(editRoute),
  ];

  it.each(routes)('%s builds the 409 through conflictResponsePayload', (file) => {
    const src = read(file);

    expect(src).toContain('conflictResponsePayload');
    // The stunted shape, by its most distinctive fragment. A route that
    // reintroduced it would answer with something the prompt cannot render.
    expect(src).not.toContain('requiresConfirmation: true, existingId');
  });
});

describe('the third answer reaches the write path', () => {
  it.each(LEGACY_MODULES.map(createRoute))('%s forwards keepBoth', (file) => {
    // Without this the button would be offered and then quietly ignored — the
    // upload would overwrite instead of forking, which is the one outcome the
    // user explicitly did not choose.
    expect(read(file)).toMatch(/keepBoth:/);
  });

  it.each(EDIT_ROUTES.map(editRoute))('%s withdraws both write answers', (file) => {
    // An EDIT names its target with `replaceId`; `createRecord` refuses that
    // collision however it is confirmed, so a prompt offering to overwrite or
    // fork would 409 straight back and re-open itself.
    const src = read(file);
    expect(src).toContain('allowKeepBoth: false');
    expect(src).toContain('allowKeepNew: false');
  });
});

describe('every module page renders the prompt', () => {
  const PAGES = path.join(__dirname, '..', 'src', 'app');

  it.each(LEGACY_MODULES.filter((m) => m !== 'credit-cards'))('%s', (mod) => {
    const src = read(path.join(PAGES, mod, 'page.js'));

    expect(src).toContain('DuplicateResolveDialog');
    expect(src).toContain('useDuplicateResolve');
    // The prompt this replaced. `window.confirm` has two answers and no way to
    // show the user what they are choosing between.
    expect(src).not.toMatch(/window\.confirm\(/);
  });
});
