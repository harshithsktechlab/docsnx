'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { toast } from 'sonner';
import { popFlash } from '@/lib/flashToast';

/**
 * Raise the message the previous page left for this one.
 *
 * Mounted once, in Shell, above its early returns — every route in the app is
 * wrapped by it, public pages and the onboarding wizard included, and a hook
 * below a conditional return would run on some of them and not others.
 *
 * Keyed on the pathname, so it fires on arrival and not on the page that wrote
 * the flash: that page sets the slot and pushes, and this effect next runs
 * under the new path. `popFlash` reads and clears in one call, so React's
 * double-invoked effects in development raise the toast once.
 */
export function useFlashToast(): void {
  const pathname = usePathname();

  useEffect(() => {
    const flash = popFlash(pathname);
    if (!flash) return;
    // The tag as the toast id: a flash that somehow arrives twice (a back-
    // forward pair landing on the same path) replaces itself instead of
    // stacking a second copy.
    toast[flash.type](flash.message, {
      id: flash.tag ?? 'flash',
      ...(flash.duration ? { duration: flash.duration } : {}),
    });
  }, [pathname]);
}
