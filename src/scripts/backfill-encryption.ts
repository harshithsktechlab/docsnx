/**
 * One-time, idempotent backfill for encryption-at-rest (see drizzle/0006).
 *
 * Run AFTER applying 0006_field_encryption.sql. For every affected row it:
 *   - encrypts plaintext identifier/credential columns (skips already-ciphertext),
 *   - populates the deterministic *_hash blind-index columns,
 *   - strips any stored CVV from credit-card blobs,
 *   - encrypts profiles.legalDetails.{pan,aadhaar,passport}.
 *
 * The `documents.metadata.documentNumber` step this used to do is gone with the
 * column (drizzle/0026): a document's identifier now lives sealed in the
 * tenant's Drive store, and there is nothing in Postgres left to encrypt.
 *
 * Idempotent: re-running is safe (isCiphertext guards every field). Reads keep
 * working between migration and backfill because decrypt() passes plaintext through.
 *
 * Usage:  npx tsx src/scripts/backfill-encryption.ts
 * (ENCRYPTION_SECRET and, optionally, BLIND_INDEX_KEY must be set in the env.)
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
config();

import { Pool } from 'pg';
import { encryptField, blindIndex, isCiphertext } from '../lib/fieldCrypto';
import { decrypt } from '../lib/encryption';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// table -> [ [encryptedColumn, hashColumnOrNull], ... ]
const SIMPLE: Record<string, Array<[string, string | null]>> = {
  bank_infos: [['account_number', 'account_number_hash'], ['customer_id', null], ['net_banking_username', null]],
  trading_demats: [['client_id', 'client_id_hash'], ['demat_account_number', 'demat_account_number_hash'], ['login_username', null]],
  lic_mediclaims: [['policy_number', 'policy_number_hash']],
  loans_debts: [['account_number', 'account_number_hash']],
  utility_bills: [['consumer_number', 'consumer_number_hash']],
  tax_compliances: [['acknowledgement_number', null]],
  corporate_compliances: [['registration_number', null]],
  contract_agreements: [['account_number', null]],
  tenants: [['api_key', null]],
  api_keys: [['api_key', null]],
};

let totalUpdated = 0;

async function backfillSimple(client: any) {
  for (const [table, cols] of Object.entries(SIMPLE)) {
    const colNames = cols.map(([c]) => c);
    const { rows } = await client.query(`SELECT id, ${colNames.join(', ')} FROM ${table}`);
    let updated = 0;
    for (const row of rows) {
      const sets: string[] = [];
      const vals: any[] = [];
      let i = 1;
      for (const [col, hashCol] of cols) {
        const val = row[col];
        if (val === null || val === undefined || val === '') continue;
        if (isCiphertext(val)) continue; // already migrated
        sets.push(`${col} = $${i++}`);
        vals.push(encryptField(val));
        if (hashCol) {
          sets.push(`${hashCol} = $${i++}`);
          vals.push(blindIndex(val));
        }
      }
      if (sets.length === 0) continue;
      vals.push(row.id);
      await client.query(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = $${i}`, vals);
      updated++;
    }
    if (updated) console.log(`  ${table}: encrypted ${updated} row(s)`);
    totalUpdated += updated;
  }
}

async function backfillCreditCards(client: any) {
  const { rows } = await client.query(`SELECT id, card_details_encrypted FROM credit_cards`);
  let updated = 0;
  for (const row of rows) {
    if (!row.card_details_encrypted) continue;
    let details: any;
    try {
      details = JSON.parse(decrypt(row.card_details_encrypted));
    } catch {
      continue;
    }
    if (details && Object.prototype.hasOwnProperty.call(details, 'cardCvv')) {
      delete details.cardCvv; // PCI: never store CVV
      const reEncrypted = encryptField(JSON.stringify(details));
      await client.query(`UPDATE credit_cards SET card_details_encrypted = $1 WHERE id = $2`, [reEncrypted, row.id]);
      updated++;
    }
  }
  if (updated) console.log(`  credit_cards: stripped CVV from ${updated} blob(s)`);
  totalUpdated += updated;
}

async function backfillProfiles(client: any) {
  const LEGAL = ['panNumber', 'aadhaarNumber', 'passportNumber'];
  const { rows } = await client.query(`SELECT id, legal_details FROM profiles WHERE legal_details IS NOT NULL`);
  let updated = 0;
  for (const row of rows) {
    const legal = row.legal_details;
    if (!legal || typeof legal !== 'object') continue;
    let changed = false;
    const next: any = { ...legal };
    for (const k of LEGAL) {
      if (next[k] && !isCiphertext(next[k])) {
        next[k] = encryptField(next[k]);
        changed = true;
      }
    }
    if (!changed) continue;
    await client.query(`UPDATE profiles SET legal_details = $1 WHERE id = $2`, [next, row.id]);
    updated++;
  }
  if (updated) console.log(`  profiles: encrypted legal IDs in ${updated} row(s)`);
  totalUpdated += updated;
}

async function main() {
  const client = await pool.connect();
  try {
    console.log('Starting encryption backfill (idempotent)...');
    await client.query('BEGIN');
    await backfillSimple(client);
    await backfillCreditCards(client);
    await backfillProfiles(client);
    await client.query('COMMIT');
    console.log(`Done. Rows updated: ${totalUpdated}.`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Backfill failed, rolled back:', err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
