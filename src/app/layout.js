import "./globals.css";
import { Suspense } from "react";
import { Inter, Outfit } from "next/font/google";
import Shell from './components/Shell';
import { ThemeProvider } from "@/components/ThemeProvider";
import { FontSizeProvider } from "@/components/FontSizeProvider";
import { Toaster } from "@/components/ui/sonner";
import ShareGate from "@/components/ShareGate";
import { APP_NAME, APP_TAGLINE, APP_OG_IMAGE } from "@/lib/brand";
import { getAppBaseUrl } from "@/lib/appUrl";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

const outfit = Outfit({
  subsets: ["latin"],
  variable: "--font-outfit",
});

const PAGE_TITLE = `${APP_NAME} — Premium Personal & Business Records SaaS`;

export const metadata = {
  // Absolute URLs for the social card: crawlers do not resolve relative
  // `og:image`s. `APP_URL` is pinned in production; in dev this is localhost,
  // which only matters if someone shares a localhost link.
  metadataBase: new URL(getAppBaseUrl()),
  title: PAGE_TITLE,
  description: APP_TAGLINE,
  manifest: "/manifest.json",
  icons: {
    // The brand mark reads the same on both themes, so there is no longer a
    // light/dark PNG pair keyed on `prefers-color-scheme`.
    icon: [
      { url: '/favicon.ico', sizes: 'any' },
      { url: '/icon-192.png', type: 'image/png', sizes: '192x192' }
    ],
    apple: [
      { url: '/apple-touch-icon.png', sizes: '180x180' }
    ]
  },
  openGraph: {
    type: "website",
    siteName: APP_NAME,
    title: PAGE_TITLE,
    description: APP_TAGLINE,
    images: [{ url: APP_OG_IMAGE, width: 1200, height: 630, alt: `${APP_NAME} — ${APP_TAGLINE}` }],
  },
  twitter: {
    card: "summary_large_image",
    title: PAGE_TITLE,
    description: APP_TAGLINE,
    images: [APP_OG_IMAGE],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: APP_NAME,
  },
  formatDetection: {
    telephone: false,
  },
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  // Light is the default theme, so the address bar starts white. ThemeToggle
  // rewrites this tag when the user switches, so it never fights the app.
  themeColor: "#ffffff"
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${inter.variable} ${outfit.variable}`}>
      <body className="font-sans">
        <FontSizeProvider>
          <ThemeProvider attribute="data-theme" defaultTheme="light" enableSystem disableTransitionOnChange>
            {/*
              ── WHY THE SHELL IS WRAPPED ────────────────────────────────────
              Shell reads `useSearchParams()` — the `?company=` the avatar menu
              puts on the four account pages, which is what keeps the workspace
              from flipping to Personal when one of them is opened from inside a
              company. In the App Router that hook must sit under a Suspense
              boundary, and Shell is mounted here, at the root, with nothing
              between it and <body>; without this every route in the app would
              be forced out of static rendering.

              `fallback={null}` because Shell already owns the loading splash:
              a second one here would be two spinners for one wait.
            */}
            <Suspense fallback={null}>
              <Shell>{children}</Shell>
            </Suspense>
            {/*
              Mounted beside the Toaster and for the same reason: any page may
              need it, none of them should have to host it. It renders nothing
              until a share needs a fresh user gesture — see ShareGate.jsx.
            */}
            <ShareGate />
            <Toaster />
          </ThemeProvider>
        </FontSizeProvider>
      </body>
    </html>
  );
}
