'use client';

import { Toaster as SonnerToaster } from 'sonner';

export function ToasterProvider() {
  return (
    <SonnerToaster
      position="top-right"
      toastOptions={{
        style: {
          background: 'hsl(var(--card))',
          color: 'hsl(var(--foreground))',
          border: '1px solid hsl(var(--border))',
        },
        className: 'rounded-xl shadow-[0_4px_30px_rgba(0,0,0,0.1)] backdrop-blur-md',
      }}
    />
  );
}
