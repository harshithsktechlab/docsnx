/**
 * READ-ONLY audit: is any field the dictionary marks `isPii` sitting in the
 * OPEN tier — i.e. readable in Postgres — instead of sealed?
 *
 * `splitRecordFields` seals only the keys the category's stored policy names, so
 * a record written under a category whose policy omits a key it carries lands
 * that value in the clear. Prints the offenders WITHOUT their values.
 *
 *   node scripts/check_open_tier_pii.mjs
 */
import { config } from 'dotenv';
import pg from 'pg';

config({ path: '.env' + '.local' });
config();

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const { rows } = await client.query(`
  SELECT d.id, d.title, d.category_module_key AS module_key,
         d.category_document_key AS document_key, d.created_at,
         entry.key AS open_key,
         f.encrypted_fields
    FROM documents d
    JOIN document_categories c
      ON c.module_key = d.category_module_key AND c.document_key = d.category_document_key
    LEFT JOIN document_category_fields f ON f.category_id = c.id
    CROSS JOIN LATERAL jsonb_each_text(coalesce(d.metadata->'open', '{}'::jsonb)) AS entry(key, value)
   WHERE d.deleted_at IS NULL
     -- A BLANK is not a leak. splitRecordFields deliberately leaves empty
     -- values out of the sealed tier — encrypting "absent" yields ciphertext
     -- that decrypts to nothing and hides the fact that nothing was captured —
     -- so a sealed key with no value legitimately appears here as ''.
     AND btrim(entry.value) <> ''
     AND entry.value <> 'null'
   ORDER BY d.created_at DESC
`);

// Which keys the dictionary considers sensitive is decided by the category's
// own encrypt list — the same list the splitter uses.
const offenders = rows.filter((r) => {
  const sealedKeys = (r.encrypted_fields || '').split(',').map((s) => s.trim());
  return sealedKeys.includes(r.open_key);
});

if (offenders.length === 0) {
  console.log('✅ no field named by its category policy is sitting in the open tier');
} else {
  console.log(`⚠️  ${offenders.length} open-tier value(s) that TODAY'S policy would seal:\n`);
  for (const o of offenders) {
    console.log(`  ${o.module_key}/${o.document_key}  key=${o.open_key}  "${o.title}"  (${o.created_at.toISOString().slice(0, 10)})`);
  }
  console.log('\nThese predate the policy that now covers them — the values were');
  console.log('written before the category sealed that key. Re-saving each record');
  console.log('re-splits it under the current policy.');
}

await client.end();
