import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   ONE RECORD, ON A PHONE                                                 ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Below `md`, <DataTable> stops rendering a table and hands each row to the
 * caller's `renderCard`. What that returns IS the record — the table adds only
 * `space-y-4` around it. So the chrome was the caller's problem, and five
 * callers solved it five ways: four hand-rolled some variation of
 * `rounded-xl border bg-card p-5 shadow-glass` and the vault module list
 * returned a bare `<div className="flex flex-col gap-2">`, which on a phone is
 * a stack of unseparated text with no edge between one record and the next.
 *
 * This is that chrome, once. `renderCard` returns the CONTENT; this draws the
 * object it sits in.
 *
 * ── SELECTION ──────────────────────────────────────────────────────────────
 * `selected` paints the same tint + 3px inset rail as a selected desktop row
 * (see <TableRow> in ./table.jsx) — deliberately the identical pair, so the two
 * layouts teach the same thing. The rail is an inset shadow rather than a
 * border for the same reason it is there: a border would resize the card by a
 * pixel and jog the whole list on every tick.
 *
 * `interactive` is opt-in and only for a card that is itself a button or link.
 * A card whose actions are buttons INSIDE it must not also lift on press, or
 * the record looks tappable in places where nothing happens.
 */
const RecordCard = React.forwardRef(
  ({ className, selected = false, interactive = false, ...props }, ref) => (
    <div
      ref={ref}
      data-state={selected ? 'selected' : undefined}
      className={cn(
        'rounded-xl border border-border bg-card p-4 shadow-glass transition-colors',
        interactive && 'cursor-pointer active:bg-primary/[0.06]',
        selected && 'bg-primary/[0.06] border-primary/50 shadow-[inset_3px_0_0_0_hsl(var(--primary))]',
        className
      )}
      {...props}
    />
  )
);
RecordCard.displayName = 'RecordCard';

export { RecordCard };
