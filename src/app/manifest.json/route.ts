import { APP_NAME, APP_TAGLINE, APP_MARK } from '@/lib/brand';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE PWA MANIFEST — was public/manifest.json                            ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * A route instead of a static file so its icons can be the app logo the super
 * admin uploads (`APP_MARK` → /api/brand/logo). The URL, name, colours and
 * shortcuts are unchanged. One image serves every declared size: the browser
 * scales it, and the admin page sends ≤512px.
 *
 * No database read here — the icon URLs are constant and the logo behind them is
 * revalidated by its ETag — so this stays a static response.
 */
export const dynamic = 'force-static';

const icon = (size: number, extra: Record<string, string> = {}) => ({
  src: APP_MARK,
  sizes: `${size}x${size}`,
  ...extra,
});

export function GET() {
  const manifest = {
    name: APP_NAME,
    short_name: APP_NAME,
    description: APP_TAGLINE,
    start_url: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#ffffff',
    icons: [
      icon(192, { purpose: 'any maskable' }),
      icon(512, { purpose: 'any maskable' }),
    ],
    shortcuts: [
      {
        name: 'View Dashboard',
        short_name: 'Dashboard',
        description: 'Go directly to the DocsNX dashboard',
        url: '/dashboard?utm_source=pwa',
        icons: [icon(192)],
      },
      {
        name: 'Upload Document',
        short_name: 'Upload',
        description: 'Upload a new document to your vault',
        url: '/documents?upload=true&utm_source=pwa',
        icons: [icon(192)],
      },
    ],
  };
  return new Response(JSON.stringify(manifest), {
    headers: { 'Content-Type': 'application/manifest+json' },
  });
}
