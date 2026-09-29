'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

// Set the moment the user accepts a reload, read on the very next page load. If
// a worker is *still* waiting then, the activation did not take (a wedged
// worker, or an edge-cached `/sw.js` flip-flopping between two builds) and
// re-prompting would put the user in an endless reload loop. Consumed on read,
// so a genuinely newer build still gets to prompt.
const UPDATE_ACCEPTED_KEY = 'pwa-update-accepted';

// `clientsClaim: true` in `src/sw.ts` means `controllerchange` fires once the
// new worker has actually taken over. It is the only honest "the update landed"
// signal — but a worker that never activates would leave the page hanging, so
// reload anyway after this long.
const CONTROLLER_CHANGE_TIMEOUT_MS = 3000;

// `sessionStorage` throws outright in Safari's private mode and wherever site
// data is blocked; the update prompt must not take the page down with it.
function readAndClearAccepted() {
  try {
    const accepted = sessionStorage.getItem(UPDATE_ACCEPTED_KEY) === 'true';
    if (accepted) sessionStorage.removeItem(UPDATE_ACCEPTED_KEY);
    return accepted;
  } catch {
    return false;
  }
}

function markAccepted() {
  try {
    sessionStorage.setItem(UPDATE_ACCEPTED_KEY, 'true');
  } catch {
    /* nothing to fall back to — worst case the user gets one extra prompt */
  }
}

/**
 * iOS never fires `beforeinstallprompt`, so there is no programmatic install on
 * iPhone/iPad — the only route is Share → Add to Home Screen, which we have to
 * *tell* the user about. iPadOS 13+ reports itself as "MacIntel", so the UA test
 * alone misses iPads; the touch-point count is what separates them from a real
 * Mac. Chrome/Firefox on iOS (`CriOS`/`FxiOS`) have no Add to Home Screen entry
 * at all, so pointing their users at it would just be wrong.
 */
function detectIOS() {
  const ua = navigator.userAgent;
  if (/crios|fxios/i.test(ua)) return false;
  const isIPhone = /iphone|ipad|ipod/i.test(ua);
  const isIPadOS = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  return isIPhone || isIPadOS;
}

function detectStandalone() {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    // Safari's non-standard flag — the only signal iOS gives us.
    navigator.standalone === true
  );
}

export function usePWA() {
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [isInstallable, setIsInstallable] = useState(false);
  const [isIOS, setIsIOS] = useState(false);
  const [isStandalone, setIsStandalone] = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [registration, setRegistration] = useState(null);
  const reloadedRef = useRef(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    // Already launched from the home screen: there is nothing to install and
    // nothing to advertise, so don't even register the listeners. Update
    // observation lives in its own effect below because it must keep running
    // here — an installed PWA has no address bar to reload from, so it needs
    // the prompt more than a tab does.
    if (detectStandalone()) {
      setIsStandalone(true);
      return;
    }

    setIsIOS(detectIOS());

    // Listen for install prompt
    const handleBeforeInstallPrompt = (e) => {
      e.preventDefault();
      setDeferredPrompt(e);
      setIsInstallable(true);
    };

    const handleAppInstalled = () => {
      setIsInstallable(false);
      setDeferredPrompt(null);
      // Remembered so the banner stays gone even if the browser stops reporting
      // standalone mode (e.g. the user opens the site in a tab afterwards).
      localStorage.setItem('pwa-installed', 'true');
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleAppInstalled);

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled', handleAppInstalled);
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;

    // Don't register a service worker here — Serwist registers `/sw.js` (built
    // from `src/sw.ts`, which owns Firebase background messaging). Registering
    // `/firebase-messaging-sw.js` as well put a second worker at scope `/`,
    // competing for control. Just observe whichever worker is active.
    let cancelled = false;

    navigator.serviceWorker.ready.then((reg) => {
      if (cancelled) return;
      setRegistration(reg);

      // The usual case: the update installed during an earlier page view and
      // has been sitting in `waiting` ever since. `updatefound` already fired
      // back then, so listening for it alone would never surface this.
      //
      // A worker still waiting right after the user accepted a reload means the
      // activation did not stick. Prompting again would just loop them, so stay
      // quiet — the worker takes over on its own once the last tab closes.
      if (reg.waiting && !readAndClearAccepted()) setUpdateAvailable(true);

      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing;
        if (newWorker) {
          newWorker.addEventListener('statechange', () => {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              setUpdateAvailable(true);
            }
          });
        }
      });
    }).catch(err => console.error('Service worker not ready:', err));

    return () => { cancelled = true; };
  }, []);

  const installApp = async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') {
      setIsInstallable(false);
    }
    setDeferredPrompt(null);
  };

  const updateApp = useCallback(() => {
    const waiting = registration?.waiting;

    // Nothing is waiting — the worker activated behind our back, so the prompt
    // is stale. Reloading would be pointless churn; just take the card away.
    if (!waiting) {
      setUpdateAvailable(false);
      return;
    }

    setUpdating(true);
    markAccepted();

    // Reloading in the same tick as `postMessage` races the activation: the
    // navigation is usually still served by the *old* worker, so the user gets
    // the old build back and the banner returns on the next load. Wait for the
    // new worker to actually take over instead.
    const reloadOnce = () => {
      if (reloadedRef.current) return;
      reloadedRef.current = true;
      window.location.reload();
    };

    navigator.serviceWorker.addEventListener('controllerchange', reloadOnce, { once: true });
    setTimeout(reloadOnce, CONTROLLER_CHANGE_TIMEOUT_MS);

    // `sw.ts` runs with `skipWaiting: false`, which is what makes this message
    // meaningful: Serwist only registers its SKIP_WAITING listener in that mode.
    waiting.postMessage({ type: 'SKIP_WAITING' });
  }, [registration]);

  // Session-only: a genuinely new build still prompts on the next page load.
  const dismissUpdate = useCallback(() => setUpdateAvailable(false), []);

  return {
    isInstallable,
    installApp,
    isIOS,
    isStandalone,
    updateAvailable,
    updateApp,
    dismissUpdate,
    updating,
  };
}
