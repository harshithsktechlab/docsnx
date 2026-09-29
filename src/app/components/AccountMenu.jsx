'use client';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   ACCOUNT MENU — the avatar in the top-right, and everything under it    ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Billing, AI Credits, Settings, Audit Logs and Logout, in one place. Before
 * this they were in three:
 *
 *  1. AN `ACCOUNT` GROUP AT THE BOTTOM OF THE LEFT RAIL. The rail is navigation
 *     INSIDE a workspace; what you do with the account itself is not that. It
 *     also vanished when the rail collapsed to 72px, and the rail is
 *     `hidden lg:flex`, so none of it existed on a phone.
 *  2. A RED LOGOUT BUTTON IN THE HEADER, sitting unguarded between Bell and
 *     Theme — the one destructive control in the row, one mis-tap away.
 *  3. THE SAME DESTINATIONS AGAIN ON `/more`, because (1) left phones with no
 *     route to them.
 *
 * ── ONE COMPONENT, TWO PRESENTATIONS ───────────────────────────────────────
 * Desktop: a panel anchored under the avatar. Mobile: the same rows as a bottom
 * sheet with 44px targets. Written once, exactly like WorkspaceSwitcher beside
 * it — two components with one purpose is how the desktop and mobile navigation
 * drifted apart last time.
 *
 * ── WHICH ROWS EXIST IS NOT DECIDED HERE ───────────────────────────────────
 * `accountMenuItems` (src/lib/accountMenu.ts) owns that, so the role gates and
 * the plan-locked fallbacks are testable without importing this JSX. Logout is
 * the exception: it is unconditional, so it is rendered rather than listed.
 *
 * ── NAVIGATION, NOT STATE ──────────────────────────────────────────────────
 * Every row is a real <Link>, so Back works, ⌘-click opens a tab, and a refresh
 * stays put.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { useRouter, usePathname } from 'next/navigation';
import {
  Activity,
  CreditCard,
  ChevronDown,
  Lock,
  LogOut,
  Settings,
  Sparkles,
  User,
  X,
} from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { anchorMenu } from '@/components/ui/row-actions-menu';
import { clientLogout } from '@/lib/clientAuth';
import { accountMenuItems, getInitials } from '@/lib/accountMenu';

/** The desktop panel's width. A number because anchorMenu does maths with it. */
const PANEL_WIDTH = 224;

/**
 * Keyed by the row, not by the path: `moduleIcon` maps paths because the module
 * registry is a path table, and this is not one. Lock belongs to the
 * plan-expired row, which is the only entry that is a gate rather than a page.
 */
const ROW_ICON = {
  billing: CreditCard,
  credits: Sparkles,
  settings: Settings,
  audit: Activity,
  expired: Lock,
};

export default function AccountMenu({
  /** The signed-in member. Null until /api/auth/me answers — the avatar still renders. */
  user = null,
  /** Passed down rather than recomputed: Shell owns the plan state. */
  planLocked = false,
  /**
   * The workspace these rows are opened FROM, or null for the household.
   *
   * None of these four pages has a company route — they belong to the tenant —
   * so without this the links were bare, and clicking one from inside Acme
   * silently moved the whole shell back to Personal: the chip, the rail, the
   * bottom nav and the badge counts. `accountMenuItems` turns it into a
   * `?company=` the shell reads back. Owned by Shell, which reads the workspace
   * off the URL.
   */
  activeCompanyId = null,
  /** 'desktop' → anchored panel; 'mobile' → bottom sheet. */
  variant = 'desktop',
  className,
}) {
  const router = useRouter();
  const pathname = usePathname();
  const items = accountMenuItems(user, planLocked, activeCompanyId);

  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [position, setPosition] = useState(null);
  const triggerRef = useRef(null);
  const panelRef = useRef(null);

  const isMobile = variant === 'mobile';
  const close = useCallback(() => setOpen(false), []);

  // Portals need a DOM to render into, which the server render does not have.
  useEffect(() => setMounted(true), []);

  const reposition = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPosition(
      anchorMenu(
        rect,
        panelRef.current?.offsetHeight ?? 0,
        { width: window.innerWidth, height: window.innerHeight },
        PANEL_WIDTH,
      ),
    );
  }, []);

  // After layout, before paint: measuring in a plain effect paints the panel at
  // 0,0 for one frame, which reads as a flash in the corner.
  useLayoutEffect(() => {
    if (open && !isMobile) reposition();
  }, [open, isMobile, items.length, reposition]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    if (!isMobile) {
      // Re-anchored rather than dismissed on scroll: on a phone, hiding the URL
      // bar fires both of these, so closing here would shut the menu on the very
      // tap that opened it.
      window.addEventListener('resize', reposition);
      window.addEventListener('scroll', reposition, true);
    }
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open, isMobile, close, reposition]);

  // Navigating away closes it — a panel that outlives the page it opened from
  // hangs over the destination.
  useEffect(() => { setOpen(false); }, [pathname]);

  const handleLogout = async () => {
    close();
    await clientLogout();
    router.push('/login');
  };

  const name = user?.name || 'User';
  const initials = getInitials(user?.name);
  const roleLabel = user?.role?.replace(/_/g, ' ') || 'Standard';

  const isActivePath = (href) => {
    // The query is the WORKSPACE, not the page: `/settings?company=acme` and
    // `/settings` are the same row, and `pathname` never carries a query — so
    // comparing the raw href would leave no row highlighted at all inside a
    // company.
    const path = href.split('?')[0];
    // '/billing' is exact for the same reason the sidebar's rule was: the prefix
    // form would light up Billing while standing on '/billing/credits'.
    if (path === '/billing') return pathname === path;
    return pathname === path || pathname.startsWith(path + '/');
  };

  const avatar = (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-tr from-primary to-orange-500 text-2xs font-black text-white">
      {/* The schema has no avatar column, so initials are the person image. The
          icon is for the moment before /api/auth/me answers, when there is no
          name to take letters from and 'U' would be a guess. */}
      {user?.name ? initials : <User size={15} />}
    </span>
  );

  const trigger = (
    <button
      ref={triggerRef}
      type="button"
      onClick={() => setOpen((prev) => !prev)}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label={`Account: ${name}`}
      title={`Account: ${name}`}
      className={cn(
        'flex shrink-0 items-center gap-1 rounded-full transition-opacity hover:opacity-85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background active:opacity-70',
        className,
      )}
    >
      {avatar}
      {/* Desktop only: the phone header has five controls in ~130px and no room
          for a caret. The sheet's slide-up is its own affordance there. */}
      {!isMobile && (
        <ChevronDown
          size={13}
          className={cn('shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')}
        />
      )}
    </button>
  );

  const identity = (
    <div className="flex items-center gap-3 px-1 pb-2 min-w-0">
      {avatar}
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-bold text-foreground">{name}</div>
        <div className="mt-0.5 truncate text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
          {roleLabel}
        </div>
      </div>
    </div>
  );

  const rowClass = (isActive) => cn(
    'flex w-full items-center gap-2.5 rounded-lg border px-3 text-left transition-colors',
    // 44px on the sheet: this is primary navigation on a touch screen.
    isMobile ? 'min-h-11 py-2.5 text-sm' : 'py-2 text-xs',
    isActive
      ? 'border-primary bg-primary/10 font-bold text-foreground'
      : 'border-border/60 font-medium text-muted-foreground hover:bg-muted/50 hover:text-foreground',
  );

  const rows = (
    <div className="flex flex-col gap-1">
      {items.map((item) => {
        const Icon = ROW_ICON[item.key];
        const isActive = isActivePath(item.path);
        return (
          <Link
            key={item.key}
            href={item.path}
            onClick={close}
            role="menuitem"
            aria-current={isActive ? 'true' : undefined}
            className={rowClass(isActive)}
          >
            <Icon size={isMobile ? 16 : 14} className="shrink-0" />
            <span className="truncate">{item.name}</span>
          </Link>
        );
      })}

      {/* A rule rather than a gap: Logout is the one row here that does not
          navigate somewhere you can come back from. `items` is empty for a
          plain member and a SUPER_ADMIN, and a divider above the only row on
          screen would be a line under nothing. */}
      {items.length > 0 && <div className="my-1 h-px bg-border/60" />}

      <button
        type="button"
        role="menuitem"
        onClick={handleLogout}
        className={cn(
          'flex w-full items-center gap-2.5 rounded-lg border border-border/60 px-3 text-left font-medium text-danger-action transition-colors hover:border-red-500/30 hover:bg-red-500/10',
          isMobile ? 'min-h-11 py-2.5 text-sm' : 'py-2 text-xs',
        )}
      >
        <LogOut size={isMobile ? 16 : 14} className="shrink-0" />
        <span>Logout</span>
      </button>
    </div>
  );

  return (
    <>
      {trigger}

      {mounted && open && createPortal(
        isMobile ? (
          <AnimatePresence>
            <motion.div
              key="scrim"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="fixed inset-0 z-[9998] bg-black/60 backdrop-blur-sm"
              onClick={close}
            />
            <motion.div
              key="sheet"
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'spring', damping: 30, stiffness: 320 }}
              role="menu"
              aria-label="Account"
              className="fixed inset-x-0 bottom-0 z-[9999] flex max-h-[80vh] flex-col rounded-t-2xl border-t border-border bg-card shadow-2xl"
            >
              <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-border" />
              <div className="flex items-center justify-between gap-2 border-b border-border/50 px-4 pb-2 pt-3">
                <span className="text-2xs font-bold uppercase tracking-widest text-faint">
                  Account
                </span>
                <button
                  type="button"
                  onClick={close}
                  aria-label="Close"
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                >
                  <X size={14} />
                </button>
              </div>
              <div className="overflow-y-auto p-3 pb-[calc(14px+env(safe-area-inset-bottom))]">
                {identity}
                {rows}
              </div>
            </motion.div>
          </AnimatePresence>
        ) : (
          <>
            {/* Catches the click that dismisses it. Transparent, and genuinely
                full-screen: the header it hangs from is a stacking context, so
                an in-place overlay would be trapped inside it. */}
            <div className="fixed inset-0 z-[9998]" onClick={close} />
            <div
              ref={panelRef}
              role="menu"
              aria-label="Account"
              style={{
                top: position?.top ?? 0,
                left: position?.left ?? 0,
                width: PANEL_WIDTH,
                // Hidden until measured: `position` is null on the first render
                // and 0,0 for a frame is a flash in the corner.
                visibility: position ? 'visible' : 'hidden',
              }}
              className="fixed z-[9999] max-h-[70vh] overflow-y-auto rounded-xl border border-border bg-card p-2 shadow-2xl animate-scale-in"
            >
              <span className="block px-1 pb-1.5 text-2xs font-bold uppercase tracking-widest text-faint">
                Account
              </span>
              {identity}
              {rows}
            </div>
          </>
        ),
        document.body,
      )}
    </>
  );
}
