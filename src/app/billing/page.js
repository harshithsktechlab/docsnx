'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  CreditCard, Crown, Calendar, CheckCircle2, Clock, IndianRupee,
  History, Sparkles, Loader2, AlertCircle, X, CheckCircle, ArrowRight, HardDrive, FileText
} from 'lucide-react';
import { clientGetMe } from '@/lib/clientAuth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { formatDate } from '@/lib/dateHelper';
import { toast } from 'sonner';
import UnifiedCheckoutModal from './UnifiedCheckoutModal';
import PageContainer from '@/app/components/PageContainer';
import { apiCall } from '@/lib/net/apiRequest';
import { resolveCurrentPlan } from './currentPlan';
import WorkspaceTabs from '@/app/components/WorkspaceTabs';
import { axisLabel, planCovers } from '@/lib/billingAxis';
import { hasYearlyPrice, upgradeOffer } from '@/lib/upgradePricing';
import { isSellable } from '@/lib/planCycles';
import { connectResult, DRIVE_CHECKBOX_LABEL } from '@/lib/googleConnectResults';
import { afterPurchase } from './afterPurchase';
import { setFlash } from '@/lib/flashToast';
import { ONBOARDING_PATH } from '@/lib/onboardingGate';


export default function BillingPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // The WHOLE /api/auth/me payload, not just its `user` half. `planDetails`
  // sits beside `user` in that response, and keeping only `user` is what made
  // the Current Plan card read an undefined path — see resolveCurrentPlan.
  const [session, setSession] = useState(null);
  const currentUser = session?.user ?? null;
  const [loading, setLoading] = useState(true);

  // Plan & subscription state
  const [availablePlans, setAvailablePlans] = useState([]);
  const [payments, setPayments] = useState([]);
  const [loadingPlans, setLoadingPlans] = useState(false);
  const [loadingPayments, setLoadingPayments] = useState(false);
  const [processingPlanId, setProcessingPlanId] = useState(null);
  const [showDrivePrompt, setShowDrivePrompt] = useState(false);
  const [isCheckoutOpen, setIsCheckoutOpen] = useState(false);
  const [selectedPlanForCheckout, setSelectedPlanForCheckout] = useState(null);
  // Code carried over from the signup form, pre-applied on the checkout that
  // opens right after registration.
  const [initialDiscountCode, setInitialDiscountCode] = useState('');

  /**
   * ── THE TWO AXES ─────────────────────────────────────────────────────────
   *
   * Billing splits Personal / Business, and NOT per company: a company carries
   * no subscription of its own, it is capped by the business plan's
   * `maxCompanies`. So these tabs are the two halves of the bill, not the
   * workspace strip the audit and credits pages draw.
   */
  const [billing, setBilling] = useState(null);
  /**
   * The half on screen. `?axis=` wins; without it, a single-account tenant
   * lands on the half they actually hold — a business-only tenant opening a
   * bare /billing used to be shown the household's (empty) side.
   */
  const axisParam = searchParams.get('axis');
  const activeAxis = axisParam === 'business' || axisParam === 'personal'
    ? axisParam
    : billing?.accountType === 'business' ? 'business' : 'personal';

  /**
   * ── THE UPGRADE TO PERSONAL + BUSINESS ───────────────────────────────────
   *
   * A tenant with ONE half can widen to both by buying a combo plan, and when
   * they are part-way through a paid term it is billed for the months left on
   * it, at the uplift only, and expires when that term does. The summary says
   * whether that applies and on what term; each combo card prices itself from
   * it with the same `upgradeOffer` the server prices the order with.
   */
  const isSingleAccount = !!billing && billing.accountType !== 'both';
  const upgrade = billing?.upgrade ?? null;
  // Shown after a successful upgrade, in place of the Drive prompt: the new
  // half exists but a former household has no company yet, and the switcher
  // hides itself for an account with both halves and zero companies.
  // Holds the half the tenant HAD ('personal' | 'business'), captured before
  // the refetch flips `accountType` to 'both'; null keeps the dialog closed.
  const [upgradedFrom, setUpgradedFrom] = useState(null);

  /**
   * The cart, keyed by axis: at most one plan per half of the account.
   *
   * Keyed rather than a list because picking a second personal plan REPLACES the
   * first — you cannot hold two household subscriptions, and a cart that let you
   * add both would take the money and apply one.
   */
  const [cart, setCart] = useState({});
  /**
   * ── THE SAME PLAN IN TWO SLOTS IS STILL ONE PLAN ──────────────────────────
   *
   * This was `Object.values(cart)`, which is two entries for a Combo — it
   * occupies both axis slots on purpose, so it cannot be bought alongside a
   * separate business plan. The list read that as a cart of two plans: the bar
   * said "2 plans selected — Combo + Combo", the checkout drew two rows, and
   * the order went up with the same `planId` twice.
   *
   * `priceCartLines` sums every line it is handed, so ₹3,499 was charged as
   * ₹6,998 for one plan — and `verify`, which iterates the stored cart, would
   * then have applied it twice and granted its AI credits twice.
   *
   * The keying stays: it is what makes a Combo mutually exclusive with a
   * business plan. Only the derived list is deduped, by plan id, keeping the
   * first occurrence so the order of the axes is preserved.
   */
  const cartPlans = [...new Map(
    Object.values(cart).filter(Boolean).map((p) => [p.id, p]),
  ).values()];

  useEffect(() => {
    async function loadSession() {
      const me = await clientGetMe();
      if (!me.success || me.user.role !== 'TENANT_ADMIN') { router.push('/dashboard'); return; }
      setSession(me);
      setLoading(false);
    }
    loadSession();
  }, []);

  const fetchPlans = useCallback(async () => {
    setLoadingPlans(true);
    try {
      const { json: data } = await apiCall('/api/admin/plans', { cache: 'no-store' });
      if (data.success) setAvailablePlans((data.plans || []).filter(p => p.isActive));
    } catch { /* silent */ }
    finally { setLoadingPlans(false); }
  }, []);

  /**
   * Filtered to the open tab. A pre-split payment carries a null `applies_to`
   * and the API reads those into Personal — see `paymentInAxis`.
   */
  const fetchPaymentHistory = useCallback(async (axis) => {
    setLoadingPayments(true);
    try {
      const { json: data } = await apiCall(`/api/payments/history?appliesTo=${axis}`);
      if (data.success) setPayments(data.payments || []);
    } catch { /* silent */ }
    finally { setLoadingPayments(false); }
  }, []);

  /** Both halves of the bill in one call — the tab strip has to label both. */
  const fetchBillingSummary = useCallback(async () => {
    try {
      const { json: data } = await apiCall('/api/billing/summary', { cache: 'no-store' });
      if (data.success) setBilling(data);
    } catch { /* silent */ }
  }, []);

  // Refresh subscription info from user session
  const refreshCurrentPlan = useCallback(async () => {
    const me = await clientGetMe();
    if (me.success) setSession(me);
  }, []);

  /**
   * The Drive prompt below sends the admin to Google with `returnTo=/billing`,
   * and every exit from that flow comes back here as `?google=<status>` —
   * which this page read nothing of, so a consent screen that was cancelled,
   * or one where the optional Drive permission was left unticked, returned the
   * admin to a billing page that said absolutely nothing had happened.
   *
   * Same shape as /settings: only `google` is stripped, because `autoCheckout`
   * and `discount` may be sitting beside it and the effect below needs them.
   */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const result = connectResult(params.get('google'));
    if (!result) return;
    if (result.ok) toast.success(result.message, { id: 'billing-drive' });
    else toast.error(result.detail, { id: 'billing-drive', duration: 10000 });
    params.delete('google');
    const rest = params.toString();
    router.replace(rest ? `/billing?${rest}` : '/billing');
  }, [router]);

  useEffect(() => {
    if (currentUser) {
      fetchPlans().then(() => {
        // Auto-checkout if query param exists
        const params = new URLSearchParams(window.location.search);
        const autoCheckout = params.get('autoCheckout');
        if (autoCheckout) {
          // Find the plan object when plans are loaded
          // We can set a timeout or rely on the plans state updating, 
          // but since fetchPlans updates state, we'll use a separate effect to watch plans.
        }
      });
      fetchBillingSummary();
    }
  }, [currentUser, fetchPlans, fetchBillingSummary]);

  // Re-read on every tab switch: the history is per-axis.
  useEffect(() => {
    if (currentUser) fetchPaymentHistory(activeAxis);
  }, [currentUser, activeAxis, fetchPaymentHistory]);

  // Handle autoCheckout once plans are loaded
  useEffect(() => {
    if (availablePlans.length > 0) {
      const params = new URLSearchParams(window.location.search);
      const autoCheckout = params.get('autoCheckout');
      if (autoCheckout && !processingPlanId) {
        const plan = availablePlans.find(p => p.id === autoCheckout);
        if (plan) {
          const discount = params.get('discount') || '';
          // Clean the URL to avoid loops
          window.history.replaceState({}, document.title, window.location.pathname);
          handleOpenCheckout(plan, discount);
        }
      }
    }
  }, [availablePlans, processingPlanId]);

  /**
   * The plan as this page renders it — derived, never stored.
   *
   * It used to be state written from two places that disagreed with each other:
   * one read the name off `currentUser.planDetails`, which does not exist, so
   * the badge fell through to "No Active Plan" for every tenant; the other read
   * it correctly, but also re-set `currentUser`, re-running the effect that
   * overwrote the good name with the fallback again. Deriving it from the one
   * payload makes both failures unrepresentable.
   */
  const currentPlan = resolveCurrentPlan(session, availablePlans);

  /** The axis on screen, as /api/billing/summary reports it. */
  const axisState = billing?.[activeAxis] ?? null;

  /**
   * The tabs. Only an account holding BOTH halves has a choice to make, so this
   * is empty (and the strip hides itself) for every personal-only tenant — which
   * is most of them, and which is the page exactly as it was before.
   */
  const axisTabs = billing?.accountType === 'both'
    ? [
      { key: 'personal', name: axisLabel('personal'), kind: 'personal' },
      { key: 'business', name: axisLabel('business'), kind: 'business' },
    ]
    : [];

  const selectAxis = (key) => {
    // Rebuilt from the current query rather than written fresh, the same way
    // /audit-logs and /billing/credits switch their workspace tabs: `?company=`
    // rides along on this page carrying the workspace the avatar menu was
    // opened from, and a bare `/billing?axis=` would drop it — switching axis
    // would silently move the whole shell back to Personal.
    const params = new URLSearchParams(window.location.search);
    params.set('axis', key);
    router.push(`/billing?${params.toString()}`);
  };

  /**
   * The plans offered on this tab. A plan whose `appliesTo` is 'both' appears in
   * EACH tab and says so on its card — it satisfies both halves at once, and
   * hiding it from one of them would make a combined plan unbuyable from the
   * side the customer happened to be looking at.
   */
  /**
   * ── A PLAN NOBODY CAN BUY IS NOT OFFERED ─────────────────────────────────
   *
   * A plan with no sellable cycle used to render a card, take a click, open the
   * checkout, and only refuse at Pay — "not currently available in INR", after
   * the customer had chosen it. `isSellable` is the same question the server
   * asks before it prices a line, so the card and the order agree.
   *
   * INR because that is the currency this grid quotes in; the checkout has its
   * own toggle, and guards the other currency itself.
   */
  const sellablePlans = availablePlans.filter((p) => isSellable(p, 'INR'));
  const plansForAxis = sellablePlans.filter((p) => planCovers(p.appliesTo, activeAxis));

  /**
   * On a single-account tenant the combo plans leave the grid and become the
   * upgrade section below it — offered as what they are (a second half of the
   * account) rather than as one more card among the household's plans. A
   * two-half tenant keeps them in each tab exactly as before.
   */
  const gridPlans = isSingleAccount ? plansForAxis.filter((p) => p.appliesTo !== 'both') : plansForAxis;
  const comboPlans = isSingleAccount ? sellablePlans.filter((p) => p.appliesTo === 'both') : [];

  /** The prorated line for one combo card, or null when the full price applies. */
  const offerFor = (plan) => {
    if (!upgrade?.eligible || !hasYearlyPrice(plan, 'INR')) return null;
    return upgradeOffer(plan, upgrade.currentPlan, {
      months: upgrade.months,
      expiresAt: new Date(upgrade.expiresAt),
    }, 'INR');
  };

  /** Add to the cart, replacing whatever was held for the axes it covers. */
  const addToCart = (plan) => {
    setCart((prev) => {
      const next = { ...prev };
      // A 'both' plan occupies BOTH slots: buying it alongside a separate
      // business plan would pay twice for the same entitlement.
      if (planCovers(plan.appliesTo, 'personal')) next.personal = plan;
      if (planCovers(plan.appliesTo, 'business')) next.business = plan;
      return next;
    });
  };

  const removeFromCart = (plan) => {
    setCart((prev) => {
      const next = { ...prev };
      for (const axis of ['personal', 'business']) {
        if (next[axis]?.id === plan.id) delete next[axis];
      }
      return next;
    });
  };

  const inCart = (plan) => cartPlans.some((p) => p.id === plan.id);


  // Calculate days remaining
  const getDaysRemaining = (expiryDate) => {
    if (!expiryDate) return null;
    const now = new Date();
    const expiry = new Date(expiryDate);
    const diff = Math.ceil((expiry - now) / (1000 * 60 * 60 * 24));
    return diff;
  };

  /**
   * The card's three figures, from the open axis when the summary has answered
   * and from the session otherwise.
   *
   * The fallback matters on first paint and on a personal-only account, where
   * `billing` may not have arrived yet and `currentPlan` is the same answer.
   */
  const axisPlanName = axisState
    ? (axisState.plan?.name || (axisState.hasPlan ? 'PLAN' : 'NO PLAN'))
    : (currentPlan?.name || 'EXPIRED');
  const axisExpiry = axisState ? axisState.expiresAt : (currentPlan?.expiry ?? null);
  const axisDaysLeft = axisExpiry ? getDaysRemaining(axisExpiry) : null;

  const daysRemaining = currentPlan?.expiry ? getDaysRemaining(currentPlan.expiry) : null;
  // Lapsed, and this admin is the only person who can undo it. Everything else
  // in the workspace is 402-locked behind them while this banner is on screen.
  const planExpired = daysRemaining !== null && daysRemaining < 0;

  /**
   * ── NEVER SUBSCRIBED IS NOT THE SAME AS LAPSED ───────────────────────────
   *
   * A new account is created with no plan and an expiry of *now*, so by the
   * time it reaches this page `planExpired` is already true — and the card told
   * someone who signed up ninety seconds ago that their plan "expired on
   * 18/09/2026", naming a plan they never had.
   *
   * This was keyed off `?welcome=1` and that was not enough: the param survives
   * exactly one navigation, so a reload — or an arrival via Shell's
   * `/billing?expired=1` — brought the expiry language straight back.
   *
   * `hasPlan` is the durable answer. It is `!!subscriptionPlanId`
   * (src/lib/planGate.ts), so it is FALSE for an account that has never
   * subscribed and TRUE for one whose term ran out — the plan row stays put
   * when it lapses. No URL, no session storage, correct on every arrival.
   */
  const axisHasPlan = axisState ? axisState.hasPlan : !!currentPlan?.id;
  const neverSubscribed = billing
    ? !billing.personal?.hasPlan && !billing.business?.hasPlan
    : false;

  /** A genuine lapse: there IS a plan, and its term has passed. */
  const showExpiry = axisHasPlan && planExpired;

  /**
   * Still read, but only for the HEADER copy — "Choose your plan" is about how
   * the visitor arrived, not about what the account holds.
   */
  const isWelcome = searchParams.get('welcome') === '1';

  /**
   * Opens checkout for ONE plan, bypassing the cart.
   *
   * Kept for the two callers that genuinely mean one plan: the signup
   * auto-checkout (`?autoCheckout=`) and the "Buy Add-ons" button, which passes
   * null. Everything else goes through the cart.
   */
  const handleOpenCheckout = (plan, discountCode = '') => {
    setSelectedPlanForCheckout(plan ? [plan] : []);
    setInitialDiscountCode(discountCode);
    setIsCheckoutOpen(true);
  };

  /** Opens checkout for everything selected across both tabs. */
  const handleCheckoutCart = () => {
    setSelectedPlanForCheckout(cartPlans);
    setInitialDiscountCode('');
    setIsCheckoutOpen(true);
  };

  const formatPrice = (price) => {
    if (price === 0) return 'Free';
    return `₹${Number(price).toLocaleString('en-IN')}`;
  };

  const getStatusBadge = (status) => {
    switch (status) {
      case 'captured': return <Badge variant="success" className="text-xs">Captured</Badge>;
      case 'created': return <Badge className="bg-amber-500/15 text-amber-500 border-amber-500/30 text-xs">Pending</Badge>;
      case 'failed': return <Badge variant="destructive" className="text-xs">Failed</Badge>;
      default: return <Badge variant="secondary" className="text-xs">{status}</Badge>;
    }
  };

  const getPlanBadgeVariant = (plan) => {
    if (typeof plan === 'string') return 'secondary'; // fallback for old plans
    return plan?.badgeColor || 'secondary';
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-3 text-muted-foreground">
        <Loader2 size={28} className="animate-spin text-primary" />
        <p className="text-sm">Loading billing information...</p>
      </div>
    );
  }

  return (
    <PageContainer width="medium" className="space-y-8 pb-12">
      {/* Header */}
      <div className="flex items-center gap-3 animate-fade-in">
        <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-primary to-orange-500 flex items-center justify-center flex-shrink-0">
          <CreditCard size={22} className="text-white" />
        </div>
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-foreground">
            {isWelcome ? 'Choose your plan' : 'Billing & Subscription'}
          </h1>
          <p className="text-muted-foreground text-sm">
            {isWelcome
              ? 'Pick a plan to activate your workspace. You can add extra members and companies at checkout.'
              : 'Manage your plan, upgrade, and view payment history'}
          </p>
        </div>
        <div className="ml-auto">
          <Button onClick={() => handleOpenCheckout(null)} variant="secondary" className="font-bold border border-border bg-card">
            Buy Add-ons
          </Button>
        </div>
      </div>

      {/* The lapse, stated once, at the top, in red — the rest of the page is the
          plan grid that fixes it. Shell sends every locked admin here. Suppressed
          on a first run, where the same condition is true for a happier reason
          and the header above has already said what to do. */}
      {showExpiry && (
        <Alert variant="destructive" className="animate-fade-in">
          <AlertCircle size={16} />
          <AlertDescription className="text-xs font-semibold">
            Your {currentPlan?.name || 'plan'} expired on {formatDate(currentPlan.expiry)}. Documents,
            records, passwords and AI are locked for everyone in this workspace until you renew.
            Nothing has been deleted &mdash; pick a plan below to unlock it again.
          </AlertDescription>
        </Alert>
      )}

      {/*
        ── PERSONAL / BUSINESS ────────────────────────────────────────────────
        Two tabs, not one per company: a company carries no subscription of its
        own and is capped by the business plan's company allowance. The strip
        hides itself for an account that has only one half.
      */}
      {/*
        "Expired" only where a plan actually ran out. Every axis of a brand-new
        account is technically expired — signup writes `expiry = now()` — so
        this asked `isExpired` alone and greeted a new admin with the word on
        every tab. `hasPlan` is what separates a lapse from never having
        subscribed.
      */}
      <WorkspaceTabs
        tabs={axisTabs}
        active={activeAxis}
        onSelect={selectAxis}
        badgeFor={(tab) => (billing?.[tab.key]?.hasPlan && billing?.[tab.key]?.isExpired ? 'Expired' : null)}
      />

      {/*
        ── THE CURRENT PLAN, ONCE THERE HAS EVER BEEN ONE ─────────────────────
        A brand-new account has no plan and an expiry of the moment it was
        created, so this card greeted someone who had signed up ninety seconds
        earlier with "PERSONAL PLAN · NO PLAN · Expires <today> · Expired". All
        of it true, none of it useful, and the first thing they saw.

        Dropped entirely rather than softened: there is nothing to report about
        a plan that does not exist, and the grid below is the answer. Keyed on
        `hasPlan` across both axes rather than on `?welcome=1`, which only
        survived one navigation — a reload brought the whole thing back.
      */}
      {!neverSubscribed && (
      <Card className="border-border/50 bg-card backdrop-blur shadow-glass animate-fade-in border-l-4 border-l-primary">
        <CardContent className="p-6">
          <div className="flex items-center gap-2 mb-4">
            <Crown size={18} className="text-primary" />
            <span className="text-sm font-bold text-foreground uppercase tracking-wider">
              {axisTabs.length > 1 ? `${axisLabel(activeAxis)} plan` : 'Current Plan'}
            </span>
          </div>
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  {/*
                    On a two-axis account the badge names THIS axis's plan, from
                    /api/billing/summary. `currentPlan` is derived from the
                    session and only ever describes the personal side, so using
                    it on the Business tab would show the household's plan under
                    a heading saying "Business".
                  */}
                  <Badge
                    variant={getPlanBadgeVariant(
                      availablePlans.find((p) => p.id === (axisState?.plan?.id ?? currentPlan?.id)) || 'secondary',
                    )}
                    className="text-sm font-extrabold px-3 py-1"
                  >
                    {axisPlanName}
                  </Badge>
                </div>
                {axisExpiry && (
                  <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1.5">
                      <Calendar size={13} className="text-primary" />
                      Expires: <span className="font-bold text-foreground">{formatDate(axisExpiry)}</span>
                    </span>
                    {axisDaysLeft !== null && (
                      <span className={cn(
                        'flex items-center gap-1.5 font-bold',
                        axisDaysLeft <= 0 ? 'text-danger-text' : axisDaysLeft <= 30 ? 'text-warning-text' : 'text-success-text'
                      )}>
                        <Clock size={13} />
                        {axisDaysLeft > 0 ? `${axisDaysLeft} days remaining` : 'Expired'}
                      </span>
                    )}
                  </div>
                )}
                {!axisExpiry && (
                  <span className="text-xs text-muted-foreground mt-1">
                    {/* A null expiry is LIFETIME, not "unknown" — but only when a
                        plan is actually held. With none, it is a free tier. */}
                    {axisState?.hasPlan ? 'Lifetime — no expiry' : 'No expiry — Free tier'}
                  </span>
                )}

                {/* What the plan actually allows on this axis, and how much of
                    it is spoken for. This is the number that decides whether the
                    answer to "add a company" is a button or a bigger plan. */}
                {axisState && (
                  <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                    {/* Personal reports one total; business reports the
                        per-company allowance, because that is what the plan
                        sells and what "add a member" is actually checked
                        against. A single business total would be a number the
                        form can refuse while it still looks like there is
                        room. */}
                    {activeAxis === 'business' ? (
                      <span>
                        Members per company:{' '}
                        <span className="font-bold text-foreground">
                          {axisState.members.perCompanyLimit}
                        </span>
                      </span>
                    ) : (
                      <span>
                        Members:{' '}
                        <span className="font-bold text-foreground">
                          {axisState.members.used} / {axisState.members.limit}
                        </span>
                      </span>
                    )}
                    {axisState.companies && (
                      <span>
                        Companies:{' '}
                        <span className="font-bold text-foreground">
                          {axisState.companies.used} / {axisState.companies.limit}
                        </span>
                      </span>
                    )}
                  </div>
                )}

                {/* Which companies are actually full. The number above says what
                    each is allowed; this says where the room is, and it is the
                    only place an admin can see that Acme is the one blocking a
                    new employee. */}
                {activeAxis === 'business' && axisState?.members?.companies?.length > 0 && (
                  <div className="mt-2 flex flex-col gap-1 text-xs text-muted-foreground">
                    {axisState.members.companies.map((c) => (
                      <span key={c.id} className="flex items-center gap-2">
                        <span className="truncate max-w-[12rem]">{c.name}</span>
                        <span className={cn(
                          'font-bold',
                          c.used >= c.limit ? 'text-danger-text' : 'text-foreground',
                        )}>
                          {c.used} / {c.limit} members
                        </span>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <Button
              variant="secondary"
              onClick={() => router.push('/billing/credits')}
              className="font-bold border border-border bg-card flex items-center gap-2 self-start sm:self-auto"
            >
              <Sparkles size={15} className="text-primary" />
              AI credit history
              <ArrowRight size={14} />
            </Button>
          </div>
        </CardContent>
      </Card>
      )}

      {/* Upgrade Plans */}
      <div className="animate-fade-in stagger-1">
        <div className="flex items-center gap-2 mb-4">
          <Sparkles size={18} className="text-primary" />
          <h2 className="text-lg font-extrabold text-foreground">
            {axisTabs.length > 1 ? `${axisLabel(activeAxis)} plans` : 'Upgrade Your Plan'}
          </h2>
        </div>

        {loadingPlans ? (
          <div className="flex items-center justify-center py-12 gap-3 text-muted-foreground">
            <Loader2 size={22} className="animate-spin text-primary" />
            <span className="text-sm">Loading plans...</span>
          </div>
        ) : gridPlans.length === 0 ? (
          <Card className="border-border/50 bg-card backdrop-blur">
            <CardContent className="p-8 text-center text-muted-foreground">
              <CreditCard size={32} className="opacity-25 mx-auto mb-3" />
              <p className="text-sm font-semibold">No plans available at this time.</p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {gridPlans.map((plan) => {
              // Against THIS axis's plan, not the session's — on the Business
              // tab, `currentPlan` is the household's and would mark the wrong
              // card "Current".
              const isCurrentPlan = (axisState?.plan?.id ?? currentPlan?.id) === plan.id;
              const isProcessing = processingPlanId === plan.id;

              return (
                <Card
                  key={plan.id}
                  className={cn(
                    'border-border/50 bg-card backdrop-blur transition-all hover:shadow-glass-hover flex flex-col',
                    isCurrentPlan && 'border-primary/50 bg-primary/5'
                  )}
                >
                  <CardContent className="p-5 flex flex-col flex-1">
                    <div className="flex items-center justify-between mb-3">
                      <Badge variant={getPlanBadgeVariant(plan)} className="font-bold text-xs">{plan.name}</Badge>
                      {isCurrentPlan && <Badge variant="secondary" className="text-2xs">Current</Badge>}
                    </div>

                    <h3 className="text-lg font-extrabold text-foreground mb-1">{plan.name}</h3>

                    <div className="flex flex-col gap-1 mb-4">
                      {/*
                        The monthly line renders only when the plan is SOLD
                        monthly. `price` is nullable since 0058 — every plan in
                        the live price list is annual — and `formatPrice(null)`
                        is ₹NaN, because its `=== 0` guard does not catch null.
                        So an unconditional line printed "₹NaN / month" directly
                        above the real yearly price.
                      */}
                      {plan.price !== null && plan.price !== undefined && plan.price !== '' && (
                        <div className="flex items-baseline gap-1.5 flex-wrap">
                          <span className="text-2xl font-black text-foreground">{formatPrice(plan.price)}</span>
                          {plan.priceUsd > 0 && (
                            <span className="text-sm text-muted-foreground font-bold">/ ${Number(plan.priceUsd).toLocaleString()}</span>
                          )}
                          <span className="text-xs text-muted-foreground font-semibold uppercase">/ month</span>
                        </div>
                      )}
                      {plan.priceYearly && (
                        <div className="flex items-baseline gap-1.5 flex-wrap">
                          {/* The headline when there is no monthly price above it. */}
                          <span className={cn(
                            'font-bold',
                            plan.price === null || plan.price === undefined || plan.price === ''
                              ? 'text-2xl font-black text-foreground'
                              : 'text-base text-foreground/80',
                          )}>{formatPrice(plan.priceYearly)}</span>
                          {plan.priceYearlyUsd > 0 && (
                            <span className="text-xs text-muted-foreground font-semibold">/ ${Number(plan.priceYearlyUsd).toLocaleString()}</span>
                          )}
                          <span className="text-xs text-muted-foreground font-semibold uppercase">/ year</span>
                        </div>
                      )}
                      {plan.priceOneTime && (
                        <div className="flex items-baseline gap-1.5 flex-wrap">
                          <span className="text-base font-bold text-foreground/80">{formatPrice(plan.priceOneTime)}</span>
                          {plan.priceOneTimeUsd > 0 && (
                            <span className="text-xs text-muted-foreground font-semibold">/ ${Number(plan.priceOneTimeUsd).toLocaleString()}</span>
                          )}
                          <span className="text-xs text-muted-foreground font-semibold uppercase">/ one-time</span>
                        </div>
                      )}
                    </div>

                    {/* Features & Limits */}
                    <div className="flex flex-col gap-1.5 mb-4 flex-1">
                      {plan.isLifetime && (
                        <span className="text-xs text-muted-foreground flex items-center gap-1.5">
                          <CheckCircle2 size={11} className="text-emerald-500 shrink-0" />
                          Lifetime Validity
                        </span>
                      )}
                      {plan.isLifetime && Number(plan.amcAmount) > 0 && (
                        <span className="text-xs text-muted-foreground flex items-center gap-1.5">
                          <CheckCircle2 size={11} className="text-emerald-500 shrink-0" />
                          ₹{plan.amcAmount}/year AMC
                        </span>
                      )}
                      <span className="text-xs text-muted-foreground flex items-center gap-1.5">
                        <CheckCircle2 size={11} className="text-emerald-500 shrink-0" />
                        Up to {plan.maxMembers} Members
                      </span>
                      {/*
                        The two numbers a business plan is actually sold on, and
                        the card never showed either — so "3 companies, 10
                        members each" was invisible at the moment of choosing.
                        Rendered only when non-zero, which is what keeps a
                        personal card exactly as it was: `max_companies` and
                        `max_members_per_company` are 0 on a personal plan.

                        Note the grain: `maxMembersPerCompany` is per company,
                        not a business-wide pool — a tenant on 3x10 can hold
                        thirty people and still be refused an eleventh in one
                        company. Saying "each" is not padding.
                      */}
                      {plan.maxCompanies > 0 && (
                        <span className="text-xs text-muted-foreground flex items-center gap-1.5">
                          <CheckCircle2 size={11} className="text-emerald-500 shrink-0" />
                          {plan.maxCompanies} {plan.maxCompanies === 1 ? 'Company' : 'Companies'}
                        </span>
                      )}
                      {plan.maxMembersPerCompany > 0 && (
                        <span className="text-xs text-muted-foreground flex items-center gap-1.5">
                          <CheckCircle2 size={11} className="text-emerald-500 shrink-0" />
                          {plan.maxMembersPerCompany} Members in each company
                        </span>
                      )}
                      <span className="text-xs text-muted-foreground flex items-center gap-1.5">
                        <CheckCircle2 size={11} className="text-emerald-500 shrink-0" />
                        {plan.storageLimitGB} GB Secure Storage
                      </span>
                      {plan.aiCredits > 0 && (
                        <span className="text-xs text-muted-foreground flex items-center gap-1.5">
                          <CheckCircle2 size={11} className="text-emerald-500 shrink-0" />
                          {plan.aiCredits} AI Assistant Credits
                        </span>
                      )}
                      {plan.features && (Array.isArray(plan.features) ? plan.features : plan.features.split(',')).map((feature, idx) => (
                        <span key={idx} className="text-xs text-muted-foreground flex items-center gap-1.5">
                          <CheckCircle2 size={11} className="text-emerald-500 shrink-0" />
                          {typeof feature === 'string' ? feature.trim() : feature}
                        </span>
                      ))}
                    </div>

                    {plan.discountCode && (
                      <div className="flex items-center gap-1.5 text-xs text-amber-500 font-bold mb-3 bg-amber-500/10 px-2 py-1 rounded-md">
                        <IndianRupee size={11} />
                        Use code <code className="bg-muted px-1 py-0.5 rounded font-mono text-foreground">{plan.discountCode}</code> for {plan.discountPercent}% off
                      </div>
                    )}

                    {/* A combined plan is worth saying so on the card: it is
                        offered in both tabs and buying it settles both. */}
                    {plan.appliesTo === 'both' && (
                      <div className="mb-2 rounded-md bg-primary/10 px-2 py-1 text-2xs font-bold text-primary">
                        Covers Personal &amp; Business
                      </div>
                    )}

                    <Button
                      onClick={() => (inCart(plan) ? removeFromCart(plan) : addToCart(plan))}
                      disabled={isCurrentPlan || isProcessing}
                      variant={inCart(plan) ? 'secondary' : 'default'}
                      className={cn(
                        'w-full font-bold h-10 text-xs mt-auto',
                        isCurrentPlan
                          ? 'bg-muted text-muted-foreground cursor-not-allowed'
                          : inCart(plan)
                            ? 'border border-primary text-primary'
                            : 'bg-primary text-primary-foreground hover:bg-primary/90'
                      )}
                    >
                      {isProcessing ? (
                        <><Loader2 size={14} className="animate-spin" /> Processing...</>
                      ) : isCurrentPlan ? (
                        <><CheckCircle2 size={14} /> Current Plan</>
                      ) : inCart(plan) ? (
                        <><CheckCircle2 size={14} /> Selected — tap to remove</>
                      ) : (
                        <><ArrowRight size={14} /> Select Plan</>
                      )}
                    </Button>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {/*
        ── UPGRADE TO PERSONAL + BUSINESS ─────────────────────────────────────
        Only a single-account tenant sees this. Each combo card carries the
        prorated figure when the tenant is part-way through a paid term, and
        the plain yearly price otherwise (a trial, a lifetime plan, or a
        lapsed one has no term to prorate against).
      */}
      {comboPlans.length > 0 && (
        <div className="animate-fade-in stagger-1">
          <div className="flex items-center gap-2 mb-1">
            <Crown size={18} className="text-primary" />
            <h2 className="text-lg font-extrabold text-foreground">
              Upgrade to Personal + Business
            </h2>
          </div>
          <p className="text-xs text-muted-foreground mb-4">
            {upgrade?.eligible
              ? `Add the ${upgrade.fromAxis === 'business' ? 'personal' : 'business'} account for the ${upgrade.months} month${upgrade.months === 1 ? '' : 's'} left on your ${upgrade.currentPlan?.name || 'current'} plan. You pay only the difference, and both halves renew together on ${formatDate(upgrade.expiresAt)}.`
              : `Add the ${billing?.accountType === 'business' ? 'personal' : 'business'} account. Billed as a full year from today.`}
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {comboPlans.map((plan) => {
              const offer = offerFor(plan);
              const selected = inCart(plan);
              return (
                <Card
                  key={plan.id}
                  className={cn(
                    'border-primary/40 bg-card backdrop-blur transition-all hover:shadow-glass-hover flex flex-col',
                    selected && 'bg-primary/5',
                  )}
                >
                  <CardContent className="p-5 flex flex-col flex-1">
                    <div className="flex items-center justify-between mb-3">
                      <Badge variant={getPlanBadgeVariant(plan)} className="font-bold text-xs">{plan.name}</Badge>
                      <Badge variant="secondary" className="text-2xs">Personal + Business</Badge>
                    </div>

                    <h3 className="text-lg font-extrabold text-foreground mb-1">{plan.name}</h3>

                    {offer ? (
                      <div className="flex flex-col gap-1 mb-4">
                        <div className="flex items-baseline gap-1.5 flex-wrap">
                          <span className="text-2xl font-black text-foreground">{formatPrice(offer.amount)}</span>
                          <span className="text-xs text-muted-foreground font-semibold uppercase">
                            for {offer.months} month{offer.months === 1 ? '' : 's'}
                          </span>
                        </div>
                        {/* The arithmetic, so the figure is checkable rather than
                            trusted: (combo − current) × months ÷ 12. */}
                        <span className="text-xs text-muted-foreground">
                          ({formatPrice(plan.priceYearly)} − {formatPrice(upgrade.currentPlan?.priceYearly ?? 0)}) × {offer.months}/12
                        </span>
                        <span className="text-xs text-muted-foreground">
                          Runs until <span className="font-bold text-foreground">{formatDate(offer.expiresAt)}</span>,
                          then {formatPrice(plan.priceYearly)} / year
                        </span>
                      </div>
                    ) : (
                      <div className="flex flex-col gap-1 mb-4">
                        {plan.priceYearly && (
                          <div className="flex items-baseline gap-1.5 flex-wrap">
                            <span className="text-2xl font-black text-foreground">{formatPrice(plan.priceYearly)}</span>
                            <span className="text-xs text-muted-foreground font-semibold uppercase">/ year</span>
                          </div>
                        )}
                        <span className="text-xs text-muted-foreground">One year from today</span>
                      </div>
                    )}

                    <div className="flex flex-col gap-1.5 mb-4 flex-1">
                      <span className="text-xs text-muted-foreground flex items-center gap-1.5">
                        <CheckCircle2 size={11} className="text-emerald-500 shrink-0" />
                        Up to {plan.maxMembers} household members
                      </span>
                      <span className="text-xs text-muted-foreground flex items-center gap-1.5">
                        <CheckCircle2 size={11} className="text-emerald-500 shrink-0" />
                        {plan.maxCompanies} {plan.maxCompanies === 1 ? 'company' : 'companies'}, {plan.maxMembersPerCompany} members each
                      </span>
                      <span className="text-xs text-muted-foreground flex items-center gap-1.5">
                        <CheckCircle2 size={11} className="text-emerald-500 shrink-0" />
                        {plan.storageLimitGB} GB Secure Storage
                      </span>
                      {plan.aiCredits > 0 && (
                        <span className="text-xs text-muted-foreground flex items-center gap-1.5">
                          <CheckCircle2 size={11} className="text-emerald-500 shrink-0" />
                          {plan.aiCredits} AI Assistant Credits
                        </span>
                      )}
                    </div>

                    <Button
                      onClick={() => (selected ? removeFromCart(plan) : addToCart(plan))}
                      variant={selected ? 'secondary' : 'default'}
                      className={cn(
                        'w-full font-bold h-10 text-xs mt-auto',
                        selected
                          ? 'border border-primary text-primary'
                          : 'bg-primary text-primary-foreground hover:bg-primary/90',
                      )}
                    >
                      {selected ? (
                        <><CheckCircle2 size={14} /> Selected — tap to remove</>
                      ) : (
                        <><ArrowRight size={14} /> Upgrade</>
                      )}
                    </Button>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </div>
      )}

      {/* Payment History */}
      <div className="animate-fade-in stagger-2">
        <div className="flex items-center gap-2 mb-4">
          <History size={18} className="text-primary" />
          <h2 className="text-lg font-extrabold text-foreground">Payment History</h2>
        </div>

        <Card className="border-border/50 bg-card backdrop-blur shadow-glass">
          <CardContent className="p-0">
            {loadingPayments ? (
              <div className="flex items-center justify-center py-12 gap-3 text-muted-foreground">
                <Loader2 size={22} className="animate-spin text-primary" />
                <span className="text-sm">Loading payment history...</span>
              </div>
            ) : payments.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 gap-2 text-muted-foreground">
                <History size={32} className="opacity-25" />
                <p className="text-sm font-semibold">No payment history yet.</p>
                <p className="text-xs">Your transactions will appear here after your first payment.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border/50 bg-muted/20">
                      <th className="text-left font-bold text-muted-foreground px-4 py-3 uppercase tracking-wider text-xs">Date</th>
                      <th className="text-left font-bold text-muted-foreground px-4 py-3 uppercase tracking-wider text-xs">Plan</th>
                      <th className="text-left font-bold text-muted-foreground px-4 py-3 uppercase tracking-wider text-xs">Amount</th>
                      <th className="text-left font-bold text-muted-foreground px-4 py-3 uppercase tracking-wider text-xs">Order ID</th>
                      <th className="text-left font-bold text-muted-foreground px-4 py-3 uppercase tracking-wider text-xs">Status</th>
                      <th className="text-left font-bold text-muted-foreground px-4 py-3 uppercase tracking-wider text-xs">Invoice</th>
                    </tr>
                  </thead>
                  <tbody>
                    {payments.map((payment) => (
                      <tr key={payment.id} className="border-b border-border/30 hover:bg-muted/10 transition-colors">
                        <td className="px-4 py-3 text-foreground font-semibold">
                          {formatDate(payment.createdAt)}
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant="secondary" className="text-xs font-bold">{payment.planName || payment.plan?.name || '—'}</Badge>
                        </td>
                        <td className="px-4 py-3 text-foreground font-bold">
                          {formatPrice(payment.amount ? payment.amount / 100 : 0)}
                        </td>
                        <td className="px-4 py-3">
                          <code className="bg-muted px-1.5 py-0.5 rounded text-xs font-mono text-muted-foreground">
                            {payment.razorpayOrderId || payment.orderId || '—'}
                          </code>
                        </td>
                        <td className="px-4 py-3">
                          {getStatusBadge(payment.status)}
                        </td>
                        <td className="px-4 py-3">
                          {payment.invoiceUrl ? (
                            <a href={payment.invoiceUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-primary hover:underline text-xs font-bold">
                              <FileText size={12} /> Preview
                            </a>
                          ) : (
                            <span className="text-muted-foreground text-xs">N/A</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/*
        ── PAY FOR BOTH HALVES AT ONCE ────────────────────────────────────────
        The cart survives a tab switch, which is the entire point: an admin picks
        a household plan on one tab and a business plan on the other, and this
        bar is where those become one payment.

        Sticky, because the selection is made by scrolling through a plan grid
        and a summary that scrolls away with it cannot be acted on.
      */}
      {cartPlans.length > 0 && (
        <div className="sticky bottom-4 z-20 animate-fade-in">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-primary/40 bg-card/95 p-4 shadow-glass backdrop-blur">
            <div className="flex min-w-0 flex-col gap-1.5">
              <span className="text-sm font-bold text-foreground">
                {cartPlans.length === 1
                  ? '1 plan selected'
                  : `${cartPlans.length} plans selected`}
              </span>
              {/*
                One chip per plan, each removable. This was the names joined
                with " + " into a single line, so the only way to drop ONE of
                two selected plans was Clear followed by re-picking the other.
              */}
              <div className="flex flex-wrap items-center gap-1.5">
                {cartPlans.map((p) => (
                  <span
                    key={p.id}
                    className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 py-0.5 pl-2.5 pr-1 text-xs font-semibold text-foreground"
                  >
                    {p.name}
                    <button
                      type="button"
                      aria-label={`Remove ${p.name}`}
                      title={`Remove ${p.name}`}
                      onClick={() => removeFromCart(p)}
                      className="rounded-full p-0.5 text-muted-foreground transition-colors hover:text-destructive"
                    >
                      <X size={12} />
                    </button>
                  </span>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                onClick={() => setCart({})}
                className="h-10 px-4 text-xs font-bold text-muted-foreground"
              >
                Clear
              </Button>
              <Button
                onClick={handleCheckoutCart}
                className="flex h-10 items-center gap-2 bg-primary px-5 text-xs font-bold text-primary-foreground hover:bg-primary/90"
              >
                <CreditCard size={14} />
                Checkout together
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Google Drive Prompt Modal */}
      <Dialog open={showDrivePrompt} onOpenChange={setShowDrivePrompt}>
        <DialogContent className="sm:max-w-md bg-card border-border/50 shadow-glass">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-xl font-black">
              <HardDrive className="text-blue-500" />
              Connect Google Drive
            </DialogTitle>
            <DialogDescription className="text-muted-foreground pt-2">
              Would you like to securely store your tenant&apos;s encrypted documents directly in your Google Drive? This ensures you have 100% control over your data.
            </DialogDescription>
          </DialogHeader>
          {/* The tick box Google shows as optional. Named here, before the
              admin leaves, because leaving it unticked produces a connection
              that looks fine and can store nothing. */}
          <p className="text-xs leading-relaxed text-muted-foreground">
            On Google&rsquo;s consent screen, tick{' '}
            <span className="font-semibold text-foreground">
              &ldquo;{DRIVE_CHECKBOX_LABEL}&rdquo;
            </span>
            . It is optional there, and without it nothing can be saved to your Drive.
          </p>
          <DialogFooter className="flex gap-2 sm:justify-start pt-4 mt-2 border-t border-border/30">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setShowDrivePrompt(false);
                router.push('/dashboard');
              }}
            >
              Skip for now
            </Button>
            <Button
              type="button"
              onClick={() => {
                window.location.href = '/api/auth/google?returnTo=/billing';
              }}
              className="bg-blue-600 hover:bg-blue-700 text-white font-bold"
            >
              Connect Google Drive
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      
      {/*
        The account has two halves now. A former household has no company yet
        and — with both halves and zero companies — no switcher to reach one,
        so the only door is the setup wizard's Companies step.
      */}
      <Dialog open={upgradedFrom !== null} onOpenChange={(open) => { if (!open) setUpgradedFrom(null); }}>
        <DialogContent className="sm:max-w-md bg-card border-border/50 shadow-glass">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-xl font-black">
              <CheckCircle className="text-emerald-500" />
              Your account now covers Personal &amp; Business
            </DialogTitle>
            <DialogDescription className="text-muted-foreground pt-2">
              {upgradedFrom === 'business'
                ? 'The personal workspace is ready. Use the workspace switcher in the header to open it.'
                : 'Add your first company to start filing business records. You can add more later from the same place.'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex gap-2 sm:justify-start pt-4 mt-2 border-t border-border/30">
            <Button type="button" variant="outline" onClick={() => setUpgradedFrom(null)}>
              Later
            </Button>
            {upgradedFrom !== 'business' && (
              <Button
                type="button"
                onClick={() => router.push('/onboarding')}
                className="bg-primary hover:bg-primary/90 text-primary-foreground font-bold"
              >
                Add a company
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {isCheckoutOpen && (
        <UnifiedCheckoutModal
          isOpen={isCheckoutOpen}
          onClose={() => setIsCheckoutOpen(false)}
          plans={selectedPlanForCheckout}
          currentUser={currentUser}
          initialDiscountCode={initialDiscountCode}
          upgrade={isSingleAccount ? upgrade : null}
          /*
            Removing a line from inside the dialog. `plans` above is a SNAPSHOT
            taken when checkout opened, not the live cart, so both have to move
            — otherwise the dialog would keep drawing a plan the cart bar had
            already dropped, and check it out.
          */
          onRemovePlan={(p) => {
            removeFromCart(p);
            setSelectedPlanForCheckout((prev) => (prev || []).filter((x) => x.id !== p.id));
          }}
          onSuccess={() => {
             // Decided BEFORE the refetch flips `accountType` to 'both'. The
             // rule is in ./afterPurchase.ts, where a test can hold it.
             const next = afterPurchase({
               tenant: currentUser?.tenant,
               accountType: billing?.accountType,
               boughtCombo: (selectedPlanForCheckout || []).some((p) => p?.appliesTo === 'both'),
             });
             // The cart has been paid for; leaving it filled would invite a
             // second purchase of what the tenant now already holds.
             setCart({});

             /*
               ── SETUP UNFINISHED: THE WIZARD, NOT THIS PAGE ──────────────────
               Billing is exempt from Shell's onboarding gate (checkout comes
               first), so nothing would move a just-paid new admin off this
               page — the Drive dialog below kept them here, and the wizard
               only appeared once they clicked a sidebar tab. The wizard asks
               the Drive question itself, on its Storage step. Said on arrival
               rather than here (src/lib/flashToast.ts): this page is gone a
               frame later.
             */
             if (next.kind === 'onboarding') {
               setFlash({
                 message: 'Payment successful — now set up your workspace.',
                 type: 'success',
                 pin: ONBOARDING_PATH,
                 tag: 'checkout-paid',
               });
               router.push(ONBOARDING_PATH);
               return;
             }

             // Staying put, so it is said here. The modal no longer raises
             // it, or the leaving branch above would have shown it twice.
             toast.success('Payment successful!', { id: 'checkout-paid' });
             refreshCurrentPlan();
             fetchPaymentHistory(activeAxis);
             fetchBillingSummary();
             if (next.kind === 'widened') setUpgradedFrom(next.from);
             else setShowDrivePrompt(true);
          }}
        />
      )}
    </PageContainer>
  );
}
