/**
 * GET /api/admin/ai-usage — the super admin AI Usage & Cost report.
 *
 *   ?view=summary                     KPI totals, daily trend, per-task split
 *   ?view=breakdown&by=<dimension>    grouped rows (task, tenant, member,
 *                                     workspace, category, document, batch, model)
 *   ?view=log                         one row per AI call
 *   ?view=options                     tenants / models for the filter dropdowns
 *   &format=csv                       breakdown or log as a CSV download
 *
 * Filters on every view: from, to (IST days), tenantId, userId, companyId
 * ('household' for the personal workspace), action ('NONE' = before tracking),
 * model, keySource, linked ('saved' | 'not_saved'), batchId, documentId.
 *
 * Cross-tenant by design — see the header of src/lib/aiUsageReport.ts.
 */
import { NextResponse } from 'next/server';
import { requireSuperAdmin, SUPER_ADMIN_ONLY } from '@/lib/adminGuard';
import {
  DIMENSIONS, readFilters, toCsv, usageBreakdown, usageFilterOptions, usageLog, usageSummary,
  type Dimension,
} from '@/lib/aiUsageReport';
import { serverError } from '@/lib/routeError';

export const dynamic = 'force-dynamic';

/** Page size for the on-screen tables; a CSV takes everything up to the cap. */
const MAX_PAGE = 100;
const MAX_CSV_ROWS = 50_000;

const MEASURE_COLUMNS = [
  { key: 'calls', label: 'AI calls' },
  { key: 'credits', label: 'Credits charged' },
  { key: 'inputTokens', label: 'Input tokens' },
  { key: 'outputTokens', label: 'Output tokens' },
  { key: 'thinkingTokens', label: 'Thinking tokens' },
  { key: 'costUsd', label: 'Gemini cost (USD)' },
  { key: 'costInr', label: 'Gemini cost (INR)' },
  { key: 'finalCostInr', label: 'Final cost (INR)' },
  { key: 'lastAt', label: 'Last used' },
];

const CSV_COLUMNS: Record<Dimension | 'log', { key: string; label: string }[]> = {
  task: [{ key: 'label', label: 'Task' }, ...MEASURE_COLUMNS],
  tenant: [{ key: 'label', label: 'Tenant' }, { key: 'memberCount', label: 'Members using AI' }, { key: 'documentCount', label: 'Documents' }, ...MEASURE_COLUMNS],
  member: [{ key: 'label', label: 'Member' }, { key: 'email', label: 'Email' }, { key: 'phone', label: 'Phone' }, { key: 'tenantName', label: 'Tenant' }, { key: 'documentCount', label: 'Documents' }, ...MEASURE_COLUMNS],
  workspace: [{ key: 'label', label: 'Workspace' }, { key: 'tenantName', label: 'Tenant' }, ...MEASURE_COLUMNS],
  category: [{ key: 'moduleName', label: 'Module' }, { key: 'label', label: 'Sub-category' }, { key: 'documentCount', label: 'Documents' }, ...MEASURE_COLUMNS],
  document: [
    { key: 'label', label: 'Document' }, { key: 'documentName', label: 'Category' }, { key: 'memberName', label: 'Member' },
    { key: 'tenantName', label: 'Tenant' }, { key: 'pageCount', label: 'Pages' },
    ...MEASURE_COLUMNS,
    { key: 'shareFinalCostInr', label: 'Power Scan share (final INR)' },
    { key: 'totalFinalCostInr', label: 'Total final cost (INR)' },
  ],
  batch: [
    { key: 'startedAt', label: 'Scanned at' }, { key: 'label', label: 'Member' }, { key: 'tenantName', label: 'Tenant' },
    { key: 'fileCount', label: 'Files' }, { key: 'pageCount', label: 'Pages' }, { key: 'recordsRead', label: 'Records read' },
    { key: 'recordsSaved', label: 'Records saved' }, ...MEASURE_COLUMNS,
  ],
  model: [{ key: 'label', label: 'Model' }, { key: 'keySource', label: 'Key' }, ...MEASURE_COLUMNS],
  log: [
    { key: 'createdAt', label: 'Time (UTC)' }, { key: 'action', label: 'Task' }, { key: 'tenantName', label: 'Tenant' },
    { key: 'memberName', label: 'Member' }, { key: 'workspaceName', label: 'Workspace' }, { key: 'categoryName', label: 'Category' },
    { key: 'documentTitle', label: 'Document' }, { key: 'notSaved', label: 'Not saved' }, { key: 'batchId', label: 'Power Scan batch' },
    { key: 'fileCount', label: 'Files' }, { key: 'pageCount', label: 'Pages' }, { key: 'modelName', label: 'Model' },
    { key: 'keySource', label: 'Key' }, { key: 'inputTokens', label: 'Input tokens' }, { key: 'outputTokens', label: 'Output tokens' },
    { key: 'thinkingTokens', label: 'Thinking tokens' }, { key: 'credits', label: 'Credits' }, { key: 'costUsd', label: 'Gemini USD' },
    { key: 'usdInrRate', label: 'USD→INR rate' }, { key: 'costInr', label: 'Gemini INR' },
    { key: 'costMultiplier', label: 'Multiplier' }, { key: 'finalCostInr', label: 'Final INR' },
  ],
};

function csvResponse(body: string, name: string) {
  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(body, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="ai-usage-${name}-${stamp}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}

export async function GET(req: Request) {
  try {
    const user = await requireSuperAdmin(req);
    if (!user) return NextResponse.json({ error: SUPER_ADMIN_ONLY }, { status: 403 });

    const params = new URL(req.url).searchParams;
    const view = params.get('view') || 'summary';
    const filters = readFilters(params);
    const csv = params.get('format') === 'csv';
    const opts = {
      page: csv ? 1 : Number(params.get('page')) || 1,
      limit: csv ? MAX_CSV_ROWS : Math.min(Number(params.get('limit')) || 25, MAX_PAGE),
      sortBy: params.get('sortBy') || undefined,
      sortOrder: params.get('sortOrder') || undefined,
    };

    if (view === 'summary') {
      return NextResponse.json({ success: true, ...(await usageSummary(filters)) });
    }

    if (view === 'options') {
      return NextResponse.json({ success: true, ...(await usageFilterOptions()) });
    }

    if (view === 'breakdown') {
      const by = params.get('by') as Dimension;
      if (!DIMENSIONS.includes(by)) {
        return NextResponse.json({ error: `Unknown breakdown "${by}".` }, { status: 400 });
      }
      const result = await usageBreakdown(by, filters, opts);
      if (csv) return csvResponse(toCsv(result.rows, CSV_COLUMNS[by]), `by-${by}`);
      return NextResponse.json({ success: true, ...result });
    }

    if (view === 'log') {
      const result = await usageLog(filters, opts);
      if (csv) return csvResponse(toCsv(result.rows, CSV_COLUMNS.log), 'calls');
      return NextResponse.json({ success: true, ...result });
    }

    return NextResponse.json({ error: `Unknown view "${view}".` }, { status: 400 });
  } catch (error) {
    return serverError(error, 'loading AI usage');
  }
}
