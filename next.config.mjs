import withSerwistInit from "@serwist/next";
import { PHASE_PRODUCTION_BUILD } from "next/constants.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// Serwist's `precachePrerendered` (on by default) globs
// `.next/server/{app,pages}/**/*.html` — but Serwist writes `sw.js` during
// webpack compilation, which finishes *before* Next's static-generation phase
// creates those files (measured 16s apart on this project). The glob therefore
// matches nothing on a clean build, which is why the precache holds only
// `/_next/**` chunks and `public/` assets and not a single page. The offline
// fallback registered in `src/sw.ts` needs `/~offline` to have been precached,
// so it has to be listed explicitly. Revision = the page's own source hash: it
// changes when the page changes (clients refetch) and is stable otherwise
// (builds stay reproducible).
const OFFLINE_FALLBACK_URL = "/~offline";
const offlineFallbackRevision = createHash("sha256")
  .update(readFileSync("src/app/~offline/page.tsx"))
  .digest("hex")
  .slice(0, 16);

// `NEXT_PUBLIC_*` vars are inlined into the client bundle at build time, not read
// at runtime. A build without them ships `undefined` into the Firebase config and
// push notifications die silently in the browser — so fail the build instead.
const REQUIRED_PUBLIC_ENV = [
  "NEXT_PUBLIC_FIREBASE_API_KEY",
  "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN",
  "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
  "NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET",
  "NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID",
  "NEXT_PUBLIC_FIREBASE_APP_ID",
];

const nextConfig = {
  // `next dev` runs Turbopack (see the "dev" script) while `next build` runs
  // Webpack. Sharing one output dir lets stale Turbopack chunks survive a
  // production build, and `next start` then loads them and throws
  // "Expected to use Webpack bindings ... referencing the Turbopack bindings"
  // on every request. Keeping dev output separate makes that impossible.
  // NOTE: /opt/docsnx IS the live deployment — prod serves straight out of .next.
  distDir: process.env.NODE_ENV === 'development' ? '.next-dev' : '.next',
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  serverExternalPackages: ['openai', '@google/genai', 'pdfkit', 'fontkit'],
  // Uploaded files are referenced in the DB as `/uploads/<name>` but must only be
  // served through the authenticated, tenant-scoped handler. This lives in the
  // config rather than in middleware on purpose: a middleware
  // `NextResponse.rewrite(req.nextUrl.clone())` inherits `https` from
  // X-Forwarded-Proto while the server listens plain HTTP on 127.0.0.1:3005, so
  // Next treated the rewrite as external and proxied it over TLS to a non-TLS
  // port (EPROTO -> 500). A relative destination here is routed internally.
  // `beforeFiles` so the rewrite still wins if anything reappears under
  // `public/uploads`.
  async rewrites() {
    return {
      beforeFiles: [
        { source: '/uploads/:filename', destination: '/api/uploads/:filename' },
      ],
      afterFiles: [],
      fallback: [],
    };
  },
  /**
   * The module was renamed from "Emergency Contacts" to "Important Contacts"
   * and its routes moved with the name. These keep the old URLs working:
   *
   *  · a bookmark, a shared link, or the installed PWA's start URL;
   *  · a tab still running the PREVIOUS bundle, which goes on calling
   *    `/api/emergency-contacts` until it is reloaded. `permanent: true` is a
   *    308, so its POST/PUT/DELETE keeps its method and body across the hop —
   *    a 301/302 would silently turn them into GETs.
   *
   * The `/api/:path*` entry must come before the bare one: `:path*` matches the
   * empty remainder too, but only with the slash present.
   */
  async redirects() {
    return [
      { source: '/emergency-contacts', destination: '/important-contacts', permanent: true },
      {
        source: '/business/:companyId/emergency-contacts',
        destination: '/business/:companyId/important-contacts',
        permanent: true,
      },
      {
        source: '/api/emergency-contacts/:path*',
        destination: '/api/important-contacts/:path*',
        permanent: true,
      },
      { source: '/api/emergency-contacts', destination: '/api/important-contacts', permanent: true },
    ];
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-XSS-Protection', value: '1; mode=block' },
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' }
        ],
      },
      {
        // Next serves `public/sw.js` with `Cache-Control: public, max-age=0`,
        // which Cloudflare does not treat as "don't cache": measured on the
        // live origin, the edge rewrote it to `public, max-age=14400` (its
        // default Browser Cache TTL) and cached the worker for four hours.
        // A stale worker at the edge makes the browser's update check flip
        // between two builds — install, prompt, reload, get the old bytes back,
        // prompt again — which is exactly the update banner that never leaves.
        // `no-store` is the one directive Cloudflare will not cache through.
        source: '/sw.js',
        headers: [
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
        ],
      },
    ];
  },
};

const withSerwist = withSerwistInit({
  swSrc: "src/sw.ts",
  swDest: "public/sw.js",
  // Defaults to ["**/*"], which sweeps every file in `public/` — including user
  // uploads — into the precache manifest. Those URLs are auth-gated and
  // tenant-scoped, so precaching them fails the whole install and the app shell
  // never caches. Whitelist the app shell explicitly; everything else is handled
  // by runtime caching.
  // NOTE: negation ("!uploads/**") does NOT work here — Serwist passes these to
  // node-glob, which silently ignores `!`-prefixed patterns. Positive only.
  globPublicPatterns: [
    "favicon.ico",
    "manifest.json",
    "apple-touch-icon.png",
    "icon-*.png",
    "brand/*",
  ],
  additionalPrecacheEntries: [
    { url: OFFLINE_FALLBACK_URL, revision: offlineFallbackRevision },
  ],
  disable: process.env.NODE_ENV === "development",
});

export default (phase) => {
  if (phase === PHASE_PRODUCTION_BUILD) {
    const missing = REQUIRED_PUBLIC_ENV.filter((key) => !process.env[key]);
    if (missing.length > 0) {
      throw new Error(
        `Missing build-time env: ${missing.join(", ")}. NEXT_PUBLIC_* vars are ` +
        `inlined at build; a build without them ships a broken client bundle.`
      );
    }
  }
  return withSerwist(nextConfig);
};
