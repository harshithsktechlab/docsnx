/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   ROLL THE DATABASE BACK TO THE PRE-BUSINESS SHAPE                       ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Run this BEFORE checking out and building the pre-business code, if the
 * business account ever has to be withdrawn:
 *
 *     npx tsx scripts/migrate_drive_scope_folders.ts --reverse
 *     node scripts/rollback_business_account.mjs
 *     git checkout e6490c5 && npm run build && sudo systemctl restart docsnx
 *
 * ── THE DRIVE STEP IS NOT OPTIONAL ─────────────────────────────────────────
 * This script rolls back the DATABASE only. Personal records now live under
 * `DocsNX_Data/Personal/`, and the old build resolves them at the ROOT with no
 * self-heal: pointed at the scoped layout it creates empty folders beside the
 * real ones and every personal vault reads as EMPTY. The ciphertext is intact
 * and the fix is to run the reverse migration, but a user watching their
 * documents vanish will not know that. Move the folders first.
 *
 * ── WHY A SCRIPT AND NOT A COMPATIBLE SCHEMA ───────────────────────────────
 * Almost all of migration 0050 is invisible to the old build: it ignores unknown
 * columns, and the defaults on `documents.company_id` / `account_scope` satisfy
 * the CHECK constraint on every insert it makes. ONE change is not invisible.
 *
 * The old `persistPointer` issues a bare four-column upsert:
 *
 *     ON CONFLICT (tenant_id, module, category_module_key, category_document_key)
 *
 * 0050 replaced that index with two PARTIAL ones, and Postgres will not infer a
 * partial index as an arbiter unless the statement carries a matching WHERE. So
 * the old build raises 42P10 on every record save — not a cosmetic regression,
 * a broken vault.
 *
 * It cannot be fixed by index design. The old build needs a non-partial UNIQUE
 * over those four columns; the business feature needs the company in that key,
 * because two companies legitimately hold a store for the same category. The two
 * are mutually exclusive, so the choice has to be made at rollback time — which
 * is what this script is.
 *
 * ── WHAT IT DOES NOT UNDO ──────────────────────────────────────────────────
 * The added tables and columns stay. Dropping them would destroy the business
 * data for no benefit — the old build cannot see them either way — and would
 * make rolling FORWARD again a restore-from-backup rather than a redeploy.
 */
import { config } from 'dotenv';

config({ path: '.env' + '.local' });
config();

import pg from 'pg';

const FORCE = process.argv.includes('--force');

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();

/** The index the pre-business `persistPointer` infers its arbiter from. */
const OLD_INDEX_SQL = `
  CREATE UNIQUE INDEX IF NOT EXISTS "vault_json_files_key_idx"
    ON "vault_json_files"
    ("tenant_id", "module", "category_module_key", "category_document_key")`;

try {
  const { rows: [counts] } = await client.query(`
    SELECT
      (SELECT count(*) FROM companies WHERE deleted_at IS NULL)          AS companies,
      (SELECT count(*) FROM documents WHERE company_id IS NOT NULL)      AS business_documents,
      (SELECT count(*) FROM vault_json_files WHERE company_id IS NOT NULL) AS business_stores`);

  const business =
    Number(counts.companies) + Number(counts.business_documents) + Number(counts.business_stores);

  if (business > 0 && !FORCE) {
    /**
     * Refused rather than assumed. Restoring the four-column unique index over
     * rows where two companies share a category would fail on a duplicate key
     * anyway — but the deeper problem is that the old build cannot reach those
     * records at all, so their Drive objects would be stranded: paid for, still
     * encrypted, and referenced by nothing the running app can see.
     */
    console.error(
      'REFUSING: this workspace holds business data.\n' +
      `  companies:          ${counts.companies}\n` +
      `  business documents: ${counts.business_documents}\n` +
      `  business stores:    ${counts.business_stores}\n\n` +
      'Rolling back strands their Drive objects — the old build cannot read or\n' +
      'delete them. Export or delete them first, or re-run with --force if you\n' +
      'have decided to abandon them.',
    );
    process.exitCode = 1;
  } else {
    if (business > 0) {
      console.warn(`--force: abandoning ${business} business row(s). Their Drive objects are left behind.`);
    }

    await client.query('BEGIN');

    // 1. The arbiter the old upsert needs. Business pointer rows would collide
    //    with it, so they go first — the Drive files they point at are not
    //    touched, which is what makes a roll-forward recoverable.
    await client.query('DELETE FROM vault_json_files WHERE company_id IS NOT NULL');
    await client.query('DROP INDEX IF EXISTS "vault_json_files_company_key_idx"');
    await client.query('DROP INDEX IF EXISTS "vault_json_files_key_idx"');
    await client.query(OLD_INDEX_SQL);

    // 2. The personal `business` module is NOT given back, and that is the one
    //    thing this script cannot undo. It used to re-activate the sixteen rows
    //    0050 retired, so the old build — which still has the module compiled in
    //    and renders the nav from `is_active` — would not come up looking broken.
    //    0055 DELETED those rows, so there is nothing to re-activate; bringing
    //    them back means re-running their INSERT from drizzle/0004 and 0023.
    //
    //    Deliberate, and cheap: the module never held a record, so the old build
    //    comes up with an empty module missing rather than an empty module
    //    present. Removing it was a product decision, and a rollback of the
    //    business ACCOUNT is not a reason to reverse it.

    // 3. Retire the business taxonomy. The old build does not know these
    //    modules, so leaving them active would show 84 categories it has no
    //    pages, permissions or field specs for.
    const { rowCount: retired } = await client.query(
      `UPDATE document_categories SET is_active = false, updated_at = now()
        WHERE module_key LIKE 'biz\\_%' AND is_active`);

    await client.query('COMMIT');

    console.log(
      'Rolled back to the pre-business schema shape.\n' +
      `  vault_json_files_key_idx: restored as a plain 4-column UNIQUE\n` +
      `  business module:          not restored — 0055 deleted its rows\n` +
      `  biz_* taxonomy:           ${retired} categories retired\n\n` +
      'Now: git checkout e6490c5 && npm run build && sudo systemctl restart docsnx',
    );
  }
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('Rollback FAILED, nothing was changed:', error);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
