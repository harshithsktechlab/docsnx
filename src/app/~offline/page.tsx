'use client';

import { useEffect } from 'react';
import { CloudOff, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

const OFFLINE_PATH = '/~offline';

/**
 * Where to go once the network is back.
 *
 * Normally this page is served UNDER the URL the user asked for (see the
 * fallback note in `src/sw.ts`), so a reload is the whole recovery. But a tab
 * can still be sitting on `/~offline` itself — sent there by a service worker
 * from before that fix, or bookmarked — and reloading that only reloads this
 * page. From there, go back to where the user came from, or the dashboard
 * (Shell sends a signed-out visitor on to /login).
 */
function recover() {
  if (window.location.pathname !== OFFLINE_PATH) {
    window.location.reload();
    return;
  }
  let target = '/dashboard';
  try {
    const ref = document.referrer ? new URL(document.referrer) : null;
    if (ref && ref.origin === window.location.origin && ref.pathname !== OFFLINE_PATH) {
      target = ref.pathname + ref.search + ref.hash;
    }
  } catch {
    // Malformed referrer — the dashboard it is.
  }
  window.location.replace(target);
}

/**
 * Serwist's navigation fallback (see `src/sw.ts`). It is served from the
 * precache when a document request can't reach the network, so it must stay
 * fully static — no fetches, no auth, nothing that assumes connectivity.
 * Shell recognises it by route segment (not pathname, since it is served under
 * other URLs) and renders it bare rather than inside the app shell.
 */
export default function OfflinePage() {
  useEffect(() => {
    // Stuck on the literal `/~offline` URL while the browser reports a
    // connection: nothing here will ever change, so leave now. Not done under
    // any other URL — there `onLine` can be true while the server is still
    // unreachable, and reloading on mount would loop.
    if (navigator.onLine && window.location.pathname === OFFLINE_PATH) {
      recover();
      return;
    }

    const onOnline = () => recover();
    // Mobile browsers often skip the `online` event for a backgrounded tab, so
    // re-check when the page comes back into view.
    const onVisible = () => {
      if (document.visibilityState === 'visible' && navigator.onLine) recover();
    };
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  return (
    <main className="min-h-screen flex items-center justify-center p-6 bg-background">
      <div className="w-full max-w-sm bg-card border border-border shadow-2xl rounded-2xl p-6 flex flex-col items-center gap-4 text-center">
        <div className="w-14 h-14 rounded-2xl bg-primary/20 flex items-center justify-center text-primary">
          <CloudOff size={28} />
        </div>
        <div className="flex flex-col gap-1">
          <h1 className="font-bold text-lg text-foreground">You&apos;re offline</h1>
          <p className="text-sm text-muted-foreground">
            DocsNX can&apos;t reach the network right now. Pages you&apos;ve already opened
            still work, and this page reloads by itself once you&apos;re back online.
          </p>
        </div>
        <Button onClick={recover} className="w-full flex items-center gap-2">
          <RefreshCw size={16} /> Try again
        </Button>
      </div>
    </main>
  );
}
