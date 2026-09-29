'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Sparkles, Activity, AlertCircle, RefreshCw, TrendingUp, TrendingDown, Clock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { DataTable } from '@/components/ui/data-table';
import { clientGetMe } from '@/lib/clientAuth';
import { formatDate } from '@/lib/dateHelper';
import { formatCreditReason, creditAmountVariant } from '@/lib/creditLedger';
import { cn } from '@/lib/utils';
import PageContainer from '@/app/components/PageContainer';
import { apiCall } from '@/lib/net/apiRequest';
import WorkspaceTabs, { workspaceTabsFor } from '@/app/components/WorkspaceTabs';


/** The four AI actions, in the order the cost tiles render. */
const ACTION_TILES = [
  { key: 'recordAnalysis', label: 'Record Analysis' },
  { key: 'categoryAnalysis', label: 'Category Analysis' },
  { key: 'portfolioAnalysis', label: 'Portfolio Analysis' },
  { key: 'bulkScan', label: 'Power Scan' },
];

export default function CreditHistoryPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [authorised, setAuthorised] = useState(false);
  const [transactions, setTransactions] = useState([]);
  const [summary, setSummary] = useState(null);
  const [pagination, setPagination] = useState(null);
  const [filterOptions, setFilterOptions] = useState({ reasons: [], users: [] });
  const [aiCosts, setAiCosts] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  /** All-time spend per workspace, for the tab badges. */
  const [perWorkspace, setPerWorkspace] = useState([]);
  const [tabs, setTabs] = useState([]);

  /** The open tab, in the URL. Absent = every workspace. */
  const activeWorkspace = searchParams.get('company');

  const selectWorkspace = useCallback((key) => {
    const params = new URLSearchParams(window.location.search);
    if (key === null) params.delete('company');
    else params.set('company', key);
    // Page 1 — see the same note on /audit-logs.
    params.delete('page');
    router.push(`/billing/credits?${params.toString()}`);
  }, [router]);

  // Credits are a billing concern, so this page is admin-only — the same gate
  // /billing itself applies. The API enforces it independently; this only
  // avoids rendering a page the user will never get data for.
  useEffect(() => {
    async function loadSession() {
      const me = await clientGetMe();
      if (!me.success || me.user.role !== 'TENANT_ADMIN') {
        router.push('/dashboard');
        return;
      }
      setAuthorised(true);
      setTabs(workspaceTabsFor({
        accountType: me.user?.tenant?.accountType,
        companies: me.companies,
        viewer: me.user,
        // "All workspaces" is the default here, because the BALANCE above the
        // table is one number for the whole account whichever tab is open — so
        // an unfiltered ledger is the view that matches it.
        includeSummary: true,
      }));
    }
    loadSession();
  }, [router]);

  const fetchLedger = useCallback(async () => {
    setLoading(true);
    try {
      // `company` in the URL, `companyId` on the API — see the same note on
      // /audit-logs. Every other param is forwarded untouched for <DataTable>.
      const params = new URLSearchParams(window.location.search);
      const tab = params.get('company');
      params.delete('company');
      if (tab) params.set('companyId', tab);

      const { json } = await apiCall(`/api/billing/credits?${params.toString()}`);
      if (json.success) {
        setPerWorkspace(Array.isArray(json.perWorkspace) ? json.perWorkspace : []);
        setTransactions(json.transactions);
        setError('');
        if (json.summary) setSummary(json.summary);
        if (json.pagination) setPagination(json.pagination);
        if (json.filterOptions) setFilterOptions(json.filterOptions);
      } else {
        setError(json.error || 'Failed to fetch credit history');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[billing/credits] handler threw', err);
      setError('Something went wrong fetching credit history. Please try again.');
    } finally {
      setLoading(false);
    }
  }, []);

  // Search, sort, filter and page state all live in the URL and are owned by
  // <DataTable>; this effect just refetches whenever the URL changes.
  useEffect(() => {
    if (authorised) fetchLedger();
  }, [authorised, searchParams, fetchLedger]);

  // The per-action costs are a separate, unpaginated concern, so they are
  // fetched once rather than on every table interaction.
  useEffect(() => {
    if (!authorised) return;
    async function fetchCosts() {
      try {
        const { json } = await apiCall('/api/ai/costs');
        if (json.success) setAiCosts(json);
      } catch { /* the cost tiles are supplementary — the ledger still renders */ }
    }
    fetchCosts();
  }, [authorised]);

  const amountCell = (tx) => (
    <span className={cn('font-bold', tx.amount >= 0 ? 'text-success-text' : 'text-foreground')}>
      {tx.amount >= 0 ? '+' : '−'}{Math.abs(tx.amount).toLocaleString()}
    </span>
  );

  const columns = [
    {
      header: 'Date',
      key: 'createdAt',
      sortable: true,
      className: 'whitespace-nowrap text-xs text-muted-foreground',
      render: (tx) => formatDate(tx.createdAt),
    },
    {
      header: 'Type',
      key: 'reason',
      sortable: true,
      render: (tx) => (
        <Badge variant={creditAmountVariant(tx.amount)}>{formatCreditReason(tx.reason)}</Badge>
      ),
    },
    {
      header: 'Credits',
      key: 'amount',
      sortable: true,
      className: 'whitespace-nowrap',
      render: amountCell,
    },
    {
      header: 'Balance After',
      key: 'balanceAfter',
      sortable: true,
      className: 'whitespace-nowrap text-sm font-semibold text-foreground',
      render: (tx) => Number(tx.balanceAfter).toLocaleString(),
    },
    {
      header: 'Member',
      key: 'user',
      render: (tx) => (
        <span className="text-sm font-medium">{tx.user?.name || 'System / Auto'}</span>
      ),
    },
    {
      header: 'Details',
      key: 'description',
      className: 'max-w-md',
      render: (tx) => <span className="text-sm">{tx.description}</span>,
    },
  ];

  const filterDefinitions = [
    {
      key: 'direction',
      label: 'Direction',
      options: [
        { value: 'grant', label: 'Credits added' },
        { value: 'spend', label: 'Credits used' },
      ],
    },
    {
      key: 'reason',
      label: 'Type',
      options: (filterOptions.reasons || []).map((r) => ({
        value: r,
        label: formatCreditReason(r),
      })),
    },
    {
      key: 'userId',
      label: 'Members',
      options: (filterOptions.users || []).map((u) => ({
        value: u.id,
        label: u.name,
      })),
    },
  ];

  /* Content only — <DataTable> wraps every mobile row in <RecordCard>, which is
     where the border, fill, padding and shadow live now. */
  const renderCard = (tx) => (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-4">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
          <Clock size={13} />
          {formatDate(tx.createdAt)}
        </span>
        <Badge variant={creditAmountVariant(tx.amount)}>{formatCreditReason(tx.reason)}</Badge>
      </div>

      <div className="flex items-baseline justify-between gap-4">
        <span className="text-2xl font-black">{amountCell(tx)}</span>
        <span className="text-xs text-muted-foreground">
          Balance: <strong className="font-semibold text-foreground">{Number(tx.balanceAfter).toLocaleString()}</strong>
        </span>
      </div>

      <p className="text-sm font-semibold leading-relaxed text-foreground">{tx.description}</p>

      <div className="border-t border-border/50 pt-2.5 text-xs text-muted-foreground">
        Member: <strong className="font-semibold text-foreground">{tx.user?.name || 'System / Auto'}</strong>
      </div>
    </div>
  );

  if (!authorised) return null;

  return (
    <PageContainer className="pb-12">

      {/* Header */}
      <div className="flex items-center justify-between gap-4 animate-fade-in">
        <div className="flex flex-col gap-1">
          <h1 className="text-3xl font-extrabold tracking-tight text-foreground flex items-center gap-2">
            <Sparkles className="text-primary" /> AI Credits
          </h1>
          <p className="text-muted-foreground text-sm">
            Your workspace&apos;s credit balance, what each AI action costs, and every credit movement.
          </p>
        </div>
        <Button
          variant="secondary"
          onClick={fetchLedger}
          className="flex items-center gap-2 h-10 px-4"
        >
          <RefreshCw size={15} />
          <span>Refresh</span>
        </Button>
      </div>

      {error && (
        <Alert variant="destructive" className="animate-fade-in">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Balance + all-time totals */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 animate-fade-in">
        <Card className="border-border/50 bg-card backdrop-blur-md shadow-glass p-6 border-l-4 border-l-primary">
          <CardHeader className="px-0 pt-0 pb-0">
            <CardTitle className="text-xs uppercase tracking-wider text-muted-foreground">Available Credits</CardTitle>
            <p className="text-4xl font-black text-primary mt-2">
              {Number(summary?.balance ?? 0).toLocaleString()}
            </p>
          </CardHeader>
        </Card>

        <Card className="border-border/50 bg-card backdrop-blur-md shadow-glass p-6">
          <CardHeader className="px-0 pt-0 pb-0">
            <CardTitle className="text-xs uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
              <TrendingUp size={13} className="text-success-text" /> Total Added
            </CardTitle>
            <p className="text-3xl font-black text-foreground mt-2">
              {Number(summary?.totalGranted ?? 0).toLocaleString()}
            </p>
          </CardHeader>
        </Card>

        <Card className="border-border/50 bg-card backdrop-blur-md shadow-glass p-6">
          <CardHeader className="px-0 pt-0 pb-0">
            <CardTitle className="text-xs uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
              <TrendingDown size={13} /> Total Used
            </CardTitle>
            <p className="text-3xl font-black text-foreground mt-2">
              {Number(summary?.totalSpent ?? 0).toLocaleString()}
            </p>
          </CardHeader>
        </Card>
      </div>

      {/* Per-action costs */}
      {aiCosts && (
        <Card className="border-border/50 bg-card backdrop-blur-md shadow-glass p-6 animate-fade-in">
          <CardHeader className="px-0 pt-0 pb-4">
            <CardTitle className="text-lg uppercase tracking-wider text-muted-foreground">Action Costs</CardTitle>
            <CardDescription>
              Costs are calculated from your member allowance ({aiCosts.multiplier} members).
            </CardDescription>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {ACTION_TILES.map((tile) => (
                <div
                  key={tile.key}
                  className="flex flex-col bg-background/50 p-4 rounded-xl border border-border/50 shadow-sm"
                >
                  <div className="flex items-center gap-2 mb-2">
                    <Activity size={16} className="text-primary" />
                    <span className="text-xs uppercase text-foreground font-bold tracking-wider">
                      {tile.label}
                    </span>
                  </div>
                  <span className="text-3xl font-black text-foreground">{aiCosts.costs[tile.key]}</span>
                  <span className="text-xs text-muted-foreground mt-1">
                    ({aiCosts.baseCosts[tile.key]} base × {aiCosts.multiplier} members)
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/*
        ── THE TABS FILTER THE LEDGER, NOT THE WALLET ─────────────────────────
        Deliberately BELOW the three cards above. There is one wallet: the
        balance and the all-time totals are the same figures whichever tab is
        open, and putting the strip above them would imply each workspace had a
        balance of its own. What the tabs change is the table underneath.
      */}
      <WorkspaceTabs
        tabs={tabs}
        active={activeWorkspace}
        onSelect={selectWorkspace}
        badgeFor={(tab) => {
          if (tab.kind === 'summary' || perWorkspace.length === 0) return null;
          const row = perWorkspace.find((r) => (
            tab.kind === 'personal' ? r.companyId === null : r.companyId === tab.key
          ));
          return (row?.spent ?? 0).toLocaleString();
        }}
      />

      {tabs.length > 1 && (
        <p className="text-xs text-muted-foreground -mt-2">
          {activeWorkspace === null
            ? 'Every workspace. The balance above is the account\u2019s single shared wallet — '
              + 'the badges show what each workspace has spent from it.'
            : 'Spending filed to this workspace. The balance above is the account\u2019s '
              + 'single shared wallet, not this workspace\u2019s own.'}
        </p>
      )}

      {/* The ledger only opens the day it ships, so an empty or short list must
          not read as "you have never used AI". */}
      {summary?.ledgerStartedAt && (
        <p className="text-xs text-muted-foreground">
          Credit history starts {formatDate(summary.ledgerStartedAt)}. Movements before that date were not recorded.
        </p>
      )}

      <DataTable
        data={transactions}
        columns={columns}
        renderCard={renderCard}
        filterDefinitions={filterDefinitions}
        pagination={pagination}
        loading={loading}
        emptyMessage="No credit movements matched your search criteria."
      />
    </PageContainer>
  );
}
