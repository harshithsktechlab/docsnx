/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   FIELD REFERENCES, CHECKED WHERE THEY ARE WRITTEN                        ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * ./fieldRefs.ts judges a pointer's SHAPE, which the browser can do. Whether
 * the member exists in THIS workspace, or the locker is a record of THIS
 * tenant in the category the field links to, only the server can answer — and
 * must, because a request is not the picker. Without this a forged
 * `member:<uuid>` or locker id from another tenant would be stored, and a
 * later display lookup would be a cross-tenant probe.
 *
 * Called from `createRecord`, the one function every create and edit passes
 * through, right after the category's spec is loaded.
 *
 * ── AN EDIT MUST NOT BE BLOCKED BY HISTORY ─────────────────────────────────
 * A locker deleted after its items were filed, or a member who has since
 * left, leaves items pointing at something no longer live. Refusing every save
 * of such an item until the user re-picked would turn an unrelated edit — a
 * new valuation — into an error about a field they did not touch. So on an
 * EDIT the check widens to "ever belonged to this tenant", which still closes
 * the cross-tenant hole; on a CREATE it is "live, here, now".
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { withTenant } from '@/lib/db';
import { documents, users } from '@/db/schema';
import type { FieldSpec } from '@/lib/documentCategoryFields';
import { visibleDocument } from './documentVisibility';
import { isWorkspaceMember } from './workspaceMembers';
import { isUuid, parseMemberRef } from './fieldRefs';

/** A pointer that does not resolve in the caller's workspace. Always a 400. */
export class InvalidReferenceError extends Error {
  readonly fieldKey: string;

  constructor(fieldKey: string, message: string) {
    super(message);
    this.name = 'InvalidReferenceError';
    this.fieldKey = fieldKey;
  }
}

export interface ReferenceContext {
  tenantId: string;
  companyId: string | null | undefined;
  /** True for an edit of an existing record — see the header. */
  isEdit: boolean;
}

async function tenantUserExists(tenantId: string, id: string): Promise<boolean> {
  const [hit] = await withTenant(tenantId, (tx) => tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, id), eq(users.tenantId, tenantId)))
    .limit(1));
  return Boolean(hit);
}

async function linkedRecordExists(
  ctx: ReferenceContext,
  id: string,
  target: { moduleKey: string; documentKey: string },
): Promise<boolean> {
  const [hit] = await withTenant(ctx.tenantId, (tx) => tx
    .select({ id: documents.id })
    .from(documents)
    .where(and(
      eq(documents.id, id),
      eq(documents.tenantId, ctx.tenantId),
      // The same workspace: a household item cannot point at a company locker.
      ctx.companyId ? eq(documents.companyId, ctx.companyId) : isNull(documents.companyId),
      eq(documents.categoryModuleKey, target.moduleKey),
      eq(documents.categoryDocumentKey, target.documentKey),
      ...(ctx.isEdit ? [] : [visibleDocument()]),
    ))
    .limit(1));
  return Boolean(hit);
}

/**
 * Throws `InvalidReferenceError` for the first pointer in `record` that does
 * not resolve. Values of every other type are ignored, as are blanks.
 */
export async function assertFieldReferences(
  ctx: ReferenceContext,
  specs: readonly FieldSpec[],
  record: Record<string, unknown> | null | undefined,
): Promise<void> {
  if (!record) return;
  for (const spec of specs) {
    if (spec.dataType !== 'member' && spec.dataType !== 'record_link') continue;
    const raw = record[spec.fieldKey];
    if (raw === null || raw === undefined || String(raw).trim() === '') continue;
    const value = String(raw).trim();

    if (spec.dataType === 'member') {
      const ref = parseMemberRef(value);
      // A typed outside name has nothing to resolve.
      if (!ref || 'name' in ref) continue;
      const ok = await isWorkspaceMember(ctx.tenantId, ref.memberId, ctx.companyId)
        || (ctx.isEdit && await tenantUserExists(ctx.tenantId, ref.memberId));
      if (!ok) {
        throw new InvalidReferenceError(spec.fieldKey, `${spec.fieldLabel} is not a member of this workspace`);
      }
      continue;
    }

    const target = spec.linkTarget;
    if (!target || !isUuid(value) || !await linkedRecordExists(ctx, value, target)) {
      throw new InvalidReferenceError(spec.fieldKey, `${spec.fieldLabel} is not a record you can link to`);
    }
  }
}

/**
 * The names every pointer value in `records` resolves to — members to their
 * names, linked records to their titles — for printing them (documentFieldList).
 *
 * Tenant-scoped both ways: an id from another tenant resolves to nothing and
 * prints as "Former member" / "Record removed", never as someone else's name.
 */
export async function loadRefLookups(
  tenantId: string,
  values: Iterable<unknown>,
): Promise<{ membersById: Map<string, string>; linkTitles: Map<string, string> }> {
  const memberIds = new Set<string>();
  const recordIds = new Set<string>();
  for (const raw of values) {
    if (raw === null || raw === undefined) continue;
    const text = String(raw).trim();
    const ref = parseMemberRef(text);
    if (ref && 'memberId' in ref) memberIds.add(ref.memberId);
    else if (isUuid(text)) recordIds.add(text.toLowerCase());
  }
  const membersById = new Map<string, string>();
  const linkTitles = new Map<string, string>();
  if (memberIds.size === 0 && recordIds.size === 0) return { membersById, linkTitles };

  await withTenant(tenantId, async (tx) => {
    if (memberIds.size > 0) {
      const rows = await tx.select({ id: users.id, name: users.name }).from(users)
        .where(and(eq(users.tenantId, tenantId), inArray(users.id, [...memberIds])));
      for (const r of rows) membersById.set(r.id, r.name ?? '');
    }
    if (recordIds.size > 0) {
      const rows = await tx.select({ id: documents.id, title: documents.title }).from(documents)
        .where(and(eq(documents.tenantId, tenantId), inArray(documents.id, [...recordIds]), visibleDocument()));
      for (const r of rows) linkTitles.set(r.id, r.title);
    }
  });
  return { membersById, linkTitles };
}

/** The values a record holds under its pointer fields, for `loadRefLookups`. */
export function pointerValues(
  values: Record<string, unknown>,
  specs: readonly { fieldKey: string; dataType?: string }[],
): unknown[] {
  return specs
    .filter((s) => s.dataType === 'member' || s.dataType === 'record_link')
    .map((s) => values[s.fieldKey])
    .filter((v) => v !== null && v !== undefined && v !== '');
}
