'use client';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   BACK NAVIGATION — ONE CONTROL, AND IT NEVER LEAVES THE APP             ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Three pages used to hand-roll their own ArrowLeft and two of those only did
 * it inside an error state. Everywhere else the only route back was the
 * sidebar (desktop) or the four-item bottom nav (mobile) — neither of which
 * reaches a sub-category workspace, a bulk-scan screen or an admin sub-page.
 * Installed as a PWA there is not even a browser back button.
 *
 * ── WHY NOT JUST router.back() ─────────────────────────────────────────────
 * Because a page is very often the FIRST entry in its history: a deep link, a
 * hard refresh, a notification tap, a PWA cold start. `router.back()` there
 * walks out of the app — to whatever the tab held before, or to a blank page.
 * The user asked for a back button, not an exit.
 *
 * So this keeps its own stack of in-app paths in sessionStorage and only calls
 * `router.back()` when it can see there is somewhere in-app to go back TO.
 * Otherwise it PUSHES the parent route, which is always a sensible place to
 * land and never leaves the app.
 *
 * The stack is self-correcting: a browser/hardware back (or a swipe) lands on
 * the path one below the top, which is recognised as a pop rather than pushed
 * as a new entry, so the two histories cannot drift apart.
 */

import { useCallback, useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';

const STACK_KEY = 'docsnx:navStack';

// Route folders that exist but have NO page of their own, so they are never a
// valid place to land. `/modules` is the one: every module page lives at
// `/modules/<moduleKey>` and there is no index above them, so the plain
// strip-a-segment rule below would otherwise send a module page to a 404.
const PAGELESS_ROUTES = ['/modules'];
/** sessionStorage is a string store and this is a hot path — keep it bounded. */
const MAX_DEPTH = 50;

/** Home differs by role: a super-admin's /dashboard is /admin. */
export function homePath(isSuperAdmin) {
  return isSuperAdmin ? '/admin' : '/dashboard';
}

/**
 * Where the brand logo goes. The role's home, EXCEPT for a plan-locked member:
 * /dashboard bounces them straight back out (Shell redirects on `isExpired`), so
 * a logo pointing there would read as broken. Their home is the one door the
 * lock leaves open — billing for an admin who can pay, the lock screen for
 * everyone else. Mirrors `lockedNavGroups` in Shell.js.
 *
 * `lockPath` is passed in rather than hardcoded so it cannot drift from Shell's
 * own PLAN_LOCK_PATH, which is what the redirect and the nav both use.
 *
 * @param {{ isSuperAdmin?: boolean, isTenantAdmin?: boolean, planLocked?: boolean, lockPath?: string }} [role]
 */
export function brandHomePath({
  isSuperAdmin = false,
  isTenantAdmin = false,
  planLocked = false,
  lockPath = '/billing/expired',
} = {}) {
  if (planLocked) return isTenantAdmin ? '/billing' : lockPath;
  return homePath(isSuperAdmin);
}

/**
 * The route one level up. Dropping the last segment covers every shape we
 * have — `/modules/identity/pan_card` → `/modules/identity` → `/dashboard`,
 * `/documents/bulk-scan` → `/documents`, `/admin/tenants` → `/admin`,
 * `/billing/credits` → `/billing` — and a top-level page falls through to home.
 */
export function parentPath(pathname, isSuperAdmin) {
  const home = homePath(isSuperAdmin);
  if (!pathname) return home;
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length <= 1) return home;
  const parent = `/${segments.slice(0, -1).join('/')}`;
  return PAGELESS_ROUTES.includes(parent) ? home : parent;
}

function readStack() {
  try {
    const raw = sessionStorage.getItem(STACK_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // Private mode, or a value some other tab left malformed. A back button is
    // not worth throwing over — fall back to "no history", i.e. the parent.
    return [];
  }
}

function writeStack(stack) {
  try {
    sessionStorage.setItem(STACK_KEY, JSON.stringify(stack));
  } catch {
    /* see readStack */
  }
}

/**
 * @param {{ isSuperAdmin?: boolean }} [options]
 * @returns {{ goBack: () => void, canGoBack: boolean }}
 *   `canGoBack` is false ONLY on the role's home page — everywhere else there
 *   is somewhere to go, even from a cold start, because of the parent fallback.
 */
export default function useBackNavigation({ isSuperAdmin = false } = {}) {
  const router = useRouter();
  const pathname = usePathname();

  // Deliberately no state: nothing rendered depends on the depth — `canGoBack`
  // is a function of the pathname alone and `goBack` reads the stack at click
  // time — so holding it would only cost an extra render per navigation.
  useEffect(() => {
    if (!pathname) return;
    const stack = readStack();

    // A re-render, or a query-string-only change. Not a navigation.
    if (stack[stack.length - 1] === pathname) return;

    if (stack.length > 1 && stack[stack.length - 2] === pathname) {
      stack.pop(); // Went back — by our button, the browser chrome, or a swipe.
    } else {
      stack.push(pathname);
      if (stack.length > MAX_DEPTH) stack.shift();
    }

    writeStack(stack);
  }, [pathname]);

  const goBack = useCallback(() => {
    // > 1 means there is an in-app entry UNDER this one, so the browser's own
    // back is both safe and correct — it restores scroll position and the RSC
    // cache, which a push cannot.
    if (readStack().length > 1) {
      router.back();
      return;
    }
    router.push(parentPath(pathname, isSuperAdmin));
  }, [router, pathname, isSuperAdmin]);

  return { goBack, canGoBack: pathname !== homePath(isSuperAdmin) };
}
