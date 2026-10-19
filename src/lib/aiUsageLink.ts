/**
 * Links tenant_ai_usages rows to the record the user finally saved.
 *
 * At AI time the record does not exist: Power Scan proposes records and the
 * single-upload paths fill an unsaved form. Each AI call's usage row id goes
 * back to the browser with the AI result, and comes back here with the save.
 *
 * The ids are a HINT from the browser and are never trusted for scope:
 *   - only rows of the saving tenant are touched (`tenant_id = tenantId`);
 *   - only rows not yet linked to anything are touched, so a replayed or
 *     forged id cannot re-point a row that already describes another record.
 * Anything that does not match is silently ignored — linking is bookkeeping,
 * and a failure here must never fail the save it follows.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db } from './db';
import { documents, tenantAiUsages } from '../db/schema';
import { visibleDocument } from './records/documentVisibility';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** At most this many ids per save — a Documents Manager save carries 2, a scan record 1. */
const MAX_IDS = 20;

export type AiUsageTarget =
  | { documentId: string }
  | { todoId: string }
  | { contactId: string };

/** Keeps only well-formed, distinct UUIDs from whatever the browser sent. */
export function cleanUsageIds(raw: unknown): string[] {
  // A multipart form carries the list as one JSON string.
  if (typeof raw === 'string' && raw.trim().startsWith('[')) {
    try { raw = JSON.parse(raw); } catch { raw = []; }
  }
  const list = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  const out = new Set<string>();
  for (const v of list) {
    if (typeof v === 'string' && UUID_RE.test(v.trim())) out.add(v.trim().toLowerCase());
    if (out.size >= MAX_IDS) break;
  }
  return [...out];
}

export async function linkAiUsage(tenantId: string, rawIds: unknown, target: AiUsageTarget): Promise<number> {
  const ids = cleanUsageIds(rawIds);
  if (!tenantId || ids.length === 0) return 0;

  const set =
    'documentId' in target ? { documentId: target.documentId }
    : 'todoId' in target ? { todoId: target.todoId }
    : { contactId: target.contactId };

  try {
    // Cross-tenant-safe by the explicit tenant predicate; the app role bypasses
    // RLS today (see api/admin/tenants/[id]/overview/route.ts), so this filter
    // is what actually scopes the write.
    const updated = await db.update(tenantAiUsages)
      .set(set)
      .where(and(
        eq(tenantAiUsages.tenantId, tenantId),
        inArray(tenantAiUsages.id, ids),
        isNull(tenantAiUsages.documentId),
        isNull(tenantAiUsages.todoId),
        isNull(tenantAiUsages.contactId),
      ))
      .returning({ id: tenantAiUsages.id });
    return updated.length;
  } catch (err) {
    console.error('[aiUsageLink] failed to link usage rows:', err);
    return 0;
  }
}

/**
 * Edit mode: the record already exists, so the usage row can be linked at AI
 * time. The browser-sent `recordId` is checked to be a live document of this
 * tenant first — a forged id links nothing.
 */
export async function linkAiUsageToExistingDocument(tenantId: string, rawIds: unknown, recordId: unknown): Promise<number> {
  const [docId] = cleanUsageIds(recordId);
  if (!tenantId || !docId) return 0;
  try {
    const [doc] = await db.select({ id: documents.id })
      .from(documents)
      .where(and(eq(documents.id, docId), eq(documents.tenantId, tenantId), visibleDocument()))
      .limit(1);
    if (!doc) return 0;
  } catch (err) {
    console.error('[aiUsageLink] failed to check document:', err);
    return 0;
  }
  return linkAiUsage(tenantId, rawIds, { documentId: docId });
}

/**
 * Stamps the category a classify call chose onto its usage row — classify is
 * the one call whose category is its OUTPUT, unknown when the row was written.
 */
export async function setAiUsageCategory(tenantId: string, usageId: unknown, moduleKey: string, documentKey: string): Promise<void> {
  const [id] = cleanUsageIds(usageId);
  if (!tenantId || !id || !moduleKey || !documentKey) return;
  try {
    await db.update(tenantAiUsages)
      .set({ moduleKey: moduleKey.slice(0, 64), documentKey: documentKey.slice(0, 100) })
      .where(and(eq(tenantAiUsages.id, id), eq(tenantAiUsages.tenantId, tenantId)));
  } catch (err) {
    console.error('[aiUsageLink] failed to set usage category:', err);
  }
}
