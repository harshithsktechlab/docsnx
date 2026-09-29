'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import {
  Download,
  Upload,
  AlertTriangle,
  CheckCircle,
  Loader2,
  Database,
  Cloud,
  ShieldCheck,
  KeyRound
} from 'lucide-react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { deriveZeroKnowledgeKey, encryptZeroKnowledge, decryptZeroKnowledge } from '@/lib/clientCrypto';
import { DriveQuotaModal } from '@/app/components/DriveQuotaModal';
import PageContainer from '@/app/components/PageContainer';
import { apiCall, apiDownload } from '@/lib/net/apiRequest';
import { apiErrorMessage } from '@/lib/net/apiErrorMessage';


export default function BackupPage() {
  const [exporting, setExporting] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [successMessage, setSuccessMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [selectedFile, setSelectedFile] = useState(null);

  // Zero-knowledge Drive sync state
  const [passphrase, setPassphrase] = useState('');
  const [tenantId, setTenantId] = useState('');
  const [driveEnabled, setDriveEnabled] = useState(false);
  const [isTenantAdmin, setIsTenantAdmin] = useState(false);
  const [driveRestoring, setDriveRestoring] = useState(false);
  // Ciphertext from the last sync attempt, kept so a quota failure can still be
  // salvaged as a local download rather than lost.
  const [quotaFailure, setQuotaFailure] = useState(null);

  useEffect(() => {
    // Fetch the tenant id (used as a per-tenant PBKDF2 salt) and Drive status.
    (async () => {
      try {
        const { json: data } = await apiCall('/api/auth/me');
        if (data?.user) {
          setTenantId(data.user.tenantId || '');
          setDriveEnabled(!!data.user.tenant?.googleDriveEnabled);
          setIsTenantAdmin(data.user.role === 'TENANT_ADMIN');
        }
      } catch {
        /* non-fatal */
      }
    })();
  }, []);

  const handleExport = async () => {
    setExporting(true);
    setSuccessMessage('');
    setErrorMessage('');
    try {
      // `apiDownload`: the success body is the archive and must not be read as
      // text, but the failure body is JSON or a proxy page — and "Export
      // failed" was the whole diagnosis for an expired session, a disconnected
      // Drive, a 500 and a 504 on an export too big for the proxy's patience.
      const outcome = await apiDownload('/api/backup', {}, {
        subject: 'backup', action: 'exporting your data',
      });
      if (!outcome.ok) {
        setErrorMessage(apiErrorMessage(outcome, {
          subject: 'backup', action: 'exporting your data',
        }));
        return;
      }
      const response = outcome.response;

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;

      const disposition = response.headers.get('Content-Disposition');
      let filename = 'vesta_backup.json';
      if (disposition && disposition.indexOf('attachment') !== -1) {
        const filenameRegex = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/;
        const matches = filenameRegex.exec(disposition);
        if (matches != null && matches[1]) {
          filename = matches[1].replace(/["]/g, '');
        }
      }

      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      setSuccessMessage('Backup downloaded successfully! Keep this file in a safe location.');
    } catch (err) {
      // `apiDownload` returns its failures, so a throw here is a bug in the
      // blob/anchor handling above rather than the export being refused.
      console.error('[backup] export handler threw', err);
      setErrorMessage('Something went wrong saving the file to your device.');
    } finally {
      setExporting(false);
    }
  };

  const handleFileChange = (e) => {
    if (e.target.files && e.target.files[0]) {
      setSelectedFile(e.target.files[0]);
      setSuccessMessage('');
      setErrorMessage('');
    }
  };

  const handleRestore = async () => {
    if (!selectedFile) {
      setErrorMessage('Please select a valid backup JSON file first.');
      return;
    }

    const confirmRestore = window.confirm(
      'WARNING: Restoring will overwrite all existing workspace records on your tenant. This action is irreversible. Proceed?'
    );
    if (!confirmRestore) return;

    setRestoring(true);
    setSuccessMessage('');
    setErrorMessage('');

    try {
      const fileText = await selectedFile.text();
      let backupObj;
      try {
        backupObj = JSON.parse(fileText);
      } catch (e) {
        throw new Error('Invalid JSON format. Please upload a valid Vesta backup file.');
      }

      const { json } = await apiCall('/api/backup', {
        method: 'POST',
        timeoutMs: 300_000,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(backupObj)
      }, { subject: 'backup', action: 'restoring from this backup' });
      if (json.success) {
        setSuccessMessage('Database restored successfully! All records have been synchronized.');
        setSelectedFile(null);
        const fileInput = document.getElementById('restore-file-picker');
        if (fileInput) fileInput.value = '';
      } else {
        setErrorMessage(json.error || 'Failed to restore database from backup file.');
      }
    } catch (err) {
      setErrorMessage(err.message || 'An error occurred during restore.');
    } finally {
      setRestoring(false);
    }
  };

  // Zero-knowledge Google Drive sync: encrypt every module IN THE BROWSER, then
  // send only ciphertext. The passphrase never leaves the browser.
  const handleDriveSync = async () => {
    setSuccessMessage('');
    setErrorMessage('');

    if (typeof window === 'undefined' || !window.crypto?.subtle) {
      setErrorMessage('Your browser does not support the Web Crypto API required for zero-knowledge encryption.');
      return;
    }
    if (passphrase.length < 8) {
      setErrorMessage('Enter a Master Passphrase of at least 8 characters. You will need the exact same passphrase to restore.');
      return;
    }

    setSyncing(true);
    try {
      // 1. Derive the AES-256-GCM key in-browser (PBKDF2), salted per tenant.
      const salt = (tenantId || '').replace(/[^0-9a-fA-F]/g, '') || undefined;
      const key = await deriveZeroKnowledgeKey(passphrase, salt);

      // 2. Fetch this tenant's own data (the caller is already authorized to see it).
      //
      // `apiCall`, not `apiDownload`: this one wants the JSON, not a file to
      // save. "Could not load your data for encryption" was the answer to a
      // full Drive, a locked vault and an expired session alike — and it was
      // thrown, so the passphrase the user had just typed was lost with it.
      const { res, json: backup } = await apiCall('/api/backup', { timeoutMs: 180_000 }, {
        subject: 'your data', action: 'loading your data to encrypt',
      });
      if (!res.ok) throw new Error(backup.error);
      const modules = backup?.data || {};

      // 3. Encrypt each module client-side -> "ivHex:ciphertextHex".
      const encryptedModules = {};
      encryptedModules.manifest = await encryptZeroKnowledge(
        { version: backup.version || '2.0', tenantId, syncedAt: new Date().toISOString(), modules: Object.keys(modules) },
        key
      );
      for (const [name, value] of Object.entries(modules)) {
        encryptedModules[name] = await encryptZeroKnowledge(value ?? [], key);
      }

      // 4. Send ciphertext only. The server never sees plaintext or the passphrase.
      const { json: syncJson } = await apiCall('/api/sync/google-drive', {
        method: 'POST',
        timeoutMs: 300_000,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ encryptedModules })
      });

      if (syncJson.success) {
        setSuccessMessage(`Encrypted and synced ${syncJson.syncedFiles?.length ?? 0} module(s) to /DocsNX_Data in your Google Drive. Only you can decrypt them with your passphrase.`);
        setPassphrase('');
      } else if (syncJson.status === 'DRIVE_NOT_CONNECTED') {
        setDriveEnabled(false);
        setErrorMessage('Google Drive sync is off. Enable the Google integration in Settings, then try again.');
      } else if (syncJson.status === 'QUOTA_EXCEEDED') {
        // Offer the ciphertext we already produced as a local download so a full
        // Drive does not mean a lost backup.
        setQuotaFailure({ module: syncJson.module || 'backup', encryptedModules });
      } else {
        setErrorMessage(syncJson.message || syncJson.error || 'Sync failed.');
      }
    } catch (err) {
      setErrorMessage(err?.message || 'Encryption/sync failed.');
    } finally {
      setSyncing(false);
    }
  };

  /** Saves the already-encrypted bundle locally when the tenant's Drive is full. */
  const handleQuotaFallbackDownload = () => {
    if (!quotaFailure) return;
    const blob = new Blob([JSON.stringify({ encryptedModules: quotaFailure.encryptedModules }, null, 2)], {
      type: 'application/json'
    });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `docsnx_encrypted_backup_${Date.now()}.enc.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);
    setQuotaFailure(null);
    setSuccessMessage('Encrypted backup downloaded. It stays unreadable without your Master Passphrase.');
  };

  // Pulls the ciphertext back out of Drive and decrypts it IN THE BROWSER. The
  // passphrase and the plaintext never touch the server; only the decrypted
  // ledger is posted back to the normal restore endpoint.
  const handleDriveRestore = async () => {
    setSuccessMessage('');
    setErrorMessage('');

    if (typeof window === 'undefined' || !window.crypto?.subtle) {
      setErrorMessage('Your browser does not support the Web Crypto API required for zero-knowledge decryption.');
      return;
    }
    if (passphrase.length < 8) {
      setErrorMessage('Enter the same Master Passphrase you used when syncing.');
      return;
    }

    const confirmRestore = window.confirm(
      'WARNING: Restoring from Google Drive will overwrite all existing workspace records on your tenant. This action is irreversible. Proceed?'
    );
    if (!confirmRestore) return;

    setDriveRestoring(true);
    try {
      const { json } = await apiCall('/api/sync/google-drive', { timeoutMs: 180_000 });

      if (!json.success) {
        if (json.status === 'NO_BACKUP') {
          setErrorMessage('No encrypted backup was found in /DocsNX_Data on your Google Drive. Sync one first.');
        } else if (json.status === 'DRIVE_NOT_CONNECTED') {
          setDriveEnabled(false);
          setErrorMessage('Google Drive is not connected. Reconnect it in Settings, then try again.');
        } else {
          setErrorMessage(json.message || json.error || 'Could not read the backup from Google Drive.');
        }
        return;
      }

      // Same salt as the sync path — a mismatch here yields an undecryptable key.
      const salt = (tenantId || '').replace(/[^0-9a-fA-F]/g, '') || undefined;
      const key = await deriveZeroKnowledgeKey(passphrase, salt);

      const data = {};
      let manifest = null;

      for (const [name, ciphertext] of Object.entries(json.modules || {})) {
        let plaintext;
        try {
          plaintext = await decryptZeroKnowledge(ciphertext, key);
        } catch {
          // AES-GCM authentication failed: the passphrase is wrong (or that one
          // file is corrupt). Either way the restore must not go ahead with a
          // partial ledger.
          throw new Error(
            'Could not decrypt the backup. Check that the Master Passphrase matches the one used when syncing.'
          );
        }

        const parsed = JSON.parse(plaintext);
        if (name === 'manifest') manifest = parsed;
        else data[name] = parsed;
      }

      if (Object.keys(data).length === 0) {
        throw new Error('The backup in Google Drive contained no restorable modules.');
      }

      const { json: restoreJson } = await apiCall('/api/backup', {
        method: 'POST',
        timeoutMs: 300_000,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: manifest?.version || '2.0',
          tenantId,
          exportDate: manifest?.syncedAt || new Date().toISOString(),
          data
        })
      }, { subject: 'backup', action: 'restoring from your Google Drive backup' });
      if (restoreJson.success) {
        setSuccessMessage('Restored successfully from your Google Drive backup. All records have been synchronized.');
        setPassphrase('');
      } else {
        setErrorMessage(restoreJson.error || 'Failed to restore from the Google Drive backup.');
      }
    } catch (err) {
      setErrorMessage(err?.message || 'Restore from Google Drive failed.');
    } finally {
      setDriveRestoring(false);
    }
  };

  return (
    <PageContainer width="compact" className="pb-12">
      <div className="flex flex-col gap-1.5 animate-fade-in">
        <h1 className="text-3xl font-extrabold tracking-tight text-foreground flex items-center gap-2">
          <Database className="text-primary w-8 h-8" />
          <span>Backup &amp; Restore</span>
        </h1>
        <p className="text-muted-foreground text-sm">Download, restore, or zero-knowledge sync your workspace records</p>
      </div>

      {successMessage && (
        <Alert variant="success" className="animate-scale-in">
          <CheckCircle size={18} />
          <AlertTitle className="font-bold text-foreground">Success</AlertTitle>
          <AlertDescription className="text-xs">{successMessage}</AlertDescription>
        </Alert>
      )}

      {errorMessage && (
        <Alert variant="destructive" className="animate-scale-in">
          <AlertTriangle size={18} />
          <AlertTitle className="font-bold text-foreground">Error</AlertTitle>
          <AlertDescription className="text-xs">{errorMessage}</AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-1 gap-6 mt-2">
        {/* Zero-Knowledge Google Drive Sync */}
        <Card className="border-primary/30 bg-card backdrop-blur shadow-glass animate-fade-in">
          <CardHeader>
            <CardTitle className="text-lg font-bold text-primary flex items-center gap-2">
              <Cloud size={18} />
              <span>Zero-Knowledge Google Drive Sync</span>
            </CardTitle>
            <CardDescription className="text-xs flex items-center gap-1.5">
              <ShieldCheck size={12} className="text-emerald-400 shrink-0" />
              <span>Data is encrypted in your browser. Neither DocsNX nor Google can read it without your passphrase.</span>
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 text-xs">
            {!driveEnabled && (
              <Alert variant="warning">
                <AlertTriangle size={14} />
                <AlertDescription className="text-xs">
                  Google Drive sync is off.{' '}
                  {isTenantAdmin ? (
                    <>
                      <Link href="/settings" className="underline font-semibold">Manage it in Settings</Link> to connect or re-enable it.
                    </>
                  ) : (
                    <>Ask your workspace admin to enable the Google integration in Settings.</>
                  )}
                </AlertDescription>
              </Alert>
            )}
            {driveEnabled && !isTenantAdmin && (
              <Alert variant="warning">
                <AlertTriangle size={14} />
                <AlertDescription className="text-xs">
                  The connected Drive belongs to your workspace admin, so only they can sync to it or restore from it.
                </AlertDescription>
              </Alert>
            )}
            <p className="text-muted-foreground leading-relaxed">
              Your records are encrypted locally with AES-256-GCM and uploaded to a dedicated <span className="font-mono">/DocsNX_Data</span> folder in your own Google Drive as <span className="font-mono">*.enc.json</span> files — one per module, updated in place on every sync. We only ever receive ciphertext.
            </p>
            <div className="flex flex-col gap-2">
              <label className="font-bold text-foreground flex items-center gap-1.5" htmlFor="zk-passphrase">
                <KeyRound size={12} /> Master Passphrase
              </label>
              <input
                id="zk-passphrase"
                type="password"
                autoComplete="new-password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                disabled={syncing}
                placeholder="Used to encrypt your backup — never sent to the server"
                className="text-xs text-foreground bg-background/30 rounded-xl border border-border/80 p-3 focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
              <p className="text-faint text-xs leading-relaxed">
                Keep this passphrase safe. If you lose it, the encrypted backup <span className="font-semibold">cannot be recovered</span> — not even by DocsNX.
              </p>
            </div>
          </CardContent>
          <CardFooter className="pt-2 flex flex-col sm:flex-row gap-2 items-stretch sm:items-center">
            <Button
              onClick={handleDriveSync}
              disabled={syncing || driveRestoring || !driveEnabled || !isTenantAdmin || passphrase.length < 8}
              className="w-full sm:w-auto font-bold h-10 px-5 text-xs bg-primary text-primary-foreground hover:bg-primary/90 flex items-center gap-2"
            >
              {syncing ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  <span>Encrypting &amp; syncing...</span>
                </>
              ) : (
                <>
                  <Cloud size={14} />
                  <span>Encrypt &amp; Sync to Google Drive</span>
                </>
              )}
            </Button>
            <Button
              onClick={handleDriveRestore}
              disabled={syncing || driveRestoring || !driveEnabled || !isTenantAdmin || passphrase.length < 8}
              variant="outline"
              className="w-full sm:w-auto font-bold h-10 px-5 text-xs flex items-center gap-2"
            >
              {driveRestoring ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  <span>Decrypting &amp; restoring...</span>
                </>
              ) : (
                <>
                  <Download size={14} />
                  <span>Restore from Google Drive</span>
                </>
              )}
            </Button>
          </CardFooter>
        </Card>

        <DriveQuotaModal
          isOpen={Boolean(quotaFailure)}
          moduleName={quotaFailure?.module || ''}
          onConfirmFallback={handleQuotaFallbackDownload}
          onCancel={() => setQuotaFailure(null)}
        />

        {/* Export Card */}
        <Card className="border-border/50 bg-card backdrop-blur shadow-glass animate-fade-in stagger-1">
          <CardHeader>
            <CardTitle className="text-lg font-bold text-primary flex items-center gap-2">
              <Download size={18} />
              <span>Export Ledger</span>
            </CardTitle>
            <CardDescription className="text-xs">
              Export all files, records, medical entries, credentials, and portfolios associated with your tenant.
            </CardDescription>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground leading-relaxed">
            All data will be packed into a single standard `.json` file containing encrypted values where necessary. You can store this backup locally or use it to migrate to another tenant.
          </CardContent>
          <CardFooter className="pt-2">
            <Button
              onClick={handleExport}
              disabled={exporting}
              className="w-full sm:w-auto font-bold h-10 px-5 text-xs bg-primary text-primary-foreground hover:bg-primary/90 flex items-center gap-2"
            >
              {exporting ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  <span>Packaging data...</span>
                </>
              ) : (
                <>
                  <Download size={14} />
                  <span>Download Backup JSON</span>
                </>
              )}
            </Button>
          </CardFooter>
        </Card>

        {/* Restore Card */}
        <Card className="border-border/50 bg-card backdrop-blur shadow-glass animate-fade-in stagger-2">
          <CardHeader>
            <CardTitle className="text-lg font-bold text-secondary flex items-center gap-2">
              <Upload size={18} />
              <span>Restore Tenant Ledger</span>
            </CardTitle>
            <CardDescription className="text-xs text-warning-text font-semibold flex items-center gap-1">
              <AlertTriangle size={12} className="text-warning-text shrink-0" />
              <span>Restoring will overwrite current tenant data.</span>
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 text-xs">
            <p className="text-muted-foreground leading-relaxed">
              Upload a valid Vesta Backup JSON file. All medical histories, documents metadata, vehicle insurance, and investments will be updated to reflect the backup file completely.
            </p>

            <div className="flex flex-col gap-2">
              <label className="font-bold text-foreground">Select Backup JSON File</label>
              <input
                id="restore-file-picker"
                type="file"
                accept=".json"
                onChange={handleFileChange}
                disabled={restoring}
                className="file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-primary/10 file:text-primary hover:file:bg-primary/20 text-xs text-muted-foreground bg-background/30 rounded-xl border border-border/80 p-2 focus:outline-none cursor-pointer"
              />
            </div>
          </CardContent>
          <CardFooter className="pt-2">
            <Button
              onClick={handleRestore}
              disabled={restoring || !selectedFile}
              className="w-full sm:w-auto font-bold h-10 px-5 text-xs bg-orange-600 text-white hover:bg-orange-700 flex items-center gap-2"
            >
              {restoring ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  <span>Restoring Ledger...</span>
                </>
              ) : (
                <>
                  <Upload size={14} />
                  <span>Upload &amp; Restore</span>
                </>
              )}
            </Button>
          </CardFooter>
        </Card>
      </div>
    </PageContainer>
  );
}
