'use client';

import React, { useState } from 'react';
import { Check, Loader2, Pencil, X } from 'lucide-react';
import { toast } from 'sonner';
import { Input } from '@/components/ui/input';
import { apiCall } from '@/lib/net/apiRequest';
import { cn } from '@/lib/utils';

/**
 * A name with a pencil: click, edit in place, Enter to save, Esc to cancel.
 *
 * One component for every name an admin can change, so that renaming works the
 * same in a personal account, a business account and a combo one:
 *   · `company`  → PUT /api/companies/[id]       (a company's own name)
 *   · `personal` → PUT /api/tenants/workspace    (a combo account's personal side)
 *   · `account`  → PUT /api/tenants/workspace    (the household, or the business account)
 *
 * The routes are the real gate — admin-only, plan-gated, validated, audited. The
 * caller decides whether to render this at all.
 *
 * On success it fires `docsnx:me-changed` and `docsnx:companies-changed`, which
 * Shell already listens for, so the rail, switcher and tabs catch up without a
 * navigation.
 */
export type RenameKind = 'company' | 'personal' | 'account';

interface InlineRenameProps {
  value: string;
  kind: RenameKind;
  /** Required for `kind="company"`. */
  companyId?: string | null;
  /** Called with the saved name once the server has accepted it. */
  onSaved?: (name: string) => void;
  /** Classes for the displayed name. */
  className?: string;
  /** Accessible name for the pencil, e.g. "Rename Acme Ltd". */
  label?: string;
}

const NOUN: Record<RenameKind, string> = {
  company: 'company',
  personal: 'personal workspace',
  account: 'workspace',
};

function request(kind: RenameKind, companyId: string | null | undefined, name: string) {
  if (kind === 'company') {
    return apiCall(`/api/companies/${companyId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
  }
  return apiCall('/api/tenants/workspace', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(kind === 'personal' ? { personalName: name } : { name }),
  });
}

export default function InlineRename({
  value,
  kind,
  companyId,
  onSaved,
  className,
  label,
}: InlineRenameProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const noun = NOUN[kind];
  const editing = draft !== null;

  const cancel = () => {
    setDraft(null);
    setError('');
  };

  const save = async () => {
    const name = (draft || '').trim();
    if (name.length < (kind === 'company' ? 1 : 2)) {
      setError(kind === 'company' ? 'A company name is required' : 'That name is too short');
      return;
    }
    if (name === value) {
      cancel();
      return;
    }
    setSaving(true);
    setError('');
    try {
      const { json } = await request(kind, companyId, name);
      if (!json?.success) {
        setError(json?.error || `Could not rename the ${noun}`);
        return;
      }
      const saved = kind === 'company' ? (json.company?.name || name) : name;
      setDraft(null);
      toast.success(`${noun.charAt(0).toUpperCase()}${noun.slice(1)} renamed`);
      window.dispatchEvent(new Event('docsnx:me-changed'));
      window.dispatchEvent(new Event('docsnx:companies-changed'));
      onSaved?.(saved);
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <span className={cn('truncate', className)}>{value}</span>
        <button
          type="button"
          onClick={() => setDraft(value)}
          aria-label={label || `Rename ${value}`}
          title={`Rename ${noun}`}
          className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <Pencil size={13} />
        </button>
      </span>
    );
  }

  return (
    <span className="inline-flex min-w-0 flex-col gap-1 normal-case tracking-normal">
      <span className="inline-flex items-center gap-1.5">
        <Input
          autoFocus
          value={draft}
          onChange={(e) => { setDraft(e.target.value); setError(''); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); save(); }
            if (e.key === 'Escape') { e.preventDefault(); cancel(); }
          }}
          disabled={saving}
          maxLength={255}
          aria-label={`New ${noun} name`}
          aria-invalid={error ? true : undefined}
          className="h-8 w-56 max-w-full text-sm font-medium text-foreground"
        />
        <button
          type="button"
          onClick={save}
          disabled={saving}
          aria-label="Save name"
          className="shrink-0 rounded p-1 text-primary transition-colors hover:bg-primary/10 disabled:opacity-50"
        >
          {saving ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}
        </button>
        <button
          type="button"
          onClick={cancel}
          disabled={saving}
          aria-label="Cancel rename"
          className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
        >
          <X size={15} />
        </button>
      </span>
      {error && <span role="alert" className="text-xs font-medium text-destructive">{error}</span>}
    </span>
  );
}
