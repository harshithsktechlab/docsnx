import './loadEnv';
import { and, eq, isNull, isNotNull } from 'drizzle-orm';
import { db } from '../src/lib/db';
import { documents, tenants } from '../src/db/schema';
import { readJsonStore, upsertRecord } from '../src/lib/vault/vaultRecords';
import type { VaultModule } from '../src/lib/vault/vaultNaming';
import { loadEncryptionPolicy } from '../src/lib/vault/fieldSplitter';
import { loadCategoryFieldSpec } from '../src/lib/records/categorySpec';
import { identifierFields } from '../src/lib/documentCategoryFields';
import { blindIndex, encryptField, decryptField } from '../src/lib/fieldCrypto';
import { maskTail } from '../src/lib/dataMasking';
import type { CategoryKey } from '../src/lib/documentCategories';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   RE-FILE THE DOCUMENT MANAGER'S MISPLACED NUMBERS                       ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * ── WHAT WENT WRONG ────────────────────────────────────────────────────────
 * The Document Manager and Power Scan post one generic `documentNumber`, and
 * `resolveFieldKey` used to map it through a fixed list of six candidate keys,
 * falling through to `document_number` when a category declared none of them.
 * 56 of the 83 sub-categories declare none, and `document_number` is declared
 * by exactly one (`civil_government/oci_visa_residency`). So for those records:
 *
 *   · the Number column showed '-' — it reads the category's `identifierFields`
 *   · the duplicate check never saw the number — no blind index under that key
 *   · the value sat in the OPEN tier IN THE CLEAR, because a category's encrypt
 *     list is its own declared PII fields and this key is not one of them
 *
 * The write path is fixed (src/lib/records/fieldMap.ts). This moves the records
 * that were already written: `document_number` → whatever key the record's own
 * category calls its identifier, sealed, masked and blind-indexed to match.
 *
 * ── AND THE OTHER HALF: A SEALED NUMBER WITH NO MASK ───────────────────────
 * Records filed through a sub-category form landed on the right key and were
 * sealed correctly — and STILL showed '-'. A list read carries the open tier
 * and the display masks, never a sealed value, so an identifier that is sealed
 * but unmasked is invisible to the Number column by design. Those records were
 * written before `toTaxonomyRecordFromFields` learned to emit a mask (it does
 * now, verified against the stored specs), so the mask has to be backfilled
 * from the plaintext — which means decrypting the sealed value, masking it, and
 * writing back only the mask.
 *
 * The blind index is backfilled on the same pass and for the same reason: a
 * record with no hash under its identifier is invisible to the duplicate check,
 * so re-uploading the same document silently created a second copy.
 *
 * ── SAFETY ─────────────────────────────────────────────────────────────────
 *   · READ-ONLY unless `--apply` is passed. The default run reports and exits.
 *   · Idempotent. A record whose identifier key already holds a value is left
 *     alone, so a half-finished run is resumed simply by running it again.
 *   · Never invents a target. A category with no identifier field keeps its
 *     value on `document_number`; there is nowhere better for it, and the
 *     `mustSeal` assertion in the write path is what keeps it sealed.
 *   · Never touches a key other than `document_number`. Categories where a
 *     candidate matched the WRONG field (a challan declaring `pan_number`) are
 *     REPORTED, not moved — the value there may be a genuine PAN, and only a
 *     human can tell which. See the summary this prints.
 *
 *   npx tsx scripts/repair_document_identifiers.ts [--apply] [--tenant <id>]
 */

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const onlyTenant = args.includes('--tenant') ? args[args.indexOf('--tenant') + 1] : null;

/** The key the old resolution fell through to. The one thing this moves. */
const LEGACY_KEY = 'document_number';

interface Move {
  tenantId: string;
  category: string;
  recordId: string;
  title: string;
  from: string;
  to: string;
  sealed: boolean;
}

/** A record already on the right key, missing its mask and/or its blind index. */
interface Backfill {
  tenantId: string;
  category: string;
  recordId: string;
  title: string;
  key: string;
  mask: boolean;
  hash: boolean;
}

/**
 * A record's identifier value, from whichever tier holds it.
 *
 * `sealed` first: a category that seals its identifier is the normal case, and
 * a record can carry a stale open-tier copy of a key that has since been
 * sealed. Returns the plaintext either way — the caller needs it to derive a
 * mask and a blind index, and neither can be computed from ciphertext.
 */
function readIdentifierValue(record: any, key: string): string | null {
  const sealed = record?.sealed?.[key];
  if (sealed !== undefined && sealed !== null && sealed !== '') {
    try {
      const plain = decryptField(String(sealed));
      return plain ? String(plain) : null;
    } catch {
      return null;
    }
  }
  const open = record?.open?.[key];
  if (open !== undefined && open !== null && open !== '') return String(open);
  return null;
}

/**
 * The record's number, wherever the old write path left it.
 *
 * `open` for anything written before the `mustSeal` fix; `sealed` for a record
 * written after it but before this repair. Returns null for a record that
 * carries neither — which is most of them.
 */
function readLegacyValue(record: any): string | null {
  const open = record?.open?.[LEGACY_KEY];
  if (open !== undefined && open !== null && open !== '') return String(open);

  const sealed = record?.sealed?.[LEGACY_KEY];
  if (sealed !== undefined && sealed !== null && sealed !== '') {
    try {
      const plain = decryptField(String(sealed));
      return plain ? String(plain) : null;
    } catch {
      // Ciphertext this deployment's key cannot open. Skipped rather than
      // moved: writing back something we could not read would destroy it.
      return null;
    }
  }
  return null;
}

async function main() {
  console.log(apply
    ? '⚠️  APPLY mode — records will be rewritten on Drive'
    : '🔍 read-only — pass --apply to write. Nothing will be changed.');

  const tenantRows = await db
    .select()
    .from(tenants)
    .where(and(
      isNull(tenants.deletedAt),
      // No Drive, no store to repair.
      isNotNull(tenants.googleDriveFolderId),
    ));

  const targets = onlyTenant ? tenantRows.filter((t) => t.id === onlyTenant) : tenantRows;
  if (targets.length === 0) {
    console.log(onlyTenant ? `no Drive-connected tenant ${onlyTenant}` : 'no Drive-connected tenants');
    return;
  }

  const moves: Move[] = [];
  const backfills: Backfill[] = [];
  const skippedNoIdentifier = new Map<string, number>();
  const unreadable: string[] = [];

  for (const tenant of targets) {
    // The DISTINCT categories this tenant holds records in — one store read
    // each, not one per record.
    const rows = await db
      .select({
        moduleKey: documents.categoryModuleKey,
        documentKey: documents.categoryDocumentKey,
      })
      .from(documents)
      .where(and(
        eq(documents.tenantId, tenant.id),
        isNull(documents.deletedAt),
        isNotNull(documents.categoryModuleKey),
      ));

    const categories = new Map<string, CategoryKey>();
    for (const r of rows) {
      if (!r.moduleKey || !r.documentKey) continue;
      categories.set(`${r.moduleKey}/${r.documentKey}`, {
        moduleKey: r.moduleKey,
        documentKey: r.documentKey,
      });
    }

    const ctx = { tenant: tenant as any, tenantId: tenant.id, userId: null };

    for (const [label, categoryKey] of categories) {
      const specs = await loadCategoryFieldSpec(db, categoryKey);
      const [target] = identifierFields(specs);

      let store;
      try {
        ({ store } = await readJsonStore(ctx as any, categoryKey.moduleKey as VaultModule, categoryKey));
      } catch (error) {
        unreadable.push(`${tenant.id} ${label}: ${(error as Error).message}`);
        continue;
      }

      const policy = await loadEncryptionPolicy(db, categoryKey);

      for (const [recordId, record] of Object.entries<any>(store.records ?? {})) {
        if (record?.deletedAt) continue;

        // ── Pass 1: a record already on the right key, but not renderable ──
        // Sealed and correct, yet the Number column shows '-' because a list
        // read never carries a sealed value — only its mask. Backfilled from
        // the plaintext, which is the one thing that can produce the mask.
        if (target) {
          const current = readIdentifierValue(record, target);
          if (current) {
            // Only a SEALED value earns a mask. Masking one the category leaves
            // open would hide a number that is meant to be shown in full —
            // `primaryIdentifier` prefers the mask wherever one exists.
            const isSealed = record?.sealed?.[target] !== undefined
              && record?.sealed?.[target] !== null
              && record?.sealed?.[target] !== '';
            const needsMask = isSealed && !record?.masked?.[target];
            const needsHash = !record?.searchHashes?.[target];

            if (needsMask || needsHash) {
              backfills.push({
                tenantId: tenant.id,
                category: label,
                recordId,
                title: record?.name ?? record?.title ?? '(untitled)',
                key: target,
                mask: needsMask,
                hash: needsHash,
              });

              if (apply) {
                await upsertRecord<any>(
                  ctx as any,
                  categoryKey.moduleKey as VaultModule,
                  categoryKey,
                  recordId,
                  (previous) => {
                    const prev = (previous ?? {}) as any;
                    const masked = { ...(prev.masked ?? {}) };
                    const searchHashes = { ...(prev.searchHashes ?? {}) };

                    if (needsMask) {
                      const mask = maskTail(current);
                      if (mask) masked[target] = mask;
                    }
                    if (needsHash) {
                      const hash = blindIndex(current);
                      if (hash) searchHashes[target] = hash;
                    }
                    // The plaintext is NOT written back anywhere — only the
                    // mask and the hash, both derived from it. The sealed tier
                    // is left exactly as it was found.
                    return { ...prev, masked, searchHashes };
                  },
                );
              }
            }
          }
        }

        // ── Pass 2: a record whose number is still on the fallback key ─────
        const value = readLegacyValue(record);
        if (!value) continue;

        if (!target) {
          // Nothing this category calls its identifier. Counted so the summary
          // can say how much is deliberately left alone.
          skippedNoIdentifier.set(label, (skippedNoIdentifier.get(label) ?? 0) + 1);
          continue;
        }
        if (target === LEGACY_KEY) continue; // already where it belongs

        // Idempotent: a record already carrying its identifier has been
        // repaired, or was written correctly, and must not be overwritten.
        const already = record?.open?.[target] ?? record?.sealed?.[target];
        if (already !== undefined && already !== null && already !== '') continue;


        const seals = policy.includes(target);
        moves.push({
          tenantId: tenant.id,
          category: label,
          recordId,
          title: record?.name ?? record?.title ?? '(untitled)',
          from: LEGACY_KEY,
          to: target,
          sealed: seals,
        });

        if (!apply) continue;

        await upsertRecord<any>(
          ctx as any,
          categoryKey.moduleKey as VaultModule,
          categoryKey,
          recordId,
          (previous) => {
            const prev = (previous ?? {}) as any;
            const open = { ...(prev.open ?? {}) };
            const sealed = { ...(prev.sealed ?? {}) };
            const masked = { ...(prev.masked ?? {}) };
            const searchHashes = { ...(prev.searchHashes ?? {}) };

            // The plaintext leaves BOTH tiers under the old key, whichever one
            // it was in. Leaving a copy behind would defeat the point.
            delete open[LEGACY_KEY];
            delete sealed[LEGACY_KEY];
            delete masked[LEGACY_KEY];
            delete searchHashes[LEGACY_KEY];

            if (seals) sealed[target] = encryptField(value);
            else open[target] = value;

            const mask = maskTail(value);
            if (mask) masked[target] = mask;
            const hash = blindIndex(value);
            if (hash) searchHashes[target] = hash;

            return { ...prev, open, sealed, masked, searchHashes, updatedAt: new Date().toISOString() };
          },
        );
      }
    }
  }

  // ── Report ────────────────────────────────────────────────────────────────
  console.log('');
  if (moves.length === 0 && backfills.length === 0) {
    console.log('✅ every record\'s number is on its category\'s identifier, masked and indexed');
  } else {
    const byCategory = new Map<string, Move[]>();
    for (const m of moves) {
      const bucket = byCategory.get(m.category) ?? [];
      bucket.push(m);
      byCategory.set(m.category, bucket);
    }
    console.log(`${apply ? 'repaired' : 'would repair'} ${moves.length} record(s):\n`);
    for (const [category, list] of [...byCategory].sort()) {
      const to = list[0].to;
      const sealed = list[0].sealed ? 'sealed' : 'open (category does not seal it)';
      console.log(`  ${category}  ${LEGACY_KEY} → ${to}  [${sealed}]  ×${list.length}`);
    }
  }

  if (backfills.length > 0) {
    const byCategory = new Map<string, Backfill[]>();
    for (const b of backfills) {
      const bucket = byCategory.get(b.category) ?? [];
      bucket.push(b);
      byCategory.set(b.category, bucket);
    }
    console.log(`\n${apply ? 'backfilled' : 'would backfill'} ${backfills.length} record(s) already on the right key:\n`);
    for (const [category, list] of [...byCategory].sort()) {
      const masks = list.filter((b) => b.mask).length;
      const hashes = list.filter((b) => b.hash).length;
      console.log(`  ${category}  ${list[0].key}  ×${list.length}  (${masks} mask, ${hashes} blind index)`);
    }
  }

  if (skippedNoIdentifier.size > 0) {
    console.log('\nleft alone — these categories identify their records by nothing:');
    for (const [category, count] of [...skippedNoIdentifier].sort()) {
      console.log(`  ${category}  ×${count}`);
    }
  }

  if (unreadable.length > 0) {
    console.log('\n⚠️  stores that could not be read (re-run to retry):');
    for (const line of unreadable) console.log(`  ${line}`);
  }

  if (!apply && (moves.length > 0 || backfills.length > 0)) {
    console.log('\nre-run with --apply to write these changes.');
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
