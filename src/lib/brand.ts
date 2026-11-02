/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE PRODUCT'S OWN IDENTITY — the logo is super-admin configurable      ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The name, mark, tagline and social image of the application itself. The name,
 * tagline and social image are static. The MARK is the one thing the super admin
 * can replace (Admin → Branding): `APP_MARK` is the URL of /api/brand/logo, which
 * serves the uploaded logo and falls back to the built-in file when there is
 * none. It lives in its own `app_branding` table.
 *
 * Even so, it is NOT the `platform*` columns on `system_configs`. Those describe the
 * BILLING ENTITY printed on an invoice — its legal name, GSTIN, address and the
 * logo that heads the PDF — and are edited under Admin → Settings → Invoicing.
 * The signed-in shell used to render `platformName`/`platformLogo` as its own
 * brand, so uploading an invoice logo silently replaced the product's logo in
 * the sidebar for every member of every tenant, while the login, register and
 * landing pages went on showing the real one. The invoice logo is still a
 * separate setting; the app logo has its own table and its own screen. This
 * module is the one place that answers "what is this application called and
 * what does its mark look like", so the two can no longer drift.
 *
 * The built-in files under `public/brand/`, the legacy favicon/PWA icons and the
 * OG image come from the DocsNX brand kit (Concept 4 — "AI Focused"). The palette
 * lives beside them as the `--docsnx-*` tokens in `globals.css`; the wordmark
 * is typeset by `BrandWordmark.tsx`.
 *
 * Plain module, no `'use client'`: `mailer.ts` and `layout.js` import it on the
 * server and `Shell.js` in the browser.
 */

/** The product name. Rendered in the shell, and the display name on every email. */
export const APP_NAME = 'DocsNX';

/**
 * The company that owns the product, as it appears in the copyright notice on
 * the public pages. Not a tenant's billing name and not `platformName` — those
 * belong to whoever is being invoiced; this one is always us.
 */
export const APP_LEGAL_ENTITY = 'HSK Tech Lab Pvt Ltd';

/** The brand kit's primary tagline, used as the default page description. */
export const APP_TAGLINE = 'AI-Powered Records. Alerts that Matter.';

/**
 * The logo mark, as a URL: the super admin's uploaded logo, or — with none
 * uploaded — a redirect to the built-in mark (`BUILT_IN_APP_MARK`). One image for
 * both themes. Public and unauthenticated, so the login page and the favicon can
 * use it. Append `?v=<appLogoVersion>` (from /api/auth/me) to bust the cache
 * after an upload; without it the browser revalidates by ETag.
 */
export const APP_MARK = '/api/brand/logo';

/**
 * The built-in mark — the gradient document with "NX" and the AI sparkle — on a
 * transparent background. What /api/brand/logo falls back to. 256px, which is 4×
 * the largest size the shell renders it at.
 */
export const BUILT_IN_APP_MARK = '/brand/docsnx-mark.png';

/** The 1200×630 card shown when a link to the app is shared. */
export const APP_OG_IMAGE = '/og-image.jpg';
