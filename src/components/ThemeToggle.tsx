'use client';

import React from 'react';
import { Sun, Moon } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE THEME CONTROL — ONE WRITER, EVERY SURFACE                         ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The theme lives in `localStorage['theme']` and is applied as `data-theme` on
 * <html> (which is what globals.css keys off). That read/write used to be
 * inlined in Shell.js, re-synced by a `setInterval(…, 1000)` that ran forever on
 * every page — a poll standing in for the fact that nothing told the header when
 * the value changed.
 *
 * With more than one control on screen (the header button and the Appearance
 * card on /more) two independent copies of that logic would drift, so the store
 * lives here and both controls subscribe to it. The interval is gone: a write
 * notifies subscribers directly. The `storage` listener stays, because that is
 * the one case a subscriber list cannot see — a change made in ANOTHER TAB.
 *
 * Not `next-themes`' `useTheme()`, even though the provider is mounted in
 * layout.js: switching to it would change hydration and system-preference
 * behaviour across the whole app, which is a bigger change than this needs.
 */

export type Theme = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'theme';
/**
 * Light on a first visit, every viewport. This has to stay in step with
 * `defaultTheme` on the next-themes provider in layout.js: both read this same
 * storage key, and it is the provider's blocking <head> script that paints
 * first. If the two disagree a new visitor gets a flash of the other theme
 * before the mount effect below corrects it.
 */
const DEFAULT: Theme = 'light';

/** The `--background` token for each theme, for the address-bar meta tag. */
const CHROME_COLOR: Record<'light' | 'dark', string> = {
  light: '#ffffff',
  dark: '#121212',
};

const listeners = new Set<() => void>();

/** Cached so `getSnapshot` is referentially stable between notifications. */
let snapshot: Theme = DEFAULT;

function readStored(): Theme {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : DEFAULT;
  } catch {
    // Private mode, or storage disabled. The theme still works for this session.
    return DEFAULT;
  }
}

/**
 * `system` is a preference, not a value — resolve it before it hits the DOM.
 *
 * `matchMedia` is feature-detected rather than assumed: it is absent on the
 * server, and missing or throwing in some embedded webviews. Falling back to
 * the default beats throwing inside a render.
 */
export function resolveTheme(theme: Theme): 'light' | 'dark' {
  if (theme !== 'system') return theme;
  const fallback: 'light' | 'dark' = DEFAULT === 'dark' ? 'dark' : 'light';
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return fallback;
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return fallback;
  }
}

function applyToDocument(theme: Theme) {
  if (typeof document === 'undefined') return;
  const resolved = resolveTheme(theme);
  document.documentElement.setAttribute('data-theme', resolved);
  // The mobile address bar and the PWA status bar read this, not the CSS. Next
  // renders the tag from `viewport.themeColor` in layout.js, but it is absent
  // in tests and on any page rendered without that export — hence the guard.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', CHROME_COLOR[resolved]);
}

function notify() {
  listeners.forEach((l) => l());
}

/** Re-read storage and repaint. Used on mount and on a cross-tab `storage` event. */
function sync() {
  const next = readStored();
  applyToDocument(next);
  if (next !== snapshot) {
    snapshot = next;
    notify();
  }
}

export function setTheme(theme: Theme) {
  snapshot = theme;
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Non-fatal: the attribute below still applies it for this session.
  }
  applyToDocument(theme);
  notify();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  // Attached per-subscriber rather than once at module scope so the listener is
  // removed when the last control unmounts.
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) sync();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

const getSnapshot = () => snapshot;
// The server has no localStorage, so it renders the default. The mount effect
// below corrects it, which is why nothing here reads storage during render.
const getServerSnapshot = (): Theme => DEFAULT;

export function useAppTheme() {
  const theme = React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  // One pass after hydration to adopt what was stored. Doing this in render
  // would make the server and client markup disagree.
  React.useEffect(() => { sync(); }, []);

  const toggleTheme = React.useCallback(() => {
    setTheme(resolveTheme(snapshot) === 'dark' ? 'light' : 'dark');
  }, []);

  return { theme, resolved: resolveTheme(theme), setTheme, toggleTheme };
}

interface ThemeToggleProps {
  /**
   * `icon`     — a single sun/moon button, for a header where space is scarce.
   * `segmented`— an explicit Light / Dark pair, for a settings surface where the
   *              current choice should be readable without decoding an icon.
   */
  variant?: 'icon' | 'segmented';
  className?: string;
}

export function ThemeToggle({ variant = 'icon', className }: ThemeToggleProps) {
  const { resolved, setTheme: choose, toggleTheme } = useAppTheme();

  if (variant === 'segmented') {
    return (
      <div
        role="radiogroup"
        aria-label="Theme"
        className={cn(
          'inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/40 p-1',
          className
        )}
      >
        {(['light', 'dark'] as const).map((option) => {
          const active = resolved === option;
          const Icon = option === 'light' ? Sun : Moon;
          return (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => choose(option)}
              className={cn(
                'flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-bold capitalize transition-colors',
                active
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <Icon size={14} strokeWidth={2.5} />
              {option}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={resolved === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      title={resolved === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      className={cn(
        'inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
        className
      )}
    >
      {resolved === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
    </button>
  );
}
