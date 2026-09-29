/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE THREE HABITS THAT PUT 159 LIES ON SCREEN                           ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Every one of these was, at some point, the normal way to write a handler in
 * this codebase — which is why there were 159 of the first, 26 of the second
 * and 170 of the third. None of them is wrong in an obvious way at the moment
 * you type it; they only become wrong when a proxy returns HTML, a phone loses
 * signal, or a tenant runs out of credits.
 *
 * A grep is the right shape of test for that. Reviewing a diff cannot catch the
 * 200th reintroduction of a pattern that looks reasonable in isolation, and
 * this repo already leans on guard tests for exactly this reason (see
 * rlsCoverage and documentDeletion).
 *
 * ── ADDING AN EXEMPTION ────────────────────────────────────────────────────
 * If one of these genuinely is right somewhere, add the path to the list beside
 * the rule WITH a reason. An exemption with no reason is how a guard stops
 * guarding anything.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function walk(dir: string, match: RegExp, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, match, out);
    else if (match.test(entry)) out.push(full);
  }
  return out;
}

/** Source with comments removed — a rule is about code, not about prose. */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const CLIENT_FILES = [
  ...walk('src/app', /\.(jsx?|tsx)$/),
  ...walk('src/components', /\.(jsx?|tsx)$/),
].filter((f) => !f.includes(`${'/'}api${'/'}`) && !f.includes('.test.'));

const ROUTE_FILES = walk('src/app/api', /^route\.(ts|js)$/);

// ───────────────────────────────────────────────────────────────────────────
describe('no client screen calls a transport failure a network error', () => {
  /**
   * The sentence appeared 159 times and covered: a device in airplane mode, a
   * connection dropped mid-request, a request we abandoned, a 413/502 HTML page
   * that made `res.json()` throw, and plain bugs in the handler above it. It
   * was the wrong advice for at least three of those, and it sent people to
   * check a connection that was working.
   */
  const EXEMPT: string[] = [
    // (none — add a path here with the reason it genuinely means the network)
  ];

  it('is not used as a user-facing message anywhere', () => {
    const offenders = CLIENT_FILES
      .filter((f) => !EXEMPT.includes(f))
      .filter((f) => /['"`]Network error/i.test(code(f)));
    expect(offenders).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('no screen reports a failure through alert()', () => {
  /**
   * A blocking, unstyled OS modal that cannot render a second line — which is
   * why all 26 sites threw away the advice half of their message and kept only
   * the failure half. `toastApiError` is the replacement; it shows both.
   */
  it('is not called in any client file', () => {
    const offenders = CLIENT_FILES.filter((f) =>
      /(?<![\w.])alert\s*\(/.test(code(f)));
    expect(offenders).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('no route answers with a bare Internal Server Error', () => {
  /**
   * A phrase from the HTTP spec, with nothing for the user to act on and
   * nothing for support to grep. `serverError(error, operation)` names what was
   * being attempted, states that nothing was changed, and attaches a reference
   * that matches the journal line.
   */
  it('is absent from every route handler', () => {
    const offenders = ROUTE_FILES.filter((f) => /Internal Server Error/.test(code(f)));
    expect(offenders).toEqual([]);
  });

  it('never returns a raw throw message to the client', () => {
    // `auth/me` and `auth/verify-otp` both sent `error.message` under a
    // `details` key — on an endpoint reachable without signing in. A throw from
    // the DB or the token comparison quoted internals to anyone with the form.
    const offenders = ROUTE_FILES.filter((f) => {
      const src = code(f);
      return /details:\s*(error|err)[?.]/.test(src)
        || /error:\s*['"`][^'"`]*['"`]\s*\+\s*(error|err)\./.test(src);
    });
    expect(offenders).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('no client file calls fetch directly', () => {
  /**
   * `fetch` cannot tell offline from a dropped connection from a timeout, and
   * `res.json()` throws on every proxy error page. Going through `apiCall` /
   * `apiRequest` / `postUpload` is what makes those distinguishable — and what
   * files the one-line diagnostic report that turns "it says network error"
   * into a grep on the journal.
   */
  const EXEMPT = [
    // The beacon itself. Routing it through the layer that reports failures to
    // it would recurse, and a failing beacon must stay silent.
    'src/lib/net/outcome.ts',
  ];

  it('goes through the transport layer instead', () => {
    const offenders = CLIENT_FILES
      .filter((f) => !EXEMPT.includes(f))
      .filter((f) => /(?<![\w.])fetch\s*\(/.test(code(f)));
    expect(offenders).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('nothing reads the body off an apiCall result', () => {
  /**
   * `apiCall` returns `{ ok, status }` — deliberately NOT a `Response`. It
   * reads the body once, as text, so that a proxy's HTML page cannot make
   * `JSON.parse` throw, and hands the parsed value back as `json`.
   *
   * So `res.json()` on that result is not a redundant second read, it is a
   * `TypeError: res.json is not a function` — and a SYNCHRONOUS one, which
   * means a trailing `.catch(() => null)` never runs and the throw escapes the
   * handler entirely. Power Scan's batch commit kept the line through the
   * migration off raw `fetch`, and it fired on the SUCCESS path: every record
   * in the chunk was in Drive and in `documents`, and the reviewer was told the
   * save had failed and sent back to press it again.
   *
   * That is the shape worth a guard rather than a review. The line is correct
   * everywhere it was copied FROM, it sits after the `res.ok` check where it
   * reads as careful, and there are 60-odd `apiCall` sites for it to come back
   * in. A raw `fetch` result is a real `Response` — but those are already
   * refused above, so within these files any `res` is an `apiCall` one.
   */
  const EXEMPT: string[] = [
    // (none — a client file with a Response to read has to explain why here)
  ];

  it('uses the already-parsed json instead', () => {
    const offenders = CLIENT_FILES
      .filter((f) => !EXEMPT.includes(f))
      .filter((f) => /from ['"]@\/lib\/net\/apiRequest['"]/.test(code(f)))
      .filter((f) => /\bres\s*\.\s*(?:json|text|blob|arrayBuffer|clone)\s*\(/.test(code(f)));
    expect(offenders).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('the AI vocabulary has exactly one copy', () => {
  it('is never redeclared outside src/lib/aiErrors.ts', () => {
    // `aiKeyManager.ts` imports the provider SDKs and cannot reach a browser
    // bundle, so Power Scan grew its own map — which then covered eight of the
    // eleven codes and drifted. The leaf module is what makes one copy possible.
    const all = [...CLIENT_FILES, ...ROUTE_FILES, ...walk('src/lib', /\.(ts|js)$/)];
    const offenders = all
      .filter((f) => !f.endsWith('src/lib/aiErrors.ts'))
      .filter((f) => /(?:const|let)\s+AI_ERROR_(?:MESSAGES|CODES)\s*(?::[^=]*)?=\s*\{/.test(code(f)));
    expect(offenders).toEqual([]);
  });
});
