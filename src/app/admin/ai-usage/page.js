'use client';

/**
 * Super admin → AI Usage & Cost.
 *
 * One page answering "how many AI credits were consumed, and what did they
 * really cost us in ₹" — overall, and by task, tenant, member, workspace,
 * category, document, Power Scan batch and model, down to every single call.
 *
 * Three money figures, always labelled the same way:
 *   Credits   — what the tenant was charged
 *   Gemini ₹  — what Google charged us (USD × the configured rate)
 *   Final ₹   — our full cost: Gemini ₹ × the multiplier (AI Settings)
 *
 * Filters live in the URL so a view can be bookmarked or shared. Clicking a
 * row drills down: tenant → its members → a member's documents → the calls.
 *
 * Protected by src/app/admin/layout.tsx (SUPER_ADMIN only); data from
 * /api/admin/ai-usage, built in src/lib/aiUsageReport.ts.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend,
} from 'recharts';
import {
  BarChart3, Coins, IndianRupee, Activity, Cpu, Download, X, Loader2, Info, Trash2, ChevronUp, ChevronDown,
  ChevronLeft, ChevronRight, RefreshCw,
} from 'lucide-react';
import PageContainer from '@/app/components/PageContainer';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { apiCall } from '@/lib/net/apiRequest';
import { formatDate } from '@/lib/dateHelper';
import { formatCount, formatInr, formatUsd } from '@/lib/formatInr';
import { AI_TASK_DESCRIPTIONS, AI_TASK_LABELS, aiTaskLabel } from '@/lib/creditLedger';
import { cn } from '@/lib/utils';

// ─── Dates (IST) ──────────────────────────────────────────────────────────

/** YYYY-MM-DD of an instant, as a calendar day in India. */
function istDay(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);
}
function shiftDay(day, delta) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

const PRESETS = {
  today: { label: 'Today', range: () => { const t = istDay(); return [t, t]; } },
  '7d': { label: 'Last 7 days', range: () => { const t = istDay(); return [shiftDay(t, -6), t]; } },
  '30d': { label: 'Last 30 days', range: () => { const t = istDay(); return [shiftDay(t, -29), t]; } },
  month: { label: 'This month', range: () => { const t = istDay(); return [`${t.slice(0, 8)}01`, t]; } },
  lastMonth: {
    label: 'Last month',
    range: () => {
      const firstThis = `${istDay().slice(0, 8)}01`;
      const lastPrev = shiftDay(firstThis, -1);
      return [`${lastPrev.slice(0, 8)}01`, lastPrev];
    },
  },
  all: { label: 'All time', range: () => [null, null] },
  custom: { label: 'Custom', range: null },
};

/** Filters the URL may carry, besides the date range. */
const FILTER_KEYS = ['tenantId', 'userId', 'companyId', 'action', 'model', 'keySource', 'linked', 'batchId', 'documentId'];

const KEY_SOURCE_LABELS = { pool: 'Platform key (pool)', env: 'Platform key (server)', tenant: "Tenant's own key" };

// ─── Tabs and their columns ───────────────────────────────────────────────

const TABS = [
  { value: 'task', label: 'By Task', help: 'Which AI features consume credits and cost. "Before tracking" is AI usage recorded before tasks were logged.' },
  { value: 'tenant', label: 'By Tenant', help: 'Each customer account. Click a row to see its members.' },
  { value: 'member', label: 'By Member', help: 'Each person who ran AI. Click a row to see the documents they processed.' },
  { value: 'workspace', label: 'By Workspace', help: 'Household vs. each company inside an account.' },
  { value: 'category', label: 'By Category', help: 'Which document types (e.g. PAN Card, Bank statement) the AI worked on.' },
  { value: 'document', label: 'By Document', help: 'Each saved document: its own AI calls plus its fair share of the Power Scan that grouped it. Click a row to see its calls.' },
  { value: 'batch', label: 'By Power Scan', help: 'Each Power Scan upload: files, pages, records read and saved. Click a row to see its calls.' },
  { value: 'model', label: 'By Model / Key', help: 'Which Gemini model and which API key paid.' },
  { value: 'log', label: 'Call Log', help: 'Every individual AI call, newest first.' },
];

/** The figures every breakdown shows, after its own identifying columns. */
const MEASURE_COLS = [
  { key: 'calls', label: 'Calls', sort: 'calls', align: 'right', render: (r) => formatCount(r.calls) },
  { key: 'credits', label: 'Credits', sort: 'credits', align: 'right', render: (r) => formatCount(r.credits) },
  { key: 'inputTokens', label: 'Input tkn', sort: 'inputTokens', align: 'right', render: (r) => formatCount(r.inputTokens) },
  { key: 'outputTokens', label: 'Output tkn', sort: 'outputTokens', align: 'right', render: (r) => formatCount(r.outputTokens) },
  { key: 'thinkingTokens', label: 'Thinking tkn', sort: 'thinkingTokens', align: 'right', render: (r) => formatCount(r.thinkingTokens) },
  { key: 'costUsd', label: 'Gemini $', sort: 'costUsd', align: 'right', render: (r) => formatUsd(r.costUsd) },
  { key: 'costInr', label: 'Gemini ₹', sort: 'costInr', align: 'right', render: (r) => formatInr(r.costInr) },
  { key: 'finalCostInr', label: 'Final ₹', sort: 'finalCostInr', align: 'right', strong: true, render: (r) => formatInr(r.finalCostInr) },
  { key: 'lastAt', label: 'Last used', sort: 'lastAt', render: (r) => (r.lastAt ? formatDate(r.lastAt) : '—') },
];

const sub = (main, second) => (
  <div className="flex flex-col">
    <span className="font-semibold text-foreground">{main || '—'}</span>
    {second ? <span className="text-2xs text-muted-foreground">{second}</span> : null}
  </div>
);

const COLUMNS = {
  task: [
    { key: 'label', label: 'Task', sort: 'name', render: (r) => sub(aiTaskLabel(r.key), AI_TASK_DESCRIPTIONS[r.key]) },
    ...MEASURE_COLS,
  ],
  tenant: [
    { key: 'label', label: 'Tenant', sort: 'name', render: (r) => sub(r.label) },
    { key: 'memberCount', label: 'Members', align: 'right', render: (r) => formatCount(r.memberCount) },
    { key: 'documentCount', label: 'Documents', align: 'right', render: (r) => formatCount(r.documentCount) },
    ...MEASURE_COLS,
  ],
  member: [
    { key: 'label', label: 'Member', sort: 'name', render: (r) => sub(r.label || (r.userId ? 'Unknown member' : 'Not recorded'), r.email || r.phone) },
    { key: 'tenantName', label: 'Tenant', render: (r) => r.tenantName || '—' },
    { key: 'documentCount', label: 'Documents', align: 'right', render: (r) => formatCount(r.documentCount) },
    ...MEASURE_COLS,
  ],
  workspace: [
    { key: 'label', label: 'Workspace', sort: 'name', render: (r) => sub(r.label, r.companyId ? 'Company' : 'Personal') },
    { key: 'tenantName', label: 'Tenant', render: (r) => r.tenantName || '—' },
    ...MEASURE_COLS,
  ],
  category: [
    { key: 'label', label: 'Category', sort: 'name', render: (r) => sub(r.moduleKey || r.documentKey ? r.label : 'Not recorded', r.moduleName) },
    { key: 'documentCount', label: 'Documents', align: 'right', render: (r) => formatCount(r.documentCount) },
    ...MEASURE_COLS,
  ],
  document: [
    {
      key: 'label', label: 'Document', sort: 'name',
      render: (r) => (
        <div className="flex flex-col">
          <span className="font-semibold text-foreground flex items-center gap-1.5">
            {r.label}
            {r.deleted ? <Badge variant="muted" className="text-2xs py-0 px-1">deleted</Badge> : null}
          </span>
          <span className="text-2xs text-muted-foreground">
            {[r.moduleName, r.documentName].filter(Boolean).join(' → ')}
          </span>
        </div>
      ),
    },
    { key: 'memberName', label: 'Member', render: (r) => sub(r.memberName, r.tenantName) },
    { key: 'pageCount', label: 'Pages', align: 'right', render: (r) => (r.pageCount != null ? formatCount(r.pageCount) : '—') },
    ...MEASURE_COLS.filter((c) => !['lastAt', 'costUsd'].includes(c.key)),
    { key: 'shareFinalCostInr', label: 'Scan share ₹', align: 'right', render: (r) => (r.batchId ? formatInr(r.shareFinalCostInr) : '—') },
    { key: 'totalFinalCostInr', label: 'Total final ₹', sort: 'totalFinalCostInr', align: 'right', strong: true, render: (r) => formatInr(r.totalFinalCostInr) },
  ],
  batch: [
    { key: 'startedAt', label: 'Scanned', render: (r) => sub(r.startedAt ? formatDate(r.startedAt) : '—', r.startedAt ? new Date(r.startedAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }) : '') },
    { key: 'label', label: 'Member', sort: 'name', render: (r) => sub(r.label, r.tenantName) },
    { key: 'fileCount', label: 'Files', align: 'right', render: (r) => (r.fileCount != null ? formatCount(r.fileCount) : '—') },
    { key: 'pageCount', label: 'Pages', align: 'right', render: (r) => (r.pageCount != null ? formatCount(r.pageCount) : '—') },
    { key: 'recordsRead', label: 'Read', align: 'right', render: (r) => formatCount(r.recordsRead) },
    { key: 'recordsSaved', label: 'Saved', align: 'right', render: (r) => formatCount(r.recordsSaved) },
    ...MEASURE_COLS.filter((c) => c.key !== 'lastAt'),
  ],
  model: [
    { key: 'label', label: 'Model', sort: 'name', render: (r) => sub(r.label) },
    { key: 'keySource', label: 'Key', render: (r) => KEY_SOURCE_LABELS[r.keySource] || 'Not recorded' },
    ...MEASURE_COLS,
  ],
  log: [
    {
      key: 'createdAt', label: 'Time', sort: 'createdAt',
      render: (r) => sub(formatDate(r.createdAt), new Date(r.createdAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit' })),
    },
    { key: 'action', label: 'Task', render: (r) => aiTaskLabel(r.action) },
    { key: 'member', label: 'Member', render: (r) => sub(r.memberName || '—', [r.tenantName, r.workspaceName].filter(Boolean).join(' · ')) },
    {
      key: 'about', label: 'About',
      render: (r) => (
        <div className="flex flex-col max-w-[240px]">
          <span className="font-semibold text-foreground truncate">
            {r.documentTitle || r.otherRecord || (r.notSaved ? 'Not saved' : r.categoryName || '—')}
          </span>
          <span className="text-2xs text-muted-foreground truncate">
            {[r.categoryName, r.pageCount != null ? `${r.pageCount} page${r.pageCount === 1 ? '' : 's'}` : null, r.batchId ? 'Power Scan' : null].filter(Boolean).join(' · ')}
          </span>
        </div>
      ),
    },
    { key: 'model', label: 'Model / key', render: (r) => sub(r.modelName, KEY_SOURCE_LABELS[r.keySource]) },
    { key: 'inputTokens', label: 'Input', sort: 'inputTokens', align: 'right', render: (r) => formatCount(r.inputTokens) },
    { key: 'outputTokens', label: 'Output', align: 'right', render: (r) => formatCount(r.outputTokens) },
    { key: 'thinkingTokens', label: 'Thinking', align: 'right', render: (r) => formatCount(r.thinkingTokens) },
    { key: 'credits', label: 'Credits', sort: 'credits', align: 'right', render: (r) => (r.credits != null ? formatCount(r.credits) : '—') },
    { key: 'costInr', label: 'Gemini ₹', sort: 'costInr', align: 'right', render: (r) => (r.costInr != null ? formatInr(r.costInr) : formatUsd(r.costUsd)) },
    { key: 'finalCostInr', label: 'Final ₹', sort: 'finalCostInr', align: 'right', strong: true, render: (r) => (r.finalCostInr != null ? formatInr(r.finalCostInr) : '—') },
  ],
};

/** Clicking a row in one tab narrows the page and moves to the next level down. */
const DRILL = {
  tenant: (r) => (r.tenantId ? { set: { tenantId: r.tenantId }, tab: 'member' } : null),
  member: (r) => (r.userId ? { set: { userId: r.userId }, tab: 'document' } : null),
  workspace: (r) => ({ set: { tenantId: r.tenantId, companyId: r.companyId || 'household' }, tab: 'member' }),
  task: (r) => ({ set: { action: r.key || 'NONE' }, tab: 'log' }),
  model: (r) => ({ set: { model: r.label, ...(r.keySource ? { keySource: r.keySource } : {}) }, tab: 'log' }),
  batch: (r) => (r.batchId ? { set: { batchId: r.batchId }, tab: 'log' } : null),
  document: (r) => (r.documentId ? { set: { documentId: r.documentId }, tab: 'log' } : null),
};

// ─── Small pieces ─────────────────────────────────────────────────────────

function Kpi({ icon: Icon, label, value, sub: subText, accent = 'text-primary' }) {
  return (
    <Card className="border-border/50 bg-card/80 backdrop-blur-md shadow-md">
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <span className="text-2xs font-bold uppercase tracking-wider text-muted-foreground">{label}</span>
          <Icon className={cn('w-4 h-4', accent)} />
        </div>
        <div className="mt-2 text-xl sm:text-2xl font-extrabold text-foreground break-words">{value}</div>
        {subText ? <p className="text-2xs text-muted-foreground mt-1">{subText}</p> : null}
      </CardContent>
    </Card>
  );
}

function FilterSelect({ label, value, onChange, options, allLabel = 'All' }) {
  return (
    <div className="flex flex-col gap-1.5 min-w-[150px] flex-1">
      <Label className="text-2xs uppercase tracking-wider text-muted-foreground">{label}</Label>
      <Select value={value || 'all'} onValueChange={(v) => onChange(v === 'all' ? null : v)}>
        <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{allLabel}</SelectItem>
          {options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
}

function SortHeader({ col, sortBy, sortOrder, onSort }) {
  const active = col.sort && sortBy === col.sort;
  return (
    <TableHead className={cn('whitespace-nowrap text-xs', col.align === 'right' && 'text-right')}>
      {col.sort ? (
        <button
          type="button"
          onClick={() => onSort(col.sort)}
          className={cn('inline-flex items-center gap-1 hover:text-foreground', active && 'text-foreground font-bold')}
        >
          {col.label}
          {active ? (sortOrder === 'asc' ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />) : null}
        </button>
      ) : col.label}
    </TableHead>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────

export default function AiUsagePage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // URL → state. The preset decides the dates unless it is "custom".
  const preset = PRESETS[searchParams.get('preset')] ? searchParams.get('preset') : '30d';
  const tab = TABS.some((t) => t.value === searchParams.get('tab')) ? searchParams.get('tab') : 'task';
  const [from, to] = useMemo(() => {
    if (preset === 'custom') return [searchParams.get('from') || null, searchParams.get('to') || null];
    return PRESETS[preset].range();
  }, [preset, searchParams]);
  const filters = useMemo(() => {
    const f = {};
    for (const k of FILTER_KEYS) if (searchParams.get(k)) f[k] = searchParams.get(k);
    return f;
  }, [searchParams]);

  const [summary, setSummary] = useState(null);
  const [options, setOptions] = useState({ tenants: [], models: [] });
  const [table, setTable] = useState({ rows: [], pagination: null });
  const [loadingSummary, setLoadingSummary] = useState(true);
  const [loadingTable, setLoadingTable] = useState(true);
  const [error, setError] = useState('');
  const [sort, setSort] = useState({ sortBy: null, sortOrder: 'desc' });
  const [page, setPage] = useState(1);
  const [reloadKey, setReloadKey] = useState(0);

  /** Writes changes into the URL; null removes a key. */
  const update = useCallback((changes) => {
    const next = new URLSearchParams(searchParams.toString());
    for (const [k, v] of Object.entries(changes)) {
      if (v === null || v === undefined || v === '') next.delete(k);
      else next.set(k, v);
    }
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  }, [router, pathname, searchParams]);

  /** The filter query shared by every request. */
  const filterQuery = useMemo(() => {
    const q = new URLSearchParams();
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    for (const [k, v] of Object.entries(filters)) q.set(k, v);
    return q;
  }, [from, to, filters]);

  // Dropdown options, once.
  useEffect(() => {
    apiCall('/api/admin/ai-usage?view=options').then(({ json }) => {
      if (json?.success) setOptions({ tenants: json.tenants || [], models: json.models || [] });
    });
  }, []);

  // KPIs + trend.
  useEffect(() => {
    let live = true;
    setLoadingSummary(true);
    setError('');
    const q = new URLSearchParams(filterQuery);
    q.set('view', 'summary');
    apiCall(`/api/admin/ai-usage?${q}`, {}, { subject: 'AI usage', action: 'loading AI usage' }).then(({ res, json }) => {
      if (!live) return;
      if (res?.ok && json?.success) setSummary(json);
      else setError(json?.error || 'Could not load AI usage.');
      setLoadingSummary(false);
    });
    return () => { live = false; };
  }, [filterQuery, reloadKey]);

  // A new tab or new filters start at page 1 with that tab's default sort.
  useEffect(() => { setPage(1); setSort({ sortBy: null, sortOrder: 'desc' }); }, [tab, filterQuery]);

  // The active tab's table.
  const tableQuery = useMemo(() => {
    const q = new URLSearchParams(filterQuery);
    if (tab === 'log') q.set('view', 'log');
    else { q.set('view', 'breakdown'); q.set('by', tab); }
    if (sort.sortBy) { q.set('sortBy', sort.sortBy); q.set('sortOrder', sort.sortOrder); }
    return q;
  }, [filterQuery, tab, sort]);

  useEffect(() => {
    let live = true;
    setLoadingTable(true);
    const q = new URLSearchParams(tableQuery);
    q.set('page', String(page));
    q.set('limit', '25');
    apiCall(`/api/admin/ai-usage?${q}`).then(({ res, json }) => {
      if (!live) return;
      if (res?.ok && json?.success) setTable({ rows: json.rows || [], pagination: json.pagination });
      else setTable({ rows: [], pagination: null });
      setLoadingTable(false);
    });
    return () => { live = false; };
  }, [tableQuery, page, reloadKey]);

  const onSort = (key) => setSort((s) => ({
    sortBy: key,
    sortOrder: s.sortBy === key && s.sortOrder === 'desc' ? 'asc' : 'desc',
  }));

  const csvHref = useMemo(() => {
    const q = new URLSearchParams(tableQuery);
    q.set('format', 'csv');
    return `/api/admin/ai-usage?${q}`;
  }, [tableQuery]);

  const drill = (row) => {
    const step = DRILL[tab]?.(row);
    if (step) update({ ...step.set, tab: step.tab });
  };

  // ── Derived figures ──
  const t = summary?.totals || {};
  const notSaved = summary?.notSaved || {};
  const perCall = t.calls ? t.finalCostInr / t.calls : 0;
  const perCredit = t.credits ? t.finalCostInr / t.credits : 0;
  const multiplierHint = t.costInr > 0 ? `Gemini ₹ × ${(t.finalCostInr / t.costInr).toFixed(2)}` : 'Gemini ₹ × multiplier';
  const trend = (summary?.trend || []).map((d) => ({
    day: d.day.slice(5).split('-').reverse().join('/'),
    'Final ₹': Number(d.finalCostInr.toFixed(4)),
    Credits: d.credits,
  }));

  // Chips for every narrowing filter, so a drill-down is always visible and undoable.
  const tenantName = (id) => options.tenants.find((x) => x.id === id)?.name;
  const chipLabels = {
    tenantId: (v) => `Tenant: ${tenantName(v) || v.slice(0, 8)}`,
    userId: (v) => `Member: ${table.rows.find((r) => r.userId === v)?.memberName || table.rows.find((r) => r.userId === v)?.label || v.slice(0, 8)}`,
    companyId: (v) => (v === 'household' ? 'Workspace: Household' : `Workspace: ${v.slice(0, 8)}`),
    action: (v) => `Task: ${aiTaskLabel(v)}`,
    model: (v) => `Model: ${v}`,
    keySource: (v) => `Key: ${KEY_SOURCE_LABELS[v] || v}`,
    linked: (v) => (v === 'not_saved' ? 'Not saved only' : 'Saved only'),
    batchId: (v) => `Power Scan: ${v.slice(0, 8)}`,
    documentId: (v) => `Document: ${v.slice(0, 8)}`,
  };
  const activeTab = TABS.find((x) => x.value === tab);
  const columns = COLUMNS[tab];

  return (
    <PageContainer className="space-y-6 pb-16 animate-fade-in">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold text-foreground flex items-center gap-2">
            <BarChart3 className="w-6 h-6 text-primary" /> AI Usage &amp; Cost
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Credits charged to customers, and what that AI really cost us. <strong>Gemini ₹</strong> is Google&apos;s bill; <strong>Final ₹</strong> is our full cost ({multiplierHint}).
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setReloadKey((k) => k + 1)} className="self-start sm:self-auto">
          <RefreshCw className="w-4 h-4 mr-2" /> Refresh
        </Button>
      </div>

      {/* Filters */}
      <Card className="border-border/50 bg-card/80">
        <CardContent className="p-4 flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            {Object.entries(PRESETS).map(([key, p]) => (
              <Button
                key={key}
                size="sm"
                variant={preset === key ? 'default' : 'outline'}
                onClick={() => {
                  if (key === 'custom') {
                    const [f0, t0] = from && to ? [from, to] : PRESETS['30d'].range();
                    update({ preset: 'custom', from: f0, to: t0 });
                  } else update({ preset: key, from: null, to: null });
                }}
              >
                {p.label}
              </Button>
            ))}
          </div>
          <div className="flex flex-wrap gap-3 items-end">
            {preset === 'custom' && (
              <>
                <div className="flex flex-col gap-1.5">
                  <Label className="text-2xs uppercase tracking-wider text-muted-foreground">From</Label>
                  <Input type="date" className="h-9" value={from || ''} max={to || undefined} onChange={(e) => update({ from: e.target.value })} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label className="text-2xs uppercase tracking-wider text-muted-foreground">To</Label>
                  <Input type="date" className="h-9" value={to || ''} min={from || undefined} onChange={(e) => update({ to: e.target.value })} />
                </div>
              </>
            )}
            <FilterSelect
              label="Tenant" allLabel="All tenants" value={filters.tenantId}
              onChange={(v) => update({ tenantId: v, userId: null, companyId: null, documentId: null, batchId: null })}
              options={options.tenants.map((x) => ({ value: x.id, label: x.name }))}
            />
            <FilterSelect
              label="Task" allLabel="All tasks" value={filters.action}
              onChange={(v) => update({ action: v })}
              options={[...Object.entries(AI_TASK_LABELS).map(([value, label]) => ({ value, label })), { value: 'NONE', label: 'Before tracking' }]}
            />
            <FilterSelect
              label="Model" allLabel="All models" value={filters.model}
              onChange={(v) => update({ model: v })}
              options={options.models.map((m) => ({ value: m, label: m }))}
            />
            <FilterSelect
              label="Key" allLabel="All keys" value={filters.keySource}
              onChange={(v) => update({ keySource: v })}
              options={Object.entries(KEY_SOURCE_LABELS).map(([value, label]) => ({ value, label }))}
            />
            <FilterSelect
              label="Saved?" allLabel="Everything" value={filters.linked}
              onChange={(v) => update({ linked: v })}
              options={[{ value: 'saved', label: 'Saved to a record' }, { value: 'not_saved', label: 'Not saved (discarded)' }]}
            />
          </div>
          {Object.keys(filters).length > 0 && (
            <div className="flex flex-wrap gap-2 items-center">
              {Object.entries(filters).map(([k, v]) => (
                <Badge key={k} variant="info" className="gap-1 pr-1">
                  {chipLabels[k]?.(v) ?? `${k}: ${v}`}
                  <button type="button" aria-label="Remove filter" onClick={() => update({ [k]: null })} className="rounded hover:bg-black/10 p-0.5">
                    <X className="w-3 h-3" />
                  </button>
                </Badge>
              ))}
              <Button size="sm" variant="ghost" onClick={() => update(Object.fromEntries(FILTER_KEYS.map((k) => [k, null])))}>
                Clear all
              </Button>
            </div>
          )}
          <p className="text-2xs text-muted-foreground">
            {from || to ? `Showing ${from ? formatDate(from) : 'the start'} – ${to ? formatDate(to) : 'today'} (India time).` : 'Showing all recorded AI usage.'}
          </p>
        </CardContent>
      </Card>

      {error && (
        <Card className="border-danger-border bg-danger-surface"><CardContent className="p-4 text-sm text-danger-text">{error}</CardContent></Card>
      )}

      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Kpi icon={Coins} label="Credits consumed" value={loadingSummary ? '…' : formatCount(t.credits)} sub="Charged to customers" />
        <Kpi icon={IndianRupee} label="Final cost" accent="text-emerald-500" value={loadingSummary ? '…' : formatInr(t.finalCostInr)} sub={multiplierHint} />
        <Kpi icon={IndianRupee} label="Gemini cost" value={loadingSummary ? '…' : formatInr(t.costInr)} sub={`${formatUsd(t.costUsd)} billed by Google`} />
        <Kpi icon={Activity} label="AI calls" value={loadingSummary ? '…' : formatCount(t.calls)} sub={`Avg final ${formatInr(perCall)} per call`} />
        <Kpi
          icon={Cpu} label="Tokens"
          value={loadingSummary ? '…' : formatCount((t.inputTokens || 0) + (t.outputTokens || 0) + (t.thinkingTokens || 0))}
          sub={`In ${formatCount(t.inputTokens)} · Out ${formatCount(t.outputTokens)} · Thinking ${formatCount(t.thinkingTokens)}`}
        />
        <Kpi icon={Coins} label="Final cost per credit" value={loadingSummary ? '…' : formatInr(perCredit)} sub="What one credit costs us" />
        <Kpi
          icon={Trash2} label="Not saved" accent="text-warning-text"
          value={loadingSummary ? '…' : formatInr(notSaved.finalCostInr)}
          sub={`${formatCount(notSaved.calls)} AI reads the user discarded`}
        />
        <Kpi
          icon={Info} label="Without ₹ figure" accent="text-muted-foreground"
          value={loadingSummary ? '…' : formatCount(summary?.unpricedCalls)}
          sub="Calls before INR tracking or with no rate set — not in ₹ totals"
        />
      </div>

      {/* Trend */}
      <Card className="border-border/50 bg-card/80">
        <CardContent className="p-4">
          <h2 className="text-sm font-bold uppercase tracking-wider text-muted-foreground mb-3">Daily final cost &amp; credits</h2>
          {trend.length === 0 ? (
            <p className="text-sm text-muted-foreground py-10 text-center">{loadingSummary ? 'Loading…' : 'No AI usage in this period.'}</p>
          ) : (
            <div className="h-[260px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={trend} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                  <XAxis dataKey="day" tickLine={false} axisLine={false} tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 11 }} />
                  <YAxis yAxisId="inr" tickLine={false} axisLine={false} width={56} tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 11 }} tickFormatter={(v) => `₹${v}`} />
                  <YAxis yAxisId="cr" orientation="right" tickLine={false} axisLine={false} width={40} tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 11 }} />
                  <Tooltip
                    contentStyle={{ backgroundColor: 'hsl(var(--card))', borderColor: 'hsl(var(--border))', borderRadius: '12px' }}
                    itemStyle={{ color: 'hsl(var(--foreground))', fontWeight: 600 }}
                    formatter={(value, name) => (name === 'Final ₹' ? formatInr(value) : formatCount(value))}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar yAxisId="inr" dataKey="Final ₹" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} maxBarSize={28} />
                  <Line yAxisId="cr" type="monotone" dataKey="Credits" stroke="#10b981" strokeWidth={2} dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Breakdowns */}
      <Card className="border-border/50 bg-card/80">
        <CardContent className="p-4 flex flex-col gap-3">
          <div className="overflow-x-auto -mx-1 px-1">
            <Tabs value={tab} onValueChange={(v) => update({ tab: v })}>
              <TabsList className="flex w-max">
                {TABS.map((x) => <TabsTrigger key={x.value} value={x.value} className="text-xs">{x.label}</TabsTrigger>)}
              </TabsList>
            </Tabs>
          </div>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <p className="text-xs text-muted-foreground flex items-start gap-1.5">
              <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {activeTab.help}
            </p>
            <Button asChild variant="outline" size="sm" className="self-start sm:self-auto">
              <a href={csvHref} download><Download className="w-4 h-4 mr-2" /> Export CSV</a>
            </Button>
          </div>

          <div className="overflow-x-auto rounded-lg border border-border/50">
            <Table>
              <TableHeader>
                <TableRow>
                  {columns.map((c) => <SortHeader key={c.key} col={c} sortBy={sort.sortBy} sortOrder={sort.sortOrder} onSort={onSort} />)}
                </TableRow>
              </TableHeader>
              <TableBody>
                {loadingTable ? (
                  <TableRow><TableCell colSpan={columns.length} className="text-center py-10 text-muted-foreground">
                    <Loader2 className="w-5 h-5 animate-spin inline mr-2" /> Loading…
                  </TableCell></TableRow>
                ) : table.rows.length === 0 ? (
                  <TableRow><TableCell colSpan={columns.length} className="text-center py-10 text-muted-foreground">
                    No AI usage matches these filters.
                  </TableCell></TableRow>
                ) : table.rows.map((r, i) => {
                  const clickable = Boolean(DRILL[tab]?.(r));
                  return (
                    <TableRow
                      key={r.key ?? r.id ?? i}
                      onClick={clickable ? () => drill(r) : undefined}
                      className={cn(clickable && 'cursor-pointer hover:bg-muted/50')}
                    >
                      {columns.map((c) => (
                        <TableCell key={c.key} className={cn('text-xs whitespace-nowrap', c.align === 'right' && 'text-right tabular-nums', c.strong && 'font-bold text-foreground')}>
                          {c.render ? c.render(r) : r[c.key]}
                        </TableCell>
                      ))}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>

          {table.pagination && table.pagination.totalPages > 1 && (
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                {formatCount(table.pagination.totalCount)} rows · page {table.pagination.page} of {table.pagination.totalPages}
              </span>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" disabled={page <= 1 || loadingTable} onClick={() => setPage((p) => p - 1)}>
                  <ChevronLeft className="w-4 h-4" />
                </Button>
                <Button size="sm" variant="outline" disabled={page >= table.pagination.totalPages || loadingTable} onClick={() => setPage((p) => p + 1)}>
                  <ChevronRight className="w-4 h-4" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </PageContainer>
  );
}
