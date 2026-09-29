'use client';

/**
 * Accordion — the disclosure primitive the module navigation and the permission
 * matrix are both built from.
 *
 * Radix rather than <details>: it gives roving focus, correct aria-expanded /
 * aria-controls wiring, and a measured content height to animate against, none
 * of which <details> provides consistently across browsers.
 *
 * ── MOBILE ─────────────────────────────────────────────────────────────────
 * The trigger is `min-h-11` (44px) — the smallest reliably tappable target —
 * and `touch-manipulation` so a double-tap does not zoom instead of opening.
 * The chevron is the only affordance that moves, so an open section reads the
 * same at 375px as at 1440px.
 */
import * as React from 'react';
import * as AccordionPrimitive from '@radix-ui/react-accordion';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

const Accordion = AccordionPrimitive.Root;

const AccordionItem = React.forwardRef(({ className, ...props }, ref) => (
  <AccordionPrimitive.Item
    ref={ref}
    className={cn('border-b border-border/50', className)}
    {...props}
  />
));
AccordionItem.displayName = 'AccordionItem';

/**
 * `asChild` is forwarded so a caller can render its own row — the permission
 * matrix puts checkboxes in the header, which must not be nested inside the
 * trigger's button or clicking one would toggle the section.
 */
const AccordionTrigger = React.forwardRef(({ className, children, ...props }, ref) => (
  <AccordionPrimitive.Header className="flex">
    <AccordionPrimitive.Trigger
      ref={ref}
      className={cn(
        'flex flex-1 items-center justify-between gap-3 py-2.5 min-h-11 touch-manipulation',
        'text-left text-sm font-semibold text-foreground transition-colors',
        'hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-md',
        '[&[data-state=open]>svg]:rotate-180',
        className
      )}
      {...props}
    >
      {children}
      <ChevronDown
        size={16}
        aria-hidden="true"
        className="shrink-0 text-muted-foreground transition-transform duration-200"
      />
    </AccordionPrimitive.Trigger>
  </AccordionPrimitive.Header>
));
AccordionTrigger.displayName = 'AccordionTrigger';

const AccordionContent = React.forwardRef(({ className, children, ...props }, ref) => (
  <AccordionPrimitive.Content
    ref={ref}
    className="overflow-hidden data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down"
    {...props}
  >
    <div className={cn('pb-2 pt-0', className)}>{children}</div>
  </AccordionPrimitive.Content>
));
AccordionContent.displayName = 'AccordionContent';

export { Accordion, AccordionItem, AccordionTrigger, AccordionContent };
