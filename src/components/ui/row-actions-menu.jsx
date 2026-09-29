'use client';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   ROW ACTIONS MENU — the ⋮ on every record row, anchored via a portal    ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * One menu for all ~20 record lists (Documents, every module document list, and
 * the 17 card-grid vaults). It replaces a `position: absolute` panel that was
 * copy-pasted into each page and was clipped in two different ways:
 *
 * ── WHY A PORTAL, NOT ABSOLUTE POSITIONING ─────────────────────────────────
 * 1. The DataTable lists it inside `overflow-hidden` (data-table.jsx) wrapped
 *    around `overflow-auto` (table.jsx). A menu opening downward off the LAST
 *    row fell outside both boxes and vanished entirely.
 * 2. The card grids give every <Card> a `backdrop-blur`. A `backdrop-filter`
 *    ancestor creates a STACKING CONTEXT, so the panel's `z-50` was scoped to
 *    its own card and painted BEHIND the next card in the grid — and, less
 *    obviously, it becomes the containing block for `position: fixed`
 *    descendants, so the full-screen click-away scrim only covered that card.
 *
 * Rendering into document.body is what makes the panel free of all of it. Same
 * reasoning, same technique as src/app/components/ModuleFlyout.jsx.
 *
 * ── THE MENU DECIDES WHETHER IT EXISTS ─────────────────────────────────────
 * `items` accepts falsy entries so callers keep their `may(doc, 'edit') && {…}`
 * idiom. If everything filters out, this renders NOTHING — an empty ⋮ is a
 * promise the menu cannot keep. Callers therefore no longer need to repeat the
 * permission expressions once to gate the button and again to gate each row.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MoreVertical } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** The panel's width. `w-36`, kept as a number because layout needs to do maths. */
const PANEL_WIDTH = 144;
/** Gap between the trigger and the panel — the old `mt-1`. */
const GAP = 4;
/** Closest the panel may sit to a viewport edge. */
const MARGIN = 8;

/**
 * Where the panel goes: right edge aligned to the trigger's, below it if there
 * is room and FLIPPED ABOVE it if there is not. Both axes are clamped to the
 * viewport, so a trigger near a corner still yields a fully visible panel.
 *
 * `height` is measured from the rendered panel, so this runs in a layout effect
 * (after layout, before paint) rather than in a plain effect — otherwise the
 * menu paints at 0,0 for one frame and reads as a flash in the corner.
 *
 * `width` defaults to this menu's own 144px. It is a parameter because the rule
 * — right-align, flip, clamp — is the same for any panel hung off a header
 * button, and the workspace switcher needs a wider one; a second copy of this
 * function is how the two would come to disagree about the 8px margin.
 */
export function anchorMenu(rect, height, viewport, width = PANEL_WIDTH) {
  const { width: vw, height: vh } = viewport;

  let left = rect.right - width;
  left = Math.min(Math.max(left, MARGIN), Math.max(MARGIN, vw - width - MARGIN));

  let top = rect.bottom + GAP;
  if (top + height > vh - MARGIN) {
    const flipped = rect.top - height - GAP;
    // Above is only better if it actually fits there; a panel taller than the
    // viewport fits nowhere, so it pins to the top and scrolls internally.
    top = flipped >= MARGIN ? flipped : MARGIN;
  }

  return { top, left };
}

export default function RowActionsMenu({
  /**
   * `[{ key, label, icon, onClick, destructive?, disabled? }]`. Falsy entries
   * are dropped, so `permission && { … }` works as a gate.
   */
  items = [],
  /** Greys the trigger — e.g. while a bulk selection is up. */
  disabled = false,
  title = 'More actions',
  /** `outline` matches the table rows, `ghost` the card grids. */
  variant = 'outline',
  triggerClassName,
  iconSize = 13,
}) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [position, setPosition] = useState(null);
  const triggerRef = useRef(null);
  const panelRef = useRef(null);

  const visible = items.filter(Boolean);

  const close = useCallback(() => setOpen(false), []);

  // Portals need a DOM to render into, which the server render does not have.
  useEffect(() => setMounted(true), []);

  // A menu left open once its trigger has been disabled keeps offering actions
  // the row itself has stopped offering — e.g. Documents greys every row control
  // the moment a bulk selection takes over.
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  const reposition = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPosition(
      anchorMenu(rect, panelRef.current?.offsetHeight ?? 0, {
        width: window.innerWidth,
        height: window.innerHeight,
      })
    );
  }, []);

  useLayoutEffect(() => {
    if (open) reposition();
  }, [open, visible.length, reposition]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    // A fixed panel does not travel with the row it belongs to, so it is
    // re-anchored rather than dismissed. Closing on scroll was the obvious
    // alternative and is wrong on a phone: hiding the URL bar fires both of
    // these, so the menu would shut on the very tap that opened it.
    // Captured, because the scroll that matters is often the table's own
    // `overflow-auto` box rather than the window.
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open, close, reposition]);

  if (visible.length === 0) return null;

  return (
    <>
      <Button
        ref={triggerRef}
        type="button"
        variant={variant}
        size="icon"
        disabled={disabled}
        onClick={(e) => {
          // Several of these rows are themselves clickable cards; the ⋮ is the
          // one thing on them that must not also open the record.
          e.stopPropagation();
          setOpen((prev) => !prev);
        }}
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={title}
        className={triggerClassName}
      >
        <MoreVertical size={iconSize} />
      </Button>

      {mounted && open && createPortal(
        <>
          {/* Catches the click that dismisses it. Transparent, and genuinely
              full-screen now that it is not trapped inside a blurred card. */}
          <div
            className="fixed inset-0 z-[9998] cursor-default"
            onClick={(e) => { e.stopPropagation(); close(); }}
          />
          <div
            ref={panelRef}
            role="menu"
            style={{
              top: position?.top ?? 0,
              left: position?.left ?? 0,
              width: PANEL_WIDTH,
              // Hidden until measured: `position` is null on the very first
              // render, and 0,0 for a frame is a flash in the corner.
              visibility: position ? 'visible' : 'hidden',
            }}
            className="fixed z-[9999] max-h-[60vh] origin-top-right overflow-y-auto rounded-lg border border-border bg-background py-1 shadow-xl"
          >
            {visible.map((item) => (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                onClick={(e) => {
                  // React portals bubble through the COMPONENT tree, not the DOM
                  // one, so without this an item click still reaches the card
                  // this menu was opened from.
                  e.stopPropagation();
                  // Close FIRST: several handlers open a modal or start a
                  // download, and the menu must not outlive the row it acted on.
                  close();
                  item.onClick?.();
                }}
                className={cn(
                  'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors disabled:pointer-events-none disabled:opacity-50',
                  item.destructive
                    ? 'text-danger-action hover:bg-red-500/10'
                    : 'text-foreground hover:bg-muted'
                )}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            ))}
          </div>
        </>,
        document.body
      )}
    </>
  );
}
