import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { payments, addons, tenantAddons, discountUsages } from '@/db/schema';
import { getUserFromRequest } from '@/lib/auth';
import { createOrder, getPublicKeyId } from '@/lib/razorpay';
import { eq } from 'drizzle-orm';
import { loadRedeemableDiscount, computeAmountSaved } from '@/lib/discountPricing';
import { generateAndUploadInvoice } from '@/lib/invoiceGenerator';
import { applyPlanToTenant, adjustTenantCredits } from '@/lib/planProvisioning';
import { ACTIONS, auditSentence } from '@/lib/audit';
import { CREDIT_REASONS } from '@/lib/creditLedger';
import { combinedAppliesTo, expiryForLine, type PlanLineItem } from '@/lib/billingAxis';
import { priceCartLines } from '@/lib/cartPricing';
import { parseAddonQuantity, MAX_ADDON_QUANTITY } from '@/lib/addonQuantity';
import { UPGRADE_CYCLE } from '@/lib/upgradePricing';
import { serverError } from '@/lib/routeError';

export async function POST(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
    }

    if (user.role !== 'SUPER_ADMIN' && user.role !== 'TENANT_ADMIN') {
      return NextResponse.json({ error: 'Access denied. Admin privileges required.' }, { status: 403 });
    }

    let { planId, planBillingCycle, currency = 'INR', addonsPurchased, tenantId, discountCode, isManualPayment, items } = await req.json();

    /**
     * ── THE CART ────────────────────────────────────────────────────────────
     *
     * `items` is the combined checkout: one entry per plan, each saying which
     * account it is for. `planId`/`planBillingCycle` remain the single-plan
     * form, and every existing caller still sends only those — so the two are
     * normalised into one list here rather than duplicating the pricing loop.
     *
     * ⚠ The client does NOT get to say which account a plan is for. That comes
     * off the plan row's own `applies_to` when each line is priced below. A
     * request that could name the axis could buy a personal plan and have it
     * applied to the business account — the cheap plan, the expensive
     * entitlement — and there would be nothing in the payment to show it.
     */
    const requestedLines: Array<{ planId: string; billingCycle: string | null }> =
      Array.isArray(items) && items.length > 0
        ? items
          .map((item: any) => ({
            planId: String(item?.planId || ''),
            billingCycle: item?.billingCycle ?? null,
          }))
          .filter((line: { planId: string }) => line.planId)
        : planId
          ? [{ planId: String(planId), billingCycle: planBillingCycle ?? null }]
          : [];

    // Deduped so a cart naming one plan twice is charged once.
    const seenPlanIds = new Set<string>();
    const cartLines = requestedLines.filter((line) => {
      if (seenPlanIds.has(line.planId)) return false;
      seenPlanIds.add(line.planId);
      return true;
    });

    if ((cartLines.length === 0 && (!addonsPurchased || addonsPurchased.length === 0)) || !tenantId) {
      return NextResponse.json({ error: 'items (or planId) or addonsPurchased, and tenantId, are required.' }, { status: 400 });
    }

    if (isManualPayment && user.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Only Super Admins can manually record payments.' }, { status: 403 });
    }

    if (user.role === 'TENANT_ADMIN' && user.tenantId !== tenantId) {
      return NextResponse.json({ error: 'Access denied. Cannot create orders for other tenants.' }, { status: 403 });
    }

    let finalPrice = 0;
    let itemName = '';
    let plan = null;
    let planPrice = 0;
    let fetchedAddons = [];

    /**
     * Price every line in the cart. One line for an ordinary checkout; two when
     * an admin buys a personal plan and a business plan in the same order.
     *
     * `priceCartLines` is the one pricer (validate-discount uses it too), and
     * it is where a combo plan bought by a single-account tenant becomes a
     * prorated UPGRADE line anchored to the term they already hold — the axis
     * AND the cycle of such a line come off the plan and the tenant, never the
     * request. See the note on `requestedLines`.
     */
    const currencyCode: 'INR' | 'USD' = currency === 'USD' ? 'USD' : 'INR';
    const priced = await priceCartLines(tenantId, cartLines, currencyCode);
    if (!priced.ok) {
      return NextResponse.json({ error: priced.error }, { status: priced.status });
    }
    const cart: PlanLineItem[] = priced.cart;
    finalPrice += priced.subtotal;
    itemName = priced.itemName;

    /**
     * The PRIMARY line, kept in the existing `plan_id` / `plan_billing_cycle`
     * columns so the invoice generator, the admin screens and the payment
     * webhook keep working without reading the cart at all. The first line is
     * the primary one; `plans_purchased` carries the whole truth.
     */
    if (priced.primary) {
      plan = priced.primary.plan;
      planId = plan.id;
      planBillingCycle = priced.primary.billingCycle;
      planPrice = priced.primary.price;
    }

    // Calculate Addons Cost
    if (addonsPurchased && addonsPurchased.length > 0) {
      for (const item of addonsPurchased) {
        const addonResult = await db.select().from(addons).where(eq(addons.id, item.id)).limit(1);
        const addon = addonResult[0];

        if (!addon || !addon.isActive) {
          return NextResponse.json({ error: `Add-on not found or inactive: ${item.id}` }, { status: 404 });
        }

        /**
         * ── HOW MANY, DECIDED HERE AND NOWHERE ELSE ─────────────────────────
         * The checkout sells add-ons by quantity now. This number multiplies a
         * price, so it is refused rather than coerced: a `-3` would be a line
         * that pays the customer, and a `1e9` is either an absurd order or —
         * on a zero-priced add-on — an unbounded free entitlement. See
         * src/lib/addonQuantity.ts for the rule; an absent quantity is 1, which
         * is what every older client means.
         */
        const quantity = parseAddonQuantity(item.quantity);
        if (quantity === null) {
          return NextResponse.json(
            { error: `Choose between 1 and ${MAX_ADDON_QUANTITY} of ${addon.name}.` },
            { status: 400 },
          );
        }

        let addonPrice = Number(currency === 'USD' ? (addon.priceUsd || 0) : addon.price);
        if (item.duration === 'YEARLY') {
          const yearlyVal = currency === 'USD' ? addon.priceYearlyUsd : addon.priceYearly;
          if (yearlyVal !== null && yearlyVal !== undefined) addonPrice = Number(yearlyVal);
        } else if (item.duration === 'ONE_TIME') {
          const oneTimeVal = currency === 'USD' ? addon.priceOneTimeUsd : addon.priceOneTime;
          if (oneTimeVal !== null && oneTimeVal !== undefined) addonPrice = Number(oneTimeVal);
        }

        // The LINE total from here on. `purchasedPrice` is what a discount
        // scoped to this add-on is applied against (see computeAmountSaved), and
        // a percentage off three seats must be off all three.
        const linePrice = addonPrice * quantity;

        finalPrice += linePrice;
        fetchedAddons.push({
          ...addon,
          purchasedPrice: linePrice,
          unitPrice: addonPrice,
          quantity,
          duration: item.duration,
        });

        if (itemName.length > 0) itemName += ', ';
        itemName += quantity > 1
          ? `${addon.name} x${quantity} (${item.duration || 'MONTHLY'})`
          : `${addon.name} (${item.duration || 'MONTHLY'})`;
      }

      // ── WHAT GETS STORED IS WHAT WAS PRICED ─────────────────────────────
      // `addonsPurchased` is written onto the payment row and is what `verify`
      // and the webhook later grant from. Rewriting it with the PARSED
      // quantities means the grant cannot disagree with the charge — a body
      // that omitted the quantity is stored as the 1 it was billed as.
      addonsPurchased = fetchedAddons.map((a) => ({
        id: a.id,
        duration: a.duration,
        quantity: a.quantity,
      }));
    }

    let appliedDiscountId: string | null = null;
    let amountSaved = 0;

    if (discountCode) {
      const loaded = await loadRedeemableDiscount(discountCode, { tenantId });
      if (!loaded.ok) {
        return NextResponse.json({ error: loaded.error }, { status: 400 });
      }
      const discount = loaded.discount;

      const priced = computeAmountSaved(discount, {
        subtotal: finalPrice,
        planId,
        planPrice: plan ? planPrice : 0,
        addons: fetchedAddons.map(a => ({ id: a.id, price: a.purchasedPrice })),
      });

      if (!priced.ok) {
        return NextResponse.json({ error: priced.error }, { status: 400 });
      }

      appliedDiscountId = discount.id;
      amountSaved = priced.amountSaved;
      finalPrice = Math.max(0, finalPrice - amountSaved);
    }

    const amountInPaise = Math.round(finalPrice * 100);

    if (amountInPaise <= 0 || isManualPayment) {
      const orderIdPrefix = isManualPayment ? 'manual' : 'trial';
      const pId = `${orderIdPrefix}_${Date.now()}`;

      // 1. Insert payment record first
      const paymentRet = await db.insert(payments).values({
        tenantId,
        planId: planId || null,
        planBillingCycle: planBillingCycle || null,
        // Which account(s) this order bought, and the full line list. null on an
        // add-ons-only order, which belongs to neither axis — `paymentInAxis`
        // reads that into the Personal tab.
        appliesTo: combinedAppliesTo(cart),
        plansPurchased: cart.length > 0 ? cart : null,
        addonsPurchased: addonsPurchased && addonsPurchased.length > 0 ? addonsPurchased : null,
        razorpayOrderId: pId,
        amount: String(finalPrice),
        currency: currency === 'USD' ? 'USD' : 'INR',
        status: 'captured',
        initiatedBy: user.role,
      }).returning({ id: payments.id });

      const paymentId = paymentRet[0].id;

      if (appliedDiscountId && amountSaved > 0) {
         await db.insert(discountUsages).values({
            discountCodeId: appliedDiscountId,
            tenantId,
            paymentId,
            amountSaved: String(amountSaved)
         });
      }

      /**
       * 2. Fulfil the order — one call per LINE, so a manually recorded combined
       * payment applies both axes exactly as the Razorpay path does.
       *
       * `applyPlanToTenant` grants the plan's AI credits, so a plan covering
       * BOTH axes must not be passed twice: `expandCart` would yield it once per
       * axis and the tenant would be credited twice for one payment. Iterating
       * `cart` (one entry per PLAN) rather than the expanded form is what keeps
       * that impossible here.
       */
      for (const line of cart) {
        const linePlan = priced.plans.get(line.planId);
        if (!linePlan) continue;

        // Cycle-derived, or — for an upgrade line — anchored to the term the
        // tenant already holds, so both halves expire together. Passed
        // explicitly rather than left to the helper's durationDays maths.
        const expiryDate = expiryForLine(line);

        // Was a read-modify-write (`currentBalance + plan.aiCredits`), which
        // silently lost a concurrent grant and left no audit or ledger row.
        // applyPlanToTenant adds in-database and records both.
        await applyPlanToTenant(db, {
          tenantId,
          plan: linePlan,
          expiry: expiryDate,
          userId: user.id,
          action: ACTIONS.payment.edit_manual,
          reason: line.billingCycle === UPGRADE_CYCLE
            ? `Upgrade to Personal + Business for the remaining ${line.proratedMonths} months, recorded by ${user.email}.`
            : `Manual payment recorded by ${user.email}.`,
          // No axis argument: `applyPlanToTenant` writes every axis the plan's
          // own `appliesTo` covers, so a business plan lands on the business
          // columns and a combined one on both.
        });
      }
      
      if (addonsPurchased && addonsPurchased.length > 0) {
        let totalAddonCredits = 0;
        for (const item of addonsPurchased) {
          const addonResult = await db.select().from(addons).where(eq(addons.id, item.id)).limit(1);
          const addonObj = addonResult[0];
          // Re-parsed rather than trusted: this loop reads the array rewritten
          // above, but it also runs for a manually recorded payment, whose body
          // has not been through the pricing loop at all.
          const quantity = parseAddonQuantity(item.quantity) ?? 1;

          if (addonObj?.aiCredits) {
            // Three of a credit pack is three packs' worth of credits, for the
            // same reason it is three times the price.
            totalAddonCredits += addonObj.aiCredits * quantity;
          }

          let expiresAt: Date | null = null;
          if (item.duration === 'MONTHLY') {
            expiresAt = new Date();
            expiresAt.setMonth(expiresAt.getMonth() + 1);
          } else if (item.duration === 'YEARLY') {
            expiresAt = new Date();
            expiresAt.setFullYear(expiresAt.getFullYear() + 1);
          }

          await db.insert(tenantAddons).values({
            tenantId,
            addonId: item.id,
            quantity,
            expiresAt,
            isActive: true
          });
        }

        if (totalAddonCredits > 0) {
          await adjustTenantCredits(db, {
            tenantId,
            amount: totalAddonCredits,
            userId: user.id,
            action: ACTIONS.addon.grant,
            details: auditSentence('grant', {
              kind: 'AI credits',
              note: `${totalAddonCredits} from add-ons on a manually recorded payment`,
            }),
            reason: CREDIT_REASONS.addon_grant,
            ledgerDescription: `Add-ons purchased — ${totalAddonCredits.toLocaleString()} AI credits granted.`,
          });
        }
      }

      // 3. Generate Invoice
      const invoiceUrl = await generateAndUploadInvoice(paymentId);
      if (invoiceUrl) {
        await db.update(payments).set({ invoiceUrl }).where(eq(payments.id, paymentId));
      }

      return NextResponse.json({ success: true, bypassPayment: true });
    }

    const receipt = `rcpt_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const notes: Record<string, string> = {
      tenantId,
      planId: planId || '',
      planBillingCycle: planBillingCycle || '',
      // An upgrade's anchored expiry, so the webhook fallback lands on the same
      // date `verify` does — it reads the cart, but the notes are its last resort.
      expiresAt: cart[0]?.expiresAt || '',
      itemName: itemName.length > 200 ? itemName.substring(0, 197) + '...' : itemName,
      initiatedBy: user.role,
    };

    if (appliedDiscountId) {
      notes.discountCodeId = appliedDiscountId;
      notes.amountSaved = String(amountSaved);
    }

    const order = await createOrder(amountInPaise, currency === 'USD' ? 'USD' : 'INR', receipt, notes);

    await db.insert(payments).values({
      tenantId,
      planId: planId || null,
      planBillingCycle: planBillingCycle || null,
      // See the note on the bypass path above.
      appliesTo: combinedAppliesTo(cart),
      plansPurchased: cart.length > 0 ? cart : null,
      addonsPurchased: addonsPurchased && addonsPurchased.length > 0 ? addonsPurchased : null,
      razorpayOrderId: order.id,
      amount: String(finalPrice),
      currency: currency === 'USD' ? 'USD' : 'INR',
      status: 'created',
      initiatedBy: user.role,
    });

    return NextResponse.json({
      success: true,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: getPublicKeyId(),
    });
  } catch (error) {
    return serverError(error, 'creating order');
  }
}
