'use client';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   MODULE OVERVIEW — /modules/<moduleKey>                                 ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * This is where a sub-category gets chosen. The sidebar used to open a flyout
 * listing them, which was a second copy of this page's list shown one click
 * earlier — and a menu to dismiss before anything else could be done. The
 * sidebar is now fourteen plain links and this page owns the list.
 *
 * Because it is the only list, it has to carry enough to choose WITH: how many
 * records are in each sub-category, how many are missing their document, and
 * what is overdue or coming up. Those come from `/counts` in one request for
 * the whole module — sixteen summary calls for Business would be absurd, and
 * they are answered from Postgres without touching Drive.
 *
 * Sub-categories the member cannot view are absent, filtered by the same
 * `usePermittedCategories` the sidebar uses. The pages behind them refuse
 * independently.
 */
import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  AlertTriangle, ArrowLeft, CalendarClock, ChevronRight, FileText, FolderOpen,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDate } from '@/lib/dateHelper';
import { cn } from '@/lib/utils';
import { ALL_NAV_MODULES, subCategoryPath } from '@/lib/moduleRegistry';
import { MODULE_COLORS, DEFAULT_MODULE_COLOR } from '@/lib/documentCategories';
import { moduleIcon } from '@/lib/moduleIcons';
import { usePermittedCategories } from '@/lib/usePermittedCategories';
import PageContainer from '@/app/components/PageContainer';
import { apiCall } from '@/lib/net/apiRequest';


/**
 * Serves BOTH `/modules/<moduleKey>` and
 * `/business/<companyId>/modules/<moduleKey>`.
 *
 * One component rather than two pages: the list, the counts, the permission
 * filter and the empty states are identical, and the only differences are which
 * half of the taxonomy the module comes from and whether a company qualifies
 * the request. Two copies of this would drift the first time either changed.
 *
 * `companyId` comes from `useParams`, so it is simply absent on the personal
 * route — no prop threading and no second call site to keep in step.
 */
export default function ModuleOverview() {
  const { moduleKey, companyId } = useParams();
  const router = useRouter();
  const { permitted } = usePermittedCategories();
  const [counts, setCounts] = useState(null);

  /** `?companyId=` on every request, or '' on the personal route. */
  const companyQuery = companyId ? `?companyId=${encodeURIComponent(companyId)}` : '';
  /** Prefix for every link out of this page. */
  const prefix = companyId ? `/business/${companyId}` : '';

  const navModule = useMemo(
    // ALL_NAV_MODULES, not NAV_MODULES: this page serves the business rail too,
    // and NAV_MODULES is deliberately the personal half only.
    () => ALL_NAV_MODULES.find((m) => m.key === moduleKey),
    [moduleKey],
  );

  const subCategories = useMemo(() => {
    if (!navModule) return [];
    if (!permitted) return navModule.subCategories;
    const allowed = permitted.get(navModule.key);
    return navModule.subCategories.filter((s) => allowed?.has(s.documentKey));
  }, [navModule, permitted]);

  useEffect(() => {
    if (!navModule) return;
    let cancelled = false;
    (async () => {
      try {
        const { json } = await apiCall(`/api/modules/${navModule.key}/counts${companyQuery}`);
        if (cancelled || !json.success) return;
        setCounts(json.counts || {});
      } catch {
        // Counts are a signpost; the list itself still works without them.
        if (!cancelled) setCounts({});
      }
    })();
    return () => { cancelled = true; };
  }, [navModule, companyQuery]);

  /**
   * Totals across the module, for the header line.
   *
   * EVERY tile counts, mirrored ones included. A mirror tile shows records this
   * module displays but another module stores — Vehicle's "Vehicle insurance"
   * is the Insurance module's motor policies — and this line is a summary of
   * the tiles below it, so leaving them out would make the header disagree with
   * what the page visibly holds, and with the dashboard tile that opens it.
   *
   * Not a double count: the record exists exactly once, and appearing in two
   * modules' totals is that one fact stated from two places. The consequence to
   * keep in mind is that module totals no longer sum to the document total —
   * which is why nothing sums them. Each tile says where its records live.
   */
  const totals = useMemo(() => {
    if (!counts) return null;
    return Object.values(counts).reduce((acc, c) => ({
      total: acc.total + c.total,
      overdue: acc.overdue + c.overdue,
      dueSoon: acc.dueSoon + c.dueSoon,
      dataOnly: acc.dataOnly + c.dataOnly,
    }), { total: 0, overdue: 0, dueSoon: 0, dataOnly: 0 });
  }, [counts]);

  if (!navModule) {
    return (
      <PageContainer className="max-w-lg items-center gap-4 py-16 text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
          <FolderOpen size={24} />
        </span>
        <h1 className="text-lg font-bold">No such module</h1>
        <Button variant="outline" onClick={() => router.push(`${prefix}/dashboard`)} className="gap-2">
          <ArrowLeft size={14} /> Back to dashboard
        </Button>
      </PageContainer>
    );
  }

  const colors = MODULE_COLORS[navModule.key] || DEFAULT_MODULE_COLOR;
  // The same icon the sidebar and /more show for this module. It used to be the
  // module's ordinal, which said nothing about the category and read as a
  // bullet number beside the title.
  const ModuleIcon = moduleIcon(navModule.key);

  return (
    <PageContainer className="gap-5">
      <div className="flex items-center gap-3">
        <span
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl"
          style={{ color: colors.fg, backgroundColor: colors.bg }}
        >
          <ModuleIcon size={18} />
        </span>
        <div className="flex min-w-0 flex-col">
          <h1 className="truncate text-xl font-extrabold tracking-tight text-foreground sm:text-2xl">
            {navModule.name}
          </h1>
          <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
            <span>
              {subCategories.length} sub-categor{subCategories.length === 1 ? 'y' : 'ies'}
            </span>
            {totals && (
              <>
                <span aria-hidden>·</span>
                <span>{totals.total} record{totals.total === 1 ? '' : 's'}</span>
                {totals.overdue > 0 && (
                  <>
                    <span aria-hidden>·</span>
                    <span className="font-semibold text-danger-text">{totals.overdue} overdue</span>
                  </>
                )}
                {totals.dueSoon > 0 && (
                  <>
                    <span aria-hidden>·</span>
                    <span className="font-semibold text-amber-500">{totals.dueSoon} due soon</span>
                  </>
                )}
              </>
            )}
          </p>
        </div>
      </div>

      {subCategories.length === 0 ? (
        <Card className="border-border/50">
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            You do not have access to any sub-category in this module.
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {subCategories.map((sub) => {
            const count = counts?.[sub.documentKey];
            const empty = counts && (!count || count.total === 0);
            return (
              <button
                key={sub.documentKey}
                onClick={() => router.push(`${prefix}${subCategoryPath(navModule.key, sub.documentKey)}`)}
                className={cn(
                  'flex min-h-[88px] flex-col gap-2 rounded-xl border p-4 text-left transition-colors touch-manipulation',
                  'border-border/50 bg-card hover:border-primary/40 hover:bg-muted/30',
                  count?.overdue > 0 && 'border-destructive/40',
                )}
              >
                <span className="flex items-start justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-2.5">
                    <span
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
                      style={{ color: colors.fg, backgroundColor: colors.bg }}
                    >
                      <FileText size={14} />
                    </span>
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="min-w-0 break-words text-xs font-bold text-foreground">
                        {sub.name}
                      </span>
                      {/* Says whose records these are, so the number below is
                          not read as a second copy of them. */}
                      {count?.mirrored && count.mirrorOf && (
                        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          Shared from {ALL_NAV_MODULES.find((m) => m.key === count.mirrorOf.moduleKey)?.name
                            ?? count.mirrorOf.moduleKey}
                        </span>
                      )}
                    </span>
                  </span>
                  <ChevronRight size={15} className="mt-1 shrink-0 text-muted-foreground" />
                </span>

                {counts === null ? (
                  <Skeleton className="h-4 w-24" />
                ) : (
                  <span className="flex flex-wrap items-center gap-1.5">
                    {/* The record count is the headline; everything else is an
                        exception worth surfacing before the user clicks. */}
                    <span className={cn(
                      'rounded-md px-1.5 py-0.5 text-xs font-bold tabular-nums',
                      empty ? 'text-faint' : 'bg-primary/10 text-primary',
                    )}
                    >
                      {empty ? 'Nothing filed yet' : `${count.total} record${count.total === 1 ? '' : 's'}`}
                    </span>

                    {count?.overdue > 0 && (
                      <span className="flex items-center gap-1 rounded-md bg-danger-surface px-1.5 py-0.5 text-xs font-bold text-danger-text">
                        <AlertTriangle size={9} />
                        {count.overdue} overdue
                      </span>
                    )}
                    {count?.dueSoon > 0 && (
                      <span className="flex items-center gap-1 rounded-md bg-amber-500/10 px-1.5 py-0.5 text-xs font-bold text-amber-500">
                        <CalendarClock size={9} />
                        {count.dueSoon} due soon
                      </span>
                    )}
                    {count?.dataOnly > 0 && (
                      <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs font-semibold text-muted-foreground">
                        {count.dataOnly} no scan
                      </span>
                    )}
                  </span>
                )}

                {/* Only when nothing above already says something more urgent. */}
                {count?.nextDueAt && count.overdue === 0 && count.dueSoon === 0 && (
                  <span className="text-xs text-muted-foreground">
                    Next due {formatDate(count.nextDueAt)}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </PageContainer>
  );
}
