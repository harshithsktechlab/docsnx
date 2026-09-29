'use client';

import React, { useEffect } from 'react';
import { AlertCircle, RefreshCw, Home } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

export default function Error({ error, reset }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] w-full items-center justify-center p-4">
      <Card className="w-full max-w-lg">
        <CardContent className="flex flex-col items-center gap-5 py-10 text-center">
          <span className="flex size-14 items-center justify-center rounded-2xl bg-danger-surface text-danger-text">
            <AlertCircle size={28} />
          </span>

          <div className="flex flex-col gap-2">
            <h2 className="text-xl font-bold text-foreground">Something went wrong</h2>
            <p className="break-words text-sm text-muted-foreground">
              {error?.message || 'An unexpected error occurred while loading this page.'}
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
            <Button variant="secondary" onClick={() => { window.location.href = '/dashboard'; }}>
              <Home size={16} />
              Go to dashboard
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
