'use client';

import React from 'react';

interface DriveQuotaModalProps {
  isOpen: boolean;
  moduleName: string;
  onConfirmFallback: () => void;
  onCancel: () => void;
  isSavingFallback?: boolean;
}

export function DriveQuotaModal({
  isOpen,
  moduleName,
  onConfirmFallback,
  onCancel,
  isSavingFallback = false,
}: DriveQuotaModalProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-slate-900/90 p-6 shadow-2xl text-white">
        <div className="flex items-center gap-3 mb-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-amber-500/20 text-amber-400">
            <svg
              className="h-6 w-6"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
            </svg>
          </div>
          <div>
            <h3 className="text-lg font-semibold">Google Drive Quota Exceeded</h3>
            <p className="text-xs text-slate-400">Personal Drive storage is full</p>
          </div>
        </div>

        <p className="text-sm text-slate-300 mb-6 leading-relaxed">
          Your personal Google Drive storage is full, so the encrypted{' '}
          <span className="font-semibold text-amber-300">{moduleName}</span> module
          could not be synced.
          <br /><br />
          You can download the Zero-Knowledge encrypted bundle and keep it{' '}
          <span className="font-semibold text-emerald-400">wherever you like</span>{' '}
          instead. It stays end-to-end encrypted — only your Master Passphrase
          can open it, and it can be restored from the Restore card on this page.
        </p>

        <div className="flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={isSavingFallback}
            className="rounded-lg border border-white/10 px-4 py-2 text-sm font-medium text-slate-300 hover:bg-white/5 transition-colors disabled:opacity-50"
          >
            Cancel & Try Later
          </button>
          <button
            type="button"
            onClick={onConfirmFallback}
            disabled={isSavingFallback}
            className="flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 transition-colors disabled:opacity-50 shadow-lg shadow-emerald-600/20"
          >
            {isSavingFallback ? (
              <>
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/20 border-t-white" />
                Preparing...
              </>
            ) : (
              'Download Encrypted Copy'
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
