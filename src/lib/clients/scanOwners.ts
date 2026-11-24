/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   POWER SCAN — DECIDING WHOSE EACH DOCUMENT IS                           ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * A company that keeps documents for clients scans a mixed pile: its own
 * paperwork, a client's PAN card, another client's GST certificate. This is the
 * server half of sorting that pile (the pure rules are in ownerMatch.ts and
 * ownerCategory.ts; the screen that confirms it is the Power Scan review grid).
 *
 *   loadScanOwnerContext   what the scan needs to know: the company's own
 *                          identity, its clients, and which client subcategories
 *                          it has ticked. `null` when the company uses none of
 *                          this — and then a scan is byte-for-byte what it was.
 *   individualClientStanza the extra block of the prompt that lets the model file
 *                          a PERSONAL document (a client's PAN card) at all. It
 *                          lists ONLY the subcategories the company ticked, so it
 *                          stays short and the model cannot propose one the
 *                          company would refuse.
 *   applyScanOwners        reads each record's owner, matches it, and re-files the
 *                          record under that owner's category.
 *
 * ── THE MODEL NEVER SEES CLIENT NAMES OR NUMBERS ───────────────────────────
 * It is asked whose document each one is, from the page itself. The match against
 * the client list happens here, on the server, with blind indexes — so the list
 * of a company's clients is never put in a prompt.
 *
 * ── A PROPOSAL, NEVER A DECISION ───────────────────────────────────────────
 * Everything written onto a record here is a suggestion for the review grid.
 * `ownerProposal.attention` marks the ones a person must look at before saving
 * (an owner nobody recognises), and the save route re-proves the client and the
 * ticked subcategory regardless of what the grid sends.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db, withTenant } from '@/lib/db';
import { clients, companies, companyProfiles, documentCategories } from '@/db/schema';
import { decryptJsonKeys, COMPANY_TAX_KEYS } from '@/lib/records/jsonFieldCrypto';
import {
  type CategoryKey,
  categoryLabel,
  isBusinessModule,
  isCatchAll,
  isClientModule,
} from '@/lib/documentCategories';
import { type ClientType, fromClientKey } from '@/lib/clientCategories';
import { taxonomyRows } from '@/lib/taxonomyRegistry';
import { loadEnabledDocumentKeys } from '@/lib/clients/clientSettings';
import { loadClientTypes } from '@/lib/clients/clientTypes';
import {
  type ClientCandidate,
  type OwnCompany,
  matchOwner,
  normaliseOwnerIds,
} from '@/lib/clients/ownerMatch';
import {
  type EnabledClientKeys,
  type OwnerChoice,
  mapPairForOwner,
  noteMessage,
} from '@/lib/clients/ownerCategory';

export interface ScanOwnerContext {
  companyId: string;
  own: OwnCompany;
  clients: ClientCandidate[];
  enabled: EnabledClientKeys;
}

/** The slice of the context the review grid needs, safe to send to the browser. */
export interface ScanOwnersPayload {
  clients: { id: string; clientType: ClientType; displayName: string }[];
  /** Derived document keys ticked, per client type — what the grid may offer. */
  enabled: { individual: string[]; company: string[] };
  /** `<moduleKey>/<documentKey>` of a client category → its display name. */
  categoryNames: Record<string, string>;
}

/**
 * The context, or `null` unless the company has ticked at least one subcategory
 * for some kind of client.
 *
 * Configuring comes first. A company that has clients but ticked nothing — or has
 * neither — gets exactly the scan it always had, prompt and review grid included:
 * this is an addition for companies that opted in, never a change to everyone's
 * existing upload. And a kind of client with nothing ticked is invisible to the
 * scan, so a company that configured only individuals is never asked about
 * company clients.
 */
export async function loadScanOwnerContext(
  user: { tenantId: string },
  companyId: string,
): Promise<ScanOwnerContext | null> {
  const loaded = await withTenant(user.tenantId, async (tx) => {
    const [tickedIndividual, tickedCompany, types] = await Promise.all([
      loadEnabledDocumentKeys(tx, user.tenantId, companyId, 'individual'),
      loadEnabledDocumentKeys(tx, user.tenantId, companyId, 'company'),
      loadClientTypes(tx, user.tenantId, companyId),
    ]);

    const rows = await tx
      .select({
        id: clients.id,
        clientType: clients.clientType,
        displayName: clients.displayName,
        panHash: clients.panHash,
        gstinHash: clients.gstinHash,
        cinHash: clients.cinHash,
      })
      .from(clients)
      .where(and(
        eq(clients.tenantId, user.tenantId),
        eq(clients.companyId, companyId),
        eq(clients.isActive, true),
        isNull(clients.deletedAt),
      ));

    const [co] = await tx
      .select({ name: companies.name })
      .from(companies)
      .where(and(
        eq(companies.id, companyId),
        eq(companies.tenantId, user.tenantId),
        isNull(companies.deletedAt),
      ))
      .limit(1);

    const [profile] = await tx
      .select({
        identityDetails: companyProfiles.identityDetails,
        taxDetails: companyProfiles.taxDetails,
      })
      .from(companyProfiles)
      .where(and(
        eq(companyProfiles.companyId, companyId),
        eq(companyProfiles.tenantId, user.tenantId),
        isNull(companyProfiles.deletedAt),
      ))
      .limit(1);

    return { tickedIndividual, tickedCompany, types, rows, co, profile };
  });

  // A kind the company has not turned on is invisible to the scan, however much is
  // ticked for it: ticks only mean something for a kind that is kept.
  const individual = loaded.types.individual ? loaded.tickedIndividual : [];
  const company = loaded.types.company ? loaded.tickedCompany : [];

  if (individual.length === 0 && company.length === 0) return null;
  if (!loaded.co) return null;
  const configured = {
    individual: individual.length > 0,
    company: company.length > 0,
  };

  const identity = (loaded.profile?.identityDetails ?? {}) as Record<string, any>;
  const tax = (decryptJsonKeys(loaded.profile?.taxDetails as any, COMPANY_TAX_KEYS) ?? {}) as Record<string, any>;

  return {
    companyId,
    own: {
      name: loaded.co.name,
      legalName: typeof identity.legalName === 'string' ? identity.legalName : null,
      cin: typeof identity.registrationNumber === 'string' ? identity.registrationNumber : null,
      pan: typeof tax.panNumber === 'string' ? tax.panNumber : null,
      gstin: typeof tax.gstNumber === 'string' ? tax.gstNumber : null,
      tan: typeof tax.tanNumber === 'string' ? tax.tanNumber : null,
    },
    // Only clients of a configured kind: one nothing is ticked for cannot receive a
    // document, so it is neither matched nor offered as an owner.
    clients: loaded.rows.filter((r) => configured[r.clientType as ClientType]).map((r) => ({
      id: r.id,
      clientType: r.clientType as ClientType,
      displayName: r.displayName,
      panHash: r.panHash,
      gstinHash: r.gstinHash,
      cinHash: r.cinHash,
    })),
    enabled: { individual: new Set(individual), company: new Set(company) },
  };
}

/** The personal pairs the individual-client stanza offers, as `module/document`. */
export async function individualSourceKeys(ctx: ScanOwnerContext): Promise<Set<string>> {
  const out = new Set<string>();
  for (const row of await taxonomyRows()) {
    if (isBusinessModule(row.moduleKey) || isClientModule(row.moduleKey)) continue;
    if (ctx.enabled.individual.has(`${row.moduleKey}-${row.documentKey}`)) {
      out.add(categoryLabel(row));
    }
  }
  return out;
}

/**
 * The prompt block for individual-client documents, or '' when none is ticked.
 *
 * Same line shape as `renderAiCategoryList` — the heading's exact form is what the
 * model pairs the two keys from — but with no fallback stanza, because this block
 * adds to a list that already has one.
 */
export async function individualClientStanza(ctx: ScanOwnerContext): Promise<string> {
  const keys = await individualSourceKeys(ctx);
  if (keys.size === 0) return '';

  const byModule = new Map<string, { moduleNo: number; moduleName: string; items: string[] }>();
  for (const row of await taxonomyRows()) {
    if (!keys.has(categoryLabel(row))) continue;
    let mod = byModule.get(row.moduleKey);
    if (!mod) {
      mod = { moduleNo: row.moduleNo, moduleName: row.moduleName, items: [] };
      byModule.set(row.moduleKey, mod);
    }
    mod.items.push(`     - "${row.documentKey}": ${row.documentName}`);
  }

  const modules = [...byModule].map(([moduleKey, m]) =>
    `   Module ${m.moduleNo} — ${m.moduleName} (moduleKey: "${moduleKey}"):\n${m.items.join('\n')}`);

  return [
    '   ── DOCUMENTS OF AN INDIVIDUAL CLIENT ──',
    '   The business using this system keeps documents for its CLIENTS as well as for itself. The entries below are for a document about a PERSON who is a client — a person\'s own PAN card, policy, bank statement, tax return and the like — as opposed to a document of the business, which belongs under the modules above.',
    '   File a record under one of these ONLY when it is clearly a personal document of an individual. The two lists never mix: use a business entry for a business document, and these only for a person\'s. If a personal document matches none of these entries, use the fallback.',
    ...modules,
  ].join('\n');
}

/** The prompt tasks that ask whose document each record is. Only sent when this feature is on. */
export const OWNER_PROMPT_TASK = `6. FOR EVERY RECORD, say WHOSE document it is, as printed on the document itself:
   - "ownerName": the person or organisation the record belongs to or is about — the registrant on a certificate, the taxpayer on a tax form, the account holder on a statement, the policyholder or insured on a policy, the employee on an HR record. When two parties are named, the one the document is primarily ABOUT. Exactly as printed; an empty string if none is named.
   - "ownerType": "individual" for a natural person, "company" for a company, firm, LLP, trust or other organisation, or "" if you cannot tell.
   - "ownerIds": the identifiers printed on THIS document for that owner, exactly as printed — { "pan": "...", "gstin": "...", "cin": "...", "tan": "..." }. Include only the ones actually printed; omit the rest. Never put an account, policy or reference number in any of them.`;

export const OWNER_SCHEMA_LINES = `      "ownerName": "<whose document this is, as printed, or an empty string>",
      "ownerType": "individual" | "company" | "",
      "ownerIds": { "pan": "", "gstin": "", "cin": "", "tan": "" },`;

/** Lift owner keys a model nested inside `extractedData`, as it sometimes does with `holderName`. */
function liftOwnerKeys(rec: any) {
  const nested = rec?.extractedData;
  if (!nested || typeof nested !== 'object') return;
  for (const key of ['ownerName', 'ownerType', 'ownerIds']) {
    if (nested[key] !== undefined) {
      if (rec[key] === undefined) rec[key] = nested[key];
      delete nested[key];
    }
  }
}

/**
 * Decide each record's owner and re-file it under that owner's category.
 *
 * Mutates `records` in place, like the scan route's other `attach*` passes, and
 * returns what the review grid needs to offer the same choices. Runs AFTER
 * pass 1 (and the mixed-document split) and BEFORE the category ids and field
 * specs are attached, so those are resolved for the category the record will
 * really be saved under.
 */
export async function applyScanOwners(records: any[], ctx: ScanOwnerContext): Promise<ScanOwnersPayload> {
  const rows = await taxonomyRows();
  const nameByKey = new Map(rows.map((r) => [categoryLabel(r), r.documentName]));
  const categoryNames: Record<string, string> = {};

  const nameOfPair = (pair: CategoryKey) => nameByKey.get(categoryLabel(pair)) ?? pair.documentKey;
  const sourceName = (pair: CategoryKey) => {
    const src = fromClientKey(pair) ?? pair;
    return nameByKey.get(categoryLabel(src)) ?? src.documentKey;
  };

  for (const rec of records || []) {
    if (!rec || rec.kind === 'todo' || rec.kind === 'emergency_contact') continue;
    const mod = rec.extractedData?.moduleKey;
    const doc = rec.extractedData?.documentKey;
    if (!mod || !doc) continue;
    liftOwnerKeys(rec);

    const source: CategoryKey = { moduleKey: mod, documentKey: doc };
    // A personal pair can only be here because the individual-client stanza
    // offered it; a catch-all is neither.
    const personal = !isBusinessModule(mod) && !isCatchAll(source);

    const ownerName = typeof rec.ownerName === 'string' ? rec.ownerName.trim() : '';
    const match = matchOwner(
      { ownerName, ownerType: rec.ownerType, ownerIds: rec.ownerIds },
      ctx.own,
      ctx.clients,
    );

    // A person's document matched to the COMPANY is a contradiction (a model
    // that read the business's own number off a client's paper): treated as
    // unknown, never silently filed under the company.
    const matchedClient = match.kind === 'client';
    const owner: OwnerChoice = matchedClient
      ? (match.clientType as ClientType)
      : personal ? 'individual' : 'own';

    const mapped = mapPairForOwner(source, owner, ctx.enabled);

    rec.sourcePair = source;
    rec.extractedData.moduleKey = mapped.pair.moduleKey;
    rec.extractedData.documentKey = mapped.pair.documentKey;
    // Resolved from the pair by `attachCategoryIds`, which runs next.
    delete rec.extractedData.categoryId;
    delete rec.extractedData.categoryName;
    if (owner !== 'own') categoryNames[categoryLabel(mapped.pair)] = nameOfPair(mapped.pair);

    const ids = normaliseOwnerIds(rec.ownerIds);
    const unrecognised = match.kind === 'unknown' || (match.kind === 'own' && personal);
    rec.ownerProposal = {
      kind: matchedClient ? 'client' : (match.kind === 'own' && !personal ? 'own' : 'unknown'),
      owner,
      via: match.via,
      reason: match.kind === 'own' && personal
        ? 'This looks like a personal document, but its numbers match this company — check who it belongs to.'
        : match.reason,
      ...(matchedClient ? { clientId: match.clientId, clientName: match.clientName, clientType: match.clientType } : {}),
      // Somebody has to look at this one before it is saved — ONLY a personal
      // document with no client to put it under (it has no home without one). A
      // company's own document whose owner nobody recognises is NOT blocked: it
      // stays under the company exactly as it would have before this feature, and
      // the grid shows a hint with an "Add client" shortcut instead.
      attention: unrecognised && personal,
      pairNote: mapped.note,
      noteText: noteMessage(mapped.note, sourceName(source), owner),
      // What the document IS, for the grid's own re-mapping message.
      sourceName: sourceName(source),
      // What an inline "Add client" is pre-filled with.
      read: {
        name: ownerName,
        type: rec.ownerType === 'individual' || rec.ownerType === 'company' ? rec.ownerType : (personal ? 'individual' : null),
        ids: { pan: ids.pan, gstin: ids.gstin, cin: ids.cin, tan: ids.tan },
      },
    };
    if (matchedClient) {
      rec.clientId = match.clientId;
      rec.clientType = match.clientType;
    }
  }

  // Everything the grid may need to name a client category after a re-map.
  for (const type of ['individual', 'company'] as const) {
    for (const documentKey of ctx.enabled[type]) {
      const moduleKey = type === 'company' ? 'biz_client_company' : 'biz_client_individual';
      const key = { moduleKey, documentKey };
      categoryNames[categoryLabel(key)] = nameOfPair(key);
    }
    const catchAll = { moduleKey: type === 'company' ? 'biz_client_company' : 'biz_client_individual', documentKey: 'uncategorized' };
    categoryNames[categoryLabel(catchAll)] = nameOfPair(catchAll);
  }

  return {
    clients: ctx.clients.map((c) => ({ id: c.id, clientType: c.clientType, displayName: c.displayName })),
    enabled: { individual: [...ctx.enabled.individual], company: [...ctx.enabled.company] },
    categoryNames,
  };
}

/**
 * `<moduleKey>/<documentKey>` → `document_categories.id` for every client category
 * the company may file under: the ticked ones of both kinds, plus each kind's
 * catch-all. The single-upload panel saves by id (the Document Manager's contract)
 * and lets the reviewer change the owner and the document type without another
 * round trip, so it needs all of them up front. Global table — no tenant column.
 */
export async function clientCategoryIds(ctx: ScanOwnerContext): Promise<Record<string, string>> {
  const rows = await db
    .select({ id: documentCategories.id, moduleKey: documentCategories.moduleKey, documentKey: documentCategories.documentKey })
    .from(documentCategories)
    .where(and(
      inArray(documentCategories.moduleKey, ['biz_client_individual', 'biz_client_company']),
      eq(documentCategories.isActive, true),
    ));
  const out: Record<string, string> = {};
  for (const r of rows) {
    const type = r.moduleKey === 'biz_client_company' ? 'company' : 'individual';
    if (r.documentKey === 'uncategorized' || ctx.enabled[type].has(r.documentKey)) {
      out[categoryLabel(r)] = r.id;
    }
  }
  return out;
}
