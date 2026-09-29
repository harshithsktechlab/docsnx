'use client';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE WIZARD'S OWN ERROR BOUNDARY — because the global one is a trap     ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `src/app/error.js` offers two ways out, and on THIS route neither is one.
 *
 *   Try again        re-renders the same component, so a fault in the wizard's
 *                    own body throws again immediately.
 *   Go to dashboard  hits the onboarding gate in Shell.js, which sees
 *                    `hasCompletedOnboarding === false` and pushes straight
 *                    back to /onboarding — into the same throw.
 *
 * That is not a hypothetical. A `const` read above its own `useState` took the
 * wizard down for every user, and this pair of buttons is what they were left
 * with: a card that could not be got out of except by clearing the session.
 *
 * So the second button here signs out instead. It is the one exit no gate can
 * bounce, and it is already the wizard's own escape hatch when it is working
 * (`BarePage` renders exactly this control). An admin who lands here can at
 * least reach the login page, and from there a different account.
 *
 * `Try again` is kept because not every fault is in the render path — a failed
 * /api/auth/me on a flaky connection throws too, and that one really does come
 * back on a retry.
 */

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, RefreshCw, LogOut } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { clientLogout } from '@/lib/clientAuth';

export default function OnboardingError({ error, reset }) {
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    console.error('[onboarding] render failed', error);
  }, [error]);

  const signOut = async () => {
    setSigningOut(true);
    try {
      await clientLogout();
    } finally {
      // Pushed whether or not the request came back. A logout that failed still
      // has to leave this page: staying put is the trap this file exists for.
      router.push('/login');
    }
  };

  return (
    <main className="flex min-h-screen w-full items-center justify-center p-4">
      <Card className="w-full max-w-lg">
        <CardContent className="flex flex-col items-center gap-5 py-10 text-center">
          <span className="flex size-14 items-center justify-center rounded-2xl bg-danger-surface text-danger-text">
            <AlertCircle size={28} />
          </span>

          <div className="flex flex-col gap-2">
            <h2 className="text-xl font-bold text-foreground">Setup could not be loaded</h2>
            <p className="break-words text-sm text-muted-foreground">
              {error?.message || 'An unexpected error occurred while loading the setup wizard.'}
            </p>
            {error?.digest && (
              <p className="text-xs text-faint">Reference: {error.digest}</p>
            )}
          </div>

          <div className="flex items-center gap-3">
            <Button onClick={() => reset()}>
              <RefreshCw size={16} />
              Try again
            </Button>
            <Button variant="secondary" onClick={signOut} disabled={signingOut}>
              <LogOut size={16} />
              {signingOut ? 'Signing out...' : 'Sign out'}
            </Button>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
