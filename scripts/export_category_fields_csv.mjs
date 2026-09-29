/**
 * READ-ONLY: export every document_category_fields row, with every column, to
 * CSV — prefixed with the category/sub-category it belongs to so a reader can
 * tell the rows apart. `fields` (jsonb) is written as its JSON text.
 *
 *   node scripts/export_category_fields_csv.mjs demo-documents/document_category_fields.csv
 */
import { writeFileSync } from 'node:fs';
import { config } from 'dotenv';
import pg from 'pg';

config({ path: '.env' + '.local' });
config();

const out = process.argv[2];
if (!out) {
  console.error('usage: node scripts/export_category_fields_csv.mjs <out.csv>');
  process.exit(1);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const { rows, fields } = await client.query(
  `SELECT CASE WHEN c.module_key LIKE 'biz\\_%' THEN 'Business' ELSE 'Personal' END AS account_type,
          c.module_no, c.module_name, c.module_key, c.document_name, c.document_key, c.is_active AS category_is_active,
          f.*
     FROM document_category_fields f
     JOIN document_categories c ON c.id = f.category_id
    ORDER BY c.sort_order`,
);

const cell = (v) => {
  if (v === null || v === undefined) return '';
  const s = v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const header = fields.map((f) => f.name);
const lines = [header.join(','), ...rows.map((r) => header.map((h) => cell(r[h])).join(','))];
writeFileSync(out, '﻿' + lines.join('\r\n') + '\r\n');
console.log(`${rows.length} rows, ${header.length} columns -> ${out}`);
console.log(header.join(', '));

await client.end();
