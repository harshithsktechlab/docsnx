/**
 * The menu itself, rendered — `accountMenu.test.ts` proves WHICH rows a viewer
 * gets, this proves the panel actually opens and puts them on screen. Both
 * matter: the rows are correct and invisible if the portal never mounts, which
 * is the failure mode a `position: absolute` panel had here before (see
 * row-actions-menu.jsx).
 *
 * Importable only because this component is `.jsx`. Shell.js, which renders it,
 * is `.js` and vitest cannot parse JSX there — hence the split.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import AccountMenu from './AccountMenu';

// Mutable so one test can stand ON an account page. `vi.hoisted` because the
// mock factory is lifted above every other statement in the file.
const { mockPathname } = vi.hoisted(() => ({ mockPathname: { current: '/dashboard' } }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => mockPathname.current,
}));
vi.mock('@/lib/clientAuth', () => ({ clientLogout: vi.fn() }));

afterEach(() => {
  cleanup();
  mockPathname.current = '/dashboard';
});

const ADMIN = { name: 'Rahul Sharma', role: 'TENANT_ADMIN' };

const openMenu = () => fireEvent.click(screen.getByRole('button', { name: /^Account:/ }));

describe('AccountMenu', () => {
  it('shows the initials, not a name, on the closed trigger', () => {
    render(<AccountMenu user={ADMIN} />);
    expect(screen.getByRole('button', { name: 'Account: Rahul Sharma' })).toHaveTextContent('RS');
    // Closed is closed: the panel is a portal and must not be in the document.
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('opens a panel holding the four account rows and Logout', () => {
    render(<AccountMenu user={ADMIN} />);
    openMenu();
    const menu = screen.getByRole('menu', { name: 'Account' });
    expect(menu).toBeInTheDocument();
    for (const label of ['Billing', 'AI Credits', 'Settings', 'Audit Logs', 'Logout']) {
      expect(screen.getByRole('menuitem', { name: label })).toBeInTheDocument();
    }
    // Real links, so Back works and ⌘-click opens a tab.
    expect(screen.getByRole('menuitem', { name: 'Billing' })).toHaveAttribute('href', '/billing');
    expect(screen.getByRole('menuitem', { name: 'Audit Logs' })).toHaveAttribute('href', '/audit-logs');
  });

  it('gives a plain member a menu that is Logout and nothing else', () => {
    render(<AccountMenu user={{ name: 'Anita Devi', role: 'MEMBER' }} />);
    openMenu();
    expect(screen.getAllByRole('menuitem')).toHaveLength(1);
    expect(screen.getByRole('menuitem', { name: 'Logout' })).toBeInTheDocument();
  });

  it('sends a plan-locked member to the lock screen, never to /billing', () => {
    render(<AccountMenu user={{ name: 'Anita Devi', role: 'MEMBER' }} planLocked />);
    openMenu();
    expect(screen.getByRole('menuitem', { name: 'Plan Expired' })).toHaveAttribute('href', '/billing/expired');
    expect(screen.queryByRole('menuitem', { name: 'Billing' })).toBeNull();
  });

  it('logs out and closes', async () => {
    const { clientLogout } = await import('@/lib/clientAuth');
    render(<AccountMenu user={ADMIN} />);
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Logout' }));
    expect(clientLogout).toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('closes on Escape', () => {
    render(<AccountMenu user={ADMIN} />);
    openMenu();
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('renders the same rows as a bottom sheet on a phone', () => {
    render(<AccountMenu user={ADMIN} variant="mobile" />);
    openMenu();
    expect(screen.getByRole('menu', { name: 'Account' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'AI Credits' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });

  /**
   * None of these four pages has a company route — they belong to the tenant —
   * so a bare link out of a company moved the whole shell home: Shell reads the
   * open workspace off the URL, and an unprefixed /settings said Personal.
   * `?company=` is what the shell reads back (`activeCompanyFrom`).
   */
  describe('opened from inside a company', () => {
    const href = (name: string) =>
      screen.getByRole('menuitem', { name }).getAttribute('href');

    it('hangs the company off every row', () => {
      render(<AccountMenu user={ADMIN} activeCompanyId="acme" />);
      openMenu();
      expect(href('Settings')).toBe('/settings?company=acme');
      expect(href('Audit Logs')).toBe('/audit-logs?company=acme');
      expect(href('AI Credits')).toBe('/billing/credits?company=acme');
      expect(href('Billing')).toBe('/billing?axis=business&company=acme');
    });

    it('carries it on the phone sheet too', () => {
      // The two presentations share `accountMenuItems`, and this is what keeps
      // them from drifting: a phone in a company must not walk home either.
      render(<AccountMenu user={ADMIN} activeCompanyId="acme" variant="mobile" />);
      openMenu();
      expect(href('Settings')).toBe('/settings?company=acme');
    });

    it('still highlights the row for the page you are on', () => {
      // `pathname` never carries a query, so comparing the raw href would leave
      // NO row highlighted anywhere inside a company. The comparison is
      // path-only: `/settings?company=acme` and `/settings` are one row.
      mockPathname.current = '/settings';
      render(<AccountMenu user={ADMIN} activeCompanyId="acme" />);
      openMenu();
      expect(screen.getByRole('menuitem', { name: 'Settings' })).toHaveAttribute('aria-current', 'true');
      // And still only that one — '/billing' stays an exact match, or Billing
      // would light up while standing on '/billing/credits'.
      expect(screen.getByRole('menuitem', { name: 'Billing' })).not.toHaveAttribute('aria-current');
    });

    it('does not light up Billing while standing on AI Credits', () => {
      mockPathname.current = '/billing/credits';
      render(<AccountMenu user={ADMIN} activeCompanyId="acme" />);
      openMenu();
      expect(screen.getByRole('menuitem', { name: 'AI Credits' })).toHaveAttribute('aria-current', 'true');
      expect(screen.getByRole('menuitem', { name: 'Billing' })).not.toHaveAttribute('aria-current');
    });
  });
});
