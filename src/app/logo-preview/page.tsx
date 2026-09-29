'use client';

/**
 * A dev aid for the brand kit. Not linked from anywhere and not part of the
 * product — the same footing as /gradient-preview and /alerts-preview.
 *
 * Everything on this page is the REAL asset the app ships — the same files
 * `layout.js`, `manifest.json`, `Shell.js` and the auth pages reference, and the
 * same `--docsnx-*` tokens from `globals.css` — rendered against both surfaces
 * the app puts them on. So if a swap under `public/` or a token edit goes
 * wrong, it is one page load away from being visible in both themes rather than
 * waiting to be noticed on a customer's home screen.
 *
 * Source of truth for the kit itself: `DocsNX-Brand-Assets/guidelines/`
 * (gitignored — ask for the folder if you need the PDF or the vector lockups).
 */

import React from 'react';
import { Sparkles } from 'lucide-react';
import PageContainer from '@/app/components/PageContainer';
import BrandWordmark from '@/app/components/BrandWordmark';
import { APP_NAME, APP_TAGLINE, APP_MARK, APP_OG_IMAGE } from '@/lib/brand';

/** token → the role the kit assigns it. Order matches the guidelines. */
const PALETTE = [
  { token: '--docsnx-navy', hex: '#0D1330', name: 'Navy', role: 'Primary dark · wordmark "Docs" on light' },
  { token: '--docsnx-blue', hex: '#2563EB', name: 'Blue', role: 'Gradient start' },
  { token: '--docsnx-purple', hex: '#7C3AED', name: 'Purple', role: 'Gradient middle · primary accent' },
  { token: '--docsnx-pink', hex: '#EC4899', name: 'Pink', role: 'Gradient end · accent' },
  { token: '--docsnx-light-purple', hex: '#EDE9FE', name: 'Light Purple', role: 'Tints and highlights' },
  { token: '--docsnx-surface', hex: '#F5F7FA', name: 'Surface', role: 'Light UI background' },
];

/** The icon files the browser and the OS actually read, at their declared sizes. */
const ICONS = [
  { src: '/favicon.ico', label: 'favicon.ico', note: 'tab · 16–256, 6 sizes', px: 32 },
  { src: '/icon-192.png', label: 'icon-192.png', note: 'PWA · maskable', px: 96 },
  { src: '/icon-512.png', label: 'icon-512.png', note: 'PWA · splash', px: 128 },
  { src: '/apple-touch-icon.png', label: 'apple-touch-icon.png', note: 'iOS home screen · 180', px: 90 },
  { src: APP_MARK, label: 'brand/docsnx-mark.png', note: 'in-app · transparent · 256', px: 96 },
];

function Surface({ dark, children, className = '' }: { dark?: boolean; children: React.ReactNode; className?: string }) {
  return (
    <div
      className={`relative rounded-2xl border p-6 ${className} ${dark ? 'border-white/10 text-white' : 'border-border text-[color:var(--docsnx-navy)]'}`}
      style={{ background: dark ? 'var(--docsnx-navy)' : 'var(--docsnx-surface)' }}
    >
      <span className={`absolute top-3 right-3 text-2xs font-bold uppercase tracking-wider px-2 py-0.5 rounded ${dark ? 'bg-white/10 text-white/70' : 'bg-black/5 text-black/50'}`}>
        {dark ? 'Dark UI' : 'Light UI'}
      </span>
      {children}
    </div>
  );
}

export default function LogoPreviewPage() {
  return (
    <PageContainer width="medium" className="space-y-10">
      <div className="flex flex-col gap-2">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 border border-primary/20 text-primary text-xs font-bold w-fit">
          <Sparkles size={14} />
          Brand kit · Concept 4 — AI Focused
        </div>
        <h1 className="text-3xl font-black tracking-tight">
          <BrandWordmark /> brand assets
        </h1>
        <p className="text-muted-foreground text-sm">
          The mark, wordmark, icons, social card and palette the app ships, rendered from the real files under{' '}
          <code className="font-mono text-xs">public/</code> and the <code className="font-mono text-xs">--docsnx-*</code> tokens.
        </p>
      </div>

      {/* 1. Lockups on both surfaces */}
      <section className="space-y-3">
        <h2 className="text-lg font-bold">Mark and wordmark</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {[false, true].map((dark) => (
            <Surface key={String(dark)} dark={dark} className="space-y-8">
              <div className="flex items-center gap-4">
                <img src={APP_MARK} alt={APP_NAME} className="w-16 h-16 object-contain" />
                <div>
                  <BrandWordmark className="text-4xl font-black tracking-tight leading-none" />
                  <p className={`text-sm mt-1 ${dark ? 'text-white/70' : 'text-black/60'}`}>{APP_TAGLINE}</p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <img src={APP_MARK} alt="" className="w-9 h-9 object-contain rounded-lg border border-current/20 p-0.5" />
                <BrandWordmark className="text-[17px] font-black tracking-tight" />
                <span className={`text-xs ${dark ? 'text-white/50' : 'text-black/40'}`}>← sidebar</span>
              </div>
              <div className="flex items-center gap-2">
                <img src={APP_MARK} alt="" className="w-7 h-7 object-contain" />
                <BrandWordmark className="text-[15px] font-extrabold tracking-tight" />
                <span className={`text-xs ${dark ? 'text-white/50' : 'text-black/40'}`}>← mobile header</span>
              </div>
            </Surface>
          ))}
        </div>
      </section>

      {/* 2. Icon files */}
      <section className="space-y-3">
        <h2 className="text-lg font-bold">Icon files</h2>
        <div className="rounded-2xl border border-border bg-card p-6 flex flex-wrap items-end gap-8">
          {ICONS.map((icon) => (
            <figure key={icon.src} className="flex flex-col items-center gap-2 text-center">
              <img src={icon.src} alt={icon.label} width={icon.px} height={icon.px} className="rounded-xl shadow-sm" />
              <figcaption>
                <div className="text-xs font-mono font-semibold">{icon.label}</div>
                <div className="text-2xs text-muted-foreground">{icon.note}</div>
              </figcaption>
            </figure>
          ))}
        </div>
      </section>

      {/* 3. Palette */}
      <section className="space-y-3">
        <h2 className="text-lg font-bold">Palette</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
          {PALETTE.map((c) => (
            <div key={c.token} className="rounded-xl border border-border overflow-hidden bg-card">
              <div className="h-16" style={{ background: `var(${c.token})` }} />
              <div className="p-3">
                <div className="text-sm font-bold">{c.name}</div>
                <div className="text-xs font-mono text-muted-foreground">{c.hex} · {c.token}</div>
                <div className="text-2xs text-muted-foreground mt-1">{c.role}</div>
              </div>
            </div>
          ))}
          <div className="rounded-xl border border-border overflow-hidden bg-card">
            <div className="h-16" style={{ background: 'var(--docsnx-gradient)' }} />
            <div className="p-3">
              <div className="text-sm font-bold">Brand gradient</div>
              <div className="text-xs font-mono text-muted-foreground">--docsnx-gradient</div>
              <div className="text-2xs text-muted-foreground mt-1">135° blue → purple → pink · <code>.brand-gradient-text</code></div>
            </div>
          </div>
        </div>
      </section>

      {/* 4. Social card */}
      <section className="space-y-3">
        <h2 className="text-lg font-bold">Social card</h2>
        <p className="text-sm text-muted-foreground">
          What a shared link unfurls to — <code className="font-mono text-xs">og:image</code> and{' '}
          <code className="font-mono text-xs">twitter:image</code> in <code className="font-mono text-xs">layout.js</code>, 1200×630.
        </p>
        <img src={APP_OG_IMAGE} alt={`${APP_NAME} — ${APP_TAGLINE}`} className="w-full max-w-2xl rounded-2xl border border-border shadow-sm" />
      </section>
    </PageContainer>
  );
}
