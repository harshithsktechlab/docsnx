'use client';

import { cn } from '@/lib/utils';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE PAGE CONTAINER — ONE LEFT EDGE FOR EVERY MODULE                    ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `<main>` in Shell.js already owns TWO things: the page gutter
 * (`p-4 md:p-6 lg:p-8`, safe-area aware) and the outer cap (`max-w-[1600px]`).
 * Roughly a third of the pages used to re-declare one or both, which is why no
 * two modules lined up: Loans & Debt added its own `p-6` and sat 24px narrower
 * than Medical at every breakpoint, and the whole super-admin console forgot
 * `mx-auto` and hugged the sidebar.
 *
 * So this component declares NO PADDING OF ITS OWN, deliberately, and it never
 * should. It contributes exactly three things: the readable width cap, the
 * centring, and the vertical rhythm between blocks.
 *
 * ── ADDING A PAGE ──────────────────────────────────────────────────────────
 * Wrap the page body in <PageContainer> and pick a width. Do not add `p-*`,
 * `px-*` or `mx-auto` on top — the first fights the gutter, the last is
 * already here.
 *
 * `space-y-*` pages pass it through `className`; the `gap` is dropped for them
 * automatically so the two spacing systems cannot both apply.
 */

const WIDTHS = {
  /** Modules, record lists, admin consoles — anything with a table or a grid. */
  default: 'max-w-7xl',
  /** Wide read/scan surfaces that still want a cap. */
  wide: 'max-w-6xl',
  /** Mixed list/detail pages: Follow-up, Billing. */
  medium: 'max-w-5xl',
  /** Settings-style pages and long-form prose: a single column. */
  narrow: 'max-w-4xl',
  /** A lone form or wizard: Settings. */
  form: 'max-w-3xl',
  /** A single card: Backup, the plan-lock screen. */
  compact: 'max-w-2xl',
};

export default function PageContainer({
  width = 'default',
  className,
  children,
  ...props
}) {
  // A caller that brought its own `space-y-*` is using the other spacing
  // system; applying `gap-6` as well would silently add to every margin.
  const hasOwnSpacing = /(^|\s)(space-y-|gap-)/.test(className || '');

  return (
    <div
      /* The hook e2e/mobile-layout.spec.ts anchors on. It asserts this
         element's left edge is EXACTLY the page gutter, which is the single
         check that catches a page re-declaring padding of its own. */
      data-page-container=""
      className={cn(
        'flex w-full flex-col mx-auto pb-8',
        !hasOwnSpacing && 'gap-6',
        WIDTHS[width] || WIDTHS.default,
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}
