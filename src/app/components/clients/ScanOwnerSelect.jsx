'use client';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   POWER SCAN — WHOSE DOCUMENT IS THIS ROW?                               ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The two controls a row of the review grid gains in a company that keeps client
 * documents (src/lib/clients/scanOwners.ts proposes; these confirm):
 *
 *   ScanOwnerSelect         the OWNER — this company itself, one of its clients, or
 *                           "add a new client". Shows why the scan chose what it
 *                           did, and stays on "Choose owner…" until a person
 *                           answers for a row the scan could not place.
 *   ClientCategorySelect    the DOCUMENT TYPE for a client row — the subcategories
 *                           the company ticked for that kind of client, plus Others.
 *                           The ordinary category picker lists the company's own
 *                           categories and has no client entries.
 *
 * Plain native selects, like the rest of the row's compact controls: a long client
 * list is exactly what a phone's own picker handles best.
 */
import { CLIENT_CATCH_ALL_KEY, CLIENT_MODULE_BY_TYPE } from '@/lib/clientCategories';

const SELECT_CLASS = 'w-full h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground '
  + 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50';

const ADD_INDIVIDUAL = '__add_individual__';
const ADD_COMPANY = '__add_company__';

/** `own`, `client:<id>`, or '' while nobody has answered. */
export function ownerValue(record) {
  if (!record?.ownerConfirmed) return '';
  if (record.ownerSel === 'own') return 'own';
  return record.clientId ? `client:${record.clientId}` : '';
}

export default function ScanOwnerSelect({ id, record, clients, enabled, onChoose, onAddClient, disabled }) {
  // A kind of client with nothing ticked cannot receive a document, so it cannot
  // be added from here either — configuring comes first.
  const canAdd = {
    individual: (enabled?.individual?.length || 0) > 0,
    company: (enabled?.company?.length || 0) > 0,
  };
  const proposal = record?.ownerProposal;
  const individuals = clients.filter((c) => c.clientType === 'individual');
  const companies = clients.filter((c) => c.clientType === 'company');
  const unanswered = !record?.ownerConfirmed || (record.ownerSel !== 'own' && !record.clientId);

  const handle = (e) => {
    const v = e.target.value;
    if (v === 'own') return onChoose({ owner: 'own' });
    if (v === ADD_INDIVIDUAL) return onAddClient('individual');
    if (v === ADD_COMPANY) return onAddClient('company');
    if (v.startsWith('client:')) {
      const client = clients.find((c) => c.id === v.slice(7));
      if (client) onChoose({ owner: client.clientType, clientId: client.id });
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="sr-only">Whose document is this?</label>
      <select
        id={id}
        value={ownerValue(record)}
        onChange={handle}
        disabled={disabled}
        aria-invalid={unanswered || undefined}
        className={`${SELECT_CLASS} ${unanswered ? 'border-destructive' : ''}`}
      >
        <option value="" disabled>Choose owner…</option>
        <option value="own">Own company</option>
        {individuals.length > 0 && (
          <optgroup label="Individual clients">
            {individuals.map((c) => <option key={c.id} value={`client:${c.id}`}>{c.displayName}</option>)}
          </optgroup>
        )}
        {companies.length > 0 && (
          <optgroup label="Company clients">
            {companies.map((c) => <option key={c.id} value={`client:${c.id}`}>{c.displayName}</option>)}
          </optgroup>
        )}
        {(canAdd.individual || canAdd.company) && (
          <optgroup label="New client">
            {canAdd.individual && <option value={ADD_INDIVIDUAL}>＋ Add individual client…</option>}
            {canAdd.company && <option value={ADD_COMPANY}>＋ Add company client…</option>}
          </optgroup>
        )}
      </select>

      {proposal && (
        <p className={`text-xs ${unanswered ? 'font-medium text-destructive' : 'text-muted-foreground'}`}>
          {unanswered && proposal.read?.name
            ? `Read "${proposal.read.name}" — ${proposal.reason}`
            : unanswered ? proposal.reason : (record.ownerConfirmedByUser ? '' : proposal.reason)}
        </p>
      )}
      {proposal?.noteText && record?.ownerConfirmed && (
        <p className="text-xs text-warning-text">{proposal.noteText}</p>
      )}
    </div>
  );
}

/**
 * The document type for a CLIENT row.
 * `enabled` is `{ individual: [derived keys], company: [...] }`; `names` maps
 * `<moduleKey>/<documentKey>` of a client category to what to call it.
 */
export function ClientCategorySelect({ id, record, enabled, names, onChange, disabled }) {
  const type = record?.ownerSel === 'company' ? 'company' : 'individual';
  const moduleKey = CLIENT_MODULE_BY_TYPE[type];
  const current = record?.extractedData?.documentKey || '';
  const keys = [...new Set([...(enabled?.[type] || []), CLIENT_CATCH_ALL_KEY, current].filter(Boolean))];
  const nameOf = (documentKey) => names?.[`${moduleKey}/${documentKey}`] || documentKey;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-xs font-semibold text-muted-foreground">Document type</label>
      <select
        id={id}
        value={current}
        onChange={(e) => onChange({ moduleKey, documentKey: e.target.value, documentName: nameOf(e.target.value) })}
        disabled={disabled}
        className={SELECT_CLASS}
      >
        {keys.map((k) => <option key={k} value={k}>{nameOf(k)}</option>)}
      </select>
    </div>
  );
}
