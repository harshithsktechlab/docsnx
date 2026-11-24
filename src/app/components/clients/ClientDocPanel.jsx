'use client';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   DOCUMENT MANAGER — A DOCUMENT THAT BELONGS TO A CLIENT                 ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The single-upload twin of Power Scan's owner column. When the read of one file
 * (`/api/documents/autofill`) says it is a CLIENT's document — or a personal
 * document nobody has been chosen for — the form's own category picker has nothing
 * to offer: it lists the company's own categories, and a client's are not among
 * them. This panel stands in for the lower half of the form:
 *
 *   owner           which client (or "Own company", which hands the read back to
 *                   the ordinary form), with the reason the scan chose it
 *   document type   the types the company ticked for that kind of client
 *   title           pre-filled, editable
 *   what was read   the values the scan pulled off the document, shown so they
 *                   can be checked; they are saved with it and editable later on
 *                   the client's own page
 *
 * and saves straight to the client through the ordinary `POST /api/documents`,
 * which proves the client and the ticked type again — nothing here is trusted.
 *
 * Shown ONLY for a client document. A company's own document never reaches it, so
 * the form behaves exactly as it always has.
 */
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, UserRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import ScanOwnerSelect, { ClientCategorySelect } from '@/app/components/clients/ScanOwnerSelect';
import ClientFormDialog from '@/app/components/clients/ClientFormDialog';
import { mapPairForOwner, noteMessage } from '@/lib/clients/ownerCategory';
import { categoryLabel } from '@/lib/documentCategories';
import { postUpload, uploadErrorMessage } from '@/lib/records/uploadRequest';
import { useWorkspaceCompanyId, withCompany } from '@/lib/net/useWorkspaceApi';

/** `pan_number` → `Pan Number`: enough to recognise a value without a spec fetch. */
const label = (key) => key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export default function ClientDocPanel({
  file, scan, title: initialTitle, searchText, usageIds, onSaved, onChooseOwn, onUseNormalForm,
}) {
  const companyId = useWorkspaceCompanyId();
  const owners = scan.clientOwner;
  const proposal = owners.proposal;

  const enabledSets = useMemo(() => ({
    individual: new Set(owners.enabled?.individual || []),
    company: new Set(owners.enabled?.company || []),
  }), [owners.enabled]);

  const [clientList, setClientList] = useState(owners.clients || []);
  const [state, setState] = useState({
    ownerSel: proposal.owner,
    // A recognised client is confirmed; an unrecognised owner is not, and the
    // picker reads "Choose owner…" until somebody answers.
    ownerConfirmed: !proposal.attention,
    clientId: owners.clientId || undefined,
    pair: { moduleKey: scan.category?.moduleKey, documentKey: scan.category?.documentKey },
    note: proposal.noteText || '',
  });
  const [title, setTitle] = useState(initialTitle || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(null);

  const source = owners.sourcePair || state.pair;
  const record = {
    ownerProposal: { ...proposal, noteText: state.note },
    ownerSel: state.ownerSel,
    ownerConfirmed: state.ownerConfirmed,
    clientId: state.clientId,
    extractedData: { ...state.pair },
  };
  const unresolved = !state.ownerConfirmed || (state.ownerSel !== 'own' && !state.clientId);
  const categoryId = owners.categoryIds?.[categoryLabel(state.pair)] || null;

  const choose = ({ owner, clientId }) => {
    // The company's own document: not this panel's — the ordinary form, with the
    // read run again without any client matching.
    if (owner === 'own') { onChooseOwn(); return; }
    const { pair, note } = mapPairForOwner(source, owner, enabledSets);
    setState({
      ownerSel: owner,
      ownerConfirmed: true,
      clientId,
      pair,
      note: noteMessage(note, proposal.sourceName || 'This document type', owner),
    });
  };

  const save = async () => {
    setError('');
    if (unresolved) { setError('Choose which client this document belongs to.'); return; }
    if (!categoryId) { setError('That document type is not available for this client any more. Pick another.'); return; }
    if (!title.trim()) { setError('Give this document a name.'); return; }

    const body = new FormData();
    body.append('files', file);
    body.append('title', title.trim());
    body.append('categoryId', categoryId);
    body.append('clientId', state.clientId);
    // The values the read produced, keyed exactly as the category's spec is. The
    // server uses that spec as the allowlist and seals what it marks as PII.
    body.append('metadata', JSON.stringify({ ...(scan.fields || {}), document_title: title.trim() }));
    body.append('taxonomyFields', 'true');
    if (searchText) body.append('searchText', searchText);
    if (usageIds?.length) body.append('aiUsageIds', JSON.stringify(usageIds));

    setSaving(true);
    const outcome = await postUpload(withCompany('/api/documents', companyId), body);
    setSaving(false);

    if (!outcome.ok && (outcome.kind !== 'http' || !outcome.json)) {
      setError(uploadErrorMessage(outcome, 'document'));
      return;
    }
    const json = outcome.json;
    if (json?.success) {
      const client = clientList.find((c) => c.id === state.clientId);
      toast.success(client ? `Saved to ${client.displayName}` : 'Saved to the client');
      onSaved(state.clientId);
      return;
    }
    if (outcome.status === 409 && json?.requiresConfirmation) {
      setError('This looks like a document already on file for this client. Open the client’s page to replace or review it.');
      return;
    }
    setError(
      json?.fieldErrors ? Object.values(json.fieldErrors).filter(Boolean).join(' ')
        : (json?.error || 'Could not save this document.'),
    );
  };

  const read = Object.entries(scan.fields || {}).filter(([k, v]) => v && k !== 'document_title');

  return (
    <div className="flex flex-col gap-4 border-t border-border/50 pt-5 mt-2" data-testid="client-doc-panel">
      <div className="flex items-start gap-3">
        <span className="w-9 h-9 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
          <UserRound size={17} />
        </span>
        <div className="flex flex-col min-w-0">
          <h3 className="text-sm font-bold text-foreground">This looks like a client&apos;s document</h3>
          <p className="text-xs text-muted-foreground">
            {proposal.reason}
            {' '}Confirm who it belongs to, then save — it is filed under that client, not under the company.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="client-doc-owner" className="text-xs font-semibold text-muted-foreground">Belongs to *</Label>
          <ScanOwnerSelect
            id="client-doc-owner"
            record={record}
            clients={clientList}
            enabled={owners.enabled}
            disabled={saving}
            onChoose={choose}
            onAddClient={(type) => setAdding({
              type,
              prefill: {
                displayName: proposal.read?.name || '',
                details: type === 'company'
                  ? { panNumber: proposal.read?.ids?.pan, gstNumber: proposal.read?.ids?.gstin, registrationNumber: proposal.read?.ids?.cin, tanNumber: proposal.read?.ids?.tan }
                  : { panNumber: proposal.read?.ids?.pan },
              },
            })}
          />
        </div>
        <ClientCategorySelect
          id="client-doc-type"
          record={record}
          enabled={owners.enabled}
          names={owners.categoryNames}
          disabled={saving || state.ownerSel === 'own'}
          onChange={(picked) => setState((s) => ({ ...s, pair: { moduleKey: picked.moduleKey, documentKey: picked.documentKey }, note: '' }))}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="client-doc-title" className="text-xs font-semibold text-muted-foreground">Document name *</Label>
        <Input id="client-doc-title" value={title} onChange={(e) => setTitle(e.target.value)} disabled={saving} />
      </div>

      {read.length > 0 && (
        <div className="rounded-lg border border-border bg-muted/30 p-3">
          <p className="text-xs font-semibold text-muted-foreground mb-2">Read from the document</p>
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5">
            {read.map(([k, v]) => (
              <div key={k} className="flex flex-col min-w-0">
                <dt className="text-2xs text-muted-foreground">{label(k)}</dt>
                <dd className="text-sm text-foreground break-words">{String(v)}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

      <div className="flex flex-col-reverse gap-3 md:flex-row md:items-center md:justify-between">
        <button type="button" onClick={onUseNormalForm} disabled={saving}
          className="text-xs font-semibold text-muted-foreground hover:text-primary w-fit">
          Not a client document? Use the normal form
        </button>
        <Button type="button" onClick={save} disabled={saving || unresolved} className="gap-2">
          {saving && <Loader2 size={14} className="animate-spin" />}
          {saving ? 'Saving…' : 'Save to client'}
        </Button>
      </div>

      <ClientFormDialog
        open={Boolean(adding)}
        onOpenChange={(open) => { if (!open) setAdding(null); }}
        type={adding?.type || 'individual'}
        prefill={adding?.prefill || null}
        onSaved={(client) => {
          if (!client) return;
          setClientList((prev) => (prev.some((c) => c.id === client.id)
            ? prev
            : [...prev, { id: client.id, clientType: client.clientType, displayName: client.displayName }]));
          choose({ owner: client.clientType, clientId: client.id });
          setAdding(null);
        }}
      />
    </div>
  );
}
