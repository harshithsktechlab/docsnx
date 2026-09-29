import { db } from './db';
import { sql } from 'drizzle-orm';

/**
 * Tenant-scoped authorization for served upload files.
 *
 * Uploaded files are referenced by `file_path` on the record that owns them.
 * A caller may only fetch a file if a record IN THEIR OWN TENANT references it.
 * We check both the stored form (`/uploads/<name>`) and the route form
 * (`/api/uploads/<name>`).
 */
/**
 * Soft-deleted records must stop serving their file, so these are split by
 * whether the table has a `deleted_at` column to filter on.
 */
const FILE_TABLES_SOFT_DELETABLE = [
  'documents', 'medical_records', 'vehicles', 'lic_mediclaims',
  'tax_compliances', 'wills_estates', 'loans_debts',
  'utility_bills', 'corporate_compliances', 'employment_payrolls',
];

const FILE_TABLES_NO_SOFT_DELETE = ['warranty_amcs', 'contract_agreements'];

export async function tenantOwnsUploadedFile(tenantId: string, filename: string): Promise<boolean> {
  if (!tenantId || !filename) return false;
  const legacy = `/uploads/${filename}`;
  const routed = `/api/uploads/${filename}`;
  // Table names are hardcoded constants (not user input) — safe to inline.
  const union = [
    ...FILE_TABLES_SOFT_DELETABLE.map(
      (t) => `SELECT tenant_id, file_path FROM ${t} WHERE deleted_at IS NULL`
    ),
    ...FILE_TABLES_NO_SOFT_DELETE.map((t) => `SELECT tenant_id, file_path FROM ${t}`),
  ].join(' UNION ALL ');
  const result: any = await db.execute(
    sql`SELECT 1 AS ok FROM (${sql.raw(union)}) AS f
        WHERE f.tenant_id = ${tenantId}::uuid AND f.file_path IN (${legacy}, ${routed})
        LIMIT 1`
  );
  const rows = Array.isArray(result) ? result : (result?.rows ?? []);
  return rows.length > 0;
}
