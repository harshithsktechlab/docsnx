import * as React from 'react';
import { cva } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  // `text-2xs` (11px, rem) rather than a hard 10px: a badge is usually the only
  // thing carrying a record's status, and at 10px absolute it also ignored the
  // app's text-size stepper. See fontSize in tailwind.config.js.
  'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-2xs font-bold uppercase tracking-[0.03em] transition-colors whitespace-nowrap',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        // `text-foreground/80` over the muted fill, not `text-muted-foreground`:
        // these two are the neutral badge, and a badge that is the same colour
        // as the caption beside it stops reading as a badge at all.
        secondary: 'border-border bg-muted text-foreground/80',
        // Same three-token split as <Alert>: an alpha tint of one mid-tone was
        // legible against exactly one of the two themes. See src/app/globals.css.
        // `destructive` and `danger` are the same badge under two names, kept
        // because callsites use both; neither may go back to `--destructive`,
        // which is a button fill (#7F1D1D on dark) and not a text colour.
        destructive: 'bg-danger-surface text-danger-text border-danger-border',
        danger: 'bg-danger-surface text-danger-text border-danger-border',
        success: 'bg-success-surface text-success-text border-success-border',
        warning: 'bg-warning-surface text-warning-text border-warning-border',
        info: 'bg-info-surface text-info-text border-info-border',
        muted: 'border-border bg-muted text-foreground/80',
        outline: 'border-border text-foreground',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
);

function Badge({ className, variant, ...props }) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
