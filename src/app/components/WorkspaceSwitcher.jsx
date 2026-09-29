'use client';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   WORKSPACE SWITCHER — Personal / Business, in the top-right cluster     ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * This used to be a block of links in the sidebar, and it was wrong in three
 * ways at once:
 *
 *  1. IT WAS IN THE LEFT RAIL. The rail is navigation INSIDE a workspace; the
 *     control that decides WHICH workspace belongs with the account controls.
 *     It also disappeared when the rail collapsed to 72px, so the one thing
 *     that says where you are was the first thing to go.
 *  2. IT LISTED COMPANIES AS PEERS OF PERSONAL. The choice is Personal vs
 *     Business first and which company second; a flat list made "Redpluto" a
 *     top-level concept and the account's two halves invisible.
 *  3. IT DID NOT EXIST ON A PHONE. The sidebar is `hidden lg:flex`, so there
 *     was NO route into a company workspace from a phone at all.
 *
 * ── ONE COMPONENT, TWO PRESENTATIONS ───────────────────────────────────────
 * Desktop: a panel anchored under the chip. Mobile: the same rows as a bottom
 * sheet, with 44px targets. Written once, for the same reason ModuleFlyout is —
 * two components with one purpose is how the desktop and mobile navigation
 * drifted apart last time.
 *
 * ── THE CHIP SAYS WHERE YOU ARE, NOT JUST WHERE YOU CAN GO ─────────────────
 * Desktop reads `Business · Acme Traders`. The mobile header has ~130px to
 * spare beside Search / To-Dos / Bell / Theme / the account avatar, so it drops
 * the `Business ·` prefix — the building icon carries that — and spends the room
 * on the company name, which is the half that actually distinguishes one
 * workspace from another. Both announce the full thing through `aria-label`.
 *
 * ── NAVIGATION, NOT STATE ──────────────────────────────────────────────────
 * Every option is a real <Link>, so Back works, a company opens in a new tab,
 * and a refresh stays put. The active workspace is read from the URL by Shell
 * and handed down here.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Building2, Check, ChevronDown, ChevronRight, UserCheck, X } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { anchorMenu } from '@/components/ui/row-actions-menu';
import {
  workspaceMenu,
  businessHref,
  activeWorkspace,
  companyHome,
  PERSONAL_HOME,
} from '@/lib/workspaceNav';

/** The desktop panel's width. A number because anchorMenu does maths with it. */
const PANEL_WIDTH = 248;

export default function WorkspaceSwitcher({
  accountType,
  companies = [],
  activeCompanyId = null,
  /**
   * The signed-in member — for `role` and `accountScope` only.
   *
   * A member added to work on a company is not offered the household, and vice
   * versa: they should experience the account as having one half, the one they
   * were added to. A TENANT_ADMIN spans both and is unaffected. See
   * `workspaceMenu`.
   */
  user = null,
  /** 'desktop' → anchored panel; 'mobile' → bottom sheet and a tighter chip. */
  variant = 'desktop',
  /**
   * Unread notifications waiting in the member's OTHER workspaces.
   *
   * The bell shows the workspace you are standing in and nothing else, which is
   * right — a company's licence renewals do not belong in the household's badge
   * — but it leaves a notice filed elsewhere with no representation on screen at
   * all. This dot is that representation, and this chip is the honest place for
   * it: the control that takes you there is the control that should say there is
   * a reason to go.
   *
   * A COUNT is deliberately not rendered. Which workspace, and how many, is a
   * question the switcher cannot answer without listing notices from a workspace
   * the user is not in. A dot says "there is something", which is all that is
   * needed to make them open the menu.
   */
  unreadElsewhere = 0,
  className,
}) {
  const pathname = usePathname();
  const menu = workspaceMenu(accountType, companies, user);
  const active = activeWorkspace(activeCompanyId, companies);
  const straightIn = businessHref(menu.companies);

  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [position, setPosition] = useState(null);
  // Open inside a company and the company list is already unfolded: the point
  // of opening the menu there is to see WHICH company, not to be asked again.
  const [showCompanies, setShowCompanies] = useState(Boolean(activeCompanyId));
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
  }, [open, isMobile, showCompanies, reposition]);

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
  // hangs over the destination. Also re-unfolds the list to match the arrival.
  useEffect(() => {
    setOpen(false);
    setShowCompanies(Boolean(activeCompanyId));
  }, [pathname, activeCompanyId]);

  // Nothing to switch between: a personal-only tenant, or a member with no
  // company access yet. This is most tenants, and they see no chip at all.
  if (menu.rowCount === 0) return null;

  const inBusiness = active.kind === 'business';
  const Icon = inBusiness ? Building2 : UserCheck;
  // What the chip reads. `companyName` is null when the id in the URL names a
  // company this member cannot reach — the chip degrades to a bare "Business"
  // rather than rendering `undefined`; the page behind it 403s on its own.
  const label = inBusiness ? (active.companyName || 'Business') : 'Personal';
  const fullLabel = inBusiness
    ? (active.companyName ? `Business — ${active.companyName}` : 'Business')
    : 'Personal';

  const showDot = Number(unreadElsewhere) > 0;

  const chipInner = (
    <>
      <span className="relative flex shrink-0">
        <Icon size={isMobile ? 13 : 14} className="shrink-0 text-primary" />
        {showDot && (
          <span
            // Ring in the chip's own background so the dot reads as separate
            // from the icon underneath it at both sizes.
            className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-destructive ring-1 ring-background"
            aria-hidden="true"
          />
        )}
      </span>
      <span className="flex min-w-0 items-center gap-1">
        {/* Desktop has the room to name the half AND the company; the phone
            spends its ~130px on the company name alone. */}
        {!isMobile && inBusiness && (
          <>
            <span className="font-bold text-foreground">Business</span>
            {active.companyName && <span className="text-faint">·</span>}
          </>
        )}
        {(isMobile || !inBusiness || active.companyName) && (
          <span
            className={cn(
              'truncate',
              isMobile ? 'max-w-[132px]' : 'max-w-[150px]',
              // On a phone the company name IS the label, so it carries the
              // weight. On desktop it is the qualifier after a bold "Business".
              !isMobile && inBusiness
                ? 'font-medium text-muted-foreground'
                : 'font-bold text-foreground',
            )}
          >
            {label}
          </span>
        )}
      </span>
    </>
  );

  const chipClass = cn(
    'flex h-8 min-w-0 items-center rounded-lg border border-primary/40 bg-primary/10',
    // Tighter chrome on a phone: every pixel spent on padding and gaps is one
    // the company name does not get, and the name is the whole point.
    isMobile ? 'gap-1 px-1.5 text-2xs' : 'gap-1.5 px-2 text-xs',
    className,
  );

  // One reachable workspace and no choice to make — a business-only account with
  // a single company. The chip still says where you are; it just does not
  // pretend to be a menu.
  // Said in words as well as with the dot: a coloured circle is nothing at all
  // to a screen reader, and this is the only cue that work is waiting elsewhere.
  const ariaLabel = `Workspace: ${fullLabel}${showDot ? ' — unread notifications in another workspace' : ''}`;

  if (menu.rowCount === 1 && menu.companies.length <= 1) {
    return (
      <div className={chipClass} aria-label={ariaLabel}>
        {chipInner}
      </div>
    );
  }

  const rowClass = (isActive) => cn(
    'flex w-full items-center gap-2 rounded-lg border px-3 text-left transition-colors',
    // 44px on the sheet: this is primary navigation on a touch screen.
    isMobile ? 'min-h-11 py-2.5 text-sm' : 'py-2 text-xs',
    isActive
      ? 'border-primary bg-primary/10 text-foreground font-bold'
      : 'border-border/60 text-muted-foreground font-medium hover:text-foreground hover:bg-muted/50',
  );

  const rows = (
    <div className="flex flex-col gap-1">
      {menu.hasPersonal && (
        <Link
          href={PERSONAL_HOME}
          onClick={close}
          aria-current={!inBusiness ? 'true' : undefined}
          className={rowClass(!inBusiness)}
        >
          <UserCheck size={isMobile ? 16 : 14} className="shrink-0" />
          <span className="truncate">Personal</span>
          {!inBusiness && <Check size={isMobile ? 16 : 13} className="ml-auto shrink-0 text-primary" />}
        </Link>
      )}

      {menu.companies.length > 0 && (
        straightIn ? (
          /* One company: the Business row IS that company. A submenu holding a
             single entry is a tap that asks a question with one answer. */
          <Link
            href={straightIn}
            onClick={close}
            aria-current={inBusiness ? 'true' : undefined}
            className={rowClass(inBusiness)}
          >
            <Building2 size={isMobile ? 16 : 14} className="shrink-0" />
            <span className="truncate">Business</span>
            <span className="ml-auto flex items-center gap-1.5 pl-2 min-w-0">
              <span className="truncate text-2xs font-medium text-muted-foreground">
                {menu.companies[0].name}
              </span>
              {inBusiness && <Check size={isMobile ? 16 : 13} className="shrink-0 text-primary" />}
            </span>
          </Link>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setShowCompanies((prev) => !prev)}
              aria-expanded={showCompanies}
              aria-current={inBusiness ? 'true' : undefined}
              className={rowClass(inBusiness)}
            >
              <Building2 size={isMobile ? 16 : 14} className="shrink-0" />
              <span className="truncate">Business</span>
              <ChevronRight
                size={isMobile ? 15 : 12}
                className={cn('ml-auto shrink-0 transition-transform', showCompanies && 'rotate-90')}
              />
            </button>
            {showCompanies && (
              /* Indented under Business, and hung off a rule, so the second
                 level reads as belonging to the first rather than as three
                 peers — which is what the old flat list looked like. */
              <div className="ml-3 flex flex-col gap-1 border-l border-border/60 pl-2">
                {menu.companies.map((c) => {
                  const isActive = activeCompanyId === c.id;
                  return (
                    <Link
                      key={c.id}
                      href={companyHome(c.id)}
                      onClick={close}
                      title={c.name}
                      aria-current={isActive ? 'true' : undefined}
                      className={rowClass(isActive)}
                    >
                      <span className="truncate">{c.name}</span>
                      {isActive && (
                        <Check size={isMobile ? 16 : 13} className="ml-auto shrink-0 text-primary" />
                      )}
                    </Link>
                  );
                })}
              </div>
            )}
          </>
        )
      )}
    </div>
  );

  const trigger = (
    <button
      ref={triggerRef}
      type="button"
      onClick={() => setOpen((prev) => !prev)}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label={ariaLabel}
      title={ariaLabel}
      className={cn(chipClass, 'transition-colors hover:bg-primary/20')}
    >
      {chipInner}
      <ChevronDown
        size={isMobile ? 12 : 13}
        className={cn('shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')}
      />
    </button>
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
              aria-label="Switch workspace"
              className="fixed inset-x-0 bottom-0 z-[9999] flex max-h-[80vh] flex-col rounded-t-2xl border-t border-border bg-card shadow-2xl"
            >
              <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-border" />
              <div className="flex items-center justify-between gap-2 border-b border-border/50 px-4 pb-2 pt-3">
                <span className="text-2xs font-bold uppercase tracking-widest text-faint">
                  Workspace
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
              aria-label="Switch workspace"
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
                Workspace
              </span>
              {rows}
            </div>
          </>
        ),
        document.body,
      )}
    </>
  );
}
