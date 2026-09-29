'use client';

import React, { useEffect } from 'react';

// Replaces the root layout when it throws, so it must render <html>/<body> itself
// and cannot rely on the theme providers or the shared UI primitives — the failure
// it catches may be that provider tree. Keep it dependency-free and inline-styled.
export default function GlobalError({ error, reset }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '1rem',
          backgroundColor: '#050a18',
          color: '#e2e8f0',
          fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
        }}
      >
        <div style={{ maxWidth: '32rem', textAlign: 'center' }}>
          <h1 style={{ fontSize: '1.25rem', fontWeight: 700, margin: '0 0 0.75rem' }}>
            Something went wrong
          </h1>
          <p style={{ fontSize: '0.875rem', color: '#94a3b8', margin: '0 0 0.5rem', wordBreak: 'break-word' }}>
            {error?.message || 'An unexpected error occurred.'}
          </p>
          {error?.digest && (
            <p style={{ fontSize: '0.75rem', color: '#64748b', margin: '0 0 1.5rem' }}>
              Reference: {error.digest}
            </p>
          )}
          {/* eslint-disable-next-line no-restricted-syntax -- must not import @/components/ui here; see note above */}
          <button
            onClick={() => reset()}
            style={{
              marginTop: '1rem',
              padding: '0.625rem 1.25rem',
              borderRadius: '0.75rem',
              border: 'none',
              cursor: 'pointer',
              fontSize: '0.875rem',
              fontWeight: 600,
              backgroundColor: '#3b82f6',
              color: '#ffffff',
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
