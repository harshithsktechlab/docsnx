'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { RefreshCw, Clock, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { DataTable } from '@/components/ui/data-table';
import { auditActionVariant, formatAuditAction } from '@/lib/auditActions';
import { formatDate } from '@/lib/dateHelper';
import PageContainer from '@/app/components/PageContainer';
import { apiCall } from '@/lib/net/apiRequest';
import { clientGetMe } from '@/lib/clientAuth';
import WorkspaceTabs, { workspaceTabsFor } from '@/app/components/WorkspaceTabs';


export default function AuditLogsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [logs, setLogs] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [filterOptions, setFilterOptions] = useState({ actions: [], users: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  /** Per-workspace entry counts, for the Summary tab's cards. */
  const [summary, setSummary] = useState([]);
  const [tabs, setTabs] = useState([]);

  /**
   * The open tab lives in the URL as `?company=`, not in state.
   *
   * Absent is Summary — the same reading the API gives it, and the reason the
   * household's tab spells itself out as `personal` rather than being the empty
   * value. See resolveWorkspaceFilter.
   */
  const activeWorkspace = searchParams.get('company');

  useEffect(() => {
    (async () => {
      const me = await clientGetMe();
      if (!me.success) return;
      setTabs(workspaceTabsFor({
        accountType: me.user?.tenant?.accountType,
        companies: me.companies,
        viewer: me.user,
        // The audit trail is the one place an account-wide view is genuinely
        // useful: "what happened here lately" spans both halves.
        includeSummary: true,
      }));
    })();
  }, []);

  const selectWorkspace = useCallback((key) => {
    const params = new URLSearchParams(window.location.search);
    if (key === null) params.delete('company');
    else params.set('company', key);
    // Page 1: the row that was page 3 of the household's trail is not page 3 of
    // Acme's, and carrying the offset across lands on an empty page.
    params.delete('page');
    router.push(`/audit-logs?${params.toString()}`);
  }, [router]);

  // Search, sort, filter and page state all live in the URL and are owned by
  // <DataTable>; this effect just refetches whenever the URL changes.
  const fetchLogs = async () => {
    setLoading(true);
    try {
      /**
       * The whole query string is forwarded, so <DataTable>'s search, sort,
       * filter and page params reach the API untouched. The one translation is
       * the tab: the URL says `company` (short, and what a user sees) while the
       * API says `companyId`, matching every other route that takes one.
       */
      const params = new URLSearchParams(window.location.search);
      const tab = params.get('company');
      params.delete('company');
      if (tab) params.set('companyId', tab);

      const { json } = await apiCall(`/api/audit-logs?${params.toString()}`);
      if (json.success) {
        setLogs(json.auditLogs);
        setError('');
        setSummary(Array.isArray(json.summary) ? json.summary : []);
        if (json.pagination) setPagination(json.pagination);
        if (json.filterOptions) setFilterOptions(json.filterOptions);
      } else {
        setError(json.error || 'Failed to fetch audit logs');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[audit-logs] handler threw', err);
      setError('Something went wrong fetching logs. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchLogs();
  }, [searchParams]);

  const actionBadge = (log) => (
    <Badge variant={auditActionVariant(log.action)}>{formatAuditAction(log.action)}</Badge>
  );

  const columns = [
    {
      header: 'Time',
      key: 'createdAt',
      sortable: true,
      className: 'whitespace-nowrap text-xs text-muted-foreground',
      render: (log) => formatDate(log.createdAt),
    },
    {
      header: 'Action',
      key: 'action',
      sortable: true,
      render: actionBadge,
    },
    {
      header: 'Details',
      key: 'details',
      className: 'max-w-md',
      render: (log) => <span className="text-sm">{log.details}</span>,
    },
    /* The IP has no column of its own any more. It is still recorded on every
       row — it is the only breadcrumb if an account is ever misused — but on a
       household vault it is a carrier address that changes constantly, and it
       was taking width from the sentence that actually says what happened. It
       hangs off the operator name instead, where it answers the question it is
       for: "was that actually me?" */
    {
      header: 'Operator',
      key: 'user',
      render: (log) => (
        <span
          className="text-sm font-medium"
          title={log.ipAddress ? `IP ${log.ipAddress}` : undefined}
        >
          {log.user?.name || 'System / Auto'}
        </span>
      ),
    },
  ];

  const filterDefinitions = [
    {
      key: 'action',
      label: 'Actions',
      options: (filterOptions.actions || []).map((a) => ({
        value: a,
        label: formatAuditAction(a),
      })),
    },
    {
      key: 'userId',
      label: 'Operators',
      options: (filterOptions.users || []).map((u) => ({
        value: u.id,
        label: u.name,
      })),
    },
  ];

  /* Content only — <DataTable> wraps every mobile row in <RecordCard>, which is
     where the border, fill, padding and shadow live now. */
  const renderCard = (log) => (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-4">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
          <Clock size={13} />
          {formatDate(log.createdAt)}
        </span>
        {actionBadge(log)}
      </div>

      <p className="text-sm font-semibold leading-relaxed text-foreground">{log.details}</p>

      {/* No IP here either — see the note on the Operator column. A phone has
          no hover, so it is simply not shown on this layout; the row still
          carries it for anyone reading the table directly. */}
      <div className="flex items-center border-t border-border/50 pt-2.5 text-xs text-muted-foreground">
        <span>
          Operator:{' '}
          <strong className="font-semibold text-foreground">
            {log.user?.name || 'System / Auto'}
          </strong>
        </span>
      </div>
    </div>
  );

  return (
    <PageContainer>

      {/* Header */}
      <div className="flex items-center justify-between gap-4 animate-fade-in">
        <div className="flex flex-col gap-1">
          <h1 className="text-3xl font-extrabold tracking-tight text-foreground">Audit Logs</h1>
          <p className="text-muted-foreground text-sm">
            {activeWorkspace === null
              ? 'Security history and record access across every workspace'
              : `Security history for ${
                tabs.find((t) => t.key === activeWorkspace)?.name || 'this workspace'
              }`}
          </p>
        </div>
        <Button
          variant="secondary"
          onClick={fetchLogs}
          className="flex items-center gap-2 h-10 px-4"
        >
          <RefreshCw size={15} />
          <span>Refresh</span>
        </Button>
      </div>

      {/*
        One tab per workspace, plus Summary. `WorkspaceTabs` hides itself when
        there is only one workspace, so a personal-only tenant sees exactly the
        page it saw before this existed.
      */}
      <WorkspaceTabs
        tabs={tabs}
        active={activeWorkspace}
        onSelect={selectWorkspace}
        badgeFor={(tab) => {
          // Counts come back only on the Summary read — on a workspace tab the
          // API does not compute them, and a stale badge is worse than none.
          if (summary.length === 0 || tab.kind === 'summary') return null;
          const row = summary.find((r) => (
            tab.kind === 'personal' ? r.companyId === null : r.companyId === tab.key
          ));
          return row ? row.entries.toLocaleString() : '0';
        }}
      />

      {/*
        The Summary tab's one addition: where the activity actually is. The table
        below it is the same flat trail this page has always rendered.
      */}
      {activeWorkspace === null && summary.length > 1 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 animate-fade-in">
          {summary.map((row) => (
            <div
              key={row.companyId || 'personal'}
              className="rounded-xl border border-border/50 bg-card p-4 shadow-glass backdrop-blur"
            >
              <p className="truncate text-xs font-semibold text-muted-foreground">{row.name}</p>
              <p className="text-2xl font-black text-foreground">
                {row.entries.toLocaleString()}
              </p>
              <p className="text-2xs text-muted-foreground">
                {row.entries === 1 ? 'entry' : 'entries'}
              </p>
            </div>
          ))}
        </div>
      )}

      {error && (
        <Alert variant="destructive" className="animate-fade-in">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <DataTable
        data={logs}
        columns={columns}
        renderCard={renderCard}
        filterDefinitions={filterDefinitions}
        pagination={pagination}
        loading={loading}
        emptyMessage="No audit logs matched your search criteria."
      />
    </PageContainer>
  );
}
