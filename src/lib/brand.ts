/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE PRODUCT'S OWN IDENTITY — deliberately NOT configurable             ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The name, mark, tagline and social image of the application itself. These
 * are static, and there is no admin screen that changes them.
 *
 * They are NOT the `platform*` columns on `system_configs`. Those describe the
 * BILLING ENTITY printed on an invoice — its legal name, GSTIN, address and the
 * logo that heads the PDF — and are edited under Admin → Settings → Invoicing.
 * The signed-in shell used to render `platformName`/`platformLogo` as its own
 * brand, so uploading an invoice logo silently replaced the product's logo in
 * the sidebar for every member of every tenant, while the login, register and
 * landing pages went on showing the real one. This module is the one place that
 * answers "what is this application called", so the two can no longer drift.
 *
 * The files under `public/brand/`, the favicon, the PWA icons and the OG image
 * all come from the DocsNX brand kit (Concept 4 — "AI Focused"). The palette
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
 * The logo mark — the gradient document with "NX" and the AI sparkle — on a
 * transparent background. One file for both themes: the gradient reads on
 * light and dark alike, so there is no longer a light/dark pair to pick from.
 * 256px, which is 4× the largest size the shell renders it at.
 */
export const APP_MARK = '/brand/docsnx-mark.png';

/** The 1200×630 card shown when a link to the app is shared. */
export const APP_OG_IMAGE = '/og-image.jpg';
