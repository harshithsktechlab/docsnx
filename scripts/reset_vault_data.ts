/**
 * Clear the vault pointers left dangling by a migration that re-keyed a
 * category — most recently drizzle/0023_master_taxonomy_realignment.sql.
 *
 *   npx tsx scripts/reset_vault_data.ts          # dry run — prints, changes nothing
 *   npx tsx scripts/reset_vault_data.ts --yes    # actually does it
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * The category pair is bound into every vault object's AES-GCM associated data
 * (see serializeAad in src/lib/tenantCrypto.ts) and names its Drive folder, so
 * a migration that changes either half leaves ciphertext nothing can open. It
 * has happened three times, each deliberately:
 *
 *   0012  `identity.pan_card`      → the pair `identity` + `pan_card`
 *   0015  `identity/pan_card`      → `documents/pan_card`   (app module names)
 *   0023  `documents/pan_card`     → `identity/pan_card`    (master doc table)
 *
 * The rows still point at those Drive files; this clears the pointers so the
 * app reports "no stored file yet" instead of failing to decrypt.
 *
 * RUN IT IMMEDIATELY AFTER any such migration, and re-upload the affected
 * files.
 *
 * ── WHY IT IS NOT IN THE MIGRATION ─────────────────────────────────────────
 * `drizzle-kit migrate` runs unattended in production. A forward migration that
 * deletes a tenant's document pointers is not something that should ever run
 * without someone typing the command.
 *
 * ⚠ DESTRUCTIVE AND IRREVERSIBLE. The Drive files themselves are left alone —
 * they are unreadable either way, and deleting a user's Drive content from a
 * script is worse than leaving it for them to remove. Re-upload the affected
 * documents afterwards.
 */
// MUST come first — src/lib/db builds its pool at import time. See loadEnv.ts.
import './loadEnv';

import { isNotNull, sql } from 'drizzle-orm';
import { db } from '../src/lib/db';
import { documents, passwords, vaultJsonFiles } from '../src/db/schema';

const CLEARED_FILE_COLUMNS = {
  fileDriveId: null,
  jsonDriveId: null,
  keyVersion: null,
  contentHash: null,
  encryptedSize: null,
};

async function main() {
  const confirmed = process.argv.includes('--yes');

  const [{ count: storeCount }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(vaultJsonFiles);
  const [{ count: docCount }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(documents)
    .where(isNotNull(documents.fileDriveId));
  const [{ count: passwordCount }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(passwords)
    .where(isNotNull(passwords.jsonDriveId));

  console.log('About to clear vault pointers made unreadable by migration 0012:');
  console.log(`  vault_json_files rows deleted ......... ${storeCount}`);
  console.log(`  documents rows with vault columns ..... ${docCount}`);
  console.log(`  passwords rows with vault columns ..... ${passwordCount}`);
  console.log('');
  console.log('The document/password ROWS survive — only their Drive pointers are cleared.');
  console.log('The encrypted files on the tenants\' Drives are left in place, unreadable.');

  if (!confirmed) {
    console.log('');
    console.log('Dry run. Re-run with --yes to apply.');
    process.exit(0);
  }

  await db.transaction(async (tx) => {
    await tx.delete(vaultJsonFiles);

    await tx.update(documents)
      .set({ ...CLEARED_FILE_COLUMNS, updatedAt: new Date() })
      .where(isNotNull(documents.fileDriveId));

    await tx.update(passwords)
      // No fileDriveId/contentHash/encryptedSize on passwords — a credential
      // has a record but no bytes.
      .set({ jsonDriveId: null, keyVersion: null, updatedAt: new Date() })
      .where(isNotNull(passwords.jsonDriveId));
  });

  console.log('');
  console.log('✅ Vault pointers cleared. Re-upload the affected documents through the UI.');
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ Failed to reset vault data:', err);
  process.exit(1);
});
