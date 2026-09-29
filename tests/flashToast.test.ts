/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   flashToast — a message handed to the page it belongs on                ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The defect this exists to close: every message in the auth flow was raised
 * for the page the reader was about to LEAVE, and the root <Toaster /> survives
 * client navigation, so four of them piled up at the top right of a sign-up.
 *
 * What is worth pinning here is the hand-off itself — one slot, the last writer
 * wins, a pinned message waits for its own page, and nothing throws when the
 * browser refuses `sessionStorage` (Safari private mode, blocked site data),
 * because a message not shown must never break a sign-up.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setFlash, peekFlash, popFlash, clearFlash } from '@/lib/flashToast';

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
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('the hand-off', () => {
  it('gives an unpinned message to whatever arrival comes first', () => {
    setFlash({ message: 'Login successful!', type: 'success' });

    const got = popFlash('/dashboard');

    expect(got?.message).toBe('Login successful!');
    expect(got?.type).toBe('success');
  });

  it('is read and cleared in one call, so a re-run of the effect stays quiet', () => {
    setFlash({ message: 'Welcome to DocsNX!', type: 'success' });

    expect(popFlash('/dashboard')?.message).toBe('Welcome to DocsNX!');
    // React double-invokes effects in development; the second run must find
    // an empty slot rather than raise the toast again.
    expect(popFlash('/dashboard')).toBeNull();
  });
});

describe('pinning', () => {
  it('holds a pinned message through the pages it is not for', () => {
    setFlash({ message: 'Finish setting up your workspace first', type: 'info', pin: '/onboarding' });

    // The gate redirects through /dashboard on the way to the wizard. That
    // render must not consume the sentence meant for the wizard.
    expect(popFlash('/dashboard')).toBeNull();
    expect(popFlash('/onboarding')?.message).toBe('Finish setting up your workspace first');
  });

  it('matches on the pathname alone, since the destination carries a query', () => {
    // /verify-email is pushed with ?identifier=…&emailHint=…
    setFlash({ message: 'Registration successful!', type: 'success', pin: '/verify-email' });

    expect(popFlash('/verify-email')?.message).toBe('Registration successful!');
  });
});

describe('one slot, last writer wins', () => {
  it('lets the gate supersede what the page being left had queued', () => {
    setFlash({ message: 'Account verified successfully!', type: 'success', tag: 'verified' });
    setFlash({ message: 'Finish setting up your workspace first', type: 'info', pin: '/onboarding' });

    expect(popFlash('/onboarding')?.message).toBe('Finish setting up your workspace first');
  });

  it('shows the superseded message to the writer first, via peek', () => {
    setFlash({ message: 'Account verified successfully!', type: 'success', tag: 'verified' });

    // What Shell's onboarding gate reads to decide what to say.
    expect(peekFlash()?.tag).toBe('verified');
    // …and peeking must not consume it.
    expect(peekFlash()?.tag).toBe('verified');
  });
});

describe('a hand-off whose navigation never happened', () => {
  it('expires rather than surfacing on an unrelated page later', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T10:00:00Z'));
    setFlash({ message: 'Login successful!', type: 'success' });

    vi.setSystemTime(new Date('2026-09-18T10:01:01Z')); // 61s — past the TTL

    expect(peekFlash()).toBeNull();
    expect(popFlash('/dashboard')).toBeNull();
  });

  it('is still delivered inside the window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T10:00:00Z'));
    setFlash({ message: 'Login successful!', type: 'success' });

    vi.setSystemTime(new Date('2026-09-18T10:00:30Z'));

    expect(popFlash('/dashboard')?.message).toBe('Login successful!');
  });

  it('can be dropped outright', () => {
    setFlash({ message: 'Login successful!', type: 'success' });
    clearFlash();
    expect(peekFlash()).toBeNull();
  });
});

describe('when the browser refuses storage', () => {
  it('neither writes nor reads throw', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => { throw new Error('The operation is insecure.'); },
      setItem: () => { throw new Error('The operation is insecure.'); },
      removeItem: () => { throw new Error('The operation is insecure.'); },
    });

    expect(() => setFlash({ message: 'Login successful!', type: 'success' })).not.toThrow();
    expect(popFlash('/dashboard')).toBeNull();
    expect(peekFlash()).toBeNull();
    expect(() => clearFlash()).not.toThrow();
  });

  it('survives a slot someone else scribbled on', () => {
    sessionStorage.setItem('docsnx_flash', 'not json');
    expect(peekFlash()).toBeNull();
  });
});
