/**
 * The back button's whole job is to not strand the user, so what is worth
 * testing is the two decisions it makes: where "up" is from an arbitrary path,
 * and whether there is in-app history to walk back through at all. The second
 * is the one that matters — `router.back()` on a cold-started deep link walks
 * OUT of the app, which is what the nav stack exists to prevent.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const mockBack = vi.fn();
const mockPush = vi.fn();
let mockPathname = '/dashboard';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ back: mockBack, push: mockPush }),
  usePathname: () => mockPathname,
}));

import useBackNavigation, { parentPath, homePath, brandHomePath } from './useBackNavigation';

describe('parentPath', () => {
  it('walks a sub-category workspace up one level at a time', () => {
    expect(parentPath('/modules/identity/pan_card', false)).toBe('/modules/identity');
    expect(parentPath('/modules/identity', false)).toBe('/dashboard');
  });

  it('handles the nested utility screens', () => {
    expect(parentPath('/documents/bulk-scan', false)).toBe('/documents');
    expect(parentPath('/dashboard/context', false)).toBe('/dashboard');
    expect(parentPath('/billing/credits', false)).toBe('/billing');
    expect(parentPath('/admin/tenants', false)).toBe('/admin');
  });

  it('sends a top-level page to the role’s home', () => {
    expect(parentPath('/passwords', false)).toBe('/dashboard');
    expect(parentPath('/admin/tenants', true)).toBe('/admin');
    expect(parentPath('/admin', true)).toBe('/admin');
    expect(homePath(true)).toBe('/admin');
  });

  it('never returns empty for a malformed or root path', () => {
    expect(parentPath('/', false)).toBe('/dashboard');
    expect(parentPath('', false)).toBe('/dashboard');
    expect(parentPath(undefined as unknown as string, false)).toBe('/dashboard');
  });
});

describe('brandHomePath', () => {
  it('sends each role to its own home', () => {
    expect(brandHomePath({})).toBe('/dashboard');
    expect(brandHomePath({ isSuperAdmin: true })).toBe('/admin');
    expect(brandHomePath({ isTenantAdmin: true })).toBe('/dashboard');
  });

  it('never points a plan-locked user at /dashboard, which bounces them', () => {
    // A member's only open door is the lock screen; an admin can still pay.
    expect(brandHomePath({ planLocked: true })).toBe('/billing/expired');
    expect(brandHomePath({ planLocked: true, isTenantAdmin: true })).toBe('/billing');
    expect(brandHomePath({ planLocked: true, lockPath: '/billing/amc-lock' })).toBe('/billing/amc-lock');
  });
});

describe('useBackNavigation', () => {
  beforeEach(() => {
    sessionStorage.clear();
    mockBack.mockClear();
    mockPush.mockClear();
    mockPathname = '/dashboard';
  });

  it('pushes the parent rather than calling back() on a cold deep link', () => {
    // One entry in the stack — nothing in-app underneath. This is the case that
    // used to walk the user out of the app entirely.
    mockPathname = '/modules/identity/pan_card';
    const { result } = renderHook(() => useBackNavigation({ isSuperAdmin: false }));

    act(() => result.current.goBack());

    expect(mockBack).not.toHaveBeenCalled();
    expect(mockPush).toHaveBeenCalledWith('/modules/identity');
  });

  it('uses real history once there is somewhere in-app to go back to', () => {
    const { rerender, result } = renderHook(() => useBackNavigation({ isSuperAdmin: false }));
    mockPathname = '/passwords';
    rerender();

    act(() => result.current.goBack());

    expect(mockBack).toHaveBeenCalledTimes(1);
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('pops rather than pushes when the user goes back by other means', () => {
    const { rerender } = renderHook(() => useBackNavigation({ isSuperAdmin: false }));
    mockPathname = '/passwords';
    rerender();
    expect(JSON.parse(sessionStorage.getItem('docsnx:navStack')!)).toEqual(['/dashboard', '/passwords']);

    // Browser chrome / hardware back / edge swipe — not our button.
    mockPathname = '/dashboard';
    rerender();
    expect(JSON.parse(sessionStorage.getItem('docsnx:navStack')!)).toEqual(['/dashboard']);
  });

  it('does not grow the stack on a re-render at the same path', () => {
    const { rerender } = renderHook(() => useBackNavigation({ isSuperAdmin: false }));
    rerender();
    rerender();
    expect(JSON.parse(sessionStorage.getItem('docsnx:navStack')!)).toEqual(['/dashboard']);
  });

  it('hides itself only on the role’s own home', () => {
    const { result, rerender } = renderHook(
      ({ sa }) => useBackNavigation({ isSuperAdmin: sa }),
      { initialProps: { sa: false } },
    );
    expect(result.current.canGoBack).toBe(false);   // /dashboard

    mockPathname = '/passwords';
    rerender({ sa: false });
    expect(result.current.canGoBack).toBe(true);

    mockPathname = '/admin';
    rerender({ sa: true });
    expect(result.current.canGoBack).toBe(false);
  });
});
