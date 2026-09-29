/**
 * READ-ONLY: print one category's stored form spec exactly as the add form will
 * render it — order, labels, types, required markers, sealing, validation.
 *
 *   node scripts/print_category_form.mjs rentals_subscriptions rental_agreements
 */
import { config } from 'dotenv';
import pg from 'pg';

config({ path: '.env' + '.local' });
config();

const [moduleKey, documentKey] = process.argv.slice(2);
if (!moduleKey || !documentKey) {
  console.error('usage: node scripts/print_category_form.mjs <moduleKey> <documentKey>');
  process.exit(1);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const { rows } = await client.query(
  `SELECT jsonb_array_elements(f.fields) AS spec
     FROM document_categories c
     JOIN document_category_fields f ON f.category_id = c.id
    WHERE c.module_key = $1 AND c.document_key = $2`,
  [moduleKey, documentKey],
);

if (rows.length === 0) {
  console.log(`no stored spec for ${moduleKey}/${documentKey}`);
} else {
  console.log(`${moduleKey}/${documentKey} — ${rows.length} fields\n`);
  for (const { spec } of rows) {
    const marks = [
      spec.isRequired ? 'REQUIRED' : '',
      spec.isPii ? 'sealed' : '',
      spec.validation?.pattern || spec.validation?.notFuture || spec.validation?.afterField ? 'rule' : '',
    ].filter(Boolean).join(' ');
    console.log(
      `  ${String(spec.sortOrder).padStart(4)}  ${spec.fieldLabel.padEnd(24)}` +
      `${spec.dataType.padEnd(10)}${marks}`,
    );
  }
}

await client.end();
