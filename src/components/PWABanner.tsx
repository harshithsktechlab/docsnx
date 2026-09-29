"use client";

import React, { useEffect, useState } from 'react';
import { X, Download, RefreshCw, Share, Plus } from 'lucide-react';
import { usePWA } from '@/hooks/usePWA';
import { Button } from './ui/button';

const DISMISS_KEY = 'pwa-banner-dismissed';

// Chrome gates `beforeinstallprompt` behind its own engagement heuristic, so the
// Android card never greets a first-time visitor. iOS has no such gate — we are
// the ones deciding when to speak — so hold the instruction card back until the
// visitor has actually stuck around.
const IOS_DWELL_MS = 8000;

/**
 * The single install/update surface for the app. Three mutually exclusive
 * states, in priority order:
 *   1. a service worker update is waiting  -> offer a reload
 *   2. the browser handed us an install prompt (Android/desktop Chromium)
 *   3. iOS Safari, where the only install route is Share -> Add to Home Screen
 */
export function PWABanner() {
  const {
    isInstallable,
    installApp,
    isIOS,
    isStandalone,
    updateAvailable,
    updateApp,
    dismissUpdate,
    updating,
  } = usePWA();
  const [dismissed, setDismissed] = useState(false);
  const [dwellElapsed, setDwellElapsed] = useState(false);

  useEffect(() => {
    if (localStorage.getItem(DISMISS_KEY) === 'true') {
      setDismissed(true);
    }
  }, []);

  useEffect(() => {
    if (!isIOS) return;
    const timer = setTimeout(() => setDwellElapsed(true), IOS_DWELL_MS);
    return () => clearTimeout(timer);
  }, [isIOS]);

  const handleDismiss = () => {
    setDismissed(true);
    localStorage.setItem(DISMISS_KEY, 'true');
  };

  // An available update is worth showing even to someone who dismissed the
  // install pitch — it is a different message with a different key. Its own
  // dismissal is session-only (`dismissUpdate`), never written to
  // `DISMISS_KEY`: silencing one reload prompt must not silence the next build.
  if (updateAvailable) {
    return (
      <Card
        title="A new version is ready"
        body="Reload to pick up the latest DocsNX. Anything you have queued offline is kept."
        icon={<RefreshCw size={20} />}
        onDismiss={dismissUpdate}
      >
        <Button onClick={updateApp} disabled={updating} className="w-full flex items-center gap-2">
          <RefreshCw size={16} className={updating ? 'animate-spin' : undefined} />
          {updating ? 'Updating…' : 'Reload now'}
        </Button>
      </Card>
    );
  }

  if (dismissed || isStandalone) return null;

  if (isInstallable) {
    return (
      <Card
        title="Install DocsNX App"
        body="Get quick access from your home screen and offline support."
        icon={<Download size={20} />}
        onDismiss={handleDismiss}
      >
        <Button onClick={installApp} className="w-full flex items-center gap-2">
          <Download size={16} /> Install App
        </Button>
      </Card>
    );
  }

  if (isIOS && dwellElapsed) {
    return (
      <Card
        title="Install DocsNX App"
        body="Add DocsNX to your home screen for quick access and offline support."
        icon={<Share size={20} />}
        onDismiss={handleDismiss}
      >
        <ol className="flex flex-col gap-2 text-xs text-muted-foreground">
          <li className="flex items-center gap-2">
            <span className="font-semibold text-foreground">1.</span>
            Tap <Share size={14} className="inline text-primary" aria-label="the Share button" /> in the Safari toolbar
          </li>
          <li className="flex items-center gap-2">
            <span className="font-semibold text-foreground">2.</span>
            Choose <Plus size={14} className="inline text-primary" aria-hidden="true" />
            <span className="font-semibold text-foreground">Add to Home Screen</span>
          </li>
        </ol>
      </Card>
    );
  }

  return null;
}

function Card({
  title,
  body,
  icon,
  onDismiss,
  children,
}: {
  title: string;
  body: string;
  icon: React.ReactNode;
  onDismiss: () => void;
  children: React.ReactNode;
}) {
  return (
    /*
     * `--fab-stack` is published by <MobileActionFab> while a floating action
     * button is on screen, and is unset everywhere else — hence the `0px`
     * fallback. At `bottom-20` this card (90% of the viewport, `z-[100]`) sat
     * straight on top of the Documents page's Add and Power Scan buttons and,
     * being above them in the stack, swallowed the taps; its own dismiss X was
     * in the overlapped corner. It now sits above whatever is floating there.
     */
    <div className="fixed bottom-[calc(80px+env(safe-area-inset-bottom)+var(--fab-stack,0px))] md:bottom-6 left-1/2 -translate-x-1/2 w-[90%] max-w-md z-[100] animate-slide-up">
      <div className="bg-card border border-border shadow-2xl rounded-2xl p-4 flex flex-col gap-3 backdrop-blur-xl">
        <div className="flex justify-between items-start">
          <div className="flex gap-3">
            <div className="w-10 h-10 rounded-xl bg-primary/20 flex items-center justify-center flex-shrink-0 text-primary">
              {icon}
            </div>
            <div className="flex flex-col">
              <span className="font-bold text-sm text-foreground">{title}</span>
              <span className="text-xs text-muted-foreground">{body}</span>
            </div>
          </div>
          <button onClick={onDismiss} aria-label="Dismiss" className="text-muted-foreground hover:text-foreground p-1">
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
