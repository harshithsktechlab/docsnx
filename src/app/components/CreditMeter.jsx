'use client';

/**
 * A workspace's AI credit balance, told the way a person reads it:
 *
 *   AI Credits                     490 left
 *   [█████░░░░░░░░░░░░░░░]
 *   of 2,000 received · 1,630 used      Adjust
 *
 * `received` and `used` are the ledger's own totals (credit_transactions), so
 * `received − used = left` for every workspace. It replaces "490 / 2,000
 * (Limit)", whose "limit" was only the current plan's credit amount: credits
 * accumulate across signup, trial, plan and add-on grants, so a balance above
 * that "limit" looked like a bug.
 */
import React from 'react';
import { cn } from '@/lib/utils';

export default function CreditMeter({ balance, received, used, onAdjust }) {
  const left = Number(balance || 0);
  const total = Math.max(Number(received || 0), left, 0);
  const pct = total > 0 ? Math.max(0, Math.min(100, (left / total) * 100)) : 0;
  const tone = left <= 0 || pct <= 10 ? 'bg-destructive' : pct <= 25 ? 'bg-amber-500' : 'bg-emerald-500';

  return (
    <div className="flex flex-col gap-1.5 mt-1 pt-1 border-t border-border/50">
      <div className="flex justify-between items-center text-2xs font-bold">
        <span className="text-muted-foreground">AI Credits</span>
        <span className={cn('text-foreground text-xs', left <= 0 && 'text-danger-text')}>
          {left.toLocaleString('en-IN')} <span className="font-normal text-muted-foreground">left</span>
        </span>
      </div>
      <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
        <div className={cn('h-full rounded-full', tone)} style={{ width: `${pct}%` }} />
      </div>
      <div className="flex justify-between items-center text-2xs text-muted-foreground">
        <span>
          of {Number(received || 0).toLocaleString('en-IN')} received · {Number(used || 0).toLocaleString('en-IN')} used
        </span>
        {onAdjust ? (
          <button type="button" onClick={onAdjust} className="font-bold text-primary hover:underline">
            Adjust
          </button>
        ) : null}
      </div>
    </div>
  );
}
