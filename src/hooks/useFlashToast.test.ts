/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   useFlashToast — the arrival end of the hand-off                        ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * src/lib/flashToast.ts proves the slot; this proves the part that was actually
 * broken — WHEN the message is raised. It must speak on the page it was left
 * for, stay quiet on the ones it was not, and raise one toast rather than two
 * when React double-invokes the effect.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useFlashToast } from './useFlashToast';
import { setFlash } from '@/lib/flashToast';

let pathname = '/dashboard';
vi.mock('next/navigation', () => ({ usePathname: () => pathname }));

const success = vi.fn();
const info = vi.fn();
const error = vi.fn();
vi.mock('sonner', () => ({ toast: { success: (...a: any[]) => success(...a), info: (...a: any[]) => info(...a), error: (...a: any[]) => error(...a), warning: vi.fn() } }));

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => { map.set(k, String(v)); },
    removeItem: (k: string) => { map.delete(k); },
    clear: () => map.clear(),
  };
}

beforeEach(() => {
  vi.stubGlobal('sessionStorage', memoryStorage());
  success.mockClear();
  info.mockClear();
  error.mockClear();
  pathname = '/dashboard';
});

afterEach(() => vi.unstubAllGlobals());

describe('on arrival', () => {
  it('raises what the previous page left, with its type', () => {
    setFlash({ message: 'Welcome to DocsNX!', type: 'success', pin: '/dashboard', tag: 'onboarding-done' });

    renderHook(() => useFlashToast());

    expect(success).toHaveBeenCalledTimes(1);
    expect(success.mock.calls[0][0]).toBe('Welcome to DocsNX!');
    // The tag doubles as the toast id, so a repeat replaces rather than stacks.
    expect(success.mock.calls[0][1]).toMatchObject({ id: 'onboarding-done' });
  });

  it('carries the longer duration the gates ask for', () => {
    pathname = '/onboarding';
    setFlash({
      message: 'Finish setting up your workspace first',
      type: 'info',
      pin: '/onboarding',
      tag: 'onboarding-gate',
      duration: 8000,
    });

    renderHook(() => useFlashToast());

    expect(info.mock.calls[0][1]).toMatchObject({ id: 'onboarding-gate', duration: 8000 });
  });

  it('says nothing when the slot is empty', () => {
    renderHook(() => useFlashToast());

    expect(success).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});

describe('a message pinned to another page', () => {
  it('is left where it is — this is the hop, not the destination', () => {
    // The wizard's sentence, while the redirect is still passing through
    // /dashboard. Consuming it here is exactly the bug this closes.
    setFlash({ message: 'Finish setting up your workspace first', type: 'info', pin: '/onboarding' });

    renderHook(() => useFlashToast());

    expect(info).not.toHaveBeenCalled();

    // …and it is still there for the page it was meant for.
    pathname = '/onboarding';
    renderHook(() => useFlashToast());
    expect(info).toHaveBeenCalledTimes(1);
  });
});

describe('a re-run of the effect', () => {
  it('does not raise the same message twice', () => {
    setFlash({ message: 'Login successful!', type: 'success', pin: '/dashboard' });

    const { rerender } = renderHook(() => useFlashToast());
    rerender();
    rerender();

    expect(success).toHaveBeenCalledTimes(1);
  });
});
