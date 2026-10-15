'use client';

import Link from 'next/link';
import { Users, UserCheck, UserPlus } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   SEATS — how full THIS workspace is                                     ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Seats are counted per workspace, never per account: the household against the
 * personal plan's total, each company against the business plan's per-company
 * allowance. So the Personal tab and the SAR tab show different numbers, and
 * neither is "the account's".
 *
 * `seats` is `{ scope, used, limit, remaining }` from GET /api/users, computed
 * by `seatUsage` — the same helper POST /api/users enforces with, so this
 * cannot report a free seat the form will refuse.
 */
export default function MemberSeatStats({ seats, workspaceName }) {
  if (!seats) return null;

  const { scope, used, limit, remaining } = seats;
  const business = scope === 'business';
  const where = business ? (workspaceName || 'this company') : 'the household';
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 100;

  const tone = remaining === 0
    ? { text: 'text-destructive', bar: 'bg-destructive', color: 'hsl(var(--destructive))' }
    : remaining === 1
      ? { text: 'text-amber-500', bar: 'bg-amber-500', color: '#f59e0b' }
      : { text: 'text-foreground', bar: 'bg-primary', color: '#10b981' };

  const tiles = [
    { name: 'Members', value: used, sub: `in ${where}`, icon: Users, color: '#8b5cf6' },
    {
      name: 'Seat limit',
      value: limit,
      sub: business ? 'per company on your Business plan' : 'on your Personal plan',
      icon: UserCheck,
      color: '#3b82f6',
    },
    {
      name: 'Seats remaining',
      value: remaining,
      sub: remaining === 0 ? 'workspace is full' : 'can still be added',
      icon: UserPlus,
      color: tone.color,
      valueClass: tone.text,
    },
  ];

  return (
    <div className="flex flex-col gap-3 animate-fade-in">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {tiles.map((t) => {
          const Icon = t.icon;
          return (
            <Card key={t.name} className="border-border/50 bg-card shadow-glass p-4 flex items-center gap-4">
              <span
                className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
                style={{ color: t.color, backgroundColor: `color-mix(in srgb, ${t.color} 12%, transparent)` }}
              >
                <Icon size={20} />
              </span>
              <div className="min-w-0">
                <div className={cn('text-2xl font-black leading-none', t.valueClass || 'text-foreground')}>
                  {t.value}
                </div>
                <div className="text-xs font-bold text-foreground mt-1.5 leading-none">{t.name}</div>
                <div className="text-xs text-muted-foreground mt-1 leading-tight truncate">{t.sub}</div>
              </div>
            </Card>
          );
        })}
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex justify-between items-center gap-2 text-xs">
          <span className="font-bold text-muted-foreground">
            {used} of {limit} seat{limit === 1 ? '' : 's'} used
          </span>
          {remaining === 0 && (
            <Link href="/billing" className="font-bold text-primary hover:underline">
              {business && limit === 0
                ? 'Your plan does not include a business account — upgrade'
                : 'Workspace full — upgrade or buy an add-on'}
            </Link>
          )}
        </div>
        <Progress value={pct} indicatorClassName={tone.bar} />
      </div>
    </div>
  );
}
