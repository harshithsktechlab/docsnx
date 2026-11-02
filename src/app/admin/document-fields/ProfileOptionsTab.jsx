'use client';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  COMPANY PROFILE DROPDOWNS — the choices on the Business Profile form    ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * "Entity Type" on Business Profile → Company Profile → Identity is a dropdown;
 * this tab is where its choices are managed. Stored in
 * `system_configs.profile_field_options` (migration 0090), platform-wide, the
 * same shape of setting as the File Size tab beside it.
 *
 * The stored value of a choice is what lands in a company's profile; the label
 * is what is shown. Removing or changing a choice does not touch profiles that
 * already hold it — the form keeps showing their value as "no longer offered".
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Plus, X } from 'lucide-react';
import { apiCall } from '@/lib/net/apiRequest';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const text = (v) => String(v ?? '').trim();

const clean = (rows) => (Array.isArray(rows) ? rows : []).map((r) => ({
  value: text(r.value),
  label: text(r.label),
  registrationLabel: text(r.registrationLabel),
  registrationPlaceholder: text(r.registrationPlaceholder),
  registrationPattern: text(r.registrationPattern),
}));

/** Does this format compile? Blank is fine — it just means no hint. */
const patternOk = (p) => {
  if (!text(p)) return true;
  try { new RegExp(p); return true; } catch { return false; }
};

/**
 * One row per Entity Type: the stored value and shown label, plus the number
 * field that follows the dropdown for that type — what it is called, an example,
 * and an optional format used only for a warning hint on the profile form.
 */
function EntityTypeEditor({ options, onChange }) {
  const rows = Array.isArray(options) ? options : [];
  const patch = (i, next) => onChange(rows.map((r, j) => (j === i ? { ...r, ...next } : r)));

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <Label className="text-xs">Choices</Label>
        <Button
          variant="outline" size="sm" className="h-7 gap-1 text-xs"
          onClick={() => onChange([...rows, { value: '', label: '' }])}
        >
          <Plus className="size-3" /> Add choice
        </Button>
      </div>

      {rows.map((o, i) => (
        <div key={i} className="space-y-2 rounded-md border bg-background/40 p-3">
          <div className="flex items-center gap-2">
            <Input
              className="h-8 flex-1 text-sm" placeholder="Stored value" value={o.value ?? ''}
              onChange={(e) => patch(i, {
                value: e.target.value,
                // Label follows the value until someone gives it a different wording.
                ...((o.label ?? '') === (o.value ?? '') ? { label: e.target.value } : {}),
              })}
            />
            <Input
              className="h-8 flex-1 text-sm" placeholder="Shown to the user" value={o.label ?? ''}
              onChange={(e) => patch(i, { label: e.target.value })}
            />
            <Button
              variant="ghost" size="icon" aria-label="Remove choice"
              className="size-8 shrink-0 text-muted-foreground hover:text-danger-action"
              onClick={() => onChange(rows.filter((_, j) => j !== i))}
            >
              <X className="size-3.5" />
            </Button>
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <div className="flex flex-col gap-1">
              <Label className="text-[11px] text-muted-foreground">Number field label</Label>
              <Input
                className="h-8 text-sm" placeholder="e.g. CIN" value={o.registrationLabel ?? ''}
                onChange={(e) => patch(i, { registrationLabel: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-[11px] text-muted-foreground">Example</Label>
              <Input
                className="h-8 font-mono text-sm" placeholder="e.g. U74999MH2015PTC123456"
                value={o.registrationPlaceholder ?? ''}
                onChange={(e) => patch(i, { registrationPlaceholder: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-[11px] text-muted-foreground">Format (regex, optional)</Label>
              <Input
                className={cn(
                  'h-8 font-mono text-sm',
                  !patternOk(o.registrationPattern) && 'border-destructive focus-visible:ring-destructive',
                )}
                placeholder="e.g. ^[A-Z]{3}-\d{4}$" value={o.registrationPattern ?? ''}
                onChange={(e) => patch(i, { registrationPattern: e.target.value })}
              />
            </div>
          </div>
          {!patternOk(o.registrationPattern) && (
            <p className="text-xs text-destructive">That format is not a valid pattern.</p>
          )}
        </div>
      ))}
    </div>
  );
}

export default function ProfileOptionsTab() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  const [options, setOptions] = useState([]);
  /** What the server last confirmed — the baseline `dirty` compares to. */
  const [saved, setSaved] = useState([]);
  const [defaults, setDefaults] = useState([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { json: data } = await apiCall('/api/admin/document-fields/profile-options');
      if (data.success) {
        setOptions(data.entityType);
        setSaved(data.entityType);
        setDefaults(data.defaults.entityType);
      } else setError(data.error || 'Could not load the company profile options');
    } catch { setError('Could not load the company profile options'); }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const dirty = useMemo(
    () => JSON.stringify(clean(options)) !== JSON.stringify(clean(saved)),
    [options, saved],
  );

  const rows = clean(options);
  const blank = rows.some((r) => r.value === '');
  const lowered = rows.map((r) => r.value.toLowerCase());
  const duplicate = lowered.some((v, i) => v !== '' && lowered.indexOf(v) !== i);
  const badPattern = rows.some((r) => !patternOk(r.registrationPattern));
  const valid = rows.length > 0 && !blank && !duplicate && !badPattern;

  // Same guard as the other tabs: a tab switch keeps this mounted, a reload doesn't.
  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const put = useCallback(async (entityType) => {
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const { json: data } = await apiCall('/api/admin/document-fields/profile-options', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entityType }),
      });
      if (data.success) {
        setOptions(data.entityType);
        setSaved(data.entityType);
        setSuccess(entityType ? 'Entity Type choices saved.' : 'Entity Type choices reset to the defaults.');
      } else setError(data.error || 'Could not save the company profile options');
    } catch { setError('Could not save the company profile options'); }
    setSaving(false);
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-24 text-muted-foreground">
        <Loader2 className="size-5 animate-spin" /> Loading…
      </div>
    );
  }

  const btn = 'inline-flex h-9 items-center justify-center gap-2 rounded-md px-4 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50';

  return (
    <div className="max-w-2xl space-y-5">
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
          <h2 className="text-sm font-medium">Entity Type</h2>
          <p className="text-xs text-muted-foreground">
            The choices on Business Profile → Company Identity, and the registration number each
            one asks for (CIN, LLPIN…). This list is shared by every company on the platform.
            Companies that already hold a value you remove keep it, shown as “no longer offered”.
            The format only triggers a warning on the form; it never blocks a save.
          </p>
        </div>

        <EntityTypeEditor options={options} onChange={(next) => { setOptions(next); setSuccess(null); }} />

        {(blank || duplicate) && (
          <p className="text-xs text-destructive">
            {blank ? 'Every choice needs a stored value.' : 'Stored values must be unique.'}
          </p>
        )}
        {options.length === 0 && (
          <p className="text-xs text-muted-foreground">
            Add at least one choice, or reset to the defaults.
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => put(rows.map((r) => ({ ...r, label: r.label || r.value })))}
          disabled={!dirty || !valid || saving}
          className={cn(btn, 'bg-primary text-primary-foreground hover:bg-primary/90')}
        >
          {saving && <Loader2 className="size-4 animate-spin" />}
          {saving ? 'Saving…' : 'Save changes'}
        </button>
        {dirty && !saving && (
          <button
            type="button"
            onClick={() => { setOptions(saved); setError(null); }}
            className={cn(btn, 'border border-input bg-background hover:bg-accent')}
          >
            Discard
          </button>
        )}
        <button
          type="button"
          onClick={() => put(null)}
          disabled={saving || JSON.stringify(clean(saved)) === JSON.stringify(clean(defaults))}
          className={cn(btn, 'border border-input bg-background hover:bg-accent')}
        >
          Reset to defaults
        </button>
      </div>
    </div>
  );
}
