import './loadEnv';
import { and, eq } from 'drizzle-orm';
import { db } from '../src/lib/db';
import { tenants, vaultJsonFiles } from '../src/db/schema';
import { readJsonStore, upsertRecord, type VaultCtx } from '../src/lib/vault/vaultRecords';
import { decryptField } from '../src/lib/fieldCrypto';
import { hashSearchTiers } from '../src/lib/search/tiers';
import { auditOperatorDriveAccess } from '../src/lib/vault/operatorAudit';

/**
 * Rebuilds the keyword index of records saved before search had tiers.
 *
 * A record used to carry ONE flat `searchTokens` list; search now ranks by where
 * a word was found (name, city, pincode, document name, ...), which needs
 * `searchTiers`. The plaintext parts of a record are tiered at query time with
 * no help from this script, but the SEALED fields (an address, and so the city
 * and the pincode) exist only as tokens — so an old record cannot be found by
 * city or pincode at the right rank until it is re-indexed. Editing a record
 * re-indexes it; this does every other one.
 *
 * The index is rebuilt from the record's own open fields plus its sealed fields,
 * opened here with the server key exactly as `storeRecordInVault` sealed them.
 * The plaintext is hashed and dropped; nothing is written but the hashes.
 * `contentTokens` (the document's own text) are left untouched, and the old flat
 * `searchTokens` list is removed in the same write.
 *
 * Idempotent: a record that already has `searchTiers` is skipped. Passwords are
 * a different module and are not searched through this index.
 *
 * Each changed record is one Drive write, so run it per tenant and off-peak.
 * Writes nothing without `--apply`.
 *
 *   npx tsx scripts/reindex_search_tiers.ts --tenant <uuid> [--apply]
 */

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const tenantArg = args.includes('--tenant') ? args[args.indexOf('--tenant') + 1] : null;
const prefix = apply ? '' : '[dry-run] ';

if (!tenantArg) {
  console.error('usage: npx tsx scripts/reindex_search_tiers.ts --tenant <uuid> [--apply]');
  process.exit(1);
}

/** A record's open fields and its sealed ones, opened — the input the index was built from. */
function fieldsOf(record: any): Record<string, unknown> {
  const fields: Record<string, unknown> = { ...(record.open ?? {}) };
  for (const [key, value] of Object.entries(record.sealed ?? {})) {
    if (typeof value !== 'string') continue;
    try {
      const plain = decryptField(value);
      if (plain) fields[key] = plain;
    } catch {
      // A value that will not open stays out of the index; the record keeps
      // matching on everything else.
    }
  }
  return fields;
}

async function main() {
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantArg!) });
  if (!tenant) {
    console.error(`no tenant ${tenantArg}`);
    process.exit(1);
  }

  const pointers = await db
    .select({
      companyId: vaultJsonFiles.companyId,
      module: vaultJsonFiles.module,
      categoryModuleKey: vaultJsonFiles.categoryModuleKey,
      categoryDocumentKey: vaultJsonFiles.categoryDocumentKey,
    })
    .from(vaultJsonFiles)
    .where(and(eq(vaultJsonFiles.tenantId, tenant.id), eq(vaultJsonFiles.module, 'documents')));

  console.log(`${prefix}${tenant.name} (${tenant.id}) — ${pointers.length} store(s)\n`);

  let inspected = 0;
  let stale = 0;
  let changed = 0;
  let failed = 0;

  for (const p of pointers) {
    const label = `${p.categoryModuleKey}/${p.categoryDocumentKey}${p.companyId ? ` [company ${p.companyId}]` : ''}`;
    const ctx = { tenant, tenantId: tenant.id, companyId: p.companyId } as VaultCtx;
    const key = { moduleKey: p.categoryModuleKey, documentKey: p.categoryDocumentKey };

    let records: Record<string, any>;
    try {
      records = (await readJsonStore(ctx, p.module as any, key)).store.records ?? {};
    } catch (error: any) {
      failed += 1;
      console.log(`  SKIP  ${label} — store unreadable: ${error?.message ?? error}`);
      continue;
    }

    const todo = Object.entries(records).filter(([, r]) => r && r.status !== 'deleted' && !r.searchTiers);
    inspected += Object.keys(records).length;
    stale += todo.length;
    console.log(`  ${label}: ${todo.length} of ${Object.keys(records).length} record(s) to index`);
    if (!apply) continue;

    for (const [id] of todo) {
      try {
        await upsertRecord(ctx, p.module as any, key, id, (prev: any) => {
          // Rebuilt from the copy the write holds, not the one read above, so a
          // record edited in between is indexed from its current fields.
          if (!prev || prev.searchTiers) return prev;
          const next = { ...prev, searchTiers: hashSearchTiers(prev.name, fieldsOf(prev)) };
          delete next.searchTokens;
          return next;
        });
        changed += 1;
      } catch (error: any) {
        failed += 1;
        console.log(`    FAILED ${id}: ${error?.message ?? error}`);
      }
    }
  }

  await auditOperatorDriveAccess({
    tenantId: tenant.id,
    scriptPath: process.argv[1],
    argv: args,
    inspected,
    changed,
  });

  console.log(`\n${prefix}${stale} record(s) need tiers; ${changed} re-indexed; ${failed} failure(s).`);
  if (!apply && stale > 0) console.log('re-run with --apply to write.');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => { console.error(error); process.exit(1); });
