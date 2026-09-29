import * as React from 'react';
import { cn } from '@/lib/utils';

const Table = React.forwardRef(({ className, ...props }, ref) => (
  <div className="relative w-full overflow-auto">
    <table
      ref={ref}
      className={cn('w-full caption-bottom text-sm', className)}
      {...props}
    />
  </div>
));
Table.displayName = 'Table';

/*
 * The header owns its own fill. Callers used to pass `bg-muted/50` by hand —
 * only some of them did, so half the tables in the app had a header that was
 * indistinguishable from the first row. `hover:bg-transparent` on the header row
 * cancels the row hover inherited from <TableRow>: a column heading is not a
 * record and must not light up like one.
 */
const TableHeader = React.forwardRef(({ className, ...props }, ref) => (
  <thead
    ref={ref}
    className={cn(
      'bg-muted [&_tr]:border-b [&_tr]:border-border [&_tr:hover]:bg-transparent',
      className
    )}
    {...props}
  />
));
TableHeader.displayName = 'TableHeader';

const TableBody = React.forwardRef(({ className, ...props }, ref) => (
  <tbody
    ref={ref}
    className={cn('[&_tr:last-child]:border-0', className)}
    {...props}
  />
));
TableBody.displayName = 'TableBody';

const TableFooter = React.forwardRef(({ className, ...props }, ref) => (
  <tfoot
    ref={ref}
    className={cn('border-t border-border bg-muted/50 font-medium [&>tr]:last:border-b-0', className)}
    {...props}
  />
));
TableFooter.displayName = 'TableFooter';

/*
 * ── THREE CUES, EACH DOING A DIFFERENT JOB ─────────────────────────────────
 *
 * A row is findable when the eye can tell it from its neighbour, from the row
 * under the cursor, and from the one that is selected. This had one cue for all
 * three: `hover:bg-muted/30`, which in light mode was a 94% grey at 30% over
 * white — about half a percent of luminance, i.e. nothing.
 *
 *   zebra     — `even:bg-muted/50`, a static band so consecutive records are
 *               distinguishable while the mouse is nowhere near them. Sits under
 *               the hover because it is declared first.
 *   hover     — a brand tint rather than a grey one. Grey at a legible strength
 *               reads as "disabled"; the primary hue at 6% reads as "live", and
 *               being the same hue in both themes it needs no per-theme value.
 *   selected  — a stronger tint PLUS a 3px inset rail. The tint alone is a state
 *               you have to compare rows to notice; the rail is absolute, and it
 *               is an inset box-shadow rather than a border so it cannot shift
 *               the row's box by a pixel against its unselected neighbours.
 */
const TableRow = React.forwardRef(({ className, ...props }, ref) => (
  <tr
    ref={ref}
    className={cn(
      'border-b border-border transition-colors even:bg-muted/50',
      'hover:bg-primary/[0.06]',
      'data-[state=selected]:bg-primary/[0.09] data-[state=selected]:shadow-[inset_3px_0_0_0_hsl(var(--primary))]',
      className
    )}
    {...props}
  />
));
TableRow.displayName = 'TableRow';

const TableHead = React.forwardRef(({ className, ...props }, ref) => (
  <th
    ref={ref}
    className={cn(
      // `text-foreground/75`, not `text-muted-foreground`: at 11px uppercase a
      // column heading is already working hard to be read, and it was the same
      // colour as the secondary text in the cells below it.
      'h-11 px-4 text-left align-middle text-2xs font-bold uppercase tracking-wider text-foreground/75 [&:has([role=checkbox])]:pr-0',
      className
    )}
    {...props}
  />
));
TableHead.displayName = 'TableHead';

const TableCell = React.forwardRef(({ className, ...props }, ref) => (
  <td
    ref={ref}
    className={cn('px-4 py-3.5 align-middle text-sm [&:has([role=checkbox])]:pr-0', className)}
    {...props}
  />
));
TableCell.displayName = 'TableCell';

const TableCaption = React.forwardRef(({ className, ...props }, ref) => (
  <caption
    ref={ref}
    className={cn('mt-4 text-sm text-muted-foreground', className)}
    {...props}
  />
));
TableCaption.displayName = 'TableCaption';

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
};
