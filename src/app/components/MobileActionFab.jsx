'use client';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE MOBILE FAB — A FIXED BUTTON THAT RESERVES ITS OWN SCROLL ROOM      ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Two pages float a primary action above the bottom nav on a phone: the
 * Document Manager (Power Scan + Add) and every sub-category workspace (Add).
 * Both used to hand-write the same `fixed right-4 bottom-[88px]` geometry, each
 * with a comment saying the two must agree — which is not a mechanism.
 *
 * ── WHY THE SPACER ─────────────────────────────────────────────────────────
 * A `position: fixed` button is out of flow, so the page has no idea it is
 * there and scrolls its last row straight underneath it. That is exactly what
 * happened: at maximum scroll the pagination row's "Next" button — right
 * aligned, like the FAB — sat under the Add button and could not be tapped.
 *
 * So this component renders TWO things: the fixed stack, and an in-flow
 * `aria-hidden` spacer at the same point in the tree. The spacer is the fix.
 * Putting it here rather than as `pb-*` on each page means a page cannot forget
 * it, and `PageContainer` keeps its rule of declaring no padding of its own.
 *
 * The arithmetic, so the next person can check it rather than trust it. Below
 * the last in-flow row a page already has:
 *
 *     76px  Shell's `pb-[76px]` (the bottom nav)
 *   + 16px  `.page-gutter`'s padding-bottom
 *   + 32px  PageContainer's `pb-8`
 *   ------
 *     124px   + this spacer
 *
 * and the stack's TOP edge sits at `BOTTOM_OFFSET + stackHeight` above the
 * viewport bottom. With a spacer of `stackHeight + GAP` the last row therefore
 * clears the stack by exactly `124 + GAP - BOTTOM_OFFSET` = 48px, whatever the
 * stack holds. `env(safe-area-inset-bottom)` appears on both sides — Shell's
 * padding and the stack's offset — so it cancels and is not counted here.
 */

import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** Above the bottom nav (76px) with room to breathe. */
const BOTTOM_OFFSET = 88;
/** `gap-3` between stacked buttons, and the spacer's own breathing room. */
const GAP = 12;
/** `h-14 w-14` and `h-11 w-11` — kept as numbers because the spacer needs them. */
const SIZE = { primary: 56, secondary: 44 };

/**
 * @param {{ actions: Array<{
 *   key: string,
 *   icon: React.ReactNode,
 *   label: string,          // the accessible name; there is no visible one
 *   onClick: () => void,
 *   primary?: boolean,      // one per stack, and it goes at the bottom
 *   variant?: string,
 * }>, className?: string }} props
 */
export default function MobileActionFab({ actions = [], className }) {
  const items = actions.filter(Boolean);

  const stackHeight = items.reduce(
    (total, action, i) => total + SIZE[action.primary ? 'primary' : 'secondary'] + (i > 0 ? GAP : 0),
    0,
  );

  /* The PWA install banner is `z-[100]` and 90% of the viewport wide — it used
     to land on this stack and swallow the taps, with its own dismiss X in the
     overlapped corner. It reads this to sit above whatever is here, and falls
     back to 0px on the pages that float nothing. */
  useEffect(() => {
    if (!items.length) return undefined;
    const root = document.documentElement;
    root.style.setProperty('--fab-stack', `${stackHeight}px`);
    return () => root.style.removeProperty('--fab-stack');
  }, [items.length, stackHeight]);

  if (!items.length) return null;

  return (
    <>
      {/* Scroll room for the fixed stack below. Not decorative — see above. */}
      <div aria-hidden className="sm:hidden" style={{ height: `${stackHeight + GAP}px` }} />

      <div
        className={cn('sm:hidden fixed right-4 z-30 flex flex-col items-center', className)}
        style={{
          bottom: `calc(${BOTTOM_OFFSET}px + env(safe-area-inset-bottom))`,
          gap: `${GAP}px`,
        }}
      >
        {items.map((action) => (
          <Button
            key={action.key}
            onClick={action.onClick}
            aria-label={action.label}
            variant={action.variant}
            className={cn(
              'rounded-full p-0',
              action.primary ? 'h-14 w-14 shadow-xl' : 'h-11 w-11 shadow-lg',
            )}
          >
            {action.icon}
          </Button>
        ))}
      </div>
    </>
  );
}
