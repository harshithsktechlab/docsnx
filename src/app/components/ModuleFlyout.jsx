'use client';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   MODULE FLYOUT — one module's sub-categories, on click                  ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Replaces the sidebar accordion. Clicking a module used to expand its
 * sub-categories INSIDE the sidebar, which meant 14 modules and up to 16
 * sub-categories each competing for a 260px column — and nothing at all when
 * the sidebar was collapsed to its 72px rail, since a rail has nowhere to put a
 * list. A flyout is not bound by the sidebar's width, so a 16-row module renders
 * in two columns beside it and the collapsed rail behaves exactly like the
 * expanded one.
 *
 * ── ONE COMPONENT, TWO PRESENTATIONS ───────────────────────────────────────
 * Desktop: a panel anchored to the trigger. Mobile: the same list as a bottom
 * sheet. Written once because they are the same menu — the mobile nav and the
 * sidebar drifted apart before (the /more page named ten modules out of
 * fifteen), and two components with one purpose is how that happens.
 *
 * ── WHY A PORTAL, NOT ABSOLUTE POSITIONING ─────────────────────────────────
 * The sidebar is `overflow-y-auto` AND `backdrop-blur-xl`. The overflow clips a
 * child that reaches past the sidebar's edge, and — less obviously — a
 * backdrop-filter ancestor becomes the containing block for `position: fixed`
 * descendants, so even `fixed` would be trapped inside it. Rendering into
 * document.body is what makes the panel free of both.
 *
 * ── PERMISSIONS ────────────────────────────────────────────────────────────
 * `subCategories` arrives already filtered to what the member may view (see
 * `usePermittedCategories`). This component renders what it is given and makes
 * no permission decisions of its own.
 *
 * ── AND NEITHER DOES IT BUILD A PATH ───────────────────────────────────────
 * Every route here — `modulePath` and each `subCategories[].path` — is handed in
 * already carrying its workspace, because `navModulesFrom` prefixes them with
 * `/business/<companyId>` inside a company. This file used to rebuild them from
 * `subCategoryPath(moduleKey, …)` instead, which drops that prefix: opening a
 * module in a company rail and clicking any row walked the user into the
 * HOUSEHOLD's copy of that category, silently, and the row for the page you
 * were standing on could never highlight because the two paths never matched.
 *
 * So there is deliberately no fallback to a locally-built path and no import
 * that would make one possible. A row with no `path` renders dead, which is the
 * failure worth having; a row in the wrong account is not.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePathname, useRouter } from 'next/navigation';
import { ChevronRight, X } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { cn } from '@/lib/utils';

/** Below this width the panel becomes a bottom sheet. Matches Tailwind's `lg`. */
const DESKTOP_MIN_WIDTH = 1024;

/** More than this many rows and the desktop panel splits into two columns. */
const TWO_COLUMN_THRESHOLD = 8;

const PANEL_WIDTH = { single: 268, double: 464 };

/**
 * Where the panel goes: beside the trigger, nudged up if it would run off the
 * bottom of the viewport, and flipped to the trigger's left if it would run off
 * the right. Computed from the live rect rather than from the sidebar's width,
 * so it follows the sidebar's drag-resize without being told about it.
 */
function anchorTo(rect, width, height) {
  if (!rect) return { top: 12, left: 12 };
  const margin = 8;
  let left = rect.right + margin;
  if (left + width > window.innerWidth - margin) {
    left = Math.max(margin, rect.left - width - margin);
  }
  let top = rect.top;
  if (top + height > window.innerHeight - margin) {
    top = Math.max(margin, window.innerHeight - height - margin);
  }
  return { top, left };
}

export default function ModuleFlyout({
  open,
  onClose,
  /** The trigger element, for anchoring. Ignored in the sheet presentation. */
  anchorRect,
  moduleName,
  /** The module's own page, prefixed for the workspace. See the header. */
  modulePath,
  subCategories = [],
  Icon,
}) {
  const router = useRouter();
  const pathname = usePathname();
  const panelRef = useRef(null);
  const [mounted, setMounted] = useState(false);
  const [isDesktop, setIsDesktop] = useState(true);
  const [position, setPosition] = useState({ top: 0, left: 0 });

  // Portals need a DOM to render into, which the server render does not have.
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    const sync = () => setIsDesktop(window.innerWidth >= DESKTOP_MIN_WIDTH);
    sync();
    window.addEventListener('resize', sync);
    return () => window.removeEventListener('resize', sync);
  }, []);

  const twoColumn = subCategories.length > TWO_COLUMN_THRESHOLD;
  const width = twoColumn ? PANEL_WIDTH.double : PANEL_WIDTH.single;

  // Positioned after layout, before paint: measuring in a plain effect lets the
  // panel render at 0,0 for one frame, which reads as a flash in the corner.
  useLayoutEffect(() => {
    if (!open || !isDesktop) return;
    const height = panelRef.current?.offsetHeight ?? 0;
    setPosition(anchorTo(anchorRect, width, height));
  }, [open, isDesktop, anchorRect, width, subCategories.length]);

  // Escape closes, everywhere. A menu that can only be dismissed by clicking
  // exactly outside it is a menu keyboard users get stuck in.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Navigating away closes it — otherwise the panel outlives the page it opened
  // from and hangs over the destination.
  useEffect(() => { if (open) onClose(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [pathname]);

  if (!mounted || !open) return null;

  const go = (path) => { router.push(path); onClose(); };

  const rows = (
    <div
      className={cn(
        'grid gap-0.5',
        twoColumn ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1',
      )}
    >
      {subCategories.map((sub) => {
        // Handed in, not built — see the note at the top of this file.
        const path = sub.path;
        const active = pathname === path;
        return (
          <button
            key={sub.documentKey}
            onClick={() => go(path)}
            title={sub.name}
            className={cn(
              // 44px minimum: this is the primary navigation on a touch screen.
              'flex items-center gap-2 w-full min-h-11 px-3 py-2.5 rounded-lg text-left',
              'text-xs font-medium transition-colors touch-manipulation',
              active
                ? 'bg-primary/12 text-primary font-semibold'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/50',
            )}
          >
            <span className="truncate">{sub.name}</span>
          </button>
        );
      })}
      {subCategories.length === 0 && (
        <div className="px-3 py-6 text-center text-xs text-muted-foreground">
          You do not have access to any sub-category here.
        </div>
      )}
    </div>
  );

  const header = (
    <div className="flex items-center justify-between gap-2 px-3 pt-3 pb-2 border-b border-border/50">
      <button
        onClick={() => go(modulePath)}
        className="flex items-center gap-2 min-w-0 text-left group"
      >
        {Icon && (
          <span className="text-primary shrink-0"><Icon size={15} /></span>
        )}
        <span className="text-sm font-bold text-foreground truncate">{moduleName}</span>
        <ChevronRight
          size={13}
          className="text-faint shrink-0 group-hover:translate-x-0.5 transition-transform"
        />
      </button>
      <button
        onClick={onClose}
        aria-label="Close"
        className="h-7 w-7 shrink-0 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60"
      >
        <X size={13} />
      </button>
    </div>
  );

  // ── Bottom sheet (mobile) ──
  if (!isDesktop) {
    return createPortal(
      <AnimatePresence>
        <motion.div
          key="scrim"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-[9998] bg-black/60 backdrop-blur-sm"
          onClick={onClose}
        />
        <motion.div
          key="sheet"
          initial={{ y: '100%' }}
          animate={{ y: 0 }}
          exit={{ y: '100%' }}
          transition={{ type: 'spring', damping: 30, stiffness: 320 }}
          className="fixed inset-x-0 bottom-0 z-[9999] max-h-[80vh] flex flex-col rounded-t-2xl border-t border-border bg-card shadow-2xl"
        >
          <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-border" />
          {header}
          <div className="overflow-y-auto p-2 pb-[calc(12px+env(safe-area-inset-bottom))]">
            {rows}
          </div>
        </motion.div>
      </AnimatePresence>,
      document.body,
    );
  }

  // ── Anchored panel (desktop) ──
  return createPortal(
    <>
      {/* Catches the click that dismisses it. Transparent, not dimmed: the
          sidebar behind it stays readable, which is the point of a flyout. */}
      <div className="fixed inset-0 z-[9998]" onClick={onClose} />
      <motion.div
        ref={panelRef}
        initial={{ opacity: 0, x: -8 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.12 }}
        style={{ top: position.top, left: position.left, width }}
        className="fixed z-[9999] max-h-[75vh] overflow-y-auto rounded-xl border border-border bg-card shadow-2xl"
      >
        {header}
        <div className="p-2">{rows}</div>
      </motion.div>
    </>,
    document.body,
  );
}
