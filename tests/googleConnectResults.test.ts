/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   Every exit from the Google flow has something to say                   ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The OAuth round trip reports itself in the query string: `?google=<status>`.
 * The statuses are written in two route files and read in three pages, with
 * `CONNECT_RESULTS` as the only thing joining them — so a `back('…')` added to
 * a route without an entry here is a page that silently says nothing, which is
 * precisely the defect this module was written for.
 *
 * The routes are read as TEXT rather than imported: they are Next.js route
 * handlers that pull in the db, the auth layer and googleapis at module scope.
 * The same choice tests/driveMandatory.test.ts makes, and for the same reason.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  CONNECT_RESULTS,
  DRIVE_CHECKBOX_LABEL,
  connectResult,
} from '@/lib/googleConnectResults';

const ROUTES = [
  'src/app/api/auth/google/route.ts',
  'src/app/api/auth/google/callback/route.ts',
];

/** Every `back('…')` / `backTo(…, '…')` literal a route can exit through. */
function statusesRedirectedBy(file: string): string[] {
  const source = fs.readFileSync(path.join(process.cwd(), file), 'utf8');
  const found = new Set<string>();
  // `back('cancelled')` and `backTo(req, returnTo, 'forbidden')` both end in
  // the status literal, which is the only argument either call composes.
  for (const match of source.matchAll(/\bback(?:To)?\([^)]*?'([a-z_]+)'\s*\)/g)) {
    found.add(match[1]);
  }
  return [...found];
}

describe('the statuses the routes can redirect with', () => {
  it('are all spoken for', () => {
    const redirected = ROUTES.flatMap(statusesRedirectedBy);

    // A regex that matched nothing would make this whole file pass vacuously.
    expect(redirected.length).toBeGreaterThan(5);
    expect(redirected).toContain('missing_drive_scope');

    const unexplained = redirected.filter((status) => !CONNECT_RESULTS[status]);
    expect(unexplained).toEqual([]);
  });

  it('each carry both a toast line and a sentence that can stand alone', () => {
    for (const [status, result] of Object.entries(CONNECT_RESULTS)) {
      expect(result.message.length, status).toBeGreaterThan(0);
      // The detail is read cold, off a panel, by someone who missed the toast —
      // so it has to carry context the one-liner borrowed from the moment.
      expect(result.detail.length, status).toBeGreaterThan(result.message.length / 2);
      expect(['error', 'info'], status).toContain(result.tone);
    }
  });
});

describe('an unticked Drive permission', () => {
  const result = CONNECT_RESULTS.missing_drive_scope;

  it('is a failure, told loudly', () => {
    expect(result.ok).toBe(false);
    expect(result.tone).toBe('error');
  });

  /**
   * The point of the whole module. An admin who pressed "Continue" is certain
   * they granted access, so the one thing this has to do is send them back to
   * the box — in plain words, not in Google's 88-character scope wording, which
   * is quoted on the pages BEFORE they leave and only buried the instruction
   * when it was repeated here.
   */
  it('sends the admin back to the tick box, in plain words', () => {
    expect(result.detail).toMatch(/tick the box/i);
    expect(result.detail).not.toContain(DRIVE_CHECKBOX_LABEL);
  });

  /**
   * Nothing was stored, so the step is not lost — and an admin reading this
   * off a billing toast mid-signup needs to know the wizard will ask again.
   */
  it('says the connection can be made again', () => {
    expect(result.detail).toMatch(/again/i);
    expect(result.detail).toMatch(/onboarding/i);
  });

  /**
   * It is read in a toast that self-dismisses. The previous wording ran to 270
   * characters and was reported as unreadable; this keeps it to three short
   * sentences.
   */
  it('stays short enough to read before the toast goes', () => {
    expect(result.detail.length).toBeLessThanOrEqual(210);
    expect(result.message.length).toBeLessThanOrEqual(90);
  });
});

/**
 * The label the admin is told to look for, quoted exactly as Google words it.
 * It moved OUT of the failure message, so the only thing keeping it honest is
 * that the pages which show it before the redirect still use the constant.
 */
describe('the Drive tick box label', () => {
  it('is quoted verbatim on every page that starts the flow', () => {
    for (const file of [
      'src/app/onboarding/page.js',
      'src/app/billing/page.js',
      'src/app/settings/page.tsx',
    ]) {
      const source = fs.readFileSync(path.join(process.cwd(), file), 'utf8');
      expect(source, file).toContain('DRIVE_CHECKBOX_LABEL');
    }
  });
});

describe('a cancelled consent screen', () => {
  it('is reported as a choice, not as a fault', () => {
    expect(CONNECT_RESULTS.cancelled.ok).toBe(false);
    expect(CONNECT_RESULTS.cancelled.tone).toBe('info');
  });
});

describe('a status with nothing to say', () => {
  it('produces no message at all rather than a blank one', () => {
    expect(connectResult(null)).toBeNull();
    expect(connectResult(undefined)).toBeNull();
    expect(connectResult('')).toBeNull();
    expect(connectResult('nonsense')).toBeNull();
    // `constructor` and friends live on every object's prototype. Reaching one
    // through the record would hand a page a function where a result belongs.
    expect(connectResult('constructor')).toBeNull();
  });

  it('reports a real one', () => {
    expect(connectResult('connected')?.ok).toBe(true);
  });
});
