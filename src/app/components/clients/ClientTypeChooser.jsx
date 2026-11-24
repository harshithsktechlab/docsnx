'use client';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   WHICH KINDS OF CLIENT DOES THIS COMPANY KEEP?                          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The first thing Client Documents asks, once per company workspace: individuals,
 * companies, or both. Only the chosen kind(s) then get a tab, can have document
 * types configured, and can receive documents — so a company that only keeps
 * documents for individuals never sees a Company tab it will not use.
 *
 * The same screen is "Change client types" for an admin later. Turning a kind OFF
 * is refused by the server while it still has clients, and the server's own
 * sentence ("You still have 2 individual clients. Remove those clients first…") is
 * shown as it is — this only collects the answer.
 */
import { useState } from 'react';
import { Building2, Check, UserRound, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useWorkspaceApi } from '@/lib/net/useWorkspaceApi';

const OPTIONS = [
  {
    value: 'individual',
    title: 'Individual clients',
    body: 'People you keep documents for — PAN card, policies, tax returns, ID proofs.',
    icon: UserRound,
  },
  {
    value: 'company',
    title: 'Company clients',
    body: 'Businesses you keep documents for — registration, GST, contracts, filings.',
    icon: Building2,
  },
  {
    value: 'both',
    title: 'Both',
    body: 'You work with people and with companies.',
    icon: Users,
  },
];

const toValue = (t) => (t?.individual && t?.company ? 'both' : t?.individual ? 'individual' : t?.company ? 'company' : '');
const toBody = (v) => ({ individual: v === 'individual' || v === 'both', company: v === 'company' || v === 'both' });

/**
 * @param {{
 *   initial?: { chosen?: boolean, individual?: boolean, company?: boolean } | null,
 *   onSaved?: (types: any) => void,
 *   onCancel?: () => void,
 * }} props
 */
export default function ClientTypeChooser({ initial = null, onSaved, onCancel }) {
  const { api } = useWorkspaceApi();
  const [value, setValue] = useState(toValue(initial));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const editing = Boolean(initial?.chosen);

  const save = async () => {
    if (!value) return;
    setSaving(true);
    setError('');
    const { json } = await api('/api/clients/types', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(toBody(value)),
    });
    setSaving(false);
    if (!json.success) { setError(json.error || 'Could not save this choice.'); return; }
    onSaved?.(json);
  };

  return (
    <Card>
      <CardContent className="p-5 sm:p-6 flex flex-col gap-5">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-bold text-foreground">
            {editing ? 'Change client types' : 'Who do you keep documents for?'}
          </h2>
          <p className="text-sm text-muted-foreground">
            Choose the kind of client you work with. Only these are shown and used — you can change it later.
          </p>
        </div>

        <div role="radiogroup" aria-label="Kinds of client" className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {OPTIONS.map((o) => {
            const selected = value === o.value;
            const Icon = o.icon;
            return (
              <label
                key={o.value}
                className={`relative cursor-pointer rounded-xl border p-4 flex flex-col gap-2 transition-colors ${
                  selected ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50'
                }`}
              >
                <input
                  type="radio"
                  name="client-types"
                  value={o.value}
                  checked={selected}
                  onChange={() => { setValue(o.value); setError(''); }}
                  disabled={saving}
                  className="sr-only"
                />
                <span className="flex items-center gap-2">
                  <span className="w-9 h-9 rounded-lg bg-muted text-muted-foreground flex items-center justify-center"><Icon size={17} /></span>
                  <span className="font-semibold text-foreground">{o.title}</span>
                  {selected && <Check size={16} className="ml-auto text-primary" />}
                </span>
                <span className="text-xs text-muted-foreground">{o.body}</span>
              </label>
            );
          })}
        </div>

        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          {onCancel && <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>Cancel</Button>}
          <Button type="button" onClick={save} disabled={!value || saving}>
            {saving ? 'Saving…' : editing ? 'Save' : 'Continue'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
