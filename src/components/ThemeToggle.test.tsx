import React from 'react';
import { render, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { ThemeToggle, setTheme } from './ThemeToggle';

/** jsdom ships no matchMedia, so the `system` path needs one supplied. */
function stubMatchMedia(prefersDark: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: prefersDark,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
}

/**
 * The point of this component is that there is ONE writer. Shell used to own
 * the read/write inline and paper over the lack of notification with a 1s
 * poll; these tests pin the three things that replaced it.
 */
describe('ThemeToggle', () => {
  beforeEach(() => {
    stubMatchMedia(false);
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    // Pin a known starting theme between tests — the store is module-level, so
    // it survives unmount by design. Storage is deliberately left holding the
    // same value: the mount effect re-reads it, and a store that disagreed with
    // storage would flip the theme out from under the first assertion. The one
    // test that cares about an EMPTY store clears it itself.
    act(() => setTheme('dark'));
  });

  it('writes BOTH localStorage and the data-theme attribute', () => {
    const { getByRole } = render(<ThemeToggle />);

    fireEvent.click(getByRole('button'));

    expect(localStorage.getItem('theme')).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('keeps two mounted controls in sync without a poll', () => {
    const header = render(<ThemeToggle />);
    const settings = render(<ThemeToggle variant="segmented" />);

    // Toggling the header button must immediately re-render the segmented one.
    fireEvent.click(header.getByRole('button'));

    const light = settings.getByRole('radio', { name: /light/i });
    const dark = settings.getByRole('radio', { name: /dark/i });
    expect(light).toHaveAttribute('aria-checked', 'true');
    expect(dark).toHaveAttribute('aria-checked', 'false');

    // …and the reverse: choosing Dark on the card updates the header's label.
    fireEvent.click(dark);
    expect(header.getByRole('button')).toHaveAttribute('aria-label', 'Switch to light mode');
  });

  it('adopts a change made in another tab', () => {
    const { getByRole } = render(<ThemeToggle />);
    expect(getByRole('button')).toHaveAttribute('aria-label', 'Switch to light mode');

    localStorage.setItem('theme', 'light');
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'theme', newValue: 'light' }));
    });

    expect(getByRole('button')).toHaveAttribute('aria-label', 'Switch to dark mode');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('resolves `system` against the OS preference, not into the DOM raw', () => {
    // `system` is not a value `data-theme` can carry — globals.css keys off
    // light/dark only — so it has to be resolved on the way out.
    stubMatchMedia(true);
    act(() => setTheme('system'));
    render(<ThemeToggle />);

    expect(localStorage.getItem('theme')).toBe('system');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

    stubMatchMedia(false);
    act(() => setTheme('system'));
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('survives a browser with no matchMedia rather than throwing mid-render', () => {
    // Absent in some embedded webviews. Falling back beats an exception inside
    // a render that would take the whole shell down.
    // @ts-expect-error — deleting an optional-at-runtime global
    delete window.matchMedia;

    expect(() => {
      act(() => setTheme('system'));
      render(<ThemeToggle />);
    }).not.toThrow();
    // Falls back to the module default, which is light.
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('defaults to light when nothing is stored', () => {
    // The behaviour this whole file exists to pin: a first-time visitor, on any
    // viewport, lands in light — even with an OS that prefers dark.
    stubMatchMedia(true);
    localStorage.clear();
    render(<ThemeToggle />);

    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('repaints the address bar alongside the theme', () => {
    // Mobile chrome reads the meta tag, not the CSS — one writer owns both.
    const meta = document.createElement('meta');
    meta.setAttribute('name', 'theme-color');
    document.head.appendChild(meta);

    try {
      act(() => setTheme('dark'));
      expect(meta.getAttribute('content')).toBe('#121212');

      act(() => setTheme('light'));
      expect(meta.getAttribute('content')).toBe('#ffffff');
    } finally {
      meta.remove();
    }
  });
});
