/**
 * READ-ONLY post-check for migration 0025 + the field-spec seed.
 *
 * Answers the three questions that decide whether the sub-category add form
 * will work and whether it will leak:
 *
 *   1. does every ACTIVE category have a non-empty form spec?
 *   2. does every policy row seal `custom_fields`?
 *   3. does a spot-checked category carry the labels, types and validation the
 *      form expects — and is the sealed/open split still what the dictionary says?
 *
 *   node scripts/verify_category_field_spec.mjs
 */
import { config } from 'dotenv';
import pg from 'pg';

config({ path: '.env' + '.local' });
config();

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const { rows: [totals] } = await client.query(`
  SELECT
    count(*) FILTER (WHERE c.is_active)                                  AS active,
    count(*) FILTER (WHERE c.is_active AND f.fields IS NULL)             AS active_without_spec,
    count(*) FILTER (WHERE c.is_active AND jsonb_array_length(coalesce(f.fields, '[]'::jsonb)) = 0)
                                                                         AS active_empty_spec,
    count(*) FILTER (WHERE 'custom_fields' <> ALL (SELECT btrim(k)
      FROM unnest(string_to_array(coalesce(f.encrypted_fields, ''), ',')) AS k))
                                                                         AS unsealed_custom_fields
  FROM document_categories c
  LEFT JOIN document_category_fields f ON f.category_id = c.id
`);
console.log('totals:', totals);

const { rows: sample } = await client.query(`
  SELECT c.module_key, c.document_key,
         jsonb_array_length(f.fields) AS field_count,
         f.encrypted_fields
    FROM document_categories c
    JOIN document_category_fields f ON f.category_id = c.id
   WHERE (c.module_key, c.document_key) IN (
           ('identity', 'pan_card'),
           ('vehicle', 'registration_certificate'),
           ('warranty_amc', 'appliance_warranties'))
   ORDER BY c.module_key
`);
for (const row of sample) {
  console.log(`\n${row.module_key}/${row.document_key} — ${row.field_count} fields`);
  console.log(`  sealed: ${row.encrypted_fields}`);
}

const { rows: pan } = await client.query(`
  SELECT jsonb_array_elements(f.fields) AS spec
    FROM document_categories c
    JOIN document_category_fields f ON f.category_id = c.id
   WHERE c.module_key = 'identity' AND c.document_key = 'pan_card'
`);
console.log('\nidentity/pan_card spec:');
for (const { spec } of pan) {
  const rule = spec.validation
    ? ` [${spec.validation.pattern ?? spec.validation.notFuture ? 'rule' : ''}${spec.validation.message ? ': ' + spec.validation.message : ''}]`
    : '';
  console.log(
    `  ${String(spec.sortOrder).padStart(3)} ${spec.fieldKey} (${spec.dataType})` +
    `${spec.isPii ? ' 🔒' : ''}${spec.isRequired ? ' *' : ''}${rule}`,
  );
}

await client.end();
