import * as React from 'react';
import { cva } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * ── WHY THESE ARE OPAQUE SURFACES AND NOT `/10` TINTS ──────────────────────
 *
 * Every variant used to be `bg-X/10 border-X/20 text-X` — one mid-tone colour
 * doing all three jobs. That is legible against exactly one background, and the
 * app has two: `text-destructive` on dark resolved to #7F1D1D over a near-black
 * card at 1.87:1, and `text-warning` on light was amber-on-white at 1.99:1. AA
 * body text needs 4.5:1. The red-on-black alert nobody could read on the
 * bulk-scan review screen was this, not a styling accident on that page.
 *
 * So text, surface and border are three separate theme-aware tokens now (see
 * src/app/globals.css). The surface is opaque rather than an alpha tint because
 * these alerts sit on `.glass-card`, whose translucency would otherwise let the
 * page gradient through and move the contrast ratio around per placement.
 *
 * The left bar is painted with the TEXT token, not the border token: at 4px it
 * is the thing that identifies the alert at a glance while scanning a long
 * form, so it has to clear the page on its own (5:1+) rather than merely
 * separate the surface from it (~1.5:1).
 */
const alertVariants = cva(
  // `[&>svg]` targets the icon every callsite passes as the first child: it must
  // not shrink when the body wraps to a second line, and it reads as centred on
  // the first line rather than on the block. Handled here so all 28 callers get
  // it without an edit. Icons inherit `currentColor`, so they follow the variant.
  'relative w-full rounded-xl border border-l-4 p-4 flex items-start gap-3 text-sm font-medium '
    + '[&>svg]:shrink-0 [&>svg]:mt-0.5',
  {
    variants: {
      variant: {
        default:     'bg-info-surface    border-info-border    border-l-info-text    text-info-text',
        destructive: 'bg-danger-surface  border-danger-border  border-l-danger-text  text-danger-text',
        success:     'bg-success-surface border-success-border border-l-success-text text-success-text',
        warning:     'bg-warning-surface border-warning-border border-l-warning-text text-warning-text',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
);

const Alert = React.forwardRef(({ className, variant, ...props }, ref) => (
  <div
    ref={ref}
    role="alert"
    className={cn(alertVariants({ variant }), className)}
    {...props}
  />
));
Alert.displayName = 'Alert';

const AlertTitle = React.forwardRef(({ className, ...props }, ref) => (
  <h5
    ref={ref}
    className={cn('font-bold leading-none tracking-tight', className)}
    {...props}
  />
));
AlertTitle.displayName = 'AlertTitle';

const AlertDescription = React.forwardRef(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn('text-sm [&_p]:leading-relaxed', className)}
    {...props}
  />
));
AlertDescription.displayName = 'AlertDescription';

export { Alert, AlertTitle, AlertDescription };
