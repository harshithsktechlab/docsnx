/**
 * READ-ONLY: what does the AI category-analysis cache hold, per workspace?
 *
 * Splits `ai_analysis_cache` into household (company_id IS NULL) and company
 * rows, and counts the rows whose cached answer is a FAILURE — the
 * "Analysis failed due to an error." placeholder `generateCategoryAnalysis`
 * returns instead of throwing. No row contents are printed.
 *
 *   node scripts/check_analysis_cache.mjs
 */
import { config } from 'dotenv';
import pg from 'pg';

config({ path: '.env' + '.local' });
config();

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
await client.connect();
try {
  const { rows: cols } = await client.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'ai_analysis_cache' ORDER BY ordinal_position`,
  );
  console.log('columns:', cols.map((c) => c.column_name).join(', '));

  const { rows } = await client.query(
    `SELECT CASE WHEN company_id IS NULL THEN 'personal' ELSE 'company' END AS workspace,
            category,
            count(*)::int AS rows,
            count(*) FILTER (WHERE analysis_data ? 'error')::int AS failed,
            max(updated_at) AS latest
       FROM ai_analysis_cache
      GROUP BY 1, 2
      ORDER BY 1, 2`,
  );
  console.table(rows);

  const { rows: errs } = await client.query(
    `SELECT CASE WHEN company_id IS NULL THEN 'personal' ELSE 'company' END AS workspace,
            analysis_data->>'error' AS error, count(*)::int AS n
       FROM ai_analysis_cache
      WHERE analysis_data ? 'error'
      GROUP BY 1, 2`,
  );
  console.table(errs);
} finally {
  await client.end();
}
