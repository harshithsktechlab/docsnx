import React, { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Loader2, IndianRupee, Tag, CheckCircle2, X } from 'lucide-react';
import { toast } from 'sonner';
import { apiCall } from '@/lib/net/apiRequest';
import { invalidatePermittedCategories } from '@/lib/usePermittedCategories';
import { UPGRADE_CYCLE, hasYearlyPrice, upgradeOffer } from '@/lib/upgradePricing';
import { planCovers } from '@/lib/billingAxis';
import { MAX_ADDON_QUANTITY } from '@/lib/addonQuantity';
import { allowedCycles, defaultCycle, isSellable } from '@/lib/planCycles';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   ONE CHECKOUT, ONE OR MORE PLANS                                        ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `plans` is the cart: a tenant running a household and a business can buy a
 * plan for each and pay once. `plan` (singular) is the older single-plan form
 * and is still what /billing/expired and the signup auto-checkout send, so both
 * are normalised into one list rather than duplicating the pricing.
 *
 * ── EACH LINE KEEPS ITS OWN BILLING CYCLE ──────────────────────────────────
 * `planDuration` used to be one piece of state for the one plan. It is now keyed
 * BY PLAN ID: a household on a monthly plan and a company on an annual one is an
 * ordinary thing to want, and a single shared cycle would silently re-term one
 * of them.
 *
 * ── THE ACCOUNT A PLAN APPLIES TO IS NOT SENT ──────────────────────────────
 * Only `planId` and `billingCycle` go up. The server reads `applies_to` off the
 * plan row itself, so a request cannot buy a personal plan and have it applied
 * to the business account. See the note in /api/payments/create-order.
 *
 * ── AN UPGRADE LINE HAS NO CYCLE TO CHOOSE ─────────────────────────────────
 * `upgrade` is the summary's verdict on whether this single-account tenant is
 * part-way through a paid term. When it is, a combo plan in the cart is priced
 * for the months left on that term (`upgradeOffer`, the same function the
 * server prices the order with), its cycle select becomes a label, and the
 * line goes up as UPGRADE. The server recomputes and overrides regardless: the
 * figure shown here is a preview of the server's decision, not an input to it.
 */
/**
 * The term a plan opens on, and the terms it may be offered at all, both come
 * from `src/lib/planCycles.ts` now.
 *
 * What used to live here returned MONTHLY whenever the monthly price column
 * held anything — which is how a plan that RUNS for 365 days but carries its
 * ₹3,499 in that column was sold as "Monthly", granting one month for a year's
 * money. The cycle decides the expiry; the plan's own `durationDays` has to
 * agree with it, and only one module should hold that opinion because the
 * server enforces the same rule in `priceCartLines`.
 */
const CYCLE_LABELS = { MONTHLY: 'Monthly', YEARLY: 'Yearly', ONE_TIME: 'One Time' };

export default function UnifiedCheckoutModal({ isOpen, onClose, plan, plans, currentUser, onSuccess, initialDiscountCode = '', upgrade = null, onRemovePlan = null }) {
  const [addons, setAddons] = useState([]);
  /**
   * `addonId -> { duration, quantity }`.
   *
   * Was `addonId -> duration`, which could only say "one of these". Add-ons
   * that grant SEATS or COMPANIES are sold by the unit — "three more members" —
   * so the line has to carry how many, and the quantity is what multiplies both
   * the price here and the entitlement on the server.
   */
  const [selectedAddons, setSelectedAddons] = useState({});
  const [discountCode, setDiscountCode] = useState('');
  const [discountResult, setDiscountResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [validatingDiscount, setValidatingDiscount] = useState(false);
  // A code carried in from signup still has to be validated against the real
  // tenant and cart, so it is applied once the cart has finished loading.
  const [pendingAutoApply, setPendingAutoApply] = useState(false);
  const [currency, setCurrency] = useState('INR'); // 'INR' | 'USD'
  /** planId -> 'MONTHLY' | 'YEARLY' | 'ONE_TIME'. One cycle per line. */
  const [planDurations, setPlanDurations] = useState({});

  /**
   * The cart, however it was handed in. `plans` wins; `plan` is the legacy
   * single form. Filtered because a caller may pass a null to mean "add-ons
   * only", which is a real checkout.
   */
  const cartPlans = React.useMemo(
    () => (Array.isArray(plans) ? plans : plan ? [plan] : []).filter(Boolean),
    [plans, plan],
  );

  /** Is this line the prorated upgrade? Only a combo plan, only on an eligible tenant. */
  const isUpgradeLine = (p) => !!upgrade?.eligible && p?.appliesTo === 'both';

  /** The prorated line, in the current currency, or null when not sold in it. */
  const offerFor = (p, curr = currency) => {
    if (!isUpgradeLine(p) || !hasYearlyPrice(p, curr)) return null;
    return upgradeOffer(p, upgrade.currentPlan, {
      months: upgrade.months,
      expiresAt: new Date(upgrade.expiresAt),
    }, curr);
  };

  /**
   * Can every plan in this cart be sold in this currency?
   *
   * An add-ons-only checkout has no plan to constrain the choice, so both stay
   * open and the server decides. Otherwise one unsellable line disables the
   * currency: a cart is paid for in a single currency, so a plan that cannot be
   * priced in it makes the whole checkout impossible, not just that row.
   */
  const sellableIn = (curr) => (
    cartPlans.length === 0 || cartPlans.every((p) => isSellable(p, curr))
  );

  /** The cycle for a line, defaulted to the shortest term the plan actually sells. */
  const durationFor = (p) => (
    offerFor(p) ? UPGRADE_CYCLE : (planDurations[p.id] || defaultCycle(p, currency))
  );

  useEffect(() => {
    if (isOpen) {
      setDiscountCode(initialDiscountCode || '');
      setDiscountResult(null);
      setPendingAutoApply(Boolean(initialDiscountCode));
      setSelectedAddons({});
      // Seeded per line, so a cart of two plans opens with each on the term it
      // actually sells rather than both on MONTHLY.
      setPlanDurations(Object.fromEntries(cartPlans.map((p) => [p.id, defaultCycle(p, currency)])));
      fetchAddons();
    }
  }, [isOpen, cartPlans, initialDiscountCode]);


  /**
   * ── WHAT AN ADD-ON IS, DECIDED BY WHAT IT GRANTS ──────────────────────────
   *
   * Not by its id and not by its name: `extra_members`, `extra_companies` and
   * `extra_members_per_company` are the columns the server actually enforces
   * (see `activeAddonSeats`), so an add-on priced in Admin → Add-ons shows up
   * here with the right control and the right wording without a line of code
   * being changed for it.
   *
   * Returns null for everything else — a credit pack, a storage bump — which is
   * what keeps those on the checkbox they have always had.
   */
  const capacityOf = (addon) => {
    if (addon?.extraMembers > 0) {
      return { axis: 'personal', unit: 'member', label: 'Additional members' };
    }
    if (addon?.extraCompanies > 0) {
      return { axis: 'business', unit: 'company', label: 'Additional companies' };
    }
    if (addon?.extraMembersPerCompany > 0) {
      // Per COMPANY, not a business-wide pool — the wording has to say so or a
      // customer buying "3" expects three employees and gets three per company.
      return { axis: 'business', unit: 'member in each company', label: 'Additional members per company' };
    }
    return null;
  };

  /**
   * Which halves of the account this checkout is actually buying for.
   *
   * A household with only a personal plan in the cart has no companies to add
   * seats to, and offering it "Additional companies" sells something it cannot
   * use. An add-ons-only checkout (the "Buy Add-ons" button passes no plan)
   * offers everything and lets the server refuse what does not apply.
   */
  const cartAxes = React.useMemo(() => {
    if (cartPlans.length === 0) return { personal: true, business: true };
    return {
      personal: cartPlans.some((p) => planCovers(p.appliesTo, 'personal')),
      business: cartPlans.some((p) => planCovers(p.appliesTo, 'business')),
    };
  }, [cartPlans]);

  /**
   * ── WHAT THE PLAN ALREADY INCLUDES ────────────────────────────────────────
   *
   * "₹499 per member" says what one more costs and nothing about what the
   * customer already has, so there is no way to tell whether to buy any. These
   * are the plan's own allowances, read off the SAME columns the plan card
   * lists and `activeAddonSeats` adds its add-ons to — so the number here and
   * the number enforced later cannot disagree.
   *
   * Summed across the cart because a household plan and a business plan bought
   * together each contribute their own half; a Combo contributes both at once.
   * Null (not 0) when nothing in the cart grants that column: an add-ons-only
   * checkout has no plan to quote, and "includes 0" would be a claim about a
   * plan the customer may well already own.
   */
  const includedByColumn = React.useMemo(() => {
    if (cartPlans.length === 0) return {};
    const total = (column) => cartPlans.reduce((sum, p) => sum + (Number(p[column]) || 0), 0);
    return {
      extraMembers: total('maxMembers') || null,
      extraCompanies: total('maxCompanies') || null,
      extraMembersPerCompany: total('maxMembersPerCompany') || null,
    };
  }, [cartPlans]);

  /**
   * The phrase appended to a capacity add-on's price line, or null.
   *
   * Keyed by the add-on's GRANT column, so it lines up with `capacityOf` — an
   * add-on granting `extraMembersPerCompany` is quoted against the plan's
   * `maxMembersPerCompany`, which is the per-company number, not a total.
   */
  const includedWith = (addon) => {
    if (addon?.extraMembers > 0) {
      const n = includedByColumn.extraMembers;
      return n ? `your plan includes ${n}` : null;
    }
    if (addon?.extraCompanies > 0) {
      const n = includedByColumn.extraCompanies;
      return n ? `your plan includes ${n}` : null;
    }
    if (addon?.extraMembersPerCompany > 0) {
      const n = includedByColumn.extraMembersPerCompany;
      return n ? `your plan includes ${n} in each company` : null;
    }
    return null;
  };

  /** Capacity add-ons for an axis this cart does not cover are hidden; the rest always show. */
  const visibleAddons = addons.filter((addon) => {
    const capacity = capacityOf(addon);
    return !capacity || cartAxes[capacity.axis];
  });
  const fetchAddons = async () => {
    setLoading(true);
    try {
      const { json: data } = await apiCall('/api/addons');
      if (data.success) {
        setAddons(data.addons || []);
      }
    } catch (e) {
      console.error(e);
    }
    setLoading(false);
  };

  useEffect(() => {
    if (isOpen && pendingAutoApply && !loading && discountCode.trim()) {
      setPendingAutoApply(false);
      handleValidateDiscount();
    }
  }, [isOpen, pendingAutoApply, loading, discountCode]);

  /** The term an add-on opens on: the cheapest one it actually sells. */
  const defaultAddonDuration = (addon) => {
    if (addon?.priceYearly !== null && addon?.priceYearly !== undefined) return 'YEARLY';
    if (addon?.priceOneTime !== null && addon?.priceOneTime !== undefined) return 'ONE_TIME';
    if (addon?.price !== null && addon?.price !== undefined) return 'MONTHLY';
    return 'YEARLY';
  };

  const handleToggleAddon = (addonId, checked) => {
    setSelectedAddons(prev => {
      const next = { ...prev };
      if (checked) {
        const addon = addons.find(a => a.id === addonId);
        next[addonId] = { duration: defaultAddonDuration(addon), quantity: 1 };
      } else {
        delete next[addonId];
      }
      return next;
    });
    // Reset discount if cart changes
    setDiscountResult(null);
  };

  /**
   * How many of a seat or company add-on. Zero removes the line — that is what
   * the top of the dropdown means, and it keeps "none" and "one" from needing
   * two different controls.
   */
  const handleQuantityChange = (addonId, rawQuantity) => {
    const quantity = Number(rawQuantity) || 0;
    setSelectedAddons(prev => {
      const next = { ...prev };
      if (quantity < 1) {
        delete next[addonId];
      } else {
        const addon = addons.find(a => a.id === addonId);
        next[addonId] = {
          duration: prev[addonId]?.duration || defaultAddonDuration(addon),
          quantity: Math.min(quantity, MAX_ADDON_QUANTITY),
        };
      }
      return next;
    });
    // The subtotal just moved, so a saving quoted against the old one is stale.
    setDiscountResult(null);
  };

  const handleDurationChange = (addonId, duration) => {
    setSelectedAddons(prev => ({
      ...prev,
      [addonId]: { duration, quantity: prev[addonId]?.quantity || 1 },
    }));
    setDiscountResult(null);
  };

  /** The lines as the API wants them, built in one place so the three callers agree. */
  const addonLines = () => Object.entries(selectedAddons).map(([id, line]) => ({
    id,
    duration: line.duration,
    quantity: line.quantity,
  }));

  const formatAmt = (amt) => {
    const val = Number(amt) || 0;
    if (currency === 'USD') return `$${val.toLocaleString('en-US')}`;
    return `₹${val.toLocaleString('en-IN')}`;
  };

  const getPlanPrice = (planObj, duration, curr = currency) => {
    if (!planObj) return 0;
    const offer = offerFor(planObj, curr);
    if (offer) return offer.amount;
    if (curr === 'USD') {
      if (duration === 'YEARLY' && planObj.priceYearlyUsd !== null && planObj.priceYearlyUsd !== undefined) return Number(planObj.priceYearlyUsd);
      if (duration === 'ONE_TIME' && planObj.priceOneTimeUsd !== null && planObj.priceOneTimeUsd !== undefined) return Number(planObj.priceOneTimeUsd);
      return Number(planObj.priceUsd || 0);
    } else {
      if (duration === 'YEARLY' && planObj.priceYearly !== null && planObj.priceYearly !== undefined) return Number(planObj.priceYearly);
      if (duration === 'ONE_TIME' && planObj.priceOneTime !== null && planObj.priceOneTime !== undefined) return Number(planObj.priceOneTime);
      return Number(planObj.price || 0);
    }
  };

  const getAddonPrice = (addon, duration, curr = currency) => {
    if (curr === 'USD') {
      if (duration === 'YEARLY' && addon.priceYearlyUsd !== null && addon.priceYearlyUsd !== undefined) return Number(addon.priceYearlyUsd);
      if (duration === 'ONE_TIME' && addon.priceOneTimeUsd !== null && addon.priceOneTimeUsd !== undefined) return Number(addon.priceOneTimeUsd);
      return Number(addon.priceUsd || 0);
    } else {
      if (duration === 'YEARLY' && addon.priceYearly !== null && addon.priceYearly !== undefined) return Number(addon.priceYearly);
      if (duration === 'ONE_TIME' && addon.priceOneTime !== null && addon.priceOneTime !== undefined) return Number(addon.priceOneTime);
      return Number(addon.price || 0);
    }
  };

  const calculateSubtotal = () => {
    let total = 0;
    for (const p of cartPlans) total += getPlanPrice(p, durationFor(p), currency);
    
    Object.entries(selectedAddons).forEach(([addonId, line]) => {
      const addon = addons.find(a => a.id === addonId);
      if (addon) {
        // x quantity — this is what makes the total move as the dropdowns do.
        // The server recomputes it all from the add-on rows regardless; this is
        // a preview of that answer, not an input to it.
        total += getAddonPrice(addon, line.duration, currency) * (line.quantity || 1);
      }
    });
    return total;
  };

  const handleValidateDiscount = async () => {
    if (!discountCode.trim()) return;
    setValidatingDiscount(true);
    
    const addonsPurchased = addonLines();
    
    try {
      const { json: data } = await apiCall('/api/payments/validate-discount', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
        discountCode,
        // The primary line, for a discount rule written against one plan.
        planId: cartPlans[0]?.id || null,
        planBillingCycle: cartPlans[0] ? durationFor(cartPlans[0]) : undefined,
        items: cartPlans.map((p) => ({ planId: p.id, billingCycle: durationFor(p) })),
        addonsPurchased,
        currency,
        tenantId: currentUser?.tenantId
        })
      });
      if (data.success) {
        setDiscountResult({ amountSaved: data.amountSaved, discountId: data.discountId, code: discountCode });
        toast.success('Discount applied!');
      } else {
        setDiscountResult(null);
        toast.error(data.error || 'Invalid discount code');
      }
    } catch (e) {
      toast.error('Failed to validate discount');
    }
    setValidatingDiscount(false);
  };

  const loadRazorpayScript = () => {
    return new Promise((resolve) => {
      if (document.querySelector('script[src="https://checkout.razorpay.com/v1/checkout.js"]')) {
        resolve(true);
        return;
      }
      const script = document.createElement('script');
      script.src = 'https://checkout.razorpay.com/v1/checkout.js';
      script.onload = () => resolve(true);
      script.onerror = () => resolve(false);
      document.body.appendChild(script);
    });
  };

  const handleCheckout = async () => {
    const addonsPurchased = addonLines();
    if (cartPlans.length === 0 && addonsPurchased.length === 0) {
      toast.error('Please select at least one item to purchase.');
      return;
    }

    setProcessing(true);
    try {
      const loaded = await loadRazorpayScript();
      if (!loaded) { toast.error('Failed to load payment gateway.'); setProcessing(false); return; }

      const payload = {
        // `planId` stays the primary line so the invoice generator and the admin
        // screens keep reading what they always did; `items` carries the truth.
        planId: cartPlans[0]?.id || null,
        planBillingCycle: cartPlans[0] ? durationFor(cartPlans[0]) : undefined,
        items: cartPlans.map((p) => ({ planId: p.id, billingCycle: durationFor(p) })),
        currency,
        addonsPurchased,
        tenantId: currentUser.tenantId,
        discountCode: discountResult ? discountResult.code : (discountCode.trim() || undefined)
      };

      const { json: data } = await apiCall('/api/payments/create-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      
      if (!data.success) { 
        toast.error(data.error || 'Failed to create payment order.'); 
        setProcessing(false); 
        return; 
      }

      // Success is said by `onSuccess` (the page), not here: the page may be
      // leaving for the setup wizard, and a toast raised on the way out would
      // stack on top of the one it hands to that arrival.
      if (data.bypassPayment) {
        setProcessing(false);
        onClose();
        // A plan purchase can newly unlock a whole module axis (e.g. the
        // business half); the sidebar's per-session category cache
        // (usePermittedCategories) never refetches on its own, so without this
        // the new modules stay invisible until the customer reloads.
        invalidatePermittedCategories();
        if (onSuccess) onSuccess();
        return;
      }

      // Open Razorpay Checkout
      const options = {
        key: data.keyId,
        amount: data.amount,
        currency: data.currency,
        name: 'DocsNX',
        description: `Checkout`,
        order_id: data.orderId,
        handler: async (response) => {
          try {
            const { json: verifyData } = await apiCall('/api/payments/verify', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(response),
            });
            if (verifyData.success) {
              onClose();
              invalidatePermittedCategories();
              if (onSuccess) onSuccess();
            } else {
              toast.error(verifyData.error || 'Payment verification failed.');
            }
          } catch {
            toast.error('Payment verification error.');
          }
          setProcessing(false);
        },
        modal: {
          ondismiss: () => {
            setProcessing(false);
          },
        },
        prefill: {
          name: currentUser.name || '',
          email: currentUser.email || '',
        },
        theme: { color: '#e07a5f' },
      };

      const rzp = new window.Razorpay(options);
      rzp.on('payment.failed', (response) => {
        toast.error(`Payment failed: ${response.error?.description || 'Unknown error'}`);
        setProcessing(false);
      });
      rzp.open();
    } catch (err) {
      toast.error('An unexpected error occurred.');
      setProcessing(false);
    }
  };

  const subtotal = calculateSubtotal();
  const amountSaved = discountResult ? discountResult.amountSaved : 0;
  const finalPrice = Math.max(0, subtotal - amountSaved);

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !processing && onClose()}>
      <DialogContent className="sm:max-w-lg bg-card border-border/50 shadow-glass">
        <DialogHeader>
          <div className="flex items-center justify-between pr-4">
            <DialogTitle className="flex items-center gap-2 text-xl font-black">
              <IndianRupee className="text-primary" />
              Checkout
            </DialogTitle>
            <div className="flex items-center gap-1 bg-muted p-1 rounded-lg">
              <button
                type="button"
                disabled={!sellableIn('INR')}
                title={sellableIn('INR') ? undefined : 'Not sold in rupees'}
                onClick={() => { setCurrency('INR'); setDiscountResult(null); }}
                className={`px-2.5 py-1 text-xs font-bold rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${currency === 'INR' ? 'bg-background text-primary shadow-sm' : 'text-muted-foreground'}`}
              >
                ₹ INR
              </button>
              <button
                type="button"
                /*
                  A currency no plan in the cart is sold in is not offered.
                  Combo carries `price_usd = 0.00`, which priced a USD line at
                  zero and took the `amountInPaise <= 0` branch in create-order
                  — a free ₹3,499 subscription for anyone who clicked here. The
                  server refuses it now; this stops the click reaching a dead
                  end, which is the same reason the grid hides unsellable plans.
                */
                disabled={!sellableIn('USD')}
                title={sellableIn('USD') ? undefined : 'Not sold in dollars'}
                onClick={() => { setCurrency('USD'); setDiscountResult(null); }}
                className={`px-2.5 py-1 text-xs font-bold rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${currency === 'USD' ? 'bg-background text-primary shadow-sm' : 'text-muted-foreground'}`}
              >
                $ USD
              </button>
            </div>
          </div>
          <DialogDescription className="text-muted-foreground pt-2">
            Review your selection and configure billing cycle & add-ons.
          </DialogDescription>
        </DialogHeader>
        
        <div className="px-6 sm:px-7 py-5 space-y-6 overflow-y-auto max-h-[65vh]">
          {/* Plan Section — one row per line, each with its own term. */}
          {cartPlans.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-sm font-bold uppercase tracking-wider text-muted-foreground">
                {cartPlans.length === 1 ? 'Selected Plan' : 'Selected Plans'}
              </h4>
              {cartPlans.map((p) => (
                <div
                  key={p.id}
                  className="flex flex-col gap-2 bg-muted/20 p-3 rounded-md border border-border/50"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="font-bold text-foreground block">{p.name}</span>
                      {/* Which account this line buys. Read off the plan, never
                          chosen here — the server does the same. */}
                      <span className="text-xs text-muted-foreground">
                        {p.appliesTo === 'both'
                          ? 'Personal + Business'
                          : p.appliesTo === 'business' ? 'Business' : 'Personal'}
                        {offerFor(p)
                          ? ` · until ${new Date(offerFor(p).expiresAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`
                          : ' · Billing duration'}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      {offerFor(p) ? (
                        <span className="text-xs font-semibold text-muted-foreground">
                          Upgrade · {offerFor(p).months} month{offerFor(p).months === 1 ? '' : 's'}
                        </span>
                      ) : (
                      <select
                        className="bg-background text-xs border border-border/50 rounded p-1 text-foreground font-semibold"
                        value={durationFor(p)}
                        onChange={(e) => {
                          setPlanDurations((prev) => ({ ...prev, [p.id]: e.target.value }));
                          // The discount was priced against the old cart.
                          setDiscountResult(null);
                        }}
                      >
                        {/*
                          The cycles this plan actually sells, which is no
                          longer the same question as "which price columns are
                          filled in" — a 365-day plan is not offered monthly
                          however its monthly column is set. The server refuses
                          the same lines; see src/lib/planCycles.ts.
                        */}
                        {allowedCycles(p, currency).map((cycle) => (
                          <option key={cycle} value={cycle}>{CYCLE_LABELS[cycle]}</option>
                        ))}
                      </select>
                      )}
                      <span className="font-bold text-foreground">
                        {formatAmt(getPlanPrice(p, durationFor(p)))}
                      </span>
                      {/*
                        Taking one plan out of a two-plan cart without closing
                        the checkout and starting again. `onRemovePlan` is the
                        billing page's own `removeFromCart`, so the cart bar and
                        this dialog cannot disagree about what is selected.
                      */}
                      {onRemovePlan && (
                        <button
                          type="button"
                          aria-label={`Remove ${p.name}`}
                          title={`Remove ${p.name}`}
                          disabled={processing}
                          onClick={() => {
                            onRemovePlan(p);
                            // Priced against a cart that no longer exists.
                            setDiscountResult(null);
                          }}
                          className="rounded p-1 text-muted-foreground transition-colors hover:text-destructive disabled:opacity-50"
                        >
                          <X size={14} />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
          {/*
            ── ADD-ONS, AND THE TWO KINDS THERE TURN OUT TO BE ────────────────
            An add-on that grants SEATS or COMPANIES is sold by the unit: nobody
            wants "extra members", they want three of them. Those get a quantity
            dropdown, and the line total moves with it.

            Everything else — a credit pack, a storage bump — is still the thing
            you either have or do not, and keeps its checkbox.

            Which kind an add-on is comes from WHAT IT GRANTS, never from its id
            or its name: `extra_members`, `extra_companies` and
            `extra_members_per_company` are the columns the server actually
            enforces, so an add-on priced in the admin screen appears here
            correctly without anything being wired up for it.
          */}
          <div className="space-y-3">
            <h4 className="text-sm font-bold uppercase tracking-wider text-muted-foreground">Optional Add-ons</h4>
            {loading ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 size={12} className="animate-spin" /> Loading addons...</div>
            ) : visibleAddons.length === 0 ? (
              <div className="text-xs text-muted-foreground italic">No add-ons available.</div>
            ) : (
              <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                {visibleAddons.map(addon => {
                  const line = selectedAddons[addon.id];
                  const isSelected = !!line;
                  const duration = line?.duration || defaultAddonDuration(addon);
                  const quantity = line?.quantity || 0;
                  const capacity = capacityOf(addon);
                  const unitPrice = getAddonPrice(addon, duration);

                  return (
                    <div key={addon.id} className={`flex flex-col gap-2 p-3 rounded-md border transition-colors ${isSelected ? 'border-primary/50 bg-primary/5' : 'border-border/50 bg-muted/10'}`}>
                      <div className="flex items-center gap-3">
                        {/* A quantity dropdown IS the selection for a capacity
                            add-on — a checkbox beside it would be a second way
                            to say the same thing, and they would disagree. */}
                        {!capacity && (
                          <input
                            type="checkbox"
                            id={`addon-${addon.id}`}
                            checked={isSelected}
                            onChange={(e) => handleToggleAddon(addon.id, e.target.checked)}
                            className="w-4 h-4 rounded border-border text-primary focus:ring-primary cursor-pointer accent-primary"
                          />
                        )}
                        <div
                          className={capacity ? 'flex-1' : 'flex-1 cursor-pointer'}
                          onClick={capacity ? undefined : () => handleToggleAddon(addon.id, !isSelected)}
                        >
                          <span className="font-bold text-sm text-foreground block">{addon.name}</span>
                          <span className="text-xs text-muted-foreground block">{addon.description}</span>
                          {(addon.storageLimitGB > 0 || addon.aiCredits > 0) && (
                            <div className="text-xs text-muted-foreground mt-1 flex gap-2">
                              {addon.storageLimitGB > 0 && <span>• {addon.storageLimitGB}GB Storage</span>}
                              {addon.aiCredits > 0 && <span>• {addon.aiCredits} AI Credits</span>}
                            </div>
                          )}
                          {capacity && (
                            <div className="text-xs text-muted-foreground mt-1">
                              {formatAmt(unitPrice)} per {capacity.unit}
                              {/* What they already have, so "one more" means
                                  something. Omitted rather than shown as 0 when
                                  no plan in the cart grants this column. */}
                              {includedWith(addon) && (
                                <span> &middot; {includedWith(addon)}</span>
                              )}
                            </div>
                          )}
                        </div>

                        {capacity && (
                          <select
                            aria-label={capacity.label}
                            className="bg-background text-xs border border-border/50 rounded p-1.5 text-foreground min-w-[4.5rem]"
                            value={quantity}
                            onChange={(e) => handleQuantityChange(addon.id, e.target.value)}
                          >
                            {/* 0 is how a line is removed, so "none" and "one"
                                need only this one control. */}
                            {Array.from({ length: MAX_ADDON_QUANTITY + 1 }, (_, n) => (
                              <option key={n} value={n}>{n === 0 ? 'None' : `+${n}`}</option>
                            ))}
                          </select>
                        )}
                      </div>

                      {isSelected && (
                        <div className="pl-7 flex items-center justify-between border-t border-border/30 pt-2 mt-1">
                          <select
                            className="bg-background text-xs border border-border/50 rounded p-1 text-foreground"
                            value={duration}
                            onChange={(e) => handleDurationChange(addon.id, e.target.value)}
                          >
                            {addon.price !== null && addon.price !== undefined && addon.price !== "" && <option value="MONTHLY">Monthly</option>}
                            {addon.priceYearly !== null && addon.priceYearly !== undefined && addon.priceYearly !== "" && <option value="YEARLY">Yearly</option>}
                            {addon.priceOneTime !== null && addon.priceOneTime !== undefined && addon.priceOneTime !== "" && <option value="ONE_TIME">One Time</option>}
                          </select>
                          <span className="text-sm font-bold">
                            {/* The arithmetic spelled out, because a total that
                                changed when a dropdown moved and said only its
                                result is the one people distrust. */}
                            {quantity > 1 && (
                              <span className="text-xs font-medium text-muted-foreground mr-1.5">
                                {quantity} × {formatAmt(unitPrice)} =
                              </span>
                            )}
                            {formatAmt(unitPrice * Math.max(quantity, 1))}
                          </span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          {/* Discount Section */}
          <div className="space-y-2">
            <h4 className="text-sm font-bold uppercase tracking-wider text-muted-foreground">Discount Code</h4>
            <div className="flex items-center gap-2">
              <Input 
                placeholder="Enter code" 
                value={discountCode} 
                onChange={(e) => {
                   setDiscountCode(e.target.value.toUpperCase());
                   if (discountResult) setDiscountResult(null); // Reset if they edit it
                }}
                className="h-9 text-xs"
              />
              <Button size="sm" variant="secondary" className="h-9 text-xs" onClick={handleValidateDiscount} disabled={!discountCode.trim() || validatingDiscount}>
                {validatingDiscount ? <Loader2 size={12} className="animate-spin" /> : 'Apply'}
              </Button>
            </div>
            {discountResult && (
              <div className="flex items-center gap-1.5 text-xs text-emerald-500 font-bold mt-1">
                <CheckCircle2 size={12} /> Code applied! (-{formatAmt(discountResult.amountSaved)})
              </div>
            )}
          </div>

          <div className="border-t border-border/50 pt-4">
            <div className="flex justify-between items-center mb-1">
              <span className="text-sm text-muted-foreground">Subtotal</span>
              <span className="text-sm font-bold">{formatAmt(subtotal)}</span>
            </div>
            {amountSaved > 0 && (
              <div className="flex justify-between items-center mb-1 text-emerald-500">
                <span className="text-sm">Discount</span>
                <span className="text-sm font-bold">-{formatAmt(amountSaved)}</span>
              </div>
            )}
            <div className="flex justify-between items-center mt-2 pt-2 border-t border-border/30">
              <span className="text-base font-bold text-foreground">Total</span>
              <span className="text-lg font-black text-primary">{formatAmt(finalPrice)}</span>
            </div>
          </div>
        </div>

        <DialogFooter className="flex gap-2 sm:justify-end border-t border-border/30 pt-4">
          <Button type="button" variant="outline" onClick={onClose} disabled={processing}>Cancel</Button>
          <Button type="button" className="bg-primary hover:bg-primary/90 font-bold" onClick={handleCheckout} disabled={processing}>
            {processing ? <><Loader2 size={14} className="animate-spin mr-2" /> Processing...</> : `Pay ${formatAmt(finalPrice)}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
