/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE WORKSPACE LINKS FOLLOW THE WORKSPACE                               ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Passwords, to-dos and important contacts exist in both accounts. So in a
 * company workspace the sidebar's own links are what decide which account the
 * user lands in, and an unprefixed one walks them back into the household's
 * passwords from inside Acme — silently, because the page renders perfectly.
 *
 * There are no exclusions left. `/profile` and `/users` were the two, while
 * neither had a `/business/<id>/…` page to point at; both do now, because both
 * turned out to be per-account after all — a company has an identity of its own,
 * and a roster mixing an employee with a family member is the blur the business
 * account exists to remove. The list is kept as the extension point, and this
 * file asserts it is a PARTITION rather than asserting its two halves by name.
 *
 * Tested here rather than through `Shell.js`, which is JSX in a `.js` file and
 * cannot be imported by vitest at all.
 */
import { describe, it, expect } from 'vitest';
import {
  UTILITY_MODULES,
  COMPANY_UNPREFIXED_PATHS,
  utilityNavPath,
} from '@/lib/moduleRegistry';

const COMPANY = '3f4e0b2a-0000-4000-8000-000000000001';

describe('utilityNavPath', () => {
  it('leaves every path alone in the personal workspace', () => {
    for (const m of UTILITY_MODULES) {
      for (const absent of [null, undefined, '']) {
        expect(utilityNavPath(m.path, absent as any), m.path).toBe(m.path);
      }
    }
  });

  it('prefixes the three company-scoped utilities', () => {
    for (const path of ['/passwords', '/todos', '/important-contacts']) {
      expect(utilityNavPath(path, COMPANY)).toBe(`/business/${COMPANY}${path}`);
    }
  });

  it('prefixes the two that used to be excluded', () => {
    // The regression this names: `/profile` and `/users` unprefixed inside a
    // company were links that walked the user back into the household without
    // saying so — the company's own profile and roster were unreachable.
    for (const path of ['/profile', '/users']) {
      expect(utilityNavPath(path, COMPANY), path).toBe(`/business/${COMPANY}${path}`);
    }
  });

  it('leaves anything on the exclusion list alone', () => {
    // Empty today. Asserted as a rule rather than as a list so that adding a
    // genuinely tenant-wide utility later is a one-line change here.
    for (const path of COMPANY_UNPREFIXED_PATHS) {
      expect(utilityNavPath(path, COMPANY), path).toBe(path);
    }
  });

  it('splits the whole Workspace group between those two cases and no third', () => {
    // Every utility is either prefixed or explicitly excluded. A path that ends
    // up as neither — say a prefix applied to a page that was never created —
    // would be a dead link, so assert the partition rather than the two halves.
    const prefixed: string[] = [];
    const kept: string[] = [];
    for (const m of UTILITY_MODULES) {
      const href = utilityNavPath(m.path, COMPANY);
      (href === m.path ? kept : prefixed).push(m.path);
      expect(href === m.path || href === `/business/${COMPANY}${m.path}`, m.path).toBe(true);
    }
    expect(kept.sort()).toEqual([...COMPANY_UNPREFIXED_PATHS].sort());
    expect(prefixed.sort()).toEqual(
      ['/important-contacts', '/passwords', '/profile', '/todos', '/users'],
    );
  });

  it('has a real page behind every prefixed link', async () => {
    // The exclusion list is a claim about the filesystem, and a wrong claim
    // renders as a 404 rather than as a failure anywhere else.
    const { existsSync } = await import('node:fs');
    for (const m of UTILITY_MODULES) {
      if (utilityNavPath(m.path, COMPANY) === m.path) continue;
      expect(
        existsSync(`src/app/business/[companyId]${m.path}/page.js`)
          || existsSync(`src/app/business/[companyId]${m.path}/page.tsx`),
        `no business page for ${m.path}`,
      ).toBe(true);
    }
  });
});

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE FIVE NON-UTILITY PAGES THE SHELL ALSO PREFIXES                     ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * A company workspace reaches everything the household does. Four of those are
 * not in UTILITY_MODULES — they are pages in their own right — so the loop above
 * does not cover them, and each is drawn by `Shell.js` (the Overview group and
 * the mobile bottom nav) or by `MoreScreen.jsx`.
 *
 * Asserted against the filesystem for the same reason as the utilities: a
 * prefixed link with no page behind it is a 404 out of a link the app drew
 * itself, and nothing else in the suite would notice. `Shell.js` is JSX in a
 * `.js` file and cannot be imported by vitest at all, so the paths are listed
 * here — if one is renamed there, this fails and says so.
 */
const SHELL_PREFIXED_PATHS = [
  '/documents',
  '/documents/bulk-scan',
  '/analysis',
  '/follow-up',
  '/more',
];

describe('the business pages the Shell links to', () => {
  it('all take the company prefix', () => {
    for (const path of SHELL_PREFIXED_PATHS) {
      expect(utilityNavPath(path, COMPANY), path).toBe(`/business/${COMPANY}${path}`);
    }
  });

  it('all have a real page behind them', async () => {
    const { existsSync } = await import('node:fs');
    for (const path of SHELL_PREFIXED_PATHS) {
      expect(
        existsSync(`src/app/business/[companyId]${path}/page.js`)
          || existsSync(`src/app/business/[companyId]${path}/page.tsx`),
        `no business page for ${path}`,
      ).toBe(true);
    }
  });

  it('has the personal original of each one too', async () => {
    // The business route is a thin re-export of the personal page, so a missing
    // personal page is a broken import in BOTH workspaces.
    const { existsSync } = await import('node:fs');
    for (const path of SHELL_PREFIXED_PATHS) {
      expect(
        existsSync(`src/app${path}/page.js`) || existsSync(`src/app${path}/page.tsx`),
        `no personal page for ${path}`,
      ).toBe(true);
    }
  });
});
