'use client';

import React, { Fragment, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, usePathname, useSearchParams, useSelectedLayoutSegment } from 'next/navigation';
import { 
  LayoutDashboard, 
  FileText, 
  FolderOpen,
  Menu, 
  Moon, 
  Sun,
  CreditCard,
  TrendingUp,
  PiggyBank,
  Users,
  ChevronRight,
  ChevronLeft,
  ArrowLeft,
  Bell,
  Search,
  X,
  Loader2,
  Shield,
  Flame,
  CheckCircle2,
  ListTodo,
  Sparkles,
  Tag,
  Building,
  Puzzle,
  Mail,
  Receipt,
  Settings,
  Lock,
  AlertTriangle,
  MessageCircle,
  SlidersHorizontal,
  Building2
} from 'lucide-react';

import { toast } from 'sonner';
import { setFlash, peekFlash } from '@/lib/flashToast';
import { arrivalNotice } from '@/lib/arrivalNotice';
import { useFlashToast } from '@/hooks/useFlashToast';
import { clientGetMe, clientCan } from '@/lib/clientAuth';
import { APP_NAME, APP_MARK } from '@/lib/brand';
import BrandWordmark from '@/app/components/BrandWordmark';
import { maybeToastStoragePressure } from '@/lib/storageToast';
import { daysUntil } from '@/lib/planGate';
import { ONBOARDING_PATH } from '@/lib/onboardingGate';
import { lockAxisLabel, workspaceLock } from '@/lib/workspaceLock';
import { formatDate } from '@/lib/dateHelper';
import { setMaxUploadBytes } from '@/lib/records/uploadTypes';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { PWABanner } from '@/components/PWABanner';
import { usePushNotifications } from '@/lib/usePushNotifications';
import { AnimatePresence, motion } from 'framer-motion';
import { FontSizeToggle } from '@/components/FontSizeToggle';
import { ThemeToggle, useAppTheme } from '@/components/ThemeToggle';
import { NAV_MODULES, BUSINESS_NAV_MODULES, UTILITY_MODULES, TENANT_SPECIFIC_PATHS, MODULE_BASE, utilityNavPath } from '@/lib/moduleRegistry';
import { workspaceMenu, defaultCompanyId, companyHome, activeCompanyFrom, companyFromPath, PERSONAL_HOME } from '@/lib/workspaceNav';
import { moduleIcon } from '@/lib/moduleIcons';
import ModuleFlyout from '@/app/components/ModuleFlyout';
import WorkspaceSwitcher from '@/app/components/WorkspaceSwitcher';
import AccountMenu from '@/app/components/AccountMenu';
import useBackNavigation, { brandHomePath } from '@/app/components/useBackNavigation';
import { usePermittedCategories, navModulesFrom } from '@/lib/usePermittedCategories';
import { apiCall } from '@/lib/net/apiRequest';

// ─── Public routes ──────────────────────────────────────────────────────────
// Routes that render standalone (no sidebar/header/bottom-nav) AND never bounce
// a signed-out visitor to /login. Keep these two behaviours driven by the same
// list — they drifted apart before, which left the reset-password page wrapped
// in an empty app shell.
const PUBLIC_PATHS = [
  '/',
  '/login',
  '/register',
  // The two design-token preview pages: no data, no API calls, nothing
  // tenant-owned to protect, and both are useless behind a login because
  // what they exist to show is the palette itself.
  '/gradient-preview',
  '/alerts-preview',
  '/forgot-password',
  '/reset-password',
  '/verify-email',
  // The legal pages. /register asks a visitor to consent to both before they
  // have an account, so they must be readable without one — left off this list
  // they redirected straight to /login.
  '/privacy',
  '/terms',
  // Serwist's offline fallback. It must render bare and must not fire the auth
  // fetch below: by definition it is shown when the network is gone.
  '/~offline',
];

// Public routes a *signed-in* user must still be able to complete, so the
// billing / AMC-lock / onboarding gates below must not redirect away from them.
const AUTH_FLOW_PATHS = ['/forgot-password', '/reset-password', '/verify-email'];

// ─── What survives an expired plan ──────────────────────────────────────────
// Two things, and they differ by role. The admin gets Billing, because they are
// the one who can pay; a member gets the lock screen instead, because /billing
// bounces anyone who is not a TENANT_ADMIN and the two redirects would otherwise
// ping-pong forever. Both keep Settings.
//
// This is COURTESY, exactly like clientCan: the server answers 402 PLAN_EXPIRED
// on every tenant-data route regardless of what the browser chooses to render.
const EXPIRED_PATHS_ADMIN  = ['/billing', '/settings'];
const EXPIRED_PATHS_MEMBER = ['/billing/expired', '/settings'];
const PLAN_LOCK_PATH = '/billing/expired';

// The gates a member cannot navigate away from. The back button is suppressed
// here: the redirects above would land them right back on the gate, so a button
// that visibly does nothing is worse than no button.
// `/onboarding` is deliberately absent: it renders outside this shell entirely
// (see below), so it has no back button to suppress.
const LOCK_SCREEN_PATHS = [PLAN_LOCK_PATH, '/billing/amc-lock'];

/** Days before expiry at which the amber warning bar appears. */
const EXPIRY_WARNING_DAYS = 7;

/**
 * ── QUICK ACTIONS FOLLOW THE WORKSPACE ──────────────────────────────────────
 *
 * The Spotlight's five tiles. They were one hardcoded personal list, so from
 * inside a company every one of them walked the user back into the household —
 * the same silent workspace leak the bottom nav and the More screen were fixed
 * for, left behind in the one surface reached by keyboard rather than by tap.
 *
 * TWO SETS, not one set with a prefix — the same shape `cardsFor` uses in
 * WorkspaceDashboard.jsx, and for the same reason. The utility three (documents,
 * passwords, to-dos) exist in BOTH accounts and only need `utilityNavPath`. The
 * other two cannot be prefixed at all: Medical and Vehicle are PERSONAL taxonomy
 * keys and a company files into the `biz_*` fourteen, so
 * `/business/<id>/modules/vehicle` names a module that workspace does not have.
 * A company is offered two of its own dated obligations instead.
 *
 * Icons come from `moduleIcon`, keyed exactly as the sidebar keys them — module
 * key for a record module, path for a utility one — so a tile and the row it
 * opens can never show two different glyphs for one module.
 *
 * Courtesy, not permission, like every other link in this file: these are not
 * filtered by `clientCan`, and each page re-checks on arrival.
 */
function quickActionsFor(companyId) {
  // The same path shape `navModulesFrom` builds, from the same constant, so a
  // tile and its sidebar row cannot drift to two URLs for one module.
  const modulePath = (key) => `${companyId ? `/business/${companyId}` : ''}${MODULE_BASE}/${key}`;
  // Present in both accounts, so these three differ only by the prefix.
  const shared = {
    doc:  { name: 'Add Document',  icon: FileText,               path: utilityNavPath('/documents', companyId), color: 'text-blue-500',   bg: 'bg-blue-500/10'   },
    pwd:  { name: 'Save Password', icon: moduleIcon('/passwords'), path: utilityNavPath('/passwords', companyId), color: 'text-purple-500', bg: 'bg-purple-500/10' },
    task: { name: 'New Task',      icon: moduleIcon('/todos'),     path: utilityNavPath('/todos', companyId),     color: 'text-rose-500',   bg: 'bg-rose-500/10'   },
  };
  if (!companyId) {
    // Medical and Vehicle go to their MODULE pages, not to /medical and
    // /vehicles — those are phase-1 pages 0023 took out of the nav, so these
    // two tiles are the only remaining way in.
    return [
      shared.doc,
      { name: 'Add Medical', icon: moduleIcon('health_medical'), path: modulePath('health_medical'), color: 'text-cyan-500',  bg: 'bg-cyan-500/10'  },
      shared.pwd,
      shared.task,
      { name: 'Add Vehicle', icon: moduleIcon('vehicle'),        path: modulePath('vehicle'),        color: 'text-amber-500', bg: 'bg-amber-500/10' },
    ];
  }
  // Tax filings and licences rather than the household's two: both are dated
  // obligations with a cost attached to missing them, which is the same reason
  // Follow Up earns a dashboard card on the business side and not the personal.
  return [
    shared.doc,
    { name: 'Add Tax Filing', icon: moduleIcon('biz_tax'),      path: modulePath('biz_tax'),      color: 'text-cyan-500',  bg: 'bg-cyan-500/10'  },
    shared.pwd,
    shared.task,
    { name: 'Add License',    icon: moduleIcon('biz_licenses'), path: modulePath('biz_licenses'), color: 'text-amber-500', bg: 'bg-amber-500/10' },
  ];
}

/**
 * Say the lapse once per session, keyed on the expiry so a renewal re-arms it.
 *
 * Names the half that lapsed when the tenant has two, and does not when it has
 * one — "your Business plan expired" is noise to a household, and "your plan
 * expired" inside a company the customer has paid for is a support ticket.
 * The key includes the axis so a tenant whose two halves lapse on different
 * dates hears about each of them.
 *
 * ── WHERE IT IS SAID ──────────────────────────────────────────────────────
 * `destination` is the path this gate is about to push to, or null when the
 * reader is already somewhere the lock allows. Given one, the sentence is
 * handed to that page (src/lib/flashToast.ts) instead of being fired here and
 * read, half expired, wherever the redirect lands.
 *
 * ── NOT ON A FIRST RUN ────────────────────────────────────────────────────
 * A new account is created with no plan and an expiry of *now*, so it reaches
 * /billing already "lapsed" — and this would greet someone who signed up two
 * minutes ago with an expiry notice for a plan they never had, on top of the
 * welcome their sign-up just handed that page. `?welcome=1` is how
 * /verify-email marks that first visit; billing's own banner already reads it
 * (src/app/billing/page.js), and the gate itself is unchanged either way.
 */
function announcePlanExpiry(status, axis, nameTheAxis, destination) {
  if (typeof window === 'undefined') return;
  if (new URLSearchParams(window.location.search).get('welcome') === '1') return;
  const axisStatus = status?.axes?.[axis];
  const expiresAt = axisStatus?.expiresAt ?? status?.expiresAt;
  const stamp = `${axis}:${String(expiresAt || 'no-plan')}`;
  if (sessionStorage.getItem('plan_expiry_notice') === stamp) return;
  sessionStorage.setItem('plan_expiry_notice', stamp);

  const which = nameTheAxis ? `${lockAxisLabel(axis)} plan` : 'plan';
  /**
   * ── "EXPIRED" ONLY IF THERE WAS EVER A PLAN ──────────────────────────────
   * This picked its sentence on `expiresAt`, which a brand-new tenant HAS:
   * registration writes `subscription_expiry = now()` so the account is locked
   * to /billing from the first request. The result was a banner telling someone
   * who had just signed up that their plan "expired on 18/09/2026" — today's
   * date, for a plan they never bought.
   *
   * `hasPlan` is `!!subscriptionPlanId`, so it is false for an account that has
   * never subscribed and true for one whose term ran out. That is the question
   * this sentence is actually asking.
   */
  const message = axisStatus?.hasPlan && expiresAt
    ? `Your ${which} expired on ${formatDate(expiresAt)}. Renew to restore access.`
    : `Your workspace has no active ${which}. Choose one to restore access.`;

  if (destination) {
    setFlash({ message, type: 'error', pin: destination, tag: 'plan-expiry', duration: 8000 });
    return;
  }
  // Staying put: this page IS the arrival, so it is said here and now.
  toast.error(message, { id: 'plan-expiry', duration: 8000 });
}

/**
 * Say WHY the app just refused to open, on the way to the wizard.
 *
 * The bounce to `/onboarding` was silent for a long time, which reads as a
 * broken link rather than as a gate — the same mistake the plan lock made
 * before `announcePlanExpiry` existed.
 *
 * Keyed on the path they TRIED, so a fresh attempt at a different page speaks
 * again while a redirect settling on one path does not repeat itself.
 *
 * ── ONE SENTENCE FOR ONE ARRIVAL ──────────────────────────────────────────
 * Handed to the wizard rather than fired here, and pinned to it, so the
 * /dashboard render this redirect passes through cannot consume it. Writing
 * the slot also TAKES it: whatever the page being left had queued — an
 * "Account verified successfully!" out of /verify-email, a "Login successful!"
 * — is superseded rather than stacked on top of, and `arrivalNotice` folds a
 * just-verified admin's news into this one sentence.
 */
function announceOnboardingIncomplete(attemptedPath, isTenantAdmin) {
  if (typeof window === 'undefined') return;
  const stamp = `onboarding:${attemptedPath}`;
  if (sessionStorage.getItem('onboarding_notice') === stamp) return;
  sessionStorage.setItem('onboarding_notice', stamp);

  setFlash({
    message: arrivalNotice(peekFlash(), isTenantAdmin),
    type: 'info',
    pin: ONBOARDING_PATH,
    tag: 'onboarding-gate',
    duration: 8000,
  });
}

// Every master module now has a page of its own (`/modules/<moduleKey>`), so
// the SHARED_MODULE_PATHS set that used to live here is gone. It existed
// because identity, education and civil_government all resolved to /documents
// and therefore all lit up as active at once; a module that owns its path can
// simply be compared against the pathname.

export default function Shell({ children }) {
  const router = useRouter();
  const pathname = usePathname();
  // The service worker serves the offline fallback under whatever URL was
  // requested (src/sw.ts), so `pathname` says `/dashboard` while `/~offline`
  // is what rendered. The route segment is what actually identifies it.
  const isOfflineFallback = useSelectedLayoutSegment() === '~offline';
  // Read for ONE thing: `?company=` on the four account pages. See
  // `activeCompanyFrom` below, and the <Suspense> around this component in
  // layout.js, which this hook is what requires.
  const searchParams = useSearchParams();
  // Raises whatever the previous page left for this one. Called here, above
  // every early return below, because it is a hook: the loading splash, the
  // public pages and the wizard must not change how many run.
  useFlashToast();
  const [isEmbedded, setIsEmbedded] = useState(false);
  const [user, setUser] = useState(null);
  /** The companies this member may reach. Empty for a personal-only account. */
  const [companies, setCompanies] = useState([]);
  const [planState, setPlanState] = useState(null);
  // Owned by src/components/ThemeToggle.tsx, not by local state: the header
  // button and the Appearance card on /more both write it, and two independent
  // copies of that logic is what the 1s poll this replaced was covering for.
  // `resolved` (never the raw preference) is what picks a logo below — `system`
  // is not a value an <img src> can use.
  const { resolved: theme, toggleTheme } = useAppTheme();
  const [loading, setLoading] = useState(true);
  const [isCollapsed, setIsCollapsed] = useState(false);
  // Which collapsible nav groups the member has opened, keyed by group label.
  // Empty on first paint so the server render and the pre-effect client render
  // agree; the stored map is applied in the mount effect below.
  const [openGroups, setOpenGroups] = useState({});
  const [sidebarWidth, setSidebarWidth] = useState(260);
  const { registerDevice } = usePushNotifications();
  // Which module's flyout is open, and the trigger rect to anchor it to.
  const [openModule, setOpenModule] = useState(null);
  // What this member may actually reach. The nav renders the taxonomy, which is
  // the same for everyone — without this a STANDARD user is offered links that
  // 403 on arrival.
  const { categories: permittedCategories } = usePermittedCategories();

  /**
   * ── WHICH WORKSPACE IS OPEN, AND WHY THE URL DECIDES ─────────────────────
   *
   * Read from the path (`/business/<companyId>/…`) rather than held in state or
   * a cookie. Three things follow from that and none of them work otherwise:
   * two companies can be open in two tabs, a link to a record carries the
   * company it belongs to, and a refresh lands where the user was.
   *
   * The id here is UNTRUSTED — it is whatever is in the address bar. Nothing on
   * this side is load-bearing: every business route re-proves it with
   * `hasCompanyAccess`, and a company the member cannot reach simply renders an
   * empty rail and 403s on the way to any data.
   */
  /**
   * The company in the PATH, and nothing else. This is the id the plan lock
   * runs on — see `lock` and the lock branch in `loadUser` below, and the note
   * on `activeCompanyId` for why the two are not the same value.
   */
  const pathCompanyId = companyFromPath(pathname);
  /**
   * The company the CHROME is in: the path, or `?company=` on one of the four
   * account pages (`activeCompanyFrom`).
   *
   * Settings, Billing, AI Credits and Audit Logs belong to the tenant and have
   * no company route, so on the path alone every one of them read as "back to
   * Personal": the chip, the rail, the bottom nav, the quick actions and the two
   * badge counts all flipped the moment the avatar menu was used, mid-session,
   * from inside a company. The param is set by `accountMenuItems` and validated
   * against `companies` here, so an id in the address bar cannot paint a
   * company's rail over a page that has nothing to do with it.
   */
  const accountType = user?.tenant?.accountType || 'personal';
  /**
   * Which halves of the account are this viewer's. Built here rather than at the
   * switcher below because `activeCompanyId` needs it — see the fallback.
   *
   * Memoised because the landing effect below takes it as a dependency, and a
   * fresh object every render would re-run that effect every render.
   */
  const switcherMenu = useMemo(
    () => workspaceMenu(accountType, companies, user),
    [accountType, companies, user],
  );
  /**
   * ⚠ The fallback is what stops the chrome describing a workspace that does not
   * exist. `activeCompanyFrom` answers null for "no company in the URL", which
   * means the household — and a viewer with no household half (a `business`
   * tenant, or a member added to a company) would get the personal rail, the
   * personal badge counts and, with one company, no switcher chip to escape
   * with. That is what an admin saw after erasing their personal account: an
   * empty household and a company that looked deleted.
   */
  const activeCompanyId = activeCompanyFrom(pathname, searchParams, companies)
    ?? defaultCompanyId(switcherMenu);
  const inBusiness = Boolean(activeCompanyId);
  const activeCompany = companies.find((c) => c.id === activeCompanyId) || null;
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  
  // Badges & alerts states
  const [notifications, setNotifications] = useState([]);
  // The list now carries read notifications too (history), so the badge counts
  // the unread ones the API reports rather than the length of the list.
  const [unreadCount, setUnreadCount] = useState(0);
  /**
   * Unread waiting in the member's OTHER workspaces.
   *
   * The bell shows one workspace now, so a notice filed for a company while the
   * user is in Personal is invisible — and an invisible notice with nothing on
   * screen hinting at it is worse than the mixed list it replaced. This is the
   * dot on the switcher chip, and it is a count rather than rows: enough to say
   * "there is something over there", never the contents of a workspace you are
   * not standing in.
   */
  const [unreadElsewhere, setUnreadElsewhere] = useState(0);
  const [followUpCount, setFollowUpCount] = useState(0);
  const [todoCount, setTodoCount] = useState(0);
  const [showDesktopNotifications, setShowDesktopNotifications] = useState(false);
  const [showMobileNotifications, setShowMobileNotifications] = useState(false);

  /**
   * The bell's workspace, and why it is spelled out rather than omitted.
   *
   * /api/follow-up/count and /api/todos/count read an ABSENT `companyId` as the
   * household, so those two callers below drop the param. /api/notifications
   * cannot: absence there means EVERY workspace, which is what a client that has
   * not reloaded since the deploy still asks for and still gets. Saying
   * `personal` out loud is what distinguishes this client from that one.
   */
  const bellScope = `companyId=${activeCompanyId || 'personal'}`;

  const fetchNotifications = async () => {
    try {
      const { json: data } = await apiCall(`/api/notifications?${bellScope}`);
      if (data.success) {
        setNotifications(data.notifications || []);
        setUnreadCount(data.unreadCount || 0);
        setUnreadElsewhere(data.otherWorkspacesUnread || 0);
      }
    } catch (err) {
      console.error('Error fetching notifications:', err);
    }
  };

  const markAllNotificationsRead = async () => {
    // The result was discarded entirely: a refused mark-read left every badge
    // exactly where it was, said nothing, and the refetch below re-rendered the
    // same unread rows — which reads as the button being broken.
    // The SAME scope the list was drawn with. Without it this clears the unread
    // of every company the member can reach — none of which was on screen when
    // they pressed it.
    const { res, json } = await apiCall(`/api/notifications?${bellScope}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'read_all' }),
    }, { subject: 'notifications', action: 'marking these read' });
    if (!res.ok) toast.error(json.error || 'Could not mark these as read.');
    fetchNotifications();
  };

  const clearReadNotifications = async () => {
    const { res, json } = await apiCall(`/api/notifications?scope=read&${bellScope}`, { method: 'DELETE' },
      { subject: 'notifications', action: 'clearing these' });
    if (!res.ok) toast.error(json.error || 'Could not clear these notifications.');
    fetchNotifications();
  };

  const fetchFollowUpCount = async () => {
    try {
      // Company-scoped, exactly as `fetchTodoCount` below is: Follow Up now
      // answers for ONE workspace, so a badge that asked for the household's
      // count while a company was open would sit above a page showing a
      // different number. `activeCompanyId` is already a dependency of the
      // effect that calls this.
      const { json: data } = await apiCall(
        activeCompanyId ? `/api/follow-up/count?companyId=${activeCompanyId}` : '/api/follow-up/count',
      );
      if (data.success) {
        // `count`, not `total`. The route has only ever returned `count`
        // (src/app/api/follow-up/count/route.ts), so reading `total` left the
        // badge pinned at 0 while still paying for the whole computation —
        // a full documents scan plus a store read per category, every minute.
        setFollowUpCount(data.count || 0);
      }
    } catch (err) {
      console.error('Error fetching follow-up count:', err);
    }
  };

  // Pending tasks only — /api/todos/count matches `status = 'PENDING'`, which is
  // the same set the to-dos page's filter and the follow-up Tasks tab show.
  const fetchTodoCount = async () => {
    try {
      const { json: data } = await apiCall(activeCompanyId ? `/api/todos/count?companyId=${activeCompanyId}` : '/api/todos/count');
      if (data.success) {
        setTodoCount(data.count || 0);
      }
    } catch (err) {
      console.error('Error fetching to-do count:', err);
    }
  };

  useEffect(() => {
    if (user && user.role !== 'SUPER_ADMIN') {
      fetchNotifications();
      fetchFollowUpCount();
      fetchTodoCount();
      const interval = setInterval(() => {
        fetchNotifications();
        fetchFollowUpCount();
        fetchTodoCount();
      }, 60 * 1000); // 1 minute refresh
      return () => clearInterval(interval);
    }
    // `activeCompanyId` is a dependency, not noise: the to-do badge counts ONE
    // workspace, so switching companies must refetch it rather than leave the
    // previous account's number on screen until the next minute tick.
  }, [user, activeCompanyId]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const embedded = params.get('embedded') === 'true';
      if (embedded) {
        setIsEmbedded(true);
        sessionStorage.setItem('isEmbedded', 'true');
      } else if (sessionStorage.getItem('isEmbedded') === 'true') {
        setIsEmbedded(true);
      }
      
      // Load sidebar collapsed state
      const collapsed = localStorage.getItem('sidebar_collapsed') === 'true';
      setIsCollapsed(collapsed);

      // Which nav groups were left open. Guarded: a corrupt entry must not
      // throw here, or the whole shell fails to mount over a storage value.
      try {
        const stored = JSON.parse(localStorage.getItem('sidebar_open_groups') || '{}');
        if (stored && typeof stored === 'object') setOpenGroups(stored);
      } catch {
        setOpenGroups({});
      }
    }
    
    async function loadUser() {
      const data = await clientGetMe();
      if (!data.success) {
        if (!PUBLIC_PATHS.includes(pathname)) {
          router.push('/login');
          return; // Keep loading state true to prevent protected children from mounting
        }
      } else {
        setUser(data.user);
        setCompanies(Array.isArray(data.companies) ? data.companies : []);
        setPlanState(data.planStatus || null);
        // Warn on the way to full, not only once uploads start failing. Deduped
        // per state inside the helper — this runs on every navigation.
        maybeToastStoragePressure(data.storageData || null);
        setMaxUploadBytes(data.platformConfig?.maxUploadBytes);
        
        // Setup Push Notifications
        registerDevice(data.user.id, data.user.tenantId);

        // A signed-in user can still arrive here from an emailed reset/verify
        // link — let that page load instead of bouncing them to billing or
        // onboarding, which would silently break the link.
        if (AUTH_FLOW_PATHS.includes(pathname)) {
          setLoading(false);
          return;
        }

        if (data.user.role !== 'SUPER_ADMIN') {
          const isTenantAdmin = data.user.role === 'TENANT_ADMIN';

          // ── Locked out by the plan ──────────────────────────────────────
          // Expired, or never subscribed. Signing in still works — being bounced
          // to the login page with no explanation is how a lapsed subscription
          // gets mistaken for a broken account. What closes is the app: Billing
          // (admins, the renewal path) and Settings stay open, everything else
          // redirects here, and every tenant-data API answers 402 PLAN_EXPIRED
          // whatever the browser does.
          //
          // ── WHICH plan, THOUGH ──────────────────────────────────────────
          // The workspace the URL is in, not the tenant. This used to read
          // `data.user.isExpired` (the personal plan) plus a truthy
          // `planDetails` — and since /api/auth/me falls back to the DEFAULT
          // plan when none is assigned, `hasPlan` was always true and a
          // business-only tenant was never locked at all, however long its
          // plan had been dead. `planStatus.axes` is the authority now.
          // `pathCompanyId` is derived from `pathname` above, and `pathname`
          // is a dependency of this effect — so it is the workspace this
          // navigation is actually landing in, not the previous one's.
          //
          // The PATH id deliberately, not the chrome's `activeCompanyId`. The
          // four account pages carry `?company=`, and locking on that would
          // make /audit-logs?company=acme redirect to /billing?expired=1 the
          // moment the business half lapsed — closing a door EXPIRED_PATHS_*
          // above exists to hold open.
          const lockNow = workspaceLock(data.planStatus, pathCompanyId);
          if (lockNow.locked) {
            const allowed = isTenantAdmin ? EXPIRED_PATHS_ADMIN : EXPIRED_PATHS_MEMBER;
            // /login and /register stay reachable, as they did before the lock:
            // a signed-in user who navigates back to them must not be trapped.
            const onAllowed = pathname === '/login' || pathname === '/register'
              || allowed.some((p) => pathname === p || pathname.startsWith(p + '/'));
            // A member cannot pay, so the lock screen is theirs and /billing
            // is the admin's. Worked out BEFORE the announcement, because it is
            // what decides which page the sentence is read on.
            const lockPath = isTenantAdmin ? '/billing?expired=1' : PLAN_LOCK_PATH;
            // Name the half only when the tenant has two to tell apart.
            announcePlanExpiry(
              data.planStatus,
              lockNow.axis,
              data.planStatus?.accountType === 'both',
              onAllowed ? null : lockPath.split('?')[0],
            );
            if (!onAllowed) {
              // A member cannot pay, and /billing sends non-admins to /dashboard —
              // pointing them there would bounce the two redirects off each other
              // forever. They get the lock screen and their admin's name instead.
              router.push(lockPath);
              return;
            }
            setLoading(false);
            return;
          }

          if (data.isAmcLocked) {
            if (pathname !== '/billing/amc-lock' && pathname !== '/login') {
              router.push('/billing/amc-lock');
              return;
            }
          }

          /**
           * ── SETUP IS NOT FINISHED ────────────────────────────────────────
           *
           * Every file in DocsNX lives on the tenant's own Google Drive, so a
           * workspace with no grant is one where every upload fails. Until the
           * wizard is done the app is closed, and it is closed for EVERYONE in
           * the tenant, not only the admin: the Members step creates real
           * accounts, and the server gate (`requireOnboarded`) is tenant-wide,
           * so a member let loose here would collect silent 403s instead. The
           * wizard shows them a "your admin is still setting up" panel.
           *
           * Billing stays reachable because checkout happens on the way in.
           */
          if (data.user.tenant && data.user.tenant.hasCompletedOnboarding === false) {
            if (pathname !== ONBOARDING_PATH && pathname !== '/login' && pathname !== '/register' && pathname !== '/billing' && pathname !== '/verify-email') {
              announceOnboardingIncomplete(pathname, isTenantAdmin);
              router.push(ONBOARDING_PATH);
              return;
            }
          }

          // Normal user redirects
          if (pathname === '/login' || pathname === '/register' || pathname === '/') {
            /**
             * Straight to Billing when NO axis has a plan.
             *
             * This read `data.planDetails || tenant.subscriptionPlanId`, and
             * `planDetails` falls back to the default plan for a tenant with
             * none — so it was never false and this branch never fired. Asking
             * the axes gives the answer the fallback was hiding, and gives a
             * business-only tenant a correct one for the first time.
             */
            if (lockNow.fullyLapsed) {
              router.push('/billing');
            } else if (data.user.tenant && data.user.tenant.hasCompletedOnboarding === false) {
              router.push(ONBOARDING_PATH);
            } else {
              router.push('/dashboard');
            }
            return; // Keep loading state true
          }
        }
      }
      setLoading(false);
    }
    // No auth fetch on the offline fallback: the network is gone by definition,
    // and a failed /me would push to /login.
    if (isOfflineFallback) {
      setLoading(false);
      return;
    }
    loadUser();
  }, [pathname, router, isOfflineFallback]);

  // A company renamed from inside a form (the business "Belongs to" in
  // HolderSelect) — re-read ONLY the company list, so the sidebar, switcher and
  // tabs stop showing the old name before the next navigation. Not `loadUser`:
  // its redirects and push registration have nothing to do with a rename.
  useEffect(() => {
    const onCompaniesChanged = async () => {
      const data = await clientGetMe();
      if (data.success) setCompanies(Array.isArray(data.companies) ? data.companies : []);
    };
    window.addEventListener('docsnx:companies-changed', onCompaniesChanged);
    return () => window.removeEventListener('docsnx:companies-changed', onCompaniesChanged);
  }, []);

  // Route guard to redirect SUPER_ADMIN users away from tenant-specific URLs reactively.
  // TENANT_SPECIFIC_PATHS is auto-derived from src/lib/moduleRegistry.js — do not hardcode paths here.
  useEffect(() => {
    if (user?.role === 'SUPER_ADMIN') {
      const isTenantRoute = TENANT_SPECIFIC_PATHS.some(path =>
        pathname === path || pathname.startsWith(path + '/')
      );
      if (isTenantRoute) {
        router.replace('/tenants');
      }
    }
  }, [user, pathname, router]);

  /**
   * ── A VIEWER WITH NO HOUSEHOLD LANDS IN THEIR COMPANY ─────────────────────
   *
   * Sign-in sends everyone to `/dashboard`, which is the HOUSEHOLD's. For a
   * member added to work on a company that is a page with nothing on it whose
   * every module link 403s — and with no switcher (they have one workspace,
   * so there is no chip) no obvious way out of it.
   *
   * ⚠ NOT gated on `role` any more. It used to fire only for a STANDARD member,
   * which excluded the one person who most needs it: a TENANT_ADMIN who has just
   * erased their personal account. Their tenant is `business` from that moment,
   * `/dashboard` is a household they no longer have, and with a single company
   * there is no chip — so they were left on an empty page looking at what read
   * as a deleted company. `defaultCompanyId` answers for both cases at once, and
   * for a tenant with a household it answers null and nothing moves.
   *
   * Still deliberately narrow: only `/dashboard`. It is a LANDING fix, not a
   * route guard — a business viewer who follows a link to a personal page still
   * gets that page's own 403, which is the honest answer and not this effect's
   * business to pre-empt. Anything wider would start redirecting /billing and
   * /settings, which belong to the tenant rather than to either account.
   */
  useEffect(() => {
    if (!user || pathname !== PERSONAL_HOME) return;
    const fallback = defaultCompanyId(switcherMenu);
    if (!fallback) return;
    router.replace(companyHome(fallback));
  }, [user, switcherMenu, pathname, router]);

  // Removed manual service worker registration here because PWABanner/usePWA handles it.

  // Spotlight search debounce
  useEffect(() => {
    if (!searchQuery) { setSearchResults([]); return; }
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const { json } = await apiCall(`/api/search?q=${encodeURIComponent(searchQuery)}`);
        if (json.success) { setSearchResults(json.results || []); setActiveIndex(0); }
      } catch (err) { console.error('Search failed:', err); }
      finally { setSearching(false); }
    }, 250);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); setSearchOpen(prev => !prev); }
      if (!searchOpen) return;
      if (e.key === 'Escape') { setSearchOpen(false); setSearchQuery(''); setSearchResults([]); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIndex(prev => prev < searchResults.length - 1 ? prev + 1 : prev); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIndex(prev => prev > 0 ? prev - 1 : prev); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        if (activeIndex >= 0 && activeIndex < searchResults.length) {
          router.push(searchResults[activeIndex].link);
          setSearchOpen(false); setSearchQuery(''); setSearchResults([]);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [searchOpen, searchResults, activeIndex, router]);

  const toggleSidebar = () => {
    const nextState = !isCollapsed;
    setIsCollapsed(nextState);
  };

  /**
   * Open or close one collapsible nav group, and remember the choice.
   *
   * Persisted from the handler rather than an effect on `openGroups`: an effect
   * would fire on mount with the empty initial map and wipe what was stored
   * before the mount effect above had a chance to read it back.
   */
  const toggleGroup = (label) => {
    setOpenGroups((prev) => {
      const next = { ...prev, [label]: !prev[label] };
      try {
        localStorage.setItem('sidebar_open_groups', JSON.stringify(next));
      } catch {
        // Private-mode / quota. The group still toggles for this session.
      }
      return next;
    });
  };

  useEffect(() => {
    const handleMouseMove = (e) => {
      if (!document.isResizingSidebar) return;
      let newWidth = e.clientX;
      if (newWidth < 200) newWidth = 200;
      if (newWidth > 400) newWidth = 400;
      setSidebarWidth(newWidth);
    };
    const handleMouseUp = () => {
      document.isResizingSidebar = false;
      document.body.style.cursor = 'default';
    };
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  // ─── Back navigation ──────────────────────────────────────────────────────
  // Called up here, above the two early returns below, because it is a hook and
  // the loading splash must not change how many run. It tracks the pathname on
  // every render, so it also has to see the ones the splash paints.
  const { goBack, canGoBack } = useBackNavigation({
    isSuperAdmin: user?.role === 'SUPER_ADMIN',
  });

  // ─── Loading Splash ───
  if (loading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-6 bg-background">
        <div className="flex items-center gap-3">
          <img src={APP_MARK} alt={APP_NAME} className="h-10 w-auto object-contain animate-pulse bg-transparent" />
        </div>
        <div className="flex gap-1.5">
          <div className="w-1 h-8 rounded-full bg-primary animate-pulse" />
          <div className="w-1 h-8 rounded-full bg-primary animate-pulse delay-75" />
          <div className="w-1 h-8 rounded-full bg-primary animate-pulse delay-150" />
        </div>
      </div>
    );
  }

  // Public/auth pages own their whole viewport — no sidebar, header or bottom nav.
  if (isOfflineFallback || PUBLIC_PATHS.includes(pathname)) return <>{children}</>;

  /**
   * So does the wizard, and for a related reason: until setup is finished every
   * nav link in this shell leads somewhere the gate above bounces straight back
   * from. A sidebar full of links that all return here is worse than no sidebar.
   *
   * Deliberately NOT in PUBLIC_PATHS — that list also decides who is spared the
   * redirect to /login, and the wizard needs a session.
   */
  if (pathname === ONBOARDING_PATH) return <>{children}</>;

  // ─── Nav Groups — auto-derived from src/lib/moduleRegistry.js ────────────
  // Do NOT add nav items here. Add them to moduleRegistry.js instead.
  // ─────────────────────────────────────────────────────────────────────────
  const navGroups = [
    {
      label: 'Overview',
      /**
       * ── THE OVERVIEW GROUP FOLLOWS THE WORKSPACE ──────────────────────────
       *
       * In a company workspace these used to be personal links, so "Dashboard"
       * silently teleported the user back to Personal — with the sidebar still
       * showing the company's modules, which is the confusing half.
       *
       * A company now reaches everything the household does, and by the same
       * route: `utilityNavPath` prefixes each path with the company, and the
       * page behind it is the SAME component reading the SAME API with a
       * company on the request. Only the taxonomy differs.
       *
       * Follow Up used to be the exception — one unprefixed link aggregating
       * every workspace at once. It is per workspace now, so it takes the
       * prefix like the rest; a company's renewals belong on the company's
       * page, not in the household's badge.
       *
       * The first row is named after the COMPANY, not 'Company Home'. On an
       * account holding several, the generic label was the same four words in
       * every workspace and said nothing about which one was open — which is
       * the only question switching workspaces asks. The name falls back to
       * 'Company' for the render before `/api/companies` lands, and the row
       * truncates, so a long one clips rather than widening the rail.
       */
      items: inBusiness ? [
        { name: activeCompany?.name || 'Company', path: `/business/${activeCompanyId}/dashboard`, icon: LayoutDashboard },
        { name: 'Document Manager', path: utilityNavPath('/documents', activeCompanyId), icon: FolderOpen      },
        { name: 'Follow Up',        path: utilityNavPath('/follow-up', activeCompanyId), icon: CheckCircle2, count: followUpCount },
        { name: 'AI Analysis',      path: utilityNavPath('/analysis',  activeCompanyId), icon: Sparkles       },
      ] : [
        { name: 'Dashboard',   path: '/dashboard',           icon: LayoutDashboard                  },
        // The document manager is a page in its own right, not a module: it is
        // the only view that spans the whole taxonomy (and the only one that can
        // reach `other`), and it is where both single upload and Power Scan file
        // into. It used to be reachable only by clicking Identity, which read as
        // though managing documents were an Identity feature.
        { name: 'Document Manager', path: '/documents',      icon: FolderOpen                       },
        // Power Scan is deliberately NOT here. It uploads documents into the
        // documents module and is entered from that module's own page, the
        // same way single upload is. It was listed under Overview as though it
        // were a feature of its own, which is what made it look like a
        // separate module rather than a second way to fill the same table.
        { name: 'Follow Up',   path: '/follow-up',           icon: CheckCircle2, count: followUpCount },
        { name: 'AI Analysis', path: '/analysis',            icon: Sparkles                         },
      ],
    },
    {
      // One flat list in master-document-table order — the table IS the
      // information architecture, so a second grouping layer above it would be
      // exactly the ambiguity migration 0023 removed.
      //
      // The heading is 'Modules' in BOTH workspaces. It carried the company's
      // name while the Overview row above it read 'Company Home'; now that the
      // row is the name, a named heading would print it twice in one rail and
      // leave the group itself unlabelled — the group says what these links
      // ARE, and the workspace they belong to is already answered above it.
      label: 'Modules',
      // Filtered to the sub-categories this member may view; a module with none
      // left is not rendered at all. The SCOPE argument is what keeps the two
      // taxonomies apart — /api/document-categories returns both, and a member
      // with default permissions holds all of them.
      items: navModulesFrom(
        permittedCategories,
        inBusiness ? BUSINESS_NAV_MODULES : NAV_MODULES,
        inBusiness ? 'business' : 'personal',
        inBusiness ? `/business/${activeCompanyId}` : '',
      ).map((m) => ({
        name: m.name,
        path: m.path,
        icon: moduleIcon(m.key),
        moduleKey: m.key,
        subCategories: m.subCategories,
      })),
    },
    {
      label: 'Workspace',
      // Collapsible in the sidebar. Flagged rather than matched on the label:
      // `lockedNavGroups` below reuses the label 'Account', and that group must
      // never be collapsible — see the comment there.
      collapsible: true,
      // Company-prefixed in a company workspace — all five of them now, see
      // `utilityNavPath`. Profiles and Members were the two exclusions, until a
      // company gained a profile of its own and a roster of its own. The icon
      // still keys off the UNPREFIXED path, since it names the module, not the
      // workspace.
      items: UTILITY_MODULES.map((m) => ({
        name: m.name,
        path: utilityNavPath(m.path, activeCompanyId),
        icon: moduleIcon(m.path),
      })),
    },
    /* ── NO `ACCOUNT` GROUP HERE ANY MORE ──────────────────────────────
       Billing, AI Credits, Settings and Audit Logs moved to the avatar menu
       in the top-right of both headers (AccountMenu.jsx), which is where they
       belong: the rail is navigation INSIDE a workspace, it disappears at
       72px, and being `hidden lg:flex` it never existed on a phone at all.
       Which rows that menu offers is decided by `accountMenuItems`
       (src/lib/accountMenu.ts) — including the TENANT_ADMIN gate this group
       used to declare. */
  ];

  // Super Admin nav items
  const superAdminNavItems = [
    { name: 'Dashboard', path: '/admin', icon: Sparkles },
    { name: 'Tenants', path: '/admin/tenants', icon: Building },
    { name: 'Users', path: '/admin/users', icon: Users },
    { name: 'Plans', path: '/admin/plans', icon: CreditCard },
    { name: 'Add-ons', path: '/admin/addons', icon: Puzzle },
    { name: 'Discounts', path: '/admin/discounts', icon: Tag },
    { name: 'AI Settings', path: '/admin/ai-settings', icon: Shield },
    // Per-field configuration for the 83 sub-categories: what is collected,
    // what is encrypted, what a scan reads, what a user must fill in.
    { name: 'Field Config', path: '/admin/document-fields', icon: SlidersHorizontal },
    { name: 'WhatsApp', path: '/admin/whatsapp', icon: MessageCircle },
    { name: 'Payments', path: '/admin/payments', icon: Receipt },
    { name: 'Platform Settings', path: '/admin/settings', icon: Settings }
  ];

  const isSuperAdmin = user?.role === 'SUPER_ADMIN';
  const isTenantAdmin = user?.role === 'TENANT_ADMIN';

  // ─── Plan lock, in the navigation ─────────────────────────────────────────
  // The module links already vanish on their own — clientCan denies every module
  // on a lapsed axis, so the permitted list comes back empty. What is left is
  // to keep the two doors that stay open visible, instead of showing a member an
  // empty sidebar with no way out.
  //
  // Per WORKSPACE, not per tenant: on an account holding both halves, a lapsed
  // household must not empty the sidebar of a company that is paid for. The
  // decision lives in src/lib/workspaceLock.ts so it can be tested — Shell is
  // JSX in a .js file and vitest cannot import it.
  // The PATH id, like the lock branch in `loadUser` — see the note there.
  const lock = workspaceLock(planState, pathCompanyId);
  const planLocked = !!user && !isSuperAdmin && lock.locked;
  const daysToExpiry = daysUntil(planState?.expiresAt);
  const expiringSoon = !planLocked && daysToExpiry !== null
    && daysToExpiry >= 0 && daysToExpiry <= EXPIRY_WARNING_DAYS;

  // ─── Where the brand goes ─────────────────────────────────────────────────
  // Both copies of the logo — the sidebar's and the mobile header's — are links
  // home, the way every other site's is. On mobile it is the only brand on
  // screen, so it is also the shortest route back from a deep module page.
  const brandHome = brandHomePath({ isSuperAdmin, isTenantAdmin, planLocked, lockPath: PLAN_LOCK_PATH });
  const brandLabel = APP_NAME;

  // ─── Should the back button render? ───────────────────────────────────────
  // Everywhere except the two dead ends:
  //   · the role's own home, which has nothing above it;
  //   · the plan gates, where the redirect logic above would bounce the user
  //     straight back here and the button would read as broken.
  const showBack = canGoBack && !LOCK_SCREEN_PATHS.includes(pathname);

  // Deliberately NOT `collapsible`: this group is the only navigation a
  // plan-locked member has left, so it must not be closable at all.
  //
  // And deliberately still IN THE RAIL, unlike the Account group above. The
  // avatar menu offers these same two rows when `planLocked` — but every other
  // group is gone by then, so removing this one would leave a locked desktop
  // user staring at an empty sidebar. The duplication is the lesser fault.
  const lockedNavGroups = [
    {
      label: 'Account',
      items: [
        ...(isTenantAdmin
          ? [{ name: 'Billing', path: '/billing', icon: CreditCard }]
          : [{ name: 'Plan Expired', path: PLAN_LOCK_PATH, icon: Lock }]),
        { name: 'Settings', path: '/settings', icon: Settings },
      ],
    },
  ];
  // A group's `roles` is enforced here. No group declares one today — the
  // Account group that did now lives in the header menu, which applies the same
  // TENANT_ADMIN gate in `accountMenuItems` — but the filter stays: a group
  // whose `roles` is declared and never read is exactly how every member came
  // to see Billing, AI Credits and Settings, three links that all bounce a
  // non-admin straight back to /dashboard.
  // Filtered here rather than inside the JSX map so the `first:border-t-0` group
  // separator still lands on whichever group actually renders first.
  const visibleNavGroups = (planLocked ? lockedNavGroups : navGroups)
    .filter((g) => !g.roles || g.roles.includes(user?.role));

  const bottomNavItems = planLocked
    ? [
        isTenantAdmin
          ? { name: 'Billing', path: '/billing', icon: CreditCard }
          : { name: 'Plan', path: PLAN_LOCK_PATH, icon: Lock },
        { name: 'Settings', path: '/settings', icon: Settings },
      ]
    : user?.role === 'SUPER_ADMIN'
    ? [
        { name: 'Dashboard', path: '/admin', icon: LayoutDashboard },
        { name: 'Tenants', path: '/admin/tenants', icon: Building },
        { name: 'Users', path: '/admin/users', icon: Users },
        { name: 'Plans', path: '/admin/plans', icon: Tag },
        { name: 'Settings', path: '/admin/ai-settings', icon: Shield }
      ]
    /* ── THE BOTTOM NAV FOLLOWS THE WORKSPACE ────────────────────────────
       The four personal paths below used to be the only ones there were, so
       reaching a company on a phone — once the switcher made that possible at
       all — dropped the user into a workspace whose every navigation control
       walked them straight back out of it, silently.

       Every path is company-prefixed, so nothing here leaves the workspace.

       The row is now the personal row, slot for slot, differing only in where
       each tab points. It held To-Dos in the Docs slot for a while, on the
       argument that the company's home page opened onto a module grid — it no
       longer does, and the argument was thin even then, because the
       Document Manager is the one view that spans a workspace's WHOLE taxonomy
       (it is why the desktop rail lists it under Overview in both workspaces,
       see navGroups above), and that argument left the phone as the only
       surface where the two accounts disagreed about how to reach it.

       To-Dos gives up nothing by leaving: `todoButton` below is in BOTH
       headers, on every width, carrying the same count badge, and To-Dos is a
       UTILITY_MODULES entry so the More tab lists it company-prefixed too. The
       Document Manager had neither. AI Analysis stays one tap in, on the More
       tab and in the desktop rail. */
    : inBusiness
    ? [
        { name: 'Company', path: `/business/${activeCompanyId}/dashboard`, icon: LayoutDashboard },
        { name: 'Follow Up', path: utilityNavPath('/follow-up', activeCompanyId), icon: CheckCircle2, count: followUpCount },
        // FileText, not the rail's FolderOpen: this is the personal row's Docs
        // tab with a company on it, and the two tab bars must read alike.
        { name: 'Docs', path: utilityNavPath('/documents', activeCompanyId), icon: FileText },
        { name: 'More', path: `/business/${activeCompanyId}/more`, icon: Menu },
      ]
    : [
        { name: 'Home', path: '/dashboard', icon: LayoutDashboard },
        // Carries the same badge as the desktop row. Without it the two
        // surfaces disagreed about whether anything needed attention.
        { name: 'Follow Up', path: '/follow-up', icon: CheckCircle2, count: followUpCount },
        { name: 'Docs', path: '/documents', icon: FileText },
        { name: 'More', path: '/more', icon: Menu }
      ];

  // '/billing' joins the exact-match list now that '/billing/credits' is its own
  // nav entry: the prefix rule would light up BOTH rows on the sub-page.
  const isActivePath = (path) => {
    if (path === '/dashboard' || path === '/admin' || path === '/billing') return pathname === path;
    return pathname === path || pathname.startsWith(path + '/');
  };

  // ─── Header to-do button ──────────────────────────────────────────────────
  // One element, rendered into BOTH headers, so the desktop and mobile badges
  // cannot drift apart the way two copies of the same markup would.
  //
  // Gated on clientCan rather than just on `isSuperAdmin`, unlike the Bell
  // beside it: the sidebar's Workspace group maps UTILITY_MODULES unfiltered,
  // so a member without `todos.view` is already offered a To-Dos link that
  // lands them on a 403. This button does not repeat that.
  const showTodoButton = !isSuperAdmin && !planLocked && clientCan(user, 'todos', null, 'view');

  // ─── The workspace switcher ───────────────────────────────────────────────
  // It moved out of the sidebar and into BOTH headers' right-hand clusters. The
  // rail is navigation inside a workspace; the control that chooses the
  // workspace belongs with the account controls — and in the rail it did not
  // exist on a phone at all, which left no route into a company from one.
  //
  // Hidden only when EVERY half is locked. Switching workspaces then lands on a
  // gate that redirects straight back, and a control that visibly does nothing
  // is worse than no control.
  //
  // ⚠ NOT hidden on `planLocked`, which is now per-workspace. With one half
  // lapsed and the other paid, the switcher is the ONLY way out of the lock
  // screen and into the account the customer is still paying for — hiding it
  // there would strand them on a renewal page for a half they may not even
  // want.
  //
  // `switcherMenu` (built beside `activeCompanyId` above) is asked the same
  // question the switcher asks itself, so a member who belongs to one account
  // gets no chip at all rather than a chip that opens onto a single row naming
  // where they already are. That is only honest because `defaultCompanyId` has
  // already put them IN that one workspace — see the fallback up there.
  const showSwitcher = !isSuperAdmin && !lock.fullyLapsed && switcherMenu.hasChoice;
  const workspaceSwitcher = (variant) => (
    <WorkspaceSwitcher
      variant={variant}
      accountType={accountType}
      companies={companies}
      activeCompanyId={activeCompanyId}
      user={user}
      unreadElsewhere={unreadElsewhere}
    />
  );
  const todoButton = (
    <Button
      variant="ghost"
      size="icon"
      aria-label="To-Dos"
      onClick={() => router.push(utilityNavPath('/todos', activeCompanyId))}
      className={cn(
        'h-8 w-8 shrink-0 relative',
        todoCount > 0 ? 'text-primary hover:text-primary/80' : 'text-muted-foreground hover:text-foreground'
      )}
    >
      <ListTodo size={16} />
      {todoCount > 0 && (
        <span className="absolute top-1 right-1 w-3.5 h-3.5 bg-destructive text-white rounded-full text-2xs flex items-center justify-center font-bold border border-background">
          {todoCount}
        </span>
      )}
    </Button>
  );


  const SidebarItem = ({ item }) => {
    const Icon = item.icon;
    const active = isActivePath(item.path);
    return (
      <button
        onClick={() => router.push(item.path)}
        title={isCollapsed ? item.name : undefined}
        className={cn(
          'flex items-center gap-3 w-full py-2.5 text-xs font-semibold transition-all border-l-2 relative',
          isCollapsed ? 'justify-center px-0' : 'px-5',
          active 
            ? 'text-primary bg-primary/10 border-l-primary font-bold' 
            : 'text-muted-foreground border-l-transparent hover:text-foreground hover:bg-muted/40'
        )}
      >
        <span className={cn('flex items-center shrink-0', active ? 'text-primary' : 'text-faint')}>
          <Icon size={16} strokeWidth={active ? 2.5 : 1.8} />
        </span>
        {!isCollapsed && <span className="truncate">{item.name}</span>}
        {item.count > 0 && (
          <span className={cn(
            "absolute right-2 px-1.5 py-0.5 text-2xs font-black bg-primary text-primary-foreground rounded-full leading-none",
            isCollapsed && "top-1 right-3"
          )}>
            {item.count}
          </span>
        )}
      </button>
    );
  };

  /**
   * One master module in the sidebar: a row that opens its sub-categories in a
   * flyout.
   *
   * This was an <Accordion type="single" collapsible> that expanded IN PLACE.
   * Two things were wrong with that. Fourteen modules with up to sixteen
   * sub-categories each turned a 260px column into a scroll of ninety rows the
   * moment one opened; and when the sidebar was collapsed to its 72px rail the
   * sub-categories could not be shown at all, so the rail silently lost half the
   * app's navigation. A flyout is not bound by the sidebar's width, so the rail
   * and the expanded sidebar now behave identically — see ModuleFlyout.jsx for
   * why it is a portal rather than an absolutely-positioned child.
   *
   * The flyout is the FAST path — one click from anywhere to any sub-category.
   * The module page lists the same sub-categories with their record and renewal
   * counts, for when the question is "where should I look?" rather than "take me
   * to X". Both are reachable: the row opens the menu, and the menu's header
   * opens the module page.
   */
  const SidebarModules = ({ items }) => (
    <>
      {items.map((item) => {
        const Icon = item.icon;
        const active = isActivePath(item.path);
        const isOpen = openModule?.moduleKey === item.moduleKey;
        return (
          <button
            key={item.moduleKey}
            onClick={(e) => setOpenModule(
              isOpen
                ? null
                : {
                    moduleKey: item.moduleKey,
                    name: item.name,
                    icon: item.icon,
                    // The module's own page, carrying the workspace. The flyout
                    // builds no path of its own — it used to, and dropped the
                    // company doing it.
                    path: item.path,
                    subCategories: item.subCategories,
                    rect: e.currentTarget.getBoundingClientRect(),
                  },
            )}
            title={isCollapsed ? item.name : undefined}
            aria-expanded={isOpen}
            className={cn(
              'flex items-center gap-3 w-full py-2.5 text-xs font-semibold transition-all border-l-2 relative',
              isCollapsed ? 'justify-center px-0' : 'px-5',
              active || isOpen
                ? 'text-primary bg-primary/10 border-l-primary font-bold'
                : 'text-muted-foreground border-l-transparent hover:text-foreground hover:bg-muted/40',
            )}
          >
            <span className={cn('flex items-center shrink-0', active || isOpen ? 'text-primary' : 'text-faint')}>
              <Icon size={16} strokeWidth={active ? 2.5 : 1.8} />
            </span>
            {!isCollapsed && (
              <>
                <span className="truncate">{item.name}</span>
                <ChevronRight
                  size={13}
                  className={cn(
                    'ml-auto shrink-0 transition-transform',
                    isOpen ? 'translate-x-0.5 text-primary' : 'text-faint',
                  )}
                />
              </>
            )}
          </button>
        );
      })}
    </>
  );

  const NotificationList = ({ onClose }) => {
    // The API returns unread first, then the read history, so the divider goes
    // at the first read row rather than needing a second pass over the list.
    const firstReadId = notifications.find((n) => n.isRead)?.id;

    return (
    <div className="flex flex-col gap-1 w-full max-h-[320px] overflow-hidden bg-popover text-popover-foreground">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border/50">
        <span className="text-xs font-bold">
          Active Alerts {unreadCount > 0 && <span className="ml-1 bg-destructive text-white rounded-full px-1.5 py-0.5 text-2xs">{unreadCount}</span>}
        </span>
        <div className="flex items-center gap-1">
          {unreadCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={markAllNotificationsRead}
              className="h-6 px-2 text-xs font-semibold text-muted-foreground hover:text-foreground"
            >
              Mark all read
            </Button>
          )}
          {firstReadId && (
            <Button
              variant="ghost"
              size="sm"
              onClick={clearReadNotifications}
              className="h-6 px-2 text-xs font-semibold text-muted-foreground hover:text-foreground"
            >
              Clear read
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            className="h-6 w-6 text-muted-foreground hover:text-foreground"
          >
            <X size={12} />
          </Button>
        </div>
      </div>
      <div className="overflow-y-auto max-h-[260px] p-1.5 flex flex-col gap-1.5">
        {notifications.length === 0 ? (
          <div className="py-6 px-3 text-center text-muted-foreground text-xs flex flex-col items-center gap-1.5">
            <span className="text-emerald-500 text-lg">✓</span>
            <span>All records up to date!</span>
          </div>
        ) : (
          notifications.map((n) => (
            <Fragment key={n.id}>
              {n.id === firstReadId && (
                <div className="px-1 pt-1 pb-0.5 text-2xs font-bold uppercase tracking-wider text-faint">
                  Earlier
                </div>
              )}
              <button
                onClick={async () => {
                  // Mark read — NOT delete. The row stays in the panel as
                  // history so the notice can be re-read after acting on it.
                  if (!n.isRead) {
                    // Best-effort by design: the navigation below is what the
                    // user asked for, and blocking it on a failed mark-read
                    // would be worse than the row staying bold. Reported all
                    // the same, because silence here looked like a bug.
                    const { res, json } = await apiCall(`/api/notifications/${n.id}`, { method: 'PATCH' }, { subject: 'notification', action: 'marking this read' });
                    if (!res.ok) toast.error(json.error || 'Could not mark this as read.');
                  }
                  router.push(n.link);
                  onClose();
                  fetchNotifications();
                }}
                className={cn(
                  'w-full text-left p-2 rounded-lg border-l-2 bg-card hover:bg-muted/50 transition-colors text-xs leading-relaxed',
                  n.isRead ? 'border-border opacity-60' : 'border-primary'
                )}
              >
                <div className="flex items-center gap-1.5 mb-0.5">
                  <span className="font-bold text-foreground text-xs">{n.title}</span>
                  {/*
                    ── WHY ONE KIND OF ROW IS TAGGED AND THE REST ARE NOT ────
                    The panel is scoped to the workspace you are standing in, so
                    a notice in it needs no label — the chip above already says
                    where "here" is. Billing notices are the exception: they are
                    filed account-level and therefore appear in EVERY workspace,
                    so a "Personal plan expires in 3 days" read from inside Acme
                    would otherwise look like a notice that had leaked in from
                    somewhere else.

                    Only on an account with somewhere else to be — the same
                    `hasChoice` the switcher chip turns on. On a single-workspace
                    account every notice is account-level in effect and the tag
                    would be on every row, saying nothing.
                  */}
                  {n.accountScope === 'account' && switcherMenu.hasChoice && (
                    <span className="shrink-0 rounded px-1 py-px text-2xs font-bold uppercase tracking-wider bg-muted text-muted-foreground">
                      Account
                    </span>
                  )}
                </div>
                <div className="text-muted-foreground">{n.message}</div>
              </button>
            </Fragment>
          ))
        )}
      </div>
    </div>
    );
  };

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      {/* ─── Desktop Sidebar ─── */}
      {!isEmbedded && (
        <aside 
          className={cn(
            "min-h-screen bg-card border-r border-border flex flex-col shrink-0 fixed top-0 left-0 bottom-0 z-40 overflow-y-auto hidden lg:flex transition-all duration-75"
          )}
          style={{ width: isCollapsed ? 72 : sidebarWidth }}
        >
          {/* Drag Resizer Handle */}
          {!isCollapsed && (
            <div 
              className="absolute right-0 top-0 bottom-0 w-1.5 border-l border-border/50 cursor-col-resize hover:bg-primary/50 active:bg-primary z-50 transition-colors flex items-center justify-center group"
              onMouseDown={(e) => {
                e.preventDefault();
                document.isResizingSidebar = true;
                document.body.style.cursor = 'col-resize';
              }}
            >
              <div className="h-8 w-1 bg-border rounded-full group-hover:bg-transparent transition-colors" />
            </div>
          )}
          {/* Brand — a link home. The layout classes stay on the anchor itself:
              an <a> is inline by default, so moving them to a wrapper would drop
              the row's flex/height and shift the whole rail. */}
          <Link
            href={brandHome}
            aria-label={`${brandLabel} home`}
            className={cn(
              "flex items-center gap-3 p-5 border-b border-border/60 bg-transparent h-[76px] transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
              isCollapsed ? "justify-center" : ""
            )}
          >
            <img src={APP_MARK} alt={APP_NAME} className={cn("object-contain shrink-0 rounded-lg border border-border/50 p-0.5 bg-background/50", isCollapsed ? "w-8 h-8" : "w-9 h-9")} />
            {!isCollapsed && (
              <div className="flex flex-col justify-center min-w-0 pb-0.5">
                {/* `min-w-0` here and `truncate` on the two rows below stay even
                    though the product name is now a fixed short string: the
                    workspace name underneath it is arbitrary, and this column
                    is what keeps a long one from running out under the SA
                    badge and widening the rail. */}
                <div className="text-[17px] font-black tracking-tight flex min-w-0 items-center gap-1.5 leading-none">
                  <BrandWordmark className="truncate" />
                  {isSuperAdmin && (
                    <Badge variant="destructive" className="text-2xs font-black px-1.5 py-0.5 leading-none flex items-center gap-0.5 rounded-full shrink-0">
                      SA
                    </Badge>
                  )}
                </div>
                <div className="text-xs text-muted-foreground font-semibold truncate mt-1">
                  {isSuperAdmin ? 'Platform Admin' : (user?.tenant?.name || 'My Workspace')}
                </div>
              </div>
            )}
          </Link>

          {/* Spotlight Search Shortcut */}
          {!isSuperAdmin && !isCollapsed && (
            <div className="px-4 pb-2 pt-4">
              <Button
                variant="outline"
                onClick={() => setSearchOpen(true)}
                className="w-full flex items-center justify-between px-3 py-2 h-9 border border-border/85 bg-background/30 text-muted-foreground text-xs hover:text-foreground transition-all rounded-lg"
              >
                <div className="flex items-center gap-2">
                  <Search size={13} className="text-muted-foreground" />
                  <span>Search records...</span>
                </div>
                <kbd className="pointer-events-none inline-flex h-5 select-none items-center gap-0.5 rounded border border-border bg-muted px-1.5 font-mono text-2xs font-medium text-muted-foreground">
                  <span className="text-xs">⌘</span>K
                </kbd>
              </Button>
            </div>
          )}

          {/* Nav Items */}
          <div className="flex-1 py-3 flex flex-col gap-1 overflow-x-hidden">
            {isSuperAdmin ? (
              <div className="flex flex-col gap-1">
                {!isCollapsed && <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground px-5 py-2">System Admin</span>}
                {superAdminNavItems.map(item => <SidebarItem key={item.path} item={item} />)}
              </div>
            ) : (
              visibleNavGroups.map((group, idx) => {
                // The 72px rail has no caption to click, so it keeps the
                // always-expanded list it has always shown.
                const collapsible = !!group.collapsible && !isCollapsed;
                // A group holding the current page opens itself and stays open:
                // arriving at /settings by URL would otherwise show a shut group
                // with the active row hidden inside it.
                const onActivePath = group.items.some((i) => isActivePath(i.path));
                const expanded = !collapsible || !!openGroups[group.label] || onActivePath;
                const itemsId = `nav-group-${idx}`;
                return (
                  <div key={idx} className="flex flex-col gap-0.5 border-t border-border/40 pt-2 first:border-t-0 first:pt-0">
                    {!isCollapsed && (
                      collapsible ? (
                        <button
                          onClick={() => toggleGroup(group.label)}
                          aria-expanded={expanded}
                          aria-controls={itemsId}
                          className="flex items-center w-full text-left text-2xs font-bold uppercase tracking-widest text-faint px-5 py-1.5 hover:text-foreground transition-colors"
                        >
                          {group.label}
                          <ChevronRight
                            size={11}
                            className={cn('ml-auto shrink-0 transition-transform', expanded && 'rotate-90')}
                          />
                        </button>
                      ) : (
                        <span className="text-2xs font-bold uppercase tracking-widest text-faint px-5 py-1">
                          {group.label}
                        </span>
                      )
                    )}
                    {expanded && (
                      <div id={itemsId} className="flex flex-col gap-0.5">
                        {group.label === 'Modules'
                          ? <SidebarModules items={group.items} />
                          : group.items.map(item => <SidebarItem key={item.path} item={item} />)}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>

          {/* Collapse toggle button */}
          <div className="flex justify-end p-2 border-t border-border/40">
            <Button 
              variant="ghost" 
              size="icon" 
              onClick={toggleSidebar} 
              className="h-8 w-8 text-muted-foreground hover:text-foreground mx-auto"
            >
              {isCollapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
            </Button>
          </div>

          {/* The user + Plan & Usage footer moved to /profile ("Account &
              Usage"); name and role are in the header's AccountMenu. */}
        </aside>
      )}

      {/* ─── Main Content Area ─── */}
      {/* `min-w-0` is load-bearing, not tidying.
          This is a flex ITEM of the row above, so without it the item keeps the
          default `min-width: auto` and its automatic minimum size is the
          MIN-CONTENT width of everything inside it. One wide descendant — a
          `whitespace-nowrap` button pair (see button.tsx), a long unbroken
          token, a fixed-px block — therefore stretches this entire column past
          100vw, and `body { overflow-x: hidden }` then clips the overflow
          silently. The result is not "one element scrolls": it is the mobile
          header, the plan banners and every page block shifted left relative to
          the viewport. With `min-w-0` the column stays viewport-width and only
          the offending element overflows, which is the failure we want. */}
      <div
        className={cn(
          'flex-1 min-w-0 flex flex-col min-h-screen transition-all duration-75 lg:pl-[var(--sidebar-width)]',
          /* The bottom nav is 76px PLUS the home-indicator inset it pads itself
             with (see its `pb-[calc(6px+env(…))]` below). Reserving a flat 76px
             here left the tail of every page under the nav by ~34px on any
             notched phone. The two numbers have to be written the same way. */
          !isEmbedded ? 'pb-[calc(76px+env(safe-area-inset-bottom))] lg:pb-0' : ''
        )}
        style={!isEmbedded ? { '--sidebar-width': `${isCollapsed ? 72 : sidebarWidth}px` } : {}}
      >
        {/* Desktop Header */}
        {!isEmbedded && (
          <header className="hidden lg:flex items-center justify-end h-14 px-6 border-b border-border bg-card sticky top-0 z-30 gap-3">
            {/* `mr-auto` rather than flipping the header to `justify-between`:
                the row is `justify-end` and everything after this is a
                right-hand control, so one auto margin on the first child moves
                only this button and leaves that cluster exactly as it was. */}
            {showBack && (
              <Button
                variant="ghost"
                size="sm"
                onClick={goBack}
                className="mr-auto h-8 gap-2 text-xs font-semibold text-muted-foreground hover:text-foreground"
              >
                <ArrowLeft size={14} />
                Back
              </Button>
            )}
            {showSwitcher && workspaceSwitcher('desktop')}
            {/* There is no Search icon in this header — desktop search is the
                sidebar spotlight button and ⌘K — so "beside Search" resolves
                here to the slot immediately left of the Bell. */}
            {showTodoButton && todoButton}
            {!isSuperAdmin && (
              <div className="relative mr-2">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => { setShowDesktopNotifications(!showDesktopNotifications); fetchNotifications(); }}
                  className={cn(
                    'h-8 w-8 relative',
                    unreadCount > 0 ? 'text-primary hover:text-primary/80' : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  <Bell size={16} />
                  {unreadCount > 0 && (
                    <span className="absolute top-1 right-1 w-3.5 h-3.5 bg-destructive text-white rounded-full text-2xs flex items-center justify-center font-bold border border-background">
                      {unreadCount}
                    </span>
                  )}
                </Button>
                {showDesktopNotifications && (
                  <>
                    <div className="fixed inset-0 z-[9999]" onClick={() => setShowDesktopNotifications(false)} />
                    <div className="absolute top-10 right-0 w-[280px] max-h-80 overflow-hidden z-[10000] glass-card rounded-xl shadow-2xl animate-scale-in border border-border/80">
                      <NotificationList onClose={() => setShowDesktopNotifications(false)} />
                    </div>
                  </>
                )}
              </div>
            )}
            <FontSizeToggle />
            <Button
              variant="outline"
              size="sm"
              onClick={toggleTheme}
              className="h-8 gap-2 text-xs font-semibold border-border/60"
            >
              {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
              {theme === 'dark' ? 'Light' : 'Dark'}
            </Button>
            {/* Everything account-shaped, behind one avatar: Billing, AI
                Credits, Settings, Audit Logs and Logout. Logout used to be a
                bare red button right here, between Bell and Theme — the one
                destructive control in the row, one mis-click away. */}
            <AccountMenu user={user} planLocked={planLocked} activeCompanyId={activeCompanyId} variant="desktop" />
          </header>
        )}
        {/* Mobile Header */}
        {!isEmbedded && (
          <header className="sticky top-0 z-30 h-14 bg-card border-b border-border flex lg:hidden items-center justify-between px-4">
            {/* Sits OUTSIDE the brand block, so the brand — which is the side
                that gives way (see below) — absorbs these 32px by truncating
                and the four buttons opposite keep their room. `-ml-1.5` pulls
                the icon's own padding back to the gutter so the row still
                starts on the same vertical as the page below it. */}
            {showBack && (
              <Button
                variant="ghost"
                size="icon"
                onClick={goBack}
                aria-label="Go back"
                className="h-8 w-8 -ml-1.5 mr-0.5 shrink-0 text-muted-foreground hover:text-foreground"
              >
                <ArrowLeft size={18} />
              </Button>
            )}
            {/* `min-w-0` here and `shrink-0` on the icon cluster opposite: the
                brand block is the side that gives way. Without it the block
                could not shrink below its min-content width, so a long
                workspace name was paid for by the four 32px buttons on the
                right, which squeezed into each other. */}
            <Link
              href={brandHome}
              aria-label={`${brandLabel} home`}
              onClick={() => { setShowMobileNotifications(false); setOpenModule(null); }}
              className={cn(
                'flex items-center gap-2.5 bg-transparent h-full transition-opacity active:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                /* Below `sm` with a switcher on screen this block is the 28px
                   logo and nothing else (its text is hidden — see below), so it
                   is FIXED at that size: left shrinkable, `min-w-0` let it be
                   squeezed to zero width and Tailwind's preflight
                   `img { max-width: 100% }` then crushed the logo itself down
                   to a 6px sliver. The workspace chip is what gives way
                   instead, by truncating. Above `sm` the brand carries its text
                   again and goes back to being the flexible side. */
                showSwitcher
                  ? 'shrink-0 sm:min-w-0 sm:flex-1'
                  : 'min-w-0 flex-1',
              )}
            >
              <img src={APP_MARK} alt={APP_NAME} className="w-7 h-7 object-contain shrink-0 rounded-lg border border-border/50 p-0.5 bg-background/50" />
              {/* ── WHAT GIVES WAY ON A 393px PHONE ────────────────────────
                  The row is 16px gutters, a 28px logo, five 32px controls, and
                  now the workspace chip. That does not fit, so below `sm` the
                  brand TEXT steps aside and the logo — still a link home —
                  carries the brand alone. The workspace name is the more useful
                  of the two here: it is the thing that changes. */}
              <div className={cn('flex flex-col justify-center min-w-0 pb-0.5', showSwitcher && 'hidden sm:flex')}>
                <span className="text-[15px] font-extrabold tracking-tight leading-none flex min-w-0 items-center gap-1">
                  <BrandWordmark className="truncate" />
                  {isSuperAdmin && (
                    <Badge variant="destructive" className="text-2xs font-black px-1.5 py-0 leading-none h-3.5 flex items-center rounded-full shrink-0">SA</Badge>
                  )}
                </span>
                <span className="text-2xs text-muted-foreground font-medium truncate mt-0.5 leading-none">
                  {isSuperAdmin ? 'Platform Admin' : (user?.tenant?.name || 'My Workspace')}
                </span>
              </div>
            </Link>

            {/* No `shrink-0` on the row itself, unlike the buttons inside it:
                the workspace chip is the one thing here that may narrow, and it
                does so by truncating the company name rather than by squeezing
                the five 32px controls into each other. */}
            <div className={cn('flex items-center', showSwitcher ? 'min-w-0 gap-1' : 'shrink-0 gap-1.5')}>
              {showSwitcher && workspaceSwitcher('mobile')}
              {!isSuperAdmin && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setSearchOpen(true)}
                  className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
                >
                  <Search size={16} />
                </Button>
              )}

              {showTodoButton && todoButton}

              {/* Mobile Notifications */}
              {!isSuperAdmin && (
                <div className="relative shrink-0">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => { setShowMobileNotifications(!showMobileNotifications); fetchNotifications(); }}
                    className={cn(
                      'h-8 w-8 relative',
                      unreadCount > 0 ? 'text-primary hover:text-primary/80' : 'text-muted-foreground hover:text-foreground'
                    )}
                  >
                    <Bell size={16} />
                    {unreadCount > 0 && (
                      <span className="absolute top-1 right-1 w-3.5 h-3.5 bg-destructive text-white rounded-full text-2xs flex items-center justify-center font-bold border border-background">
                        {unreadCount}
                      </span>
                    )}
                  </Button>
                  {showMobileNotifications && (
                    <>
                      <div className="fixed inset-0 z-[9999]" onClick={() => setShowMobileNotifications(false)} />
                      <div className="absolute top-10 right-0 w-60 max-h-80 overflow-hidden z-[10000] glass-card rounded-xl shadow-2xl animate-scale-in border border-border/85">
                        <NotificationList onClose={() => setShowMobileNotifications(false)} />
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* The text-size stepper is ~140px wide, so on a 360px phone it
                  cannot sit beside Search, To-Dos, Bell and the account
                  avatar — it stays behind `md` and is reachable from
                  /more → Appearance instead.

                  The theme button is 32px and does fit, and it was the more
                  costly omission: wrapped in the same `hidden md:flex` inside a
                  header that is itself `lg:hidden`, it appeared ONLY in the
                  768–1023px tablet band. Below that there was no way to leave
                  dark mode anywhere in the app. */}
              <div className="hidden md:flex shrink-0 items-center gap-1">
                <FontSizeToggle />
              </div>
              <ThemeToggle className="shrink-0" />

              {/* A 32px avatar where a 32px Logout icon was, so the width
                  arithmetic described above is unchanged. It opens the bottom
                  sheet — which is also the only route a phone has to Billing
                  and Settings now that the rail's Account group is gone. */}
              <AccountMenu user={user} planLocked={planLocked} activeCompanyId={activeCompanyId} variant="mobile" />
            </div>
          </header>
        )}

        {/* ─── Plan banners ───────────────────────────────────────────────
            Red once the plan has lapsed (the page under it is the lock screen
            or Billing), amber in the last week before it does — so an expiry is
            never the first thing a user hears about it. */}
        {planLocked && (
          <div className="bg-danger-surface border-b border-danger-border px-4 py-2.5 flex items-center gap-2 text-xs font-semibold text-danger-text">
            <Lock size={14} className="shrink-0" />
            <span>
              {planState?.expiresAt
                ? `Your plan expired on ${formatDate(planState.expiresAt)}. Your workspace is locked until it is renewed.`
                : 'Your workspace has no active plan. Choose one to unlock it.'}
            </span>
          </div>
        )}
        {expiringSoon && (
          <div className="bg-warning-surface border-b border-warning-border px-4 py-2.5 flex items-center gap-2 text-xs font-semibold text-warning-text">
            <AlertTriangle size={14} className="shrink-0" />
            <span>
              {daysToExpiry === 0
                ? 'Your plan expires today.'
                : `Your plan expires in ${daysToExpiry} day${daysToExpiry === 1 ? '' : 's'} (${formatDate(planState.expiresAt)}).`}
            </span>
            {isTenantAdmin && (
              <button onClick={() => router.push('/billing')} className="underline underline-offset-2 hover:opacity-80">
                Renew now
              </button>
            )}
          </div>
        )}

        {/* Page Content */}
        {/* `page-gutter` (globals.css) is the ONLY horizontal inset a page
            gets — same 16/24/32px as the `p-4 md:p-6 lg:p-8` it replaces, plus
            the safe-area inset that `viewportFit: "cover"` makes necessary in
            landscape. Pages own their width cap via PageContainer, never their
            padding. */}
        <main className={cn('flex-grow page-gutter w-full max-w-[1600px]', !isEmbedded && 'animate-fade-in')}>
          {children}
        </main>
      </div>

      {/* ─── Mobile Bottom Nav ─── */}
      {!isEmbedded && (
        <nav className="fixed bottom-0 left-0 right-0 z-40 bg-card border-t border-border flex lg:hidden py-1.5 pb-[calc(6px+env(safe-area-inset-bottom))] shadow-lg">
          {bottomNavItems.map((item) => {
            const Icon = item.icon;
            const active = isActivePath(item.path);
            return (
              <button
                key={item.name}
                className={cn(
                  'flex flex-col items-center justify-center gap-1 flex-1 py-1 text-center font-semibold transition-colors',
                  active ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
                )}
                onClick={() => router.push(item.path)}
              >
                {/* A filled pill behind the ACTIVE icon. Colour alone was
                    carrying this — and `text-primary` against
                    `text-muted-foreground` at 18px, on a phone, held at arm's
                    length, is not a reliable "you are here". The pill is a
                    shape, which reads before the colour does. */}
                <span
                  className={cn(
                    'flex items-center justify-center rounded-full px-3.5 py-1 transition-colors',
                    active ? 'bg-primary/10' : 'bg-transparent'
                  )}
                >
                  {/* The count stays anchored to the ICON, not to the pill —
                      the pill is wider than the glyph, and hanging the badge off
                      its corner detaches it from the thing it counts. */}
                  <span className="relative flex items-center justify-center">
                    <Icon size={18} strokeWidth={active ? 2.5 : 1.8} />
                    {item.count > 0 && (
                      <span className="absolute -top-1 -right-2 px-1 py-0.5 text-2xs font-black bg-primary text-primary-foreground rounded-full leading-none">
                        {item.count}
                      </span>
                    )}
                  </span>
                </span>
                <span className="text-2xs tracking-wide">{item.name}</span>
              </button>
            );
          })}
        </nav>
      )}

      {/* ─── Spotlight Search ─── */}
      <AnimatePresence>
        {searchOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 z-[99999] flex items-start justify-center pt-[15vh] px-4 bg-black/70 backdrop-blur-md"
            onClick={(e) => {
              if (e.target === e.currentTarget) { setSearchOpen(false); setSearchQuery(''); setSearchResults([]); }
            }}
          >
            <motion.div 
              initial={{ scale: 0.95, opacity: 0, y: -20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.95, opacity: 0, y: -20 }}
              transition={{ type: 'spring', damping: 25, stiffness: 300 }}
              className="w-full max-w-xl bg-card border border-border/50 rounded-2xl shadow-[0_0_50px_rgba(0,0,0,0.5)] overflow-hidden p-0 flex flex-col"
            >
              {/* Search Input */}
              <div className="flex items-center gap-3 px-4 py-4 border-b border-border/30 bg-background/50">
                <Search size={20} className="text-primary shrink-0" />
                <input
                  type="text"
                  placeholder="Search documents, health records, vehicles..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="flex-grow bg-transparent border-none outline-none text-foreground text-base font-semibold placeholder:text-faint min-w-0"
                  autoComplete="off"
                />
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => { setSearchOpen(false); setSearchQuery(''); setSearchResults([]); }}
                  className="h-8 w-8 text-muted-foreground hover:text-foreground hover:bg-muted/50 rounded-full"
                >
                  <X size={16} />
                </Button>
              </div>

              {/* Results */}
              <div className="overflow-y-auto flex-grow py-2 max-h-[450px]">
                {searching ? (
                  <div className="flex flex-col items-center gap-3 py-16 text-muted-foreground">
                    <Loader2 size={28} className="animate-spin text-primary" />
                    <span className="text-sm font-semibold">Searching your vault...</span>
                  </div>
                ) : searchQuery && searchResults.length === 0 ? (
                  <div className="py-16 text-center text-muted-foreground text-sm font-medium">
                    No matches found for &quot;{searchQuery}&quot;
                  </div>
                ) : !searchQuery ? (
                  <div className="px-5 py-6 flex flex-col gap-5">
                    <div>
                      <span className="font-bold uppercase text-faint tracking-wider text-xs mb-3 block">Quick Actions</span>
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                        {/* Scoped to the workspace the user is standing in —
                            see quickActionsFor. Unprefixed, these five tiles
                            were the last control in the shell that silently
                            walked a company user back into the household. */}
                        {quickActionsFor(activeCompanyId).map(action => (
                          <button
                            key={action.name}
                            onClick={() => { router.push(action.path); setSearchOpen(false); }}
                            className="flex items-center gap-3 p-3 rounded-xl border border-border/40 bg-muted/20 hover:bg-muted/50 hover:border-border transition-all text-left group"
                          >
                            <div className={`p-2 rounded-lg ${action.bg} ${action.color} group-hover:scale-110 transition-transform`}>
                              <action.icon size={16} />
                            </div>
                            <span className="text-xs font-bold text-foreground">{action.name}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                    
                    <div className="bg-muted/20 border border-border/40 rounded-xl p-4 mt-2">
                      <span className="font-bold uppercase text-faint tracking-wider text-xs block mb-2">Pro Tips</span>
                      <div className="flex flex-col gap-1.5 text-xs text-muted-foreground leading-relaxed">
                         <span className="flex items-center gap-2"><CheckCircle2 size={12} className="text-primary"/> Search records across your entire workspace.</span>
                         <span className="flex items-center gap-2"><CheckCircle2 size={12} className="text-primary"/> Press <kbd className="bg-background px-1 py-0.5 rounded font-mono border shadow-sm">↑↓</kbd> to navigate, <kbd className="bg-background px-1 py-0.5 rounded font-mono border shadow-sm">Enter</kbd> to select.</span>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col">
                    {searchResults.map((res, index) => {
                      const isSelected = index === activeIndex;
                      return (
                        <button
                          key={res.id}
                          onMouseEnter={() => setActiveIndex(index)}
                          onClick={() => { router.push(res.link); setSearchOpen(false); setSearchQuery(''); setSearchResults([]); }}
                          className={cn(
                            'w-full text-left flex items-center justify-between px-5 py-3 transition-all border-l-2',
                            isSelected
                              ? 'bg-primary/10 border-l-primary'
                              : 'border-l-transparent hover:bg-muted/30'
                          )}
                        >
                          <div className="flex flex-col gap-0.5 min-w-0 pr-4">
                            <span className={cn('text-xs font-bold truncate', isSelected ? 'text-primary' : 'text-foreground')}>
                              {res.title}
                            </span>
                            <span className="text-xs text-muted-foreground truncate mt-0.5">{res.subtitle}</span>
                          </div>
                          <Badge variant={isSelected ? 'default' : 'secondary'} className="text-2xs font-bold uppercase shrink-0 py-0 h-5 px-2">
                            {res.module}
                          </Badge>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Footer */}
              <div className="flex items-center justify-between px-5 py-3 border-t border-border/30 text-xs text-faint bg-muted/20">
                <span className="font-semibold">{searchResults.length} result{searchResults.length !== 1 ? 's' : ''}</span>
                <span className="flex gap-4 font-semibold">
                  <span className="flex items-center gap-1"><kbd className="bg-background border px-1.5 py-0.5 rounded text-2xs shadow-sm">↑↓</kbd> Navigate</span>
                  <span className="flex items-center gap-1"><kbd className="bg-background border px-1.5 py-0.5 rounded text-2xs shadow-sm">↵</kbd> Select</span>
                  <span className="flex items-center gap-1"><kbd className="bg-background border px-1.5 py-0.5 rounded text-2xs shadow-sm">Esc</kbd> Close</span>
                </span>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      {/* ─── Module Flyout ─── */}
      {/* Rendered once here rather than per row: only one can be open, and a
          portal per module row would be fourteen portals to keep in step. */}
      <ModuleFlyout
        open={Boolean(openModule)}
        onClose={() => setOpenModule(null)}
        anchorRect={openModule?.rect}
        moduleName={openModule?.name}
        modulePath={openModule?.path}
        subCategories={openModule?.subCategories ?? []}
        Icon={openModule?.icon}
      />

      <PWABanner />
    </div>
  );
}

