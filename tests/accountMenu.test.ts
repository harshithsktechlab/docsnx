/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE ACCOUNT MENU OFFERS ONLY WHAT THE VIEWER CAN ACTUALLY OPEN         ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Three failures this guards, all of which render as a working-looking menu:
 *
 *  1. A plain member offered Billing, AI Credits, Settings and Audit Logs. This
 *     is not hypothetical — the sidebar group these rows came from declared
 *     `roles: ['TENANT_ADMIN']` and nothing read it for months, so every member
 *     saw four links that all bounce them back to /dashboard.
 *  2. A plan-locked MEMBER sent to /billing, which bounces a non-admin to
 *     /dashboard, which redirects a locked user back to the lock screen. The
 *     two redirects ping-pong; the member never reaches either page.
 *  3. A plan-locked ADMIN NOT offered Billing. They are the one person who can
 *     pay, and by then the rest of the navigation is gone.
 *
 * Tested here rather than through AccountMenu.jsx, which vitest cannot import.
 */
import { describe, it, expect } from 'vitest';
import { accountMenuItems, getInitials, PLAN_LOCK_PATH } from '@/lib/accountMenu';

const paths = (
  viewer: { role?: string | null } | null,
  locked = false,
  companyId: string | null = null,
) => accountMenuItems(viewer, locked, companyId).map((i) => i.path);

describe('accountMenuItems', () => {
  it('gives a tenant admin all four rows, in display order', () => {
    expect(accountMenuItems({ role: 'TENANT_ADMIN' })).toEqual([
      { key: 'billing', name: 'Billing', path: '/billing' },
      { key: 'credits', name: 'AI Credits', path: '/billing/credits' },
      { key: 'settings', name: 'Settings', path: '/settings' },
      { key: 'audit', name: 'Audit Logs', path: '/audit-logs' },
    ]);
  });

  it('offers a plain member nothing but Logout', () => {
    // Logout is not a row — it is unconditional and lives in the component —
    // so an empty list here means a menu holding exactly Logout.
    expect(accountMenuItems({ role: 'MEMBER' })).toEqual([]);
    expect(accountMenuItems({ role: 'USER' })).toEqual([]);
    expect(accountMenuItems({})).toEqual([]);
  });

  it('offers a super admin nothing but Logout: no plan, no credits, no trail', () => {
    // /api/audit-logs denies SUPER_ADMIN outright — the trail is tenant-owned.
    expect(accountMenuItems({ role: 'SUPER_ADMIN' })).toEqual([]);
    expect(accountMenuItems({ role: 'SUPER_ADMIN' }, true)).toEqual([]);
  });

  it('survives a null viewer — /api/auth/me has not answered yet', () => {
    expect(accountMenuItems(null)).toEqual([]);
    expect(accountMenuItems(undefined)).toEqual([]);
  });

  describe('once the plan has lapsed', () => {
    it('leaves the admin the door they can pay through', () => {
      expect(paths({ role: 'TENANT_ADMIN' }, true)).toEqual(['/billing', '/settings']);
    });

    it('sends a member to the lock screen, never to /billing', () => {
      expect(paths({ role: 'MEMBER' }, true)).toEqual([PLAN_LOCK_PATH, '/settings']);
      expect(paths({ role: 'MEMBER' }, true)).not.toContain('/billing');
    });

    it('withholds AI Credits and Audit Logs from everyone', () => {
      for (const role of ['TENANT_ADMIN', 'MEMBER']) {
        const locked = paths({ role }, true);
        expect(locked).not.toContain('/billing/credits');
        expect(locked).not.toContain('/audit-logs');
      }
    });
  });

  /**
   * ── THE ROWS CARRY THE WORKSPACE THEY WERE OPENED FROM ────────────────────
   *
   * None of these four pages has a `/business/<id>/…` form — there is one
   * /settings and one subscription however many companies sit under them — and
   * the shell reads the open workspace out of the URL. So a bare link out of a
   * company moved the whole shell home: the chip, the rail, the bottom nav, the
   * quick actions and the two badge counts all flipped to Personal on a click
   * the user made to open Settings.
   *
   * The other end of this is `activeCompanyFrom` in workspaceNav.ts, which is
   * what reads the param back.
   */
  describe('opened from inside a company', () => {
    const admin = { role: 'TENANT_ADMIN' };

    it('hangs the company off all four rows', () => {
      expect(accountMenuItems(admin, false, 'acme')).toEqual([
        // `axis=business` is the param /billing itself reads to open the right
        // half of the bill; `company` is there for the shell.
        { key: 'billing', name: 'Billing', path: '/billing?axis=business&company=acme' },
        { key: 'credits', name: 'AI Credits', path: '/billing/credits?company=acme' },
        { key: 'settings', name: 'Settings', path: '/settings?company=acme' },
        { key: 'audit', name: 'Audit Logs', path: '/audit-logs?company=acme' },
      ]);
    });

    it('leaves the household exactly as it was', () => {
      // The regression that matters most: every existing link is byte-identical
      // when there is no company to carry.
      for (const nothing of [null, undefined]) {
        expect(accountMenuItems(admin, false, nothing)).toEqual(accountMenuItems(admin));
      }
    });

    it('opens /audit-logs and /billing/credits on that company tab', () => {
      // Not a separate mechanism: both pages already read `?company=` to pick
      // their WorkspaceTabs tab and to filter the fetch, so the menu setting it
      // selects the right tab for free. This holds the param name still.
      const byKey = Object.fromEntries(
        accountMenuItems(admin, false, 'acme').map((i) => [i.key, i.path]),
      );
      for (const key of ['credits', 'audit']) {
        expect(new URLSearchParams(byKey[key].split('?')[1]).get('company')).toBe('acme');
      }
    });

    it('never hangs one off the lock screen', () => {
      // The lock screen is a door OUT of a lapsed account, not a view of a
      // workspace — and the workspace it would name is the one the member has
      // just been locked out of.
      expect(paths({ role: 'MEMBER' }, true, 'acme')).toEqual([PLAN_LOCK_PATH, '/settings?company=acme']);
    });

    it('still offers a member nothing, and a super admin nothing', () => {
      // A company in the URL is not a promotion.
      expect(accountMenuItems({ role: 'MEMBER' }, false, 'acme')).toEqual([]);
      expect(accountMenuItems({ role: 'SUPER_ADMIN' }, false, 'acme')).toEqual([]);
    });
  });
});

describe('getInitials', () => {
  it('takes the first two words', () => {
    expect(getInitials('Rahul Sharma')).toBe('RS');
    expect(getInitials('anita devi kumar')).toBe('AD');
  });

  it('handles one name', () => {
    expect(getInitials('Rahul')).toBe('R');
  });

  it('falls back rather than rendering an empty circle', () => {
    // The moment before /api/auth/me answers, and the tenant whose display name
    // is whitespace.
    expect(getInitials(null)).toBe('?');
    expect(getInitials(undefined)).toBe('?');
    expect(getInitials('')).toBe('?');
    expect(getInitials('   ')).toBe('?');
  });
});
