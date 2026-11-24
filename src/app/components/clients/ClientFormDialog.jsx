'use client';

/**
 * Add / edit one client — the "basic info" form.
 *
 * Two shapes, chosen by `type`: an individual (name, date of birth, contact, PAN,
 * Aadhaar, address) and a company (name, entity type, CIN, PAN, GSTIN, TAN,
 * contact person, contact, address). The server validates every field and owns
 * the sealing of the identifiers (src/lib/clients/clientData.ts); this form only
 * collects, and shows the server's message when it refuses.
 *
 * Editing loads the FULL record first. The list a user came from carries masked
 * identifiers only, so the form cannot be seeded from it.
 */
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useWorkspaceApi } from '@/lib/net/useWorkspaceApi';

const FIELDS = {
  individual: [
    { key: 'dateOfBirth', label: 'Date of birth', type: 'date' },
    { key: 'mobile', label: 'Mobile', type: 'tel', placeholder: '+91 98765 43210' },
    { key: 'email', label: 'Email', type: 'email' },
    { key: 'panNumber', label: 'PAN', placeholder: 'ABCDE1234F', upper: true },
    { key: 'aadhaarNumber', label: 'Aadhaar', placeholder: '1234 5678 9012' },
    { key: 'address', label: 'Address', area: true },
    { key: 'notes', label: 'Notes', area: true },
  ],
  company: [
    { key: 'entityType', label: 'Entity type', placeholder: 'Private Limited, LLP, Proprietorship…' },
    { key: 'registrationNumber', label: 'CIN / LLPIN', upper: true },
    { key: 'panNumber', label: 'PAN', placeholder: 'ABCDE1234F', upper: true },
    { key: 'gstNumber', label: 'GSTIN', placeholder: '27ABCDE1234F1Z5', upper: true },
    { key: 'tanNumber', label: 'TAN', placeholder: 'ABCD12345E', upper: true },
    { key: 'contactPerson', label: 'Contact person' },
    { key: 'mobile', label: 'Mobile', type: 'tel' },
    { key: 'email', label: 'Email', type: 'email' },
    { key: 'address', label: 'Address', area: true },
    { key: 'notes', label: 'Notes', area: true },
  ],
};

export default function ClientFormDialog({ open, onOpenChange, type, clientId = null, prefill = null, onSaved }) {
  const { api } = useWorkspaceApi();
  const [name, setName] = useState('');
  const [details, setDetails] = useState({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const editing = Boolean(clientId);
  const noun = type === 'company' ? 'company' : 'individual';

  useEffect(() => {
    if (!open) return;
    setError('');
    if (!editing) {
      // `prefill` is how a scan's "Add client" hands over what it read.
      setName(prefill?.displayName || '');
      setDetails(prefill?.details || {});
      return;
    }
    let cancelled = false;
    setLoading(true);
    (async () => {
      const { json } = await api(`/api/clients/${clientId}`);
      if (cancelled) return;
      setLoading(false);
      if (!json.success) { setError(json.error || 'Could not load this client.'); return; }
      setName(json.client.displayName || '');
      setDetails(json.client.details || {});
    })();
    return () => { cancelled = true; };
  }, [open, editing, clientId, api, prefill]);

  const set = (key, value) => setDetails((d) => ({ ...d, [key]: value }));

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) { setError(type === 'company' ? 'Company name is required.' : 'Name is required.'); return; }
    setSaving(true);
    setError('');
    const body = editing
      ? { displayName: name, details }
      : { clientType: type, displayName: name, details };
    const { json } = await api(editing ? `/api/clients/${clientId}` : '/api/clients', {
      method: editing ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    setSaving(false);
    if (!json.success) { setError(json.error || 'Could not save this client.'); return; }
    toast.success(editing ? 'Client updated.' : 'Client added.');
    onOpenChange(false);
    onSaved?.(json.client);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined} className="max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit ${noun} client` : `Add ${noun} client`}</DialogTitle>
          <DialogDescription>
            {type === 'company'
              ? 'Basic details of the company you keep documents for.'
              : 'Basic details of the person you keep documents for.'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="client-name">{type === 'company' ? 'Company name' : 'Full name'} *</Label>
            <Input id="client-name" value={name} onChange={(e) => setName(e.target.value)} disabled={loading} autoFocus />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {FIELDS[type].map((f) => (
              <div key={f.key} className={`flex flex-col gap-1.5 ${f.area ? 'sm:col-span-2' : ''}`}>
                <Label htmlFor={`client-${f.key}`}>{f.label}</Label>
                {f.area ? (
                  <Textarea
                    id={`client-${f.key}`}
                    rows={2}
                    value={details[f.key] || ''}
                    onChange={(e) => set(f.key, e.target.value)}
                    disabled={loading}
                  />
                ) : (
                  <Input
                    id={`client-${f.key}`}
                    type={f.type || 'text'}
                    placeholder={f.placeholder}
                    value={details[f.key] || ''}
                    onChange={(e) => set(f.key, f.upper ? e.target.value.toUpperCase() : e.target.value)}
                    disabled={loading}
                  />
                )}
              </div>
            ))}
          </div>

          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
            <Button type="submit" disabled={saving || loading}>{saving ? 'Saving…' : editing ? 'Save changes' : 'Add client'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
