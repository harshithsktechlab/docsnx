/**
 * Queries behind the super admin AI Usage & Cost page (/admin/ai-usage).
 *
 * Every number comes from `tenant_ai_usages`, one row per AI call:
 *   credits      — what the tenant was charged (credits_charged)
 *   gemini ₹     — what Google charged us, in INR (cost_inr)
 *   final ₹      — our full cost: gemini ₹ × the multiplier in force (final_cost_inr)
 *   $            — the same Gemini cost in USD (cost)
 *
 * ── CROSS-TENANT, ON PURPOSE ──────────────────────────────────────────────
 * Like every route under /api/admin, these read across tenants with plain `db`
 * and no `withTenant`. That works because the app's database role bypasses RLS
 * (see api/admin/tenants/[id]/overview/route.ts). A role that did not would see
 * zero rows here, not an error — if every figure on the page drops to 0 after a
 * DB role change, that is why.
 *
 * ── RAW SQL, WHITELISTED IDENTIFIERS ──────────────────────────────────────
 * Grouping, joins and the per-document batch share are far clearer in SQL than
 * in the query builder. Every VALUE is a bound parameter; the only raw text is
 * chosen from the fixed maps in this file (dimension, sort column, direction),
 * never from the request.
 *
 * ── OLD ROWS ──────────────────────────────────────────────────────────────
 * Rows written before 0075 have no task, member, credits or INR; before 0076
 * no document, batch or final cost. They are counted in calls / tokens / $ and
 * show up as "Before tracking". `cost_multiplier IS NOT NULL` marks a row
 * written after 0076, which is the only era in which "not saved" means
 * anything — earlier rows could never be linked.
 */
import { sql, type SQL } from 'drizzle-orm';
import { db } from './db';

// ─── Filters ──────────────────────────────────────────────────────────────

export interface AiUsageFilters {
  /** Inclusive IST calendar days, YYYY-MM-DD. */
  from?: string | null;
  to?: string | null;
  tenantId?: string | null;
  userId?: string | null;
  /** A company id, or 'household' for the personal workspace (NULL). */
  companyId?: string | null;
  /** An action code, or 'NONE' for rows from before tracking. */
  action?: string | null;
  model?: string | null;
  keySource?: string | null;
  /** 'saved' — linked to a record; 'not_saved' — a read whose result was never saved. */
  linked?: string | null;
  batchId?: string | null;
  documentId?: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const uuidOr = (v: unknown) => (typeof v === 'string' && UUID_RE.test(v) ? v : null);
const dayOr = (v: unknown) => (typeof v === 'string' && DAY_RE.test(v) && !Number.isNaN(Date.parse(v)) ? v : null);
const shortOr = (v: unknown, max = 100) => (typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : null);

/** Reads the filter set off a URL's query string, dropping anything malformed. */
export function readFilters(params: URLSearchParams): AiUsageFilters {
  const company = params.get('companyId');
  return {
    from: dayOr(params.get('from')),
    to: dayOr(params.get('to')),
    tenantId: uuidOr(params.get('tenantId')),
    userId: uuidOr(params.get('userId')),
    companyId: company === 'household' ? 'household' : uuidOr(company),
    action: shortOr(params.get('action'), 64),
    model: shortOr(params.get('model')),
    keySource: shortOr(params.get('keySource'), 16),
    linked: params.get('linked') === 'saved' || params.get('linked') === 'not_saved' ? params.get('linked') : null,
    batchId: uuidOr(params.get('batchId')),
    documentId: uuidOr(params.get('documentId')),
  };
}

/** Calls whose result was meant to become a record — the only ones that can be "not saved". */
const LINKABLE_ACTIONS = sql`('FIELD_READ', 'DOC_CLASSIFY')`;
const IS_LINKED = sql`(u.document_id IS NOT NULL OR u.todo_id IS NOT NULL OR u.contact_id IS NOT NULL)`;
const IS_NOT_SAVED = sql`(u.cost_multiplier IS NOT NULL AND u.action IN ${LINKABLE_ACTIONS} AND NOT ${IS_LINKED})`;

/** WHERE clause over alias `u` (tenant_ai_usages). Always returns a valid condition. */
export function whereFor(f: AiUsageFilters): SQL {
  const parts: SQL[] = [sql`TRUE`];
  // IST days: midnight in Asia/Kolkata, converted to an instant.
  if (f.from) parts.push(sql`u.created_at >= (${f.from}::date)::timestamp AT TIME ZONE 'Asia/Kolkata'`);
  if (f.to) parts.push(sql`u.created_at < ((${f.to}::date + 1))::timestamp AT TIME ZONE 'Asia/Kolkata'`);
  if (f.tenantId) parts.push(sql`u.tenant_id = ${f.tenantId}::uuid`);
  if (f.userId) parts.push(sql`u.user_id = ${f.userId}::uuid`);
  if (f.companyId === 'household') parts.push(sql`u.company_id IS NULL`);
  else if (f.companyId) parts.push(sql`u.company_id = ${f.companyId}::uuid`);
  if (f.action === 'NONE') parts.push(sql`u.action IS NULL`);
  else if (f.action) parts.push(sql`u.action = ${f.action}`);
  if (f.model) parts.push(sql`u.model_name = ${f.model}`);
  if (f.keySource) parts.push(sql`u.key_source = ${f.keySource}`);
  if (f.linked === 'saved') parts.push(IS_LINKED);
  if (f.linked === 'not_saved') parts.push(IS_NOT_SAVED);
  if (f.batchId) parts.push(sql`u.batch_id = ${f.batchId}::uuid`);
  if (f.documentId) parts.push(sql`u.document_id = ${f.documentId}::uuid`);
  return sql.join(parts, sql` AND `);
}

// ─── Measures ─────────────────────────────────────────────────────────────

/** The same figures on every row of every view. */
const MEASURES = sql`
  COUNT(*)::int AS calls,
  COALESCE(SUM(u.credits_charged), 0)::int AS credits,
  COALESCE(SUM(u.prompt_tokens), 0)::bigint AS input_tokens,
  COALESCE(SUM(u.completion_tokens), 0)::bigint AS output_tokens,
  COALESCE(SUM(u.thinking_tokens), 0)::bigint AS thinking_tokens,
  COALESCE(SUM(u.cost), 0)::float8 AS cost_usd,
  COALESCE(SUM(u.cost_inr), 0)::float8 AS cost_inr,
  COALESCE(SUM(u.final_cost_inr), 0)::float8 AS final_cost_inr,
  MAX(u.created_at) AS last_at`;

export interface Measures {
  calls: number;
  credits: number;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  costUsd: number;
  costInr: number;
  finalCostInr: number;
  lastAt: string | null;
}

function rowsOf(result: any): any[] {
  return Array.isArray(result) ? result : (result?.rows ?? []);
}

/**
 * Postgres timestamptz text ("2026-10-19 05:18:10.350002+00") → ISO 8601.
 * The driver returns timestamps as strings, and that spelling is not one every
 * browser's Date parser accepts (Safari rejects it).
 */
function isoTimestamp(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (typeof v !== 'string') return v;
  const d = new Date(v.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'));
  return Number.isNaN(d.getTime()) ? v : d.toISOString();
}

/** snake_case SQL row → camelCase, with bigint/numeric strings made numbers. */
function camel(row: any): any {
  const out: any = {};
  for (const [k, v] of Object.entries(row)) {
    const key = k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    if (/At$/.test(key)) { out[key] = isoTimestamp(v); continue; }
    out[key] = typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) && /(tokens|calls|credits|cost|count|share|total|n)$/i.test(key)
      ? Number(v)
      : v;
  }
  return out;
}

async function query(q: SQL): Promise<any[]> {
  return rowsOf(await db.execute(q)).map(camel);
}

// ─── Summary ──────────────────────────────────────────────────────────────

export async function usageSummary(f: AiUsageFilters) {
  const where = whereFor(f);
  const [totals] = await query(sql`SELECT ${MEASURES} FROM tenant_ai_usages u WHERE ${where}`);
  const [notSaved] = await query(sql`SELECT ${MEASURES} FROM tenant_ai_usages u WHERE ${where} AND ${IS_NOT_SAVED}`);
  const [unpriced] = await query(sql`
    SELECT COUNT(*)::int AS calls FROM tenant_ai_usages u WHERE ${where} AND u.cost_inr IS NULL`);
  const trend = await query(sql`
    SELECT to_char((u.created_at AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') AS day, ${MEASURES}
    FROM tenant_ai_usages u WHERE ${where}
    GROUP BY 1 ORDER BY 1`);
  const byTask = await query(sql`
    SELECT u.action, ${MEASURES} FROM tenant_ai_usages u WHERE ${where}
    GROUP BY u.action ORDER BY final_cost_inr DESC, calls DESC`);
  return {
    totals,
    notSaved,
    /** Calls with no INR figure (before 0075, or no rate configured) — the ₹ totals exclude them. */
    unpricedCalls: unpriced?.calls ?? 0,
    trend,
    byTask,
  };
}

// ─── Breakdowns ───────────────────────────────────────────────────────────

export const DIMENSIONS = ['task', 'tenant', 'member', 'workspace', 'category', 'document', 'batch', 'model'] as const;
export type Dimension = (typeof DIMENSIONS)[number];

/** Sortable columns, by the alias every view exposes. */
const SORTS: Record<string, string> = {
  calls: 'calls', credits: 'credits', inputTokens: 'input_tokens', outputTokens: 'output_tokens',
  thinkingTokens: 'thinking_tokens', costUsd: 'cost_usd', costInr: 'cost_inr', finalCostInr: 'final_cost_inr',
  lastAt: 'last_at', totalFinalCostInr: 'total_final_cost_inr', name: 'label',
};

/**
 * The grouped SELECT for one dimension. Each yields `label` (what the row is
 * called) plus ids for drill-down, plus MEASURES.
 */
function groupedSql(dim: Dimension, where: SQL): SQL {
  switch (dim) {
    case 'task':
      return sql`
        SELECT u.action AS key, COALESCE(u.action, 'NONE') AS label, ${MEASURES}
        FROM tenant_ai_usages u WHERE ${where} GROUP BY u.action`;
    case 'tenant':
      return sql`
        SELECT u.tenant_id AS key, u.tenant_id AS tenant_id, MAX(t.name) AS label, ${MEASURES},
               COUNT(DISTINCT u.user_id)::int AS member_count, COUNT(DISTINCT u.document_id)::int AS document_count
        FROM tenant_ai_usages u LEFT JOIN tenants t ON t.id = u.tenant_id
        WHERE ${where} GROUP BY u.tenant_id`;
    case 'member':
      return sql`
        SELECT COALESCE(u.user_id::text, 'none:' || u.tenant_id::text) AS key, u.user_id AS user_id,
               u.tenant_id AS tenant_id, MAX(us.name) AS label, MAX(us.email) AS email,
               MAX(us.phone_number) AS phone, MAX(t.name) AS tenant_name, ${MEASURES},
               COUNT(DISTINCT u.document_id)::int AS document_count
        FROM tenant_ai_usages u
        LEFT JOIN users us ON us.id = u.user_id
        LEFT JOIN tenants t ON t.id = u.tenant_id
        WHERE ${where} GROUP BY u.user_id, u.tenant_id`;
    case 'workspace':
      return sql`
        SELECT u.tenant_id::text || ':' || COALESCE(u.company_id::text, 'household') AS key,
               u.tenant_id AS tenant_id, u.company_id AS company_id,
               COALESCE(MAX(c.name), 'Household') AS label, MAX(t.name) AS tenant_name, ${MEASURES}
        FROM tenant_ai_usages u
        LEFT JOIN companies c ON c.id = u.company_id
        LEFT JOIN tenants t ON t.id = u.tenant_id
        WHERE ${where} GROUP BY u.tenant_id, u.company_id`;
    case 'category':
      return sql`
        SELECT COALESCE(u.module_key, '') || '/' || COALESCE(u.document_key, '') AS key,
               u.module_key, u.document_key,
               MAX(dc.module_name) AS module_name, MAX(dc.document_name) AS document_name,
               COALESCE(MAX(dc.document_name), u.document_key, u.module_key, 'Unknown') AS label, ${MEASURES},
               COUNT(DISTINCT u.document_id)::int AS document_count
        FROM tenant_ai_usages u
        LEFT JOIN document_categories dc ON dc.module_key = u.module_key AND dc.document_key = u.document_key
        WHERE ${where} GROUP BY u.module_key, u.document_key`;
    case 'model':
      return sql`
        SELECT u.model_name || '|' || COALESCE(u.key_source, '') AS key, u.model_name AS label,
               u.key_source, ${MEASURES}
        FROM tenant_ai_usages u WHERE ${where} GROUP BY u.model_name, u.key_source`;
    case 'batch':
      return sql`
        SELECT u.batch_id AS key, u.batch_id, MIN(u.created_at) AS started_at,
               MAX(u.tenant_id::text)::uuid AS tenant_id, MAX(t.name) AS tenant_name,
               MAX(us.name) AS label,
               MAX(u.file_count) FILTER (WHERE u.action = 'BULK_SCAN')::int AS file_count,
               MAX(u.page_count) FILTER (WHERE u.action = 'BULK_SCAN')::int AS page_count,
               COUNT(*) FILTER (WHERE u.action = 'FIELD_READ')::int AS records_read,
               (COUNT(DISTINCT u.document_id) + COUNT(DISTINCT u.todo_id) + COUNT(DISTINCT u.contact_id))::int AS records_saved,
               ${MEASURES}
        FROM tenant_ai_usages u
        LEFT JOIN tenants t ON t.id = u.tenant_id
        LEFT JOIN users us ON us.id = u.user_id
        WHERE ${where} AND u.batch_id IS NOT NULL GROUP BY u.batch_id`;
    case 'document':
      /**
       * A document's own calls (its field read, its classify) plus its SHARE of
       * the one Power Scan call that grouped its batch: that call's cost ÷ the
       * documents saved from the batch. The share is computed here, never
       * stored, so it stays right as more of a batch is saved.
       */
      return sql`
        WITH f AS (SELECT * FROM tenant_ai_usages u WHERE ${where}),
        scan AS (
          SELECT u.batch_id,
                 SUM(u.cost)::float8 AS usd, SUM(u.cost_inr)::float8 AS inr,
                 SUM(u.final_cost_inr)::float8 AS final_inr, SUM(u.credits_charged)::float8 AS credits
          FROM f u WHERE u.action = 'BULK_SCAN' AND u.batch_id IS NOT NULL GROUP BY u.batch_id
        ),
        saved AS (
          SELECT batch_id, COUNT(DISTINCT document_id)::int AS n
          FROM tenant_ai_usages WHERE batch_id IS NOT NULL AND document_id IS NOT NULL GROUP BY batch_id
        ),
        doc AS (
          SELECT u.document_id, (MAX(u.batch_id::text))::uuid AS batch_id, ${MEASURES}
          FROM f u WHERE u.document_id IS NOT NULL GROUP BY u.document_id
        )
        SELECT doc.document_id AS key, doc.document_id, doc.batch_id,
               COALESCE(d.title, '(deleted document)') AS label,
               d.deleted_at IS NOT NULL OR d.id IS NULL AS deleted,
               d.category_module_key AS module_key, d.category_document_key AS document_key,
               dc.module_name, dc.document_name, d.page_count, d.file_name,
               d.tenant_id, t.name AS tenant_name, us.name AS member_name,
               doc.calls, doc.credits, doc.input_tokens, doc.output_tokens, doc.thinking_tokens,
               doc.cost_usd, doc.cost_inr, doc.final_cost_inr, doc.last_at,
               COALESCE(scan.credits / NULLIF(saved.n, 0), 0)::float8 AS share_credits,
               COALESCE(scan.inr / NULLIF(saved.n, 0), 0)::float8 AS share_cost_inr,
               COALESCE(scan.final_inr / NULLIF(saved.n, 0), 0)::float8 AS share_final_cost_inr,
               (doc.final_cost_inr + COALESCE(scan.final_inr / NULLIF(saved.n, 0), 0))::float8 AS total_final_cost_inr,
               (doc.cost_inr + COALESCE(scan.inr / NULLIF(saved.n, 0), 0))::float8 AS total_cost_inr,
               (doc.credits + COALESCE(scan.credits / NULLIF(saved.n, 0), 0))::float8 AS total_credits
        FROM doc
        LEFT JOIN scan ON scan.batch_id = doc.batch_id
        LEFT JOIN saved ON saved.batch_id = doc.batch_id
        LEFT JOIN documents d ON d.id = doc.document_id
        LEFT JOIN document_categories dc ON dc.module_key = d.category_module_key AND dc.document_key = d.category_document_key
        LEFT JOIN tenants t ON t.id = d.tenant_id
        LEFT JOIN users us ON us.id = d.user_id`;
  }
}

export interface PageOptions {
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: string;
}

export async function usageBreakdown(dim: Dimension, f: AiUsageFilters, opts: PageOptions = {}) {
  const limit = Math.min(Math.max(1, Math.floor(opts.limit || 25)), 50_000);
  const page = Math.max(1, Math.floor(opts.page || 1));
  const defaultSort = dim === 'document' ? 'total_final_cost_inr' : 'final_cost_inr';
  const sortCol = SORTS[opts.sortBy || ''] && (opts.sortBy !== 'totalFinalCostInr' || dim === 'document')
    ? SORTS[opts.sortBy as string]
    : defaultSort;
  const dir = opts.sortOrder === 'asc' ? 'ASC' : 'DESC';

  const rows = await query(sql`
    SELECT q.*, COUNT(*) OVER ()::int AS total_count
    FROM (${groupedSql(dim, whereFor(f))}) q
    ORDER BY ${sql.raw(sortCol)} ${sql.raw(dir)} NULLS LAST, q.calls DESC
    LIMIT ${limit} OFFSET ${(page - 1) * limit}`);

  const totalCount = rows[0]?.totalCount ?? 0;
  return {
    rows: rows.map(({ totalCount: _t, ...r }) => r),
    pagination: { page, limit, totalCount, totalPages: Math.max(1, Math.ceil(totalCount / limit)) },
  };
}

// ─── Call log ─────────────────────────────────────────────────────────────

export async function usageLog(f: AiUsageFilters, opts: PageOptions = {}) {
  const limit = Math.min(Math.max(1, Math.floor(opts.limit || 25)), 50_000);
  const page = Math.max(1, Math.floor(opts.page || 1));
  const LOG_SORTS: Record<string, string> = {
    createdAt: 'u.created_at', credits: 'u.credits_charged', finalCostInr: 'u.final_cost_inr',
    costInr: 'u.cost_inr', inputTokens: 'u.prompt_tokens',
  };
  const sortCol = LOG_SORTS[opts.sortBy || ''] ?? 'u.created_at';
  const dir = opts.sortOrder === 'asc' ? 'ASC' : 'DESC';
  const where = whereFor(f);

  const rows = await query(sql`
    SELECT u.id, u.created_at, u.action, u.model_name, u.key_source,
           u.prompt_tokens AS input_tokens, u.completion_tokens AS output_tokens,
           u.thinking_tokens, u.cached_tokens, u.credits_charged AS credits,
           u.cost::float8 AS cost_usd, u.cost_inr::float8 AS cost_inr,
           u.final_cost_inr::float8 AS final_cost_inr, u.usd_inr_rate::float8 AS usd_inr_rate,
           u.cost_multiplier::float8 AS cost_multiplier,
           u.batch_id, u.file_count, u.page_count, u.module_key, u.document_key,
           u.tenant_id, t.name AS tenant_name, u.user_id, us.name AS member_name,
           u.company_id, COALESCE(c.name, CASE WHEN u.company_id IS NULL THEN 'Household' END) AS workspace_name,
           u.document_id, d.title AS document_title, dc.document_name AS category_name,
           COALESCE(td.task, ec.name) AS other_record,
           ${IS_NOT_SAVED} AS not_saved,
           COUNT(*) OVER ()::int AS total_count
    FROM tenant_ai_usages u
    LEFT JOIN tenants t ON t.id = u.tenant_id
    LEFT JOIN users us ON us.id = u.user_id
    LEFT JOIN companies c ON c.id = u.company_id
    LEFT JOIN documents d ON d.id = u.document_id
    LEFT JOIN document_categories dc ON dc.module_key = u.module_key AND dc.document_key = u.document_key
    LEFT JOIN todos td ON td.id = u.todo_id
    LEFT JOIN emergency_contacts ec ON ec.id = u.contact_id
    WHERE ${where}
    ORDER BY ${sql.raw(sortCol)} ${sql.raw(dir)} NULLS LAST, u.created_at DESC
    LIMIT ${limit} OFFSET ${(page - 1) * limit}`);

  const totalCount = rows[0]?.totalCount ?? 0;
  return {
    rows: rows.map(({ totalCount: _t, ...r }) => r),
    pagination: { page, limit, totalCount, totalPages: Math.max(1, Math.ceil(totalCount / limit)) },
  };
}

// ─── Filter options ───────────────────────────────────────────────────────

/** What the page's dropdowns can offer: tenants and models that have usage. */
export async function usageFilterOptions() {
  const tenants = await query(sql`
    SELECT t.id, t.name FROM tenants t
    WHERE EXISTS (SELECT 1 FROM tenant_ai_usages u WHERE u.tenant_id = t.id)
    ORDER BY t.name`);
  const models = await query(sql`SELECT DISTINCT model_name AS name FROM tenant_ai_usages ORDER BY 1`);
  return { tenants, models: models.map((m) => m.name) };
}

// ─── CSV ──────────────────────────────────────────────────────────────────

/** RFC 4180 CSV, with a BOM so Excel reads ₹ and Indian names correctly. */
export function toCsv(rows: any[], columns: { key: string; label: string }[]): string {
  const cell = (v: unknown) => {
    if (v === null || v === undefined) return '';
    const s = v instanceof Date ? v.toISOString() : String(v);
    // Guard against spreadsheet formula injection from names and titles.
    const safe = /^[=+\-@]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const lines = [columns.map((c) => cell(c.label)).join(',')];
  for (const r of rows) lines.push(columns.map((c) => cell(r[c.key])).join(','));
  return '﻿' + lines.join('\r\n');
}
