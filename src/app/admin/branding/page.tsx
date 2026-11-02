'use client';

/**
 * Admin → Branding: replace the DocsNX logo for the whole product. The layout
 * above (`src/app/admin/layout.tsx`) already restricts this tree to SUPER_ADMIN,
 * and the routes re-check it. This is the APPLICATION's logo — the invoice
 * entity's logo is a different setting under Admin → Settings → Invoicing.
 *
 * The browser fits the picture inside 512×512 (never cropping — a logo need not
 * be square) and re-encodes it as a PNG, so transparency survives and a
 * legitimate upload is a few tens of KB. The server re-validates all of it.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ImageIcon, Loader2, RotateCcw, Upload } from 'lucide-react';
import { toast } from 'sonner';
import PageContainer from '@/app/components/PageContainer';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { apiCall } from '@/lib/net/apiRequest';
import { APP_NAME } from '@/lib/brand';

const LOGO_API = '/api/admin/branding/logo';
const MAX_SIDE = 512;
/** Mirrors MAX_APP_LOGO_BYTES on the server (512 KB). */
const MAX_BYTES = 512 * 1024;

/** Fit inside MAX_SIDE, keep alpha, and shrink further if the PNG is still too big. */
async function prepareLogo(file: File): Promise<Blob | null> {
  const bitmap = await createImageBitmap(file);
  try {
    for (const limit of [MAX_SIDE, 384, 256]) {
      const scale = Math.min(1, limit / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (blob && blob.size <= MAX_BYTES) return blob;
    }
    return null;
  } finally {
    bitmap.close?.();
  }
}

export default function BrandingPage() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [isCustom, setIsCustom] = useState(false);
  /** Cache-buster for the preview; bumps after every change. */
  const [version, setVersion] = useState(0);

  const loadStatus = useCallback(async () => {
    const { res, json } = await apiCall(LOGO_API);
    if (res.ok && json.success) {
      setIsCustom(!!json.isCustom);
      setVersion(json.updatedAt || 0);
    } else {
      toast.error(json.error || 'Could not load the logo settings.');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const pickFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
      toast.error('Use a PNG, JPEG or WebP logo.');
      return;
    }
    setBusy(true);
    try {
      const blob = await prepareLogo(file);
      if (!blob) {
        toast.error('That logo could not be made small enough. Try a simpler image.');
        return;
      }
      const { res, json } = await apiCall(LOGO_API, {
        method: 'PUT',
        headers: { 'Content-Type': blob.type },
        body: blob,
      });
      if (!res.ok || !json.success) {
        toast.error(json.error || 'Could not save the logo.');
        return;
      }
      setIsCustom(true);
      setVersion(json.updatedAt || Date.now());
      toast.success('Logo updated. It now shows across the app.');
      router.refresh();
    } catch (err) {
      console.error('[admin/branding] logo resize failed', err);
      toast.error('That file could not be read as an image.');
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    setBusy(true);
    try {
      const { res, json } = await apiCall(LOGO_API, { method: 'DELETE' });
      if (!res.ok || !json.success) {
        toast.error(json.error || 'Could not reset the logo.');
        return;
      }
      setIsCustom(false);
      setVersion(Date.now());
      toast.success(`Reset to the built-in ${APP_NAME} logo.`);
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  const previewSrc = `/api/brand/logo?v=${version}`;

  return (
    <PageContainer width="medium" className="space-y-6 pb-16">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <ImageIcon className="w-6 h-6 text-primary" /> Branding
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          The {APP_NAME} logo shown in the sidebar, on the sign-in and landing pages, as the browser tab icon, and
          on the installed app and push notifications.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{APP_NAME} logo</CardTitle>
          <CardDescription>
            {isCustom ? 'A custom logo is in use.' : `The built-in ${APP_NAME} logo is in use.`}
            {' '}PNG, JPEG or WebP. Transparent PNGs work best; it is shrunk to fit 512×512.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {loading ? (
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                {[{ label: 'Light', cls: 'bg-white' }, { label: 'Dark', cls: 'bg-slate-900' }].map((s) => (
                  <div key={s.label} className={`rounded-xl border border-border p-6 flex flex-col items-center gap-3 ${s.cls}`}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={previewSrc} alt={`${APP_NAME} logo on a ${s.label.toLowerCase()} background`} className="h-24 w-auto max-w-full object-contain" />
                    <span className={`text-xs ${s.label === 'Dark' ? 'text-white/60' : 'text-black/50'}`}>{s.label} background</span>
                  </div>
                ))}
              </div>

              <div className="flex flex-wrap gap-3">
                <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={pickFile} />
                <Button onClick={() => fileRef.current?.click()} disabled={busy}>
                  {busy ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Upload className="w-4 h-4 mr-2" />}
                  {isCustom ? 'Replace logo' : 'Upload logo'}
                </Button>
                {isCustom && (
                  <Button variant="outline" onClick={reset} disabled={busy}>
                    <RotateCcw className="w-4 h-4 mr-2" /> Reset to default
                  </Button>
                )}
              </div>

              <p className="text-xs text-muted-foreground">
                Open sessions pick the new logo up on their next page load. Browser tab and home-screen icons are
                cached by the device and can take longer to change. The invoice logo is separate — see Settings →
                Invoicing.
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </PageContainer>
  );
}
