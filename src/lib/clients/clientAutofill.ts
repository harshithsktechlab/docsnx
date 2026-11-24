/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   A CLIENT'S BASIC INFO, FILLED FROM THEIR DOCUMENTS                     ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * An adviser adds "Ram Das" with a name and little else, then files his PAN card.
 * The PAN is on the card; asking the adviser to type it again is exactly the
 * chore this removes. When a document is saved for a client, the identifiers and
 * facts it states are copied onto the CLIENT'S details — the same thing
 * `autoUpdateProfile` (src/lib/profileUpdater.ts) already does for a household
 * member's profile, which skips companies and so never covered clients.
 *
 * ── THE RULES, AND WHY EACH IS THERE ───────────────────────────────────────
 *   BLANKS ONLY     A value the adviser typed (or an earlier document supplied)
 *                   is never overwritten. A document can be wrong, or be about
 *                   someone else on the page; a person who has just corrected a
 *                   field must not have it silently changed back.
 *   A SHORT LIST    Only categories whose field IS the client's own identifier:
 *                   a PAN card's PAN, a GST certificate's GSTIN. Not "any field
 *                   called pan_number" — an ITR or a loan form can carry someone
 *                   else's PAN (a guarantor's), and the wrong person's number on
 *                   a client is worse than an empty box.
 *   VALIDATED       Through the same schema the form uses. A value that does not
 *                   look like what it is (an OCR slip) is dropped, not stored.
 *   NO CLASHES      A PAN or GSTIN another client of the company already holds is
 *                   not copied: a scan matches documents to clients on those, and
 *                   two clients sharing one would make that match ambiguous.
 *   NEVER FATAL     It runs after the document is saved. Any failure is logged
 *                   and the document stays saved.
 *   NO VALUES IN THE AUDIT TRAIL   The audit line names the FIELDS filled
 *                   ("PAN, date of birth"), never what they are.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { withTenant } from '@/lib/db';
import { clients, documents } from '@/db/schema';
import { decryptField } from '@/lib/fieldCrypto';
import { readJsonStore } from '@/lib/vault/vaultRecords';
import { visibleDocument } from '@/lib/records/documentVisibility';
import { writeAudit, auditSentence } from '@/lib/audit';
import { recordAction } from '@/lib/auditActions';
import { categoryLabel, type CategoryKey } from '@/lib/documentCategories';
import { type ClientType, CLIENT_MODULE_BY_TYPE, isClientType, sourceKeyOf } from '@/lib/clientCategories';
import {
  type ClientDetails, clientDetailsForEdit, parseClientDetails, prepareClientRow,
} from '@/lib/clients/clientData';
import { findClientConflict } from '@/lib/clients/clientConflicts';

/** One document field → one client detail. */
interface Mapping {
  /** The field key in the document's own spec. */
  field: string;
  /** The key in `clients.details`. */
  detail: string;
  /** What to call it in the audit line. */
  label: string;
}

/**
 * Which documents state which facts about their owner, by SOURCE category (a
 * client category resolves to its source first). Deliberately short — see "A
 * SHORT LIST" above.
 */
const MAPPINGS: Record<ClientType, Record<string, readonly Mapping[]>> = {
  individual: {
    'identity/pan_card': [
      { field: 'pan_number', detail: 'panNumber', label: 'PAN' },
      { field: 'date_of_birth', detail: 'dateOfBirth', label: 'date of birth' },
    ],
    'identity/aadhaar_card': [
      { field: 'aadhaar_number', detail: 'aadhaarNumber', label: 'Aadhaar' },
      { field: 'date_of_birth', detail: 'dateOfBirth', label: 'date of birth' },
      { field: 'address', detail: 'address', label: 'address' },
    ],
    'identity/passport': [
      { field: 'date_of_birth', detail: 'dateOfBirth', label: 'date of birth' },
      { field: 'address', detail: 'address', label: 'address' },
    ],
    'identity/driving_license': [
      { field: 'date_of_birth', detail: 'dateOfBirth', label: 'date of birth' },
      { field: 'address', detail: 'address', label: 'address' },
    ],
  },
  company: {
    'biz_tax/gst_registration': [
      { field: 'gstin', detail: 'gstNumber', label: 'GSTIN' },
    ],
    'biz_registration/pan_card': [
      { field: 'pan_number', detail: 'panNumber', label: 'PAN' },
    ],
    'biz_registration/certificate_of_incorporation': [
      { field: 'cin_number', detail: 'registrationNumber', label: 'CIN' },
    ],
  },
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface Found {
  details: ClientDetails;
  labels: Record<string, string>;
}

/**
 * The client details a document states, from its field values. Pure.
 *
 * `fields` is the document's taxonomy-keyed record. Empty values are skipped, a
 * date is kept only as an ISO date (the form's date input speaks that), and
 * everything else is validated by the same schema the client form uses when the
 * details are merged — see `fillBlanks`.
 *
 * A GSTIN also states its holder's PAN (characters 3-12), so a company client
 * known only by a GST certificate gets a PAN too.
 */
export function detailsFromRecord(
  type: ClientType,
  category: CategoryKey,
  fields: Record<string, unknown> | null | undefined,
): Found {
  const out: Found = { details: {}, labels: {} };
  if (!fields) return out;
  const source = sourceKeyOf(category);
  const mappings = MAPPINGS[type][categoryLabel(source)];
  if (!mappings) return out;

  for (const m of mappings) {
    const raw = fields[m.field];
    if (typeof raw !== 'string') continue;
    const value = raw.trim();
    if (!value) continue;
    // A date is kept as the ISO date the form's date input speaks; a stored
    // timestamp ("1985-08-15T00:00:00.000Z") is cut to its date.
    const text = m.detail === 'dateOfBirth' ? value.slice(0, 10) : value;
    if (m.detail === 'dateOfBirth' && !ISO_DATE.test(text)) continue;
    out.details[m.detail] = text;
    out.labels[m.detail] = m.label;
  }

  if (type === 'company' && out.details.gstNumber && !out.details.panNumber) {
    const gstin = out.details.gstNumber.replace(/\s+/g, '').toUpperCase();
    if (gstin.length === 15) {
      out.details.panNumber = gstin.slice(2, 12);
      out.labels.panNumber = 'PAN';
    }
  }
  return out;
}

export interface Filled {
  merged: ClientDetails;
  /** The detail keys that were blank and are now filled, in a stable order. */
  changed: string[];
  labels: string[];
}

/**
 * Merge what a document states into the client's existing details — blanks only —
 * and validate the result. A found value that fails validation is dropped on its
 * own, so one OCR slip cannot cost the others.
 */
export function fillBlanks(type: ClientType, existing: ClientDetails, found: Found): Filled {
  const merged: ClientDetails = { ...existing };
  const changed: string[] = [];

  for (const [detail, value] of Object.entries(found.details)) {
    if (merged[detail] && String(merged[detail]).trim() !== '') continue;
    // Each candidate is checked ALONE, so the form's own rule decides it.
    const check = parseClientDetails(type, { [detail]: value });
    if (!check.ok) continue;
    const normalised = check.details[detail];
    if (!normalised) continue;
    merged[detail] = normalised;
    changed.push(detail);
  }

  return { merged, changed, labels: changed.map((d) => found.labels[d]).filter(Boolean) };
}

/**
 * Copy what a saved document states onto its client. Returns the labels filled
 * (empty when nothing was, which is the common case). Never throws: the document
 * is already saved, and its client's profile is a convenience.
 */
export async function fillClientFromRecord(
  user: { id: string; tenantId: string },
  companyId: string,
  clientId: string,
  category: CategoryKey,
  fields: Record<string, unknown> | null | undefined,
  req?: Request,
): Promise<string[]> {
  try {
    return await withTenant(user.tenantId, async (tx) => {
      const [row] = await tx
        .select()
        .from(clients)
        .where(and(
          eq(clients.id, clientId),
          eq(clients.tenantId, user.tenantId),
          eq(clients.companyId, companyId),
          isNull(clients.deletedAt),
        ))
        .limit(1);
      if (!row || !isClientType(row.clientType)) return [];
      const type = row.clientType;

      const found = detailsFromRecord(type, category, fields);
      if (Object.keys(found.details).length === 0) return [];

      const filled = fillBlanks(type, clientDetailsForEdit(row.details), found);
      if (filled.changed.length === 0) return [];

      // Rebuilt through the same path as an edit, so the sealed keys and the blind
      // indexes cannot fall out of step with each other.
      const next = prepareClientRow(row.displayName, filled.merged);

      // A PAN / GSTIN / CIN another client already holds is not copied.
      const conflict = await findClientConflict(tx, user.tenantId, companyId, type, next, row.id);
      if (conflict) return [];

      await tx.update(clients)
        .set({
          details: next.details,
          panHash: next.panHash,
          gstinHash: next.gstinHash,
          cinHash: next.cinHash,
          updatedAt: new Date(),
        })
        .where(and(
          eq(clients.id, row.id),
          eq(clients.tenantId, user.tenantId),
          eq(clients.companyId, companyId),
        ));

      await writeAudit({
        tenantId: user.tenantId,
        userId: user.id,
        companyId,
        action: recordAction(CLIENT_MODULE_BY_TYPE[type], 'update'),
        // The FIELDS, never their values: audit rows are unencrypted and kept.
        details: auditSentence('update', {
          kind: `${type} client`,
          name: row.displayName,
          note: `filled from a document: ${[...new Set(filled.labels)].join(', ')}`,
        }),
        req,
        entityType: 'clients',
        entityId: row.id,
      }, tx);

      return [...new Set(filled.labels)];
    });
  } catch (error) {
    console.error('[clients] could not fill client details from a document:', error);
    return [];
  }
}

/**
 * Fill a client's blanks from the documents ALREADY on file for them — the same
 * thing `fillClientFromRecord` does for a document as it is saved, for the ones
 * saved before it existed (or whose details were blank at the time).
 *
 * Reads only the client's documents in the short list above, opens each category's
 * store once, and decrypts the sealed values here (a PAN is sealed). Returns the
 * labels filled, de-duplicated. Same rules throughout: blanks only, validated, no
 * clashes.
 */
export async function refreshClientFromDocuments(
  user: { id: string; tenantId: string; tenant?: any },
  companyId: string,
  clientId: string,
  req?: Request,
): Promise<string[]> {
  const [client] = await withTenant(user.tenantId, (tx) => tx
    .select({ clientType: clients.clientType })
    .from(clients)
    .where(and(
      eq(clients.id, clientId),
      eq(clients.tenantId, user.tenantId),
      eq(clients.companyId, companyId),
      isNull(clients.deletedAt),
    ))
    .limit(1));
  if (!client || !isClientType(client.clientType)) return [];
  const type = client.clientType;

  const rows = await withTenant(user.tenantId, (tx) => tx
    .select({
      id: documents.id,
      moduleKey: documents.categoryModuleKey,
      documentKey: documents.categoryDocumentKey,
    })
    .from(documents)
    .where(and(
      eq(documents.tenantId, user.tenantId),
      eq(documents.companyId, companyId),
      eq(documents.clientId, clientId),
      visibleDocument(),
    )));

  // Only the documents that state something about their owner, grouped by category
  // so each store is opened once.
  const byCategory = new Map<string, { key: CategoryKey; ids: string[] }>();
  for (const r of rows) {
    if (!r.moduleKey || !r.documentKey) continue;
    const key = { moduleKey: r.moduleKey, documentKey: r.documentKey };
    if (!MAPPINGS[type][categoryLabel(sourceKeyOf(key))]) continue;
    const entry = byCategory.get(categoryLabel(key));
    if (entry) entry.ids.push(r.id); else byCategory.set(categoryLabel(key), { key, ids: [r.id] });
  }

  const labels = new Set<string>();
  for (const { key, ids } of byCategory.values()) {
    let records: Record<string, any> = {};
    try {
      const { store } = await readJsonStore(
        { tenant: user.tenant, tenantId: user.tenantId, userId: user.id, companyId } as any,
        key.moduleKey as any,
        key,
      );
      records = store.records ?? {};
    } catch (error) {
      // One unreadable store must not stop the others (a Drive blip).
      console.error(`[clients] could not read ${categoryLabel(key)} while refreshing a client:`, error);
      continue;
    }
    for (const id of ids) {
      const record = records[id];
      if (!record) continue;
      const fields: Record<string, unknown> = { ...(record.open ?? {}) };
      for (const [k, v] of Object.entries(record.sealed ?? {})) {
        fields[k] = typeof v === 'string' ? decryptField(v) : v;
      }
      for (const label of await fillClientFromRecord(user, companyId, clientId, key, fields, req)) labels.add(label);
    }
  }
  return [...labels];
}
