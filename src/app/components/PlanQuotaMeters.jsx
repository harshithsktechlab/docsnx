'use client';

import { cn } from '@/lib/utils';
import { storagePressure } from '@/lib/storagePressure';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   PLAN QUOTA METERS — STORAGE AND AI CREDITS                            ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Lifted out of the Shell sidebar footer, where it was inlined and therefore
 * `hidden lg:flex` along with the whole <aside>. That made a tenant's AI
 * consumption invisible on every phone — the thing you pay for, readable only
 * on a desktop.
 *
 * Purely presentational: both callers already hold `planDetails` and
 * `storageData` from `clientGetMe()`, so this takes them as props rather than
 * fetching a second time.
 *
 * The credits arithmetic is deliberately unchanged from the sidebar version —
 * the `Math.max(5, …)` floor that keeps a nearly-empty bar visible.
 *
 * The storage bar reads its colour from `storagePressure`, the same rule the
 * warning toast and the server use, so a tenant cannot see an amber bar and a
 * reassuring message on the same screen. It replaced a local `0.9` constant
 * that only the plan branch consulted: the Drive branch was pinned emerald and
 * would have stayed green at 100% full.
 */

const GB = 1024 * 1024 * 1024;

export default function PlanQuotaMeters({
  planDetails,
  storageData,
  /**
   * The live balance. Falls back to the plan's allowance so a tenant whose
   * ledger row has not been written yet reads as "full", never as zero — a
   * false zero here looks like an outage of the thing they bought.
   */
  aiCreditsBalance,
  /** `lg` gives the standalone card treatment; `sm` matches the sidebar footer. */
  size = 'sm',
  className,
}) {
  if (!planDetails) return null;

  const large = size === 'lg';
  const labelClass = cn('font-bold text-muted-foreground uppercase', large ? 'text-xs' : 'text-xs');
  const valueClass = cn('font-bold', large ? 'text-xs' : 'text-2xs');
  const trackClass = cn('w-full bg-muted rounded-full overflow-hidden', large ? 'h-2' : 'h-1.5');

  const credits = aiCreditsBalance ?? planDetails.aiCredits;

  // The storage bar. A Drive tenant is measured against their own Drive; a plan
  // tenant against the plan. `unlimited` means the ceiling is not merely large
  // but UNKNOWN — a Drive quota we have not read yet — so the bar reports the
  // bytes used and no fill rather than implying an empty disk.
  const pressure = storagePressure(storageData);
  // `storageData.limitBytes` is authoritative for BOTH kinds: the tenant's Drive
  // ceiling, or the plan allowance WITH any storage add-ons already folded in by
  // checkStorageLimit. `planDetails.storageLimitGB` is the bare plan and is only
  // the fallback — using it for the width while `pressure` read the add-on
  // limit would fill the bar faster than it changes colour.
  const limitBytes = Number.isFinite(storageData?.limitBytes) && storageData.limitBytes > 0
    ? storageData.limitBytes
    : planDetails.storageLimitGB * GB;
  const measurable =
    !!storageData && !storageData.unlimited && Number.isFinite(limitBytes) && limitBytes > 0;

  const fillPercent = measurable
    ? Math.min(100, (storageData.currentBytes / limitBytes) * 100)
    : 0;
  const fillClass = pressure === 'full'
    ? 'bg-destructive'
    : pressure === 'warning' ? 'bg-amber-500' : 'bg-primary';
  const usedClass = pressure === 'full'
    ? 'text-destructive'
    : pressure === 'warning' ? 'text-amber-500' : 'text-primary';

  return (
    <div className={cn('flex flex-col', large ? 'gap-4' : 'gap-2.5 px-1', className)}>
      {storageData && (
        <div className="flex flex-col gap-1">
          <div className="flex justify-between items-center gap-2 px-0.5">
            <span className={labelClass}>
              {storageData.isGoogleDrive ? 'Drive Sync Storage' : planDetails.name + ' Storage'}
            </span>
            <span className={cn(valueClass, usedClass)}>
              {measurable
                ? `${(storageData.currentBytes / GB).toFixed(2)} / ${(limitBytes / GB).toFixed(0)} GB`
                : `${(storageData.currentBytes / GB).toFixed(2)} GB used`}
            </span>
          </div>
          <div className={trackClass}>
            <div
              className={cn('h-full rounded-full transition-all', fillClass)}
              style={{ width: `${fillPercent}%` }}
            />
          </div>
        </div>
      )}

      {typeof planDetails.aiCredits === 'number' && (
        <div className="flex flex-col gap-1">
          <div className="flex justify-between items-center gap-2 px-0.5">
            <span className={labelClass}>AI Credits</span>
            <span className={cn(valueClass, 'text-accent')}>
              {credits.toLocaleString()} / {planDetails.aiCredits.toLocaleString()}
            </span>
          </div>
          <div className={trackClass}>
            <div
              className="h-full rounded-full bg-gradient-to-r from-accent to-primary transition-all"
              style={{
                width: `${planDetails.aiCredits > 0 ? Math.min(100, Math.max(5, (credits / planDetails.aiCredits) * 100)) : 100}%`,
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
