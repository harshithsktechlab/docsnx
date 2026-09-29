/**
 * Split an extracted record into the SEALED tier and the OPEN tier, driven by
 * `document_category_fields.encrypted_fields` — one comma-separated list per
 * category.
 *
 * ── DYNAMIC BY DESIGN ─────────────────────────────────────────────────────
 * The policy names every key a category *could* carry; a given document
 * carries some subset. The split is therefore an INTERSECTION: whichever
 * listed fields are actually present get encrypted, and a listed field the
 * record does not have is simply skipped — never materialised as an empty
 * sealed value, which would be indistinguishable from "the user left it blank".
 *
 * ── FAIL-CLOSED ORDERING ──────────────────────────────────────────────────
 * A key absent from the list goes to the open tier in the clear. That makes an
 * unseeded or truncated policy row dangerous, so `loadEncryptionPolicy()`
 * falls back to the compiled-in policy rather than to an empty list: a DB that
 * has not been seeded encrypts the same fields as one that has, instead of
 * encrypting nothing.
 *
 * `maskSensitiveText()` in aiPrivacyMasker.ts remains the second net over
 * whatever reaches the open tier — a backstop, not the classification.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { documentCategories, documentCategoryFields } from '@/db/schema';
import { encryptField, decryptField } from '@/lib/fieldCrypto';
import type { CategoryKey } from '@/lib/documentCategories';
import {
  BASELINE_OPEN_KEYS,
  BASELINE_SEALED_KEYS,
  parseEncryptedFields,
  encryptedFieldsFor,
} from '@/lib/documentCategoryFields';
import { applyPolicyOverrides, loadFieldOverrides } from '@/lib/records/fieldOverrides';

/** Anything that can run a select: the pooled `db` or a withTenant transaction. */
export type PolicyExecutor = Pick<typeof db, 'select'>;

export interface SplitRecord {
  /** Keys the policy names AND the record carries. Encrypt these. */
  sealed: Record<string, unknown>;
  /** Everything else. Readable — search, reminders and AI see this. */
  open: Record<string, unknown>;
}

/**
 * A list, forced to agree with the baseline in both directions.
 *
 * ADDING (`BASELINE_SEALED_KEYS`) is the safe half and the original purpose:
 * the baseline applies to every category by construction, so a list missing one
 * of its keys is a stale or absent policy — never an operator declaring that
 * free text may be readable.
 *
 * ── THE SUBTRACTION, AND WHY IT IS NARROW ──────────────────────────────────
 * `BASELINE_OPEN_KEYS` removes sealing, which is the direction this layer is
 * NOT normally allowed to be wrong in, so it is written to be incapable of
 * widening: it subtracts a fixed, hard-coded list and consults nothing else —
 * no stored column, no override, no argument. A caller cannot pass a key into
 * it, and an operator cannot reach it at all.
 *
 * It exists because `custom_fields` was sealed from 0025 until 0038, so every
 * stored policy still names it. Without a floor, un-sealing it would depend on
 * a migration having run AND a seed having followed, and any category that
 * missed either would keep sealing it — the field readable for some tenants and
 * not others, with nothing to explain the difference.
 *
 * Order matters: subtract AFTER adding, so a key in both lists ends up open.
 * Nothing is in both today, and the tests assert the two stay disjoint.
 */
function withBaseline(fields: readonly string[]): string[] {
  const missing = BASELINE_SEALED_KEYS.filter((key) => !fields.includes(key));
  const withSealed = missing.length > 0 ? [...fields, ...missing] : fields;
  return withSealed.filter((key) => !BASELINE_OPEN_KEYS.includes(key));
}

/**
 * Load a category's encrypt list by `document_categories.(module_key,
 * document_key)`.
 *
 * Returns the compiled-in policy when the DB has no row for the category —
 * see the fail-closed note above — and never less than the sealed baseline,
 * whichever branch answers. An explicitly EMPTY stored list is honoured as
 * written apart from that floor, since an empty list is a deliberate operator
 * choice rather than an absence.
 *
 * ── WHY THE NO-ROW BRANCH HAS A FLOOR TOO ──────────────────────────────────
 * `encryptedFieldsFor` answers from the compiled policy, which knows only the
 * SEEDED categories. Ask it about a category that is not seeded — one retired
 * by a taxonomy migration, say — and it correctly returns []. Returning that
 * verbatim would mean "seal nothing", so a record written under such a category
 * would land in the open tier in the clear, in full.
 *
 * That branch is not reachable today: `withCategory` 404s on any pair outside
 * the seed before authentication, and `resolveCategory` filters isActive. The
 * floor is here so that stops being the only thing standing between a retired
 * category and an unsealed record — and so deleting a policy row (0035) is a
 * safe operation rather than one that silently disarms this module.
 */
export async function loadEncryptionPolicy(
  executor: PolicyExecutor,
  categoryKey: CategoryKey,
): Promise<string[]> {
  const [row] = await executor
    .select({ encryptedFields: documentCategoryFields.encryptedFields })
    .from(documentCategoryFields)
    .innerJoin(documentCategories, eq(documentCategories.id, documentCategoryFields.categoryId))
    .where(and(
      eq(documentCategories.moduleKey, categoryKey.moduleKey),
      eq(documentCategories.documentKey, categoryKey.documentKey),
    ))
    .limit(1);

  // An operator may have sealed a field the dictionary leaves open, or opened
  // one it seals. Loaded for both branches: a category with no policy row still
  // honours the configuration set for it.
  const overrides = await loadFieldOverrides(executor, categoryKey);

  if (!row) {
    return withBaseline(applyPolicyOverrides(encryptedFieldsFor(categoryKey), overrides));
  }

  // The stored list, plus the sealed BASELINE keys whatever it says.
  //
  // A stored list missing one of them is a row written before that key existed.
  // Without this union, the gap between applying a migration that adds a sealed
  // baseline key and running the seed script that rewrites the lists is a gap in
  // which that field is written to Postgres in the clear, silently, and only for
  // records created during it.
  //
  // withBaseline runs AFTER the overrides, and that order is the guarantee in
  // BOTH directions: whatever an operator does on the config screen, `notes`
  // comes back sealed and `custom_fields` comes back open.
  return withBaseline(applyPolicyOverrides(parseEncryptedFields(row.encryptedFields), overrides));
}

/**
 * Partition `record` against an encrypt list. Pure — no crypto, no DB — so the
 * classification can be asserted on its own.
 *
 * Only own enumerable keys are considered, and a key whose value is null or
 * undefined stays out of the sealed tier: encrypting "absent" produces
 * ciphertext that decrypts to nothing and hides the fact that nothing was
 * captured.
 */
export function splitRecordFields(
  encryptedFields: readonly string[],
  record: Record<string, unknown> | null | undefined,
): SplitRecord {
  const sealed: Record<string, unknown> = {};
  const open: Record<string, unknown> = {};
  if (!record || typeof record !== 'object') return { sealed, open };

  const toSeal = new Set(encryptedFields);
  for (const [key, value] of Object.entries(record)) {
    if (toSeal.has(key) && value !== null && value !== undefined && value !== '') {
      sealed[key] = value;
    } else {
      open[key] = value;
    }
  }
  return { sealed, open };
}

/**
 * Apply `transform` to whichever sealed-tier keys the record carries, leaving
 * everything else untouched.
 *
 * Rebuilds by walking the ORIGINAL record rather than merging the two tiers
 * back together, so key order survives the round trip. Callers persist this as
 * a JSON blob; silently reordering its keys makes stored records diff against
 * themselves for no reason.
 */
function mapSealed(
  policy: readonly string[],
  record: Record<string, unknown> | null | undefined,
  transform: (value: string) => string | null,
): Record<string, unknown> {
  const { sealed } = splitRecordFields(policy, record);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record ?? {})) {
    out[key] = key in sealed ? transform(String(value)) : value;
  }
  return out;
}

/**
 * The whole write path: resolve the policy, then encrypt whichever named fields
 * are present. Returns one object safe to persist — sealed keys hold
 * ciphertext, open keys are untouched.
 *
 * `encryptField` is idempotent on an already-encrypted value, so re-saving a
 * record that was loaded from storage does not double-encrypt.
 */
export async function encryptRecordForCategory(
  executor: PolicyExecutor,
  categoryKey: CategoryKey,
  record: Record<string, unknown> | null | undefined,
): Promise<Record<string, unknown>> {
  const policy = await loadEncryptionPolicy(executor, categoryKey);
  return mapSealed(policy, record, encryptField as (v: string) => string | null);
}

/**
 * Inverse of encryptRecordForCategory. Decrypts whichever of the policy's
 * fields are present; `decryptField` passes a non-ciphertext value through
 * unchanged, so a record written before a field joined the list still reads.
 */
export async function decryptRecordForCategory(
  executor: PolicyExecutor,
  categoryKey: CategoryKey,
  record: Record<string, unknown> | null | undefined,
): Promise<Record<string, unknown>> {
  const policy = await loadEncryptionPolicy(executor, categoryKey);
  return mapSealed(policy, record, decryptField as (v: string) => string | null);
}
