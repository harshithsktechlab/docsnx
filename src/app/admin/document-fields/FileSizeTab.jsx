'use client';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  THE PER-FILE UPLOAD CAP — one number, every upload path in the product  ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `MAX_UPLOAD_BYTES` (src/lib/records/uploadTypes.ts) was a hardcoded 25 MB
 * enforced by sixteen upload pages and five storage routes at once. This tab is
 * the one place a super admin can move it without a deploy.
 *
 * Stored as BYTES in `system_configs.max_upload_bytes` because that is the unit
 * every enforcement point compares against; shown as MB because that is the
 * unit an operator thinks in. NULL in the column means "no view expressed" and
 * the platform default answers, so a column that has never been written keeps
 * every upload path on the 25 MB it has always used.
 *
 * The ceiling is nginx's `client_max_body_size` on this vhost (100m). A cap
 * above it could not be enforced: nginx would cut the request off before the
 * route ever saw it, and the browser would report that as a network error. The
 * server refuses those values too — this input is a courtesy, not the check.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { apiCall } from '@/lib/net/apiRequest';
import { cn } from '@/lib/utils';

const MB = 1024 * 1024;

/**
 * The Bulk Scan limits, in the order they are shown. `bytes` is typed in MB and
 * stored in bytes, like the per-file cap above. A blank field is "use the
 * built-in default" and is sent as null.
 */
const SCAN_FIELDS = [
  { key: 'files', api: 'maxScanFiles', label: 'Files per scan', unit: 'files',
    help: 'How many documents can be selected for one Bulk Scan.' },
  { key: 'pages', api: 'maxScanPages', label: 'Pages per scan', unit: 'pages',
    help: 'Pages across the whole batch that the AI reads at once. A long PDF counts every page.' },
  { key: 'mb', api: 'maxScanBytes', label: 'Total size per scan', unit: 'MB',
    help: 'Combined size of all files in one scan.' },
];

export default function FileSizeTab() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  /** MB as typed. '' is a half-edited field, not a value worth saving. */
  const [valueMb, setValueMb] = useState('');
  /** What the server last confirmed, in MB — the baseline `dirty` compares to. */
  const [savedMb, setSavedMb] = useState(null);
  const [defaultMb, setDefaultMb] = useState(25);
  const [ceilingMb, setCeilingMb] = useState(100);

  /** Bulk Scan limits as typed ('' = default) and as last confirmed by the server. */
  const [scan, setScan] = useState({ files: '', pages: '', mb: '' });
  const [savedScan, setSavedScan] = useState({ files: '', pages: '', mb: '' });
  const [scanDefaults, setScanDefaults] = useState({ files: 15, pages: 40, mb: 60 });
  const [scanCeilings, setScanCeilings] = useState({ files: 50, pages: 200, mb: 100 });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { json: data } = await apiCall('/api/admin/document-fields/file-size');
      if (data.success) {
        const ceiling = Math.round(data.ceilingBytes / MB);
        const fallback = Math.round(data.defaultMaxUploadBytes / MB);
        // null means "unset" — show the default it is falling back to.
        const current = data.maxUploadBytes == null
          ? fallback
          : Math.round(data.maxUploadBytes / MB);
        setDefaultMb(fallback);
        setCeilingMb(ceiling);
        setValueMb(String(current));
        setSavedMb(current);

        const toForm = (api, key) => {
          const v = data[api];
          if (v == null) return '';
          return String(key === 'mb' ? Math.round(v / MB) : v);
        };
        const loaded = {
          files: toForm('maxScanFiles', 'files'),
          pages: toForm('maxScanPages', 'pages'),
          mb: toForm('maxScanBytes', 'mb'),
        };
        setScan(loaded);
        setSavedScan(loaded);
        if (data.scanDefaults) {
          setScanDefaults({
            files: data.scanDefaults.files,
            pages: data.scanDefaults.pages,
            mb: Math.round(data.scanDefaults.bytes / MB),
          });
        }
        if (data.scanCeilings) {
          setScanCeilings({
            files: data.scanCeilings.files,
            pages: data.scanCeilings.pages,
            mb: Math.round(data.scanCeilings.bytes / MB),
          });
        }
      } else setError(data.error || 'Could not load the upload limit');
    } catch { setError('Could not load the upload limit'); }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const parsed = Number(valueMb);
  const valid = valueMb !== '' && Number.isFinite(parsed)
    && Number.isInteger(parsed) && parsed >= 1 && parsed <= ceilingMb;
  const fileDirty = valueMb !== '' && parsed !== savedMb;

  // A blank scan field means "default" and is always valid; anything typed must
  // be a whole number from 1 up to its ceiling.
  const scanValid = (key) => {
    const raw = scan[key];
    if (raw === '') return true;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 1 && n <= scanCeilings[key];
  };
  const allScanValid = SCAN_FIELDS.every((f) => scanValid(f.key));
  const scanDirty = SCAN_FIELDS.some((f) => scan[f.key] !== savedScan[f.key]);
  const dirty = fileDirty || scanDirty;

  // The Fields tab guards its unsaved edits the same way, and for the same
  // reason: a tab switch here keeps the component mounted, but a reload does not.
  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const save = useCallback(async () => {
    if (!valid || !allScanValid) return;
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const { json: data } = await apiCall('/api/admin/document-fields/file-size', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          maxUploadBytes: parsed * MB,
          maxScanFiles: scan.files === '' ? null : Number(scan.files),
          maxScanPages: scan.pages === '' ? null : Number(scan.pages),
          maxScanBytes: scan.mb === '' ? null : Number(scan.mb) * MB,
        }),
      });
      if (data.success) {
        setSavedMb(parsed);
        setSavedScan(scan);
        setSuccess('Upload limits saved.');
      } else setError(data.error || 'Could not save the upload limit');
    } catch { setError('Could not save the upload limit'); }
    setSaving(false);
  }, [valid, parsed, allScanValid, scan]);

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-24 text-muted-foreground">
        <Loader2 className="size-5 animate-spin" /> Loading…
      </div>
    );
  }

  return (
    <div className="max-w-xl space-y-5">
      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}
      {success && !dirty && (
        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-600 dark:text-emerald-400">
          {success}
        </div>
      )}

      <div className="space-y-3 rounded-lg border bg-card/50 p-5">
        <div className="space-y-1">
          <label htmlFor="maxUploadMb" className="block text-sm font-medium">
            Maximum size of one uploaded file
          </label>
          <p className="text-xs text-muted-foreground">
            Applies to every upload in the product — the vault, the record forms,
            Power Scan and auto-fill. It is a per-file limit, not a per-request one.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <input
            id="maxUploadMb"
            type="number"
            inputMode="numeric"
            min={1}
            max={ceilingMb}
            step={1}
            value={valueMb}
            onChange={(e) => { setValueMb(e.target.value); setSuccess(null); }}
            disabled={saving}
            className={cn(
              'h-9 w-32 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm',
              'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
              'disabled:cursor-not-allowed disabled:opacity-50',
              valueMb !== '' && !valid && 'border-destructive focus-visible:ring-destructive',
            )}
          />
          <span className="text-sm text-muted-foreground">MB</span>
        </div>

        <p className="text-xs text-muted-foreground">
          {valueMb !== '' && !valid
            ? `Enter a whole number between 1 and ${ceilingMb}.`
            : `Platform default is ${defaultMb} MB. The most this can be is ${ceilingMb} MB — above that the web server rejects the upload before the app sees it.`}
        </p>
      </div>

      <div className="space-y-4 rounded-lg border bg-card/50 p-5">
        <div className="space-y-1">
          <h3 className="text-sm font-medium">Bulk scan limits</h3>
          <p className="text-xs text-muted-foreground">
            What one Bulk Scan (&ldquo;Start AI Group &amp; Scan&rdquo;) accepts. Leave a field blank to
            use the platform default. Raising files or pages makes the AI read more at
            once, which is slower, costs more and files documents less accurately.
          </p>
        </div>

        {SCAN_FIELDS.map((f) => {
          const ok = scanValid(f.key);
          const id = `scan-${f.key}`;
          return (
            <div key={f.key} className="space-y-1">
              <label htmlFor={id} className="block text-sm font-medium">{f.label}</label>
              <div className="flex items-center gap-2">
                <input
                  id={id}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={scanCeilings[f.key]}
                  step={1}
                  placeholder={String(scanDefaults[f.key])}
                  value={scan[f.key]}
                  onChange={(e) => { setScan((p) => ({ ...p, [f.key]: e.target.value })); setSuccess(null); }}
                  disabled={saving}
                  className={cn(
                    'h-9 w-32 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm',
                    'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                    'disabled:cursor-not-allowed disabled:opacity-50',
                    !ok && 'border-destructive focus-visible:ring-destructive',
                  )}
                />
                <span className="text-sm text-muted-foreground">{f.unit}</span>
              </div>
              <p className="text-xs text-muted-foreground">
                {!ok
                  ? `Enter a whole number between 1 and ${scanCeilings[f.key]}, or leave blank for the default.`
                  : `${f.help} Default ${scanDefaults[f.key]}, maximum ${scanCeilings[f.key]}.${
                    f.key === 'mb' ? ' Above that the web server rejects the upload.' : ''}`}
              </p>
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={!dirty || !valid || !allScanValid || saving}
          className={cn(
            'inline-flex h-9 items-center justify-center gap-2 rounded-md px-4 text-sm font-medium',
            'bg-primary text-primary-foreground transition-colors hover:bg-primary/90',
            'disabled:cursor-not-allowed disabled:opacity-50',
          )}
        >
          {saving && <Loader2 className="size-4 animate-spin" />}
          {saving ? 'Saving…' : 'Save changes'}
        </button>
        {dirty && !saving && (
          <button
            type="button"
            onClick={() => { setValueMb(String(savedMb)); setScan(savedScan); setError(null); }}
            className="inline-flex h-9 items-center justify-center rounded-md border border-input bg-background px-4 text-sm font-medium transition-colors hover:bg-accent"
          >
            Discard
          </button>
        )}
      </div>
    </div>
  );
}
