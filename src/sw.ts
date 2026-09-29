/// <reference lib="webworker" />
import { defaultCache } from "@serwist/next/worker";
import { type PrecacheEntry, Serwist, NetworkOnly } from "serwist";
import { initializeApp } from "firebase/app";
import { getMessaging, onBackgroundMessage } from "firebase/messaging/sw";

declare global {
  interface WorkerGlobalScope {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

// --- Firebase Push Notifications ---
const firebaseConfig = {
  apiKey: "AIzaSyBw3qC3AmUfMXlWDCbRy90DoAFnHtobgR4",
  authDomain: "notifications-29395.firebaseapp.com",
  projectId: "notifications-29395",
  storageBucket: "notifications-29395.firebasestorage.app",
  messagingSenderId: "969126989977",
  appId: "1:969126989977:web:d16ca5626f3bb535e3a808"
};

const app = initializeApp(firebaseConfig);
const messaging = getMessaging(app);

onBackgroundMessage(messaging, (payload) => {
  console.log('[sw.ts] Received background message ', payload);
  const notificationTitle = payload.notification?.title || 'New Notification';
  const notificationOptions = {
    body: payload.notification?.body,
    icon: '/icon-192.png',
    data: {
      url: payload.data?.link || payload.data?.url || (payload.notification as any)?.click_action || '/dashboard'
    }
  };

  self.registration.showNotification(notificationTitle, notificationOptions);
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const rawUrl = event.notification.data?.url || '/dashboard';
  const urlToOpen = new URL(rawUrl, self.location.origin).href;
  
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      // Check if there is already a window/tab open with the target URL
      for (let i = 0; i < windowClients.length; i++) {
        const client = windowClients[i];
        if (client.url === urlToOpen && 'focus' in client) {
          return client.focus();
        }
      }
      // If no window is open or exact match not found, just open the specific record URL
      if (self.clients.openWindow) {
        return self.clients.openWindow(urlToOpen);
      }
    })
  );
});
// -----------------------------------

// --- Serwist PWA & Offline Sync ---

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THERE IS NO OFFLINE WRITE QUEUE, AND THERE NEVER WAS                  ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * This file used to carry a `BackgroundSyncPlugin("offlineQueue")` on a route
 * matching `POST`/`PUT`/`DELETE`, plus a `NEVER_REPLAYED` denylist holding it
 * off the two scan routes. Neither ever ran a single time.
 *
 * `RuntimeCaching.method` defaults to `"GET"` (serwist v9 — `Route`'s
 * constructor, reached from `Serwist.registerCapture(matcher, handler,
 * entry.method)` with `entry.method` undefined). Every entry in
 * `runtimeCaching` below is therefore registered in the router's GET table
 * only, and `handleRequest` looks up `this._routes.get(request.method)`. A POST
 * matched nothing, no handler was found, `event.respondWith` was never called,
 * and the request went to the network exactly as if no worker existed.
 *
 * ── AND IT IS DELIBERATELY NOT BEING SWITCHED ON ───────────────────────────
 * The obvious repair — add `method: "POST"` — is the wrong one, because the
 * guard it restores is a DENYLIST. It named two routes; everything else in the
 * app would begin replaying silently up to 24 hours after the user gave up on
 * it. In this app "everything else" is payments, credit-ledger adjustments,
 * plan changes, record deletions and account erasure. A vault does not get a
 * queue whose safety depends on somebody remembering to add each new dangerous
 * route to a list.
 *
 * If offline writes are wanted, they need their own design: an ALLOWLIST of
 * routes proven idempotent, and a replay the user can see and cancel. That is a
 * feature, not a repair, so it does not live here as dead code implying the
 * behaviour already exists.
 */

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   READS THAT MUST NEVER BE WRITTEN TO THE DEVICE                        ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * These routes serve DECRYPTED vault documents. `defaultCache` routes every
 * same-origin `GET /api/*` through `NetworkFirst({ cacheName: "apis" })`, and
 * Workbox does not consult `Cache-Control` before putting a response into Cache
 * Storage — so the `private, no-store` each of these sends was ignored and a
 * member's passport, medical records and bank statements were being written to
 * the phone's cache storage in the clear. That is the one thing the vault
 * exists to prevent.
 *
 * There is a correctness half too: that strategy falls back to the cache after
 * `networkTimeoutSeconds: 10`, so a slow mobile connection could serve back
 * whichever of the last sixteen API responses happened to still be there.
 *
 * `bulk-download` is a POST and so never reached the "apis" rule, but it hands
 * back a ZIP of the same plaintext and belongs on this list beside the others.
 */
const NEVER_CACHED = [
  /^\/api\/records\/[^/]+\/[^/]+\/file$/,
  /^\/api\/documents\/[^/]+\/file$/,
  /^\/api\/documents\/bulk-download$/,
  /^\/api\/uploads\//,
];

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  // Deliberately NOT `skipWaiting: true`. Serwist only registers its
  // `SKIP_WAITING` message listener in this mode (see serwist's Serwist ctor),
  // so `skipWaiting: true` silently made `usePWA().updateApp()` a no-op — and a
  // worker that activates mid-session can swap the precache out from under a
  // page still running the old chunks. The new worker now waits until the user
  // accepts the reload prompt in `PWABanner`.
  skipWaiting: false,
  clientsClaim: true,
  navigationPreload: true,
  /**
   * ORDER IS THE WHOLE MECHANISM HERE: Serwist takes the FIRST matching route,
   * and the exemption below overlaps something broader by construction. So it
   * goes above what it is exempting itself from — the vault-file rule ahead of
   * `defaultCache`, whose `/api/*` rule would otherwise cache it.
   */
  runtimeCaching: [
    {
      matcher: ({ url, sameOrigin }) =>
        sameOrigin && NEVER_CACHED.some((path) => path.test(url.pathname)),
      handler: new NetworkOnly(),
    },
    /**
     * `?nocache=1` — a request that must reach the origin or fail, never be
     * answered from a cache.
     *
     * `postUpload` uses it to probe reachability after a zero-byte upload
     * failure, to tell "the network is down" from "the browser could not read
     * the file". `/api/auth/me` is otherwise NetworkFirst with a cache
     * fallback, and a cached answer would make an unreachable server look
     * reachable — precisely the confusion the probe exists to resolve. Ahead
     * of `defaultCache` for the same reason the vault-file rule is.
     */
    {
      matcher: ({ url, sameOrigin }) => sameOrigin && url.searchParams.get('nocache') === '1',
      handler: new NetworkOnly(),
    },
    ...defaultCache,
    // Nothing follows for POST/PUT/DELETE: every entry here is GET-only (see
    // the note above), so mutations reach the network untouched by this worker
    // — which is the behaviour the app has always actually had.
  ],
  // Navigations that can't be served from cache or network land on the precached
  // offline page instead of the browser's error screen. The fallback is served
  // UNDER THE REQUESTED URL, so the address bar keeps the page the user asked
  // for and a refresh once the network is back simply loads it.
  //
  // Documents only — deliberately NOT RSC fetches (`RSC: 1`). Answering a
  // client-side navigation with the offline HTML makes Next's router treat it
  // as a non-flight response and hard-navigate to that response's own URL,
  // `/~offline` (fetch-server-response.js → `doMpaNavigation(res.url)`). The
  // tab was then stuck there: every refresh, online or not, reloaded the
  // offline page until the user edited "~offline" out of the address bar.
  // Letting the RSC fetch fail instead sends Next down its catch branch, which
  // hard-navigates to the INTENDED url — a document request, which this entry
  // answers. The cost is a `no-response` line in the console.
  fallbacks: {
    entries: [
      {
        url: "/~offline",
        matcher: ({ request }) => request.destination === "document",
      },
    ],
  },
});

/**
 * Drop the "apis" cache whenever a new worker takes over.
 *
 * The `NEVER_CACHED` rule above stops decrypted documents being written from
 * now on; it does nothing about the ones ALREADY sitting in that cache on every
 * device that has previewed a document. Those are plaintext passports and bank
 * statements, and the only way they leave is if something deletes them.
 *
 * Cheap to do on every activation rather than once: this cache holds nothing
 * but API GET responses under a NetworkFirst strategy, so the whole cost of
 * clearing it is that an offline user re-fetches on their next connection. New
 * workers activate rarely — only on a deploy the user has accepted in
 * `PWABanner` — so this is not a recurring tax.
 */
self.addEventListener("activate", (event) => {
  event.waitUntil(caches.delete("apis"));
});

serwist.addEventListeners();
