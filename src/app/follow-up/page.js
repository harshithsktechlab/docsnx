'use client';

import { formatDate } from '@/lib/dateHelper';
import React, { useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  AlertCircle,
  Calendar,
  FileText,
  ShieldAlert,
  Sparkles,
  ExternalLink,
  Clock,
  UserCheck,
  AlertTriangle,
  BellRing,
  ArrowRight
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import PageContainer from '@/app/components/PageContainer';
import { useWorkspaceApi } from '@/lib/net/useWorkspaceApi';


export default function FollowUpPage() {
  /**
   * ── ONE PAGE, TWO WORKSPACES ──────────────────────────────────────────────
   *
   * `/follow-up` answers for the household, `/business/<id>/follow-up` for one
   * company. The two GAP tabs are personal by nature — they say which MEMBER is
   * missing a PAN or has no health cover — so a company shows Renewals and
   * Tasks only, and the route returns those two lists empty there rather than
   * this page hiding rows it was sent.
   */
  const { api, companyId } = useWorkspaceApi();
  const showGaps = !companyId;

  const [data, setData] = useState({ renewals: [], insuranceGaps: [], documentsPending: [], todosPending: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // Controlled so the summary cards above the tabs can open the tab they count.
  const [activeTab, setActiveTab] = useState('renewals');
  const tabsRef = useRef(null);

  const fetchFollowUpData = async () => {
    try {
      const { json } = await api('/api/follow-up');
      if (json.success) {
        // Merged onto the four empty lists rather than assigned, because every
        // count and tab on this page reads `.length` and `.filter` off all four.
        // A response missing one — an older service worker replaying a cached
        // body, a partial answer — took the whole page down with
        // "Cannot read properties of undefined".
        setData({
          renewals: json.renewals ?? [],
          insuranceGaps: json.insuranceGaps ?? [],
          documentsPending: json.documentsPending ?? [],
          todosPending: json.todosPending ?? [],
        });
      } else {
        setError(json.error || 'Failed to fetch follow-up items');
      }
    } catch (err) {
      // Transport failures are values now, not throws — `apiCall` and
      // `postUpload` return them. So reaching this catch means a bug in the
      // block above, and calling that a network error sent people to check
      // a connection that was working.
      console.error('[follow-up] handler threw', err);
      setError('Something went wrong fetching follow-up items. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  // Refetched when the workspace changes: `/follow-up` and
  // `/business/<id>/follow-up` render the same component, so an empty
  // dependency list would leave one workspace's renewals on the other's page.
  useEffect(() => {
    fetchFollowUpData();
    // A company has no gap tabs, so a household's "gaps" selection would leave
    // the tab strip with nothing selected there.
    setActiveTab('renewals');
  }, [companyId]);

  const renderSeverityBadge = (severity, days) => {
    // A to-do with no due date arrives as `daysLeft: null`, and `null <= 3` is
    // true — so the no-date case used to render "URGENT (nulld left)". Only a
    // real number says anything about urgency; anything else has no countdown.
    const countdown = Number.isFinite(days) ? days : undefined;
    if (severity === 'URGENT' || (countdown !== undefined && countdown <= 3)) {
      return (
        <Badge className="bg-rose-600/90 hover:bg-rose-600 text-white font-bold text-xs flex items-center gap-1 shadow-sm">
          <AlertTriangle size={11} className="animate-pulse" /> URGENT {countdown !== undefined && `(${countdown < 0 ? `Overdue ${Math.abs(countdown)}d` : `${countdown}d left`})`}
        </Badge>
      );
    }
    if (severity === 'WARNING' || (countdown !== undefined && countdown <= 15)) {
      return (
        <Badge className="bg-amber-600/90 hover:bg-amber-600 text-white font-bold text-xs flex items-center gap-1">
          WARNING {countdown !== undefined && `(${countdown}d left)`}
        </Badge>
      );
    }
    return (
      <Badge variant="secondary" className="font-semibold text-xs">
        PENDING {countdown !== undefined && `(${countdown}d left)`}
      </Badge>
    );
  };

  if (loading) {
    return (
      <PageContainer width="medium">
        <Skeleton className="h-10 w-48" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Skeleton className="h-24 w-full rounded-xl" />
          <Skeleton className="h-24 w-full rounded-xl" />
          <Skeleton className="h-24 w-full rounded-xl" />
          <Skeleton className="h-24 w-full rounded-xl" />
        </div>
        <Skeleton className="h-14 w-full rounded-xl" />
        <Skeleton className="h-64 w-full rounded-2xl" />
      </PageContainer>
    );
  }

  const urgentCount = data.renewals.filter(r => r.severity === 'URGENT' || (Number.isFinite(r.daysLeft) && r.daysLeft <= 3)).length +
    data.insuranceGaps.filter(g => g.severity === 'URGENT').length +
    data.documentsPending.filter(d => d.severity === 'URGENT').length;

  const warningCount = data.renewals.filter(r => r.severity === 'WARNING').length +
    data.insuranceGaps.filter(g => g.severity === 'WARNING').length;

  const totalCount = data.renewals.length + data.insuranceGaps.length + data.documentsPending.length + data.todosPending.length;

  // Urgent and warning counts each sum more than one list, so a card opens
  // the first tab that actually holds one of the items it counted — landing on
  // an empty Renewals tab because the urgent item was an ID gap reads as broken.
  const isUrgentRenewal = (r) => r.severity === 'URGENT' || (Number.isFinite(r.daysLeft) && r.daysLeft <= 3);
  const firstTabWith = (candidates, fallback) =>
    candidates.find(([tab, has]) => has && (showGaps || (tab !== 'gaps' && tab !== 'documents')))?.[0] ?? fallback;
  const urgentTab = firstTabWith([
    ['renewals', data.renewals.some(isUrgentRenewal)],
    ['gaps', data.insuranceGaps.some(g => g.severity === 'URGENT')],
    ['documents', data.documentsPending.some(d => d.severity === 'URGENT')],
  ], 'renewals');
  const warningTab = firstTabWith([
    ['renewals', data.renewals.some(r => r.severity === 'WARNING')],
    ['gaps', data.insuranceGaps.some(g => g.severity === 'WARNING')],
  ], 'renewals');

  // With nothing to show the tabs are not rendered, so the cards go inert.
  const cardsClickable = totalCount > 0;
  const openTab = (tab) => {
    setActiveTab(tab);
    // On a phone the cards stack one per row and the tabs are a screen or more
    // below, so switching without scrolling looks like the tap did nothing. The
    // tab strip also scrolls sideways there, so bring the chosen trigger in too.
    requestAnimationFrame(() => {
      tabsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      tabsRef.current
        ?.querySelector(`[role="tab"][data-state="active"]`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    });
  };
  const statCardProps = (tab, label) => cardsClickable ? {
    role: 'button',
    tabIndex: 0,
    'aria-label': `${label} \u2014 show in tabs below`,
    onClick: () => openTab(tab),
    onKeyDown: (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openTab(tab);
      }
    },
  } : {};
  const statCardInteractive = cardsClickable
    ? 'cursor-pointer select-none hover:shadow-lg hover:-translate-y-0.5 active:translate-y-0 active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
    : '';

  return (
    <PageContainer width="medium" className="pb-12 animate-fade-in">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight text-foreground flex items-center gap-2.5">
            Automated Follow-Up & Alert Matrix
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            {showGaps
              ? 'Exhaustive monitoring across all 18 record types for renewals, insurance gaps, and missing ID documents'
              : 'Renewals and pending tasks across this company\u2019s records'}
          </p>
        </div>
      </div>

      {/* Summary Stat Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card {...statCardProps(urgentTab, `Urgent actions: ${urgentCount}`)} className={`${statCardInteractive} p-5 border-2 border-rose-300 dark:border-rose-500/40 bg-rose-100/90 dark:bg-rose-950/40 backdrop-blur shadow-glass flex flex-col justify-between`}>
          <div className="flex items-center justify-between">
            <span className="text-xs font-extrabold uppercase tracking-wider text-rose-700 dark:text-rose-400">Urgent Actions</span>
            <div className="w-9 h-9 rounded-xl bg-rose-500/20 flex items-center justify-center text-rose-600 dark:text-rose-400">
              <BellRing size={18} />
            </div>
          </div>
          <div className="mt-3">
            <span className="text-4xl font-black text-rose-700 dark:text-rose-400 leading-none">{urgentCount}</span>
            <p className="text-xs font-medium text-rose-600/90 dark:text-rose-300/80 mt-1.5">Due within 3 days or overdue</p>
          </div>
        </Card>

        <Card {...statCardProps(warningTab, `Warning alerts: ${warningCount}`)} className={`${statCardInteractive} p-5 border-2 border-amber-300 dark:border-amber-500/40 bg-amber-100/90 dark:bg-amber-950/40 backdrop-blur shadow-glass flex flex-col justify-between`}>
          <div className="flex items-center justify-between">
            <span className="text-xs font-extrabold uppercase tracking-wider text-amber-800 dark:text-amber-400">Warning Alerts</span>
            <div className="w-9 h-9 rounded-xl bg-amber-500/20 flex items-center justify-center text-amber-700 dark:text-amber-400">
              <AlertCircle size={18} />
            </div>
          </div>
          <div className="mt-3">
            <span className="text-4xl font-black text-amber-800 dark:text-amber-400 leading-none">{warningCount}</span>
            <p className="text-xs font-medium text-amber-700/90 dark:text-amber-300/80 mt-1.5">Due in 4 to 15 days</p>
          </div>
        </Card>

        {showGaps && (
        <Card {...statCardProps('documents', `ID document gaps: ${data.documentsPending.length}`)} className={`${statCardInteractive} p-5 border-2 border-cyan-300 dark:border-cyan-500/40 bg-cyan-100/90 dark:bg-cyan-950/40 backdrop-blur shadow-glass flex flex-col justify-between`}>
          <div className="flex items-center justify-between">
            <span className="text-xs font-extrabold uppercase tracking-wider text-cyan-700 dark:text-cyan-400">ID Document Gaps</span>
            <div className="w-9 h-9 rounded-xl bg-cyan-500/20 flex items-center justify-center text-cyan-600 dark:text-cyan-400">
              <ShieldAlert size={18} />
            </div>
          </div>
          <div className="mt-3">
            <span className="text-4xl font-black text-cyan-700 dark:text-cyan-400 leading-none">{data.documentsPending.length}</span>
            <p className="text-xs font-medium text-cyan-600/90 dark:text-cyan-300/80 mt-1.5">Missing essential ID documents</p>
          </div>
        </Card>
        )}

        <Card {...statCardProps('todos', `Active to-dos: ${data.todosPending.length}`)} className={`${statCardInteractive} p-5 border-2 border-emerald-300 dark:border-emerald-500/40 bg-emerald-100/90 dark:bg-emerald-950/40 backdrop-blur shadow-glass flex flex-col justify-between`}>
          <div className="flex items-center justify-between">
            <span className="text-xs font-extrabold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">Active To-Dos</span>
            <div className="w-9 h-9 rounded-xl bg-emerald-500/20 flex items-center justify-center text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 size={18} />
            </div>
          </div>
          <div className="mt-3">
            <span className="text-4xl font-black text-emerald-700 dark:text-emerald-400 leading-none">{data.todosPending.length}</span>
            <p className="text-xs font-medium text-emerald-600/90 dark:text-emerald-300/80 mt-1.5">Assigned tasks</p>
          </div>
        </Card>
      </div>

      {totalCount === 0 ? (
        <Card className="border-border/30 bg-card backdrop-blur p-12 text-center animate-fade-in mt-2">
          <CheckCircle2 size={48} className="mx-auto text-emerald-500 mb-3" />
          <p className="text-foreground font-bold text-lg mb-1">Vault Status: All Clean!</p>
          <p className="text-muted-foreground text-sm">
            {showGaps
              ? 'No renewals, insurance gaps, or missing ID documents found across your records.'
              : 'No renewals or pending tasks found in this company\u2019s records.'}
          </p>
        </Card>
      ) : (
        <Tabs ref={tabsRef} value={activeTab} onValueChange={setActiveTab} className="w-full mt-2 animate-fade-in scroll-mt-20">
          <TabsList className="flex overflow-x-auto whitespace-nowrap scrollbar-hide w-full bg-card border border-border/50 h-auto min-h-11 p-1">
            <TabsTrigger value="renewals" className="text-xs flex items-center gap-1.5 h-9 shrink-0">
              <span>Renewals & Expiry</span>
              {data.renewals.length > 0 && (
                <span className="bg-primary/20 text-primary text-xs font-black px-1.5 py-0.5 rounded-full">
                  {data.renewals.length}
                </span>
              )}
            </TabsTrigger>
            {showGaps && (
            <TabsTrigger value="gaps" className="text-xs flex items-center gap-1.5 h-9 shrink-0">
              <span>Insurance Gaps</span>
              {data.insuranceGaps.length > 0 && (
                <span className="bg-primary/20 text-primary text-xs font-black px-1.5 py-0.5 rounded-full">
                  {data.insuranceGaps.length}
                </span>
              )}
            </TabsTrigger>
            )}
            {showGaps && (
            <TabsTrigger value="documents" className="text-xs flex items-center gap-1.5 h-9 shrink-0">
              <span>ID Document Gaps</span>
              {data.documentsPending.length > 0 && (
                <span className="bg-primary/20 text-primary text-xs font-black px-1.5 py-0.5 rounded-full">
                  {data.documentsPending.length}
                </span>
              )}
            </TabsTrigger>
            )}
            <TabsTrigger value="todos" className="text-xs flex items-center gap-1.5 h-9 shrink-0">
              <span>Pending To-Dos</span>
              {data.todosPending.length > 0 && (
                <span className="bg-primary/20 text-primary text-xs font-black px-1.5 py-0.5 rounded-full">
                  {data.todosPending.length}
                </span>
              )}
            </TabsTrigger>
          </TabsList>

          {/* 1. Renewals & Expiry Content */}
          <TabsContent value="renewals" className="flex flex-col gap-4 mt-6">
            {data.renewals.length === 0 ? (
              <div className="text-center p-8 text-muted-foreground text-xs">No upcoming or overdue renewals.</div>
            ) : (
              data.renewals.map((r) => (
                <Card
                  key={r.id}
                  className={`border-l-4 ${r.severity === 'URGENT' ? 'border-l-rose-500 bg-rose-50/80 dark:bg-rose-950/20 border-rose-200 dark:border-rose-900/50' : r.severity === 'WARNING' ? 'border-l-amber-500 bg-amber-50/80 dark:bg-amber-950/20 border-amber-200 dark:border-amber-900/50' : 'border-l-primary bg-card'} backdrop-blur border p-4 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 hover:shadow-md transition-all`}
                >
                  <div className="flex flex-col gap-1.5 min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold text-foreground text-sm">{r.title}</span>
                      {renderSeverityBadge(r.severity, r.daysLeft)}
                    </div>
                    <p className="text-xs text-muted-foreground leading-relaxed">{r.message}</p>
                    {r.recommendedAction && (
                      <div className="mt-1 text-xs text-primary font-medium flex items-center gap-1.5">
                        <ArrowRight size={13} />
                        <span>Recommended Action: {r.recommendedAction}</span>
                      </div>
                    )}
                    <span className="text-xs font-semibold text-muted-foreground flex items-center gap-1 mt-1">
                      <Calendar size={11} /> Due / Expiry Date: {formatDate(r.dueDate)}
                    </span>
                  </div>
                  <Button
                    size="sm"
                    onClick={() => window.location.href = r.link}
                    className="shrink-0 text-xs flex items-center gap-1.5"
                  >
                    {/* The verb comes from the record's own category — see
                        src/lib/records/followUpActions.ts. The fallback is for
                        a response cached before the field existed. */}
                    <span>{r.actionLabel || 'Review & Renew'}</span>
                    <ExternalLink size={14} />
                  </Button>
                </Card>
              ))
            )}
          </TabsContent>

          {/* 2. Insurance Gaps */}
          {showGaps && (
          <TabsContent value="gaps" className="flex flex-col gap-4 mt-6">
            {data.insuranceGaps.length === 0 ? (
              <div className="text-center p-8 text-muted-foreground text-xs">No insurance gaps found.</div>
            ) : (
              data.insuranceGaps.map((g) => (
                <Card
                  key={g.id}
                  className={`border-l-4 ${g.severity === 'URGENT' ? 'border-l-rose-500 bg-rose-50/80 dark:bg-rose-950/20 border-rose-200' : 'border-l-cyan-500 bg-cyan-50/70 dark:bg-cyan-950/20 border-cyan-200 dark:border-cyan-900/50'} backdrop-blur border p-4 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 hover:shadow-md transition-all`}
                >
                  <div className="flex flex-col gap-1.5 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold text-foreground text-sm">{g.title}</span>
                      {renderSeverityBadge(g.severity)}
                    </div>
                    <p className="text-xs text-muted-foreground leading-relaxed">{g.message}</p>
                    {g.recommendedAction && (
                      <div className="mt-1 text-xs text-primary font-medium flex items-center gap-1.5">
                        <ArrowRight size={13} />
                        <span>Recommended Action: {g.recommendedAction}</span>
                      </div>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => window.location.href = g.link}
                    className="shrink-0 text-xs flex items-center gap-1.5 border-cyan-500/40 hover:bg-cyan-500/10 text-cyan-700 dark:text-cyan-400 font-bold"
                  >
                    <span>Resolve Gap</span>
                    <ExternalLink size={14} />
                  </Button>
                </Card>
              ))
            )}
          </TabsContent>
          )}

          {/* 3. ID Document Gaps */}
          {showGaps && (
          <TabsContent value="documents" className="flex flex-col gap-4 mt-6">
            {data.documentsPending.length === 0 ? (
              <div className="text-center p-8 text-muted-foreground text-xs">All essential ID documents are on file.</div>
            ) : (
              data.documentsPending.map((d) => (
                <Card
                  key={d.id}
                  className={`border-l-4 ${d.severity === 'URGENT' ? 'border-l-rose-500 bg-rose-50/80 dark:bg-rose-950/20 border-rose-200' : 'border-l-amber-500 bg-amber-50/70 dark:bg-amber-950/20 border-amber-200 dark:border-amber-900/50'} backdrop-blur border p-4 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 hover:shadow-md transition-all`}
                >
                  <div className="flex flex-col gap-1.5 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold text-foreground text-sm">{d.title}</span>
                      {renderSeverityBadge(d.severity)}
                    </div>
                    <p className="text-xs text-muted-foreground leading-relaxed">{d.message}</p>
                    {d.recommendedAction && (
                      <div className="mt-1 text-xs text-primary font-medium flex items-center gap-1.5">
                        <ArrowRight size={13} />
                        <span>Recommended Action: {d.recommendedAction}</span>
                      </div>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => window.location.href = d.link}
                    className="shrink-0 text-xs flex items-center gap-1.5 border-amber-500/40 hover:bg-amber-500/10 text-amber-700 dark:text-amber-400 font-bold"
                  >
                    <span>Upload Document</span>
                    <ExternalLink size={14} />
                  </Button>
                </Card>
              ))
            )}
          </TabsContent>
          )}

          {/* 4. Pending To-Dos */}
          <TabsContent value="todos" className="flex flex-col gap-4 mt-6">
            {data.todosPending.length === 0 ? (
              <div className="text-center p-8 text-muted-foreground text-xs">No pending to-do items.</div>
            ) : (
              data.todosPending.map((t) => (
                <Card
                  key={t.id}
                  className="border-l-4 border-l-emerald-500 bg-emerald-50/70 dark:bg-emerald-950/20 border border-emerald-200 dark:border-emerald-900/50 p-4 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 hover:shadow-md transition-all"
                >
                  <div className="flex flex-col gap-1.5 min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold text-foreground text-sm truncate min-w-0">{t.task}</span>
                      {renderSeverityBadge(t.severity, t.daysLeft)}
                    </div>
                    <div className="flex items-center gap-3 mt-1 flex-wrap">
                      {t.dueDate && (
                        <span className="text-xs font-semibold text-muted-foreground flex items-center gap-1">
                          <Clock size={11} /> Due: {formatDate(t.dueDate)}
                        </span>
                      )}
                      {t.assignee && (
                        <span className="text-xs font-semibold text-muted-foreground flex items-center gap-1">
                          <UserCheck size={11} /> Assignee: {t.assignee.name}
                        </span>
                      )}
                    </div>
                    {t.recommendedAction && (
                      <div className="mt-1 text-xs text-emerald-700 dark:text-emerald-400 font-medium flex items-center gap-1.5">
                        <ArrowRight size={13} />
                        <span>Recommended Action: {t.recommendedAction}</span>
                      </div>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => window.location.href = '/todos'}
                    className="shrink-0 text-xs flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/10 font-bold"
                  >
                    <span>View Task</span>
                    <ExternalLink size={14} />
                  </Button>
                </Card>
              ))
            )}
          </TabsContent>
        </Tabs>
      )}
    </PageContainer>
  );
}
