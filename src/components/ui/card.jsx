import * as React from 'react';
import { cn } from '@/lib/utils';

/*
 * OPAQUE, not a 60% wash.
 *
 * `bg-card/60 backdrop-blur-glass` was a dark-mode idiom: 60% of a near-black
 * card over a near-black page still separates. In light mode both tokens were
 * white, so the card WAS the page — the reason nothing on a light screen looked
 * like a discrete object. The canvas is tinted now (see :root in globals.css)
 * and the card owns the white, so the translucency has nothing left to do.
 *
 * Dropping `backdrop-blur-glass` with it is deliberate: a backdrop-filter forces
 * a compositing layer per card and there is nothing behind an opaque surface to
 * blur. On a list of twenty records that is twenty layers a phone was painting
 * for no visible effect.
 */
const Card = React.forwardRef(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      'rounded-xl border border-border bg-card shadow-glass transition-all duration-300',
      className
    )}
    {...props}
  />
));
Card.displayName = 'Card';

const CardHeader = React.forwardRef(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn('flex flex-col space-y-1.5 p-6', className)}
    {...props}
  />
));
CardHeader.displayName = 'CardHeader';

const CardTitle = React.forwardRef(({ className, ...props }, ref) => (
  <h3
    ref={ref}
    className={cn('text-base font-bold leading-none tracking-tight text-foreground', className)}
    {...props}
  />
));
CardTitle.displayName = 'CardTitle';

const CardDescription = React.forwardRef(({ className, ...props }, ref) => (
  <p
    ref={ref}
    className={cn('text-xs text-muted-foreground', className)}
    {...props}
  />
));
CardDescription.displayName = 'CardDescription';

const CardContent = React.forwardRef(({ className, ...props }, ref) => (
  <div ref={ref} className={cn('p-6 pt-0', className)} {...props} />
));
CardContent.displayName = 'CardContent';

const CardFooter = React.forwardRef(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn('flex items-center p-6 pt-0', className)}
    {...props}
  />
));
CardFooter.displayName = 'CardFooter';

export { Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent };
