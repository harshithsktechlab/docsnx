import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { payments, tenants, tenantAddons, subscriptionPlans, addons, invoices } from '@/db/schema';
import { getUserFromRequest } from '@/lib/auth';
import { verifyPaymentSignature } from '@/lib/razorpay';
import { eq, and, inArray } from 'drizzle-orm';
import { generateAndUploadInvoice } from '@/lib/invoiceGenerator';
import { creditBalanceDelta, recordCreditMovement } from '@/lib/planProvisioning';
import { CREDIT_REASONS } from '@/lib/creditLedger';
import { writeAudit, ACTIONS, auditSentence } from '@/lib/audit';
import {
  expandCart,
  expiryForLine,
  planColumnsForAxis,
  widenAccountType,
  type AccountAxis,
  type PlanLineItem,
} from '@/lib/billingAxis';
import { UPGRADE_CYCLE } from '@/lib/upgradePricing';
import { parseAddonQuantity } from '@/lib/addonQuantity';
import { serverError } from '@/lib/routeError';

export async function POST(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
    }

    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = await req.json();

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return NextResponse.json(
        { error: 'razorpay_order_id, razorpay_payment_id, and razorpay_signature are required.' },
        { status: 400 }
      );
    }

    const isValid = verifyPaymentSignature(razorpay_order_id, razorpay_payment_id, razorpay_signature);

    if (!isValid) {
      return NextResponse.json({ error: 'Invalid payment signature.' }, { status: 400 });
    }

    const paymentResult = await db.query.payments.findFirst({
      where: user.role === 'SUPER_ADMIN' 
        ? eq(payments.razorpayOrderId, razorpay_order_id)
        : and(
            eq(payments.razorpayOrderId, razorpay_order_id),
            eq(payments.tenantId, user.tenantId)
          ),
      with: { plan: true, addon: true },
    });
    
    const payment = paymentResult;

    if (!payment) {
      return NextResponse.json({ error: 'Payment record not found.' }, { status: 404 });
    }

    if (payment.status === 'captured') {
      return NextResponse.json({ success: true, message: 'Payment already verified.' });
    }


    const currentTenantResult = await db.select().from(tenants).where(eq(tenants.id, payment.tenantId)).limit(1);
    const currentTenant = currentTenantResult[0];

    await db.transaction(async (tx) => {
      await tx.update(payments)
        .set({
          razorpayPaymentId: razorpay_payment_id,
          razorpaySignature: razorpay_signature,
          status: 'captured',
        })
        .where(eq(payments.id, payment.id));

      if (payment.planId && payment.plan) {
        let amcNextDueDate = currentTenant.amcNextDueDate;
        let amcLastPaidAt = currentTenant.amcLastPaidAt;

        if (payment.plan.isLifetime) {
          amcLastPaidAt = new Date();
          amcNextDueDate = new Date();
          amcNextDueDate.setFullYear(amcNextDueDate.getFullYear() + 1);
        }

        /**
         * ── FULFILLING A COMBINED CHECKOUT ──────────────────────────────────
         *
         * One order can now buy a personal plan and a business plan together.
         * `plans_purchased` carries a line per plan; `plan_id` still carries the
         * primary line, and an order placed before this shipped (or by any
         * caller that sends no cart) has only that — hence the fallback, which
         * reproduces the old single-plan behaviour exactly.
         */
        const cart: PlanLineItem[] = Array.isArray(payment.plansPurchased)
            && payment.plansPurchased.length > 0
          ? (payment.plansPurchased as PlanLineItem[])
          : [{
            planId: payment.plan.id,
            // A pre-cart order bought whatever this payment says it applied to,
            // and a null there is the household's — the same reading
            // `paymentInAxis` gives it.
            appliesTo: (payment.appliesTo as any) || 'personal',
            billingCycle: payment.planBillingCycle,
          }];

        /**
         * Every plan named by the cart, in one query.
         *
         * `payment.plan` is only the primary line; a second line naming a
         * different plan would otherwise be applied with the FIRST plan's
         * credits and expiry.
         */
        const cartPlanIds = [...new Set(cart.map((line) => line.planId))];
        const cartPlans = await tx.select().from(subscriptionPlans)
          .where(inArray(subscriptionPlans.id, cartPlanIds));
        const planById = new Map(cartPlans.map((p) => [p.id, p]));

        /**
         * ⚠ THE DOUBLE-CREDIT GUARD.
         *
         * `expandCart` yields one entry PER AXIS, so a plan whose `appliesTo` is
         * 'both' appears twice — deliberately, because both axes must be
         * written. Its AI credits must still be granted ONCE. Keyed by plan id,
         * so buying two different plans in one order grants both.
         */
        const creditedPlans = new Set<string>();
        let totalPlanCredits = 0;
        const axisColumns: Record<string, unknown> = {};
        const appliedNames: string[] = [];
        const axesWritten: AccountAxis[] = [];
        let upgradeMonths: number | null = null;

        for (const line of expandCart(cart)) {
          const linePlan = planById.get(line.planId);
          if (!linePlan) continue;

          // Per-line, because a cart may mix a monthly personal plan with an
          // annual business one — and an UPGRADE line carries the date it must
          // end on (the term the tenant already holds), which wins over the
          // cycle so both halves of the account expire together.
          const lineExpiry = expiryForLine(line);
          if (line.billingCycle === UPGRADE_CYCLE) upgradeMonths = line.proratedMonths ?? null;

          Object.assign(axisColumns, planColumnsForAxis(line.axis, linePlan.id, lineExpiry));
          axesWritten.push(line.axis);

          if (!creditedPlans.has(linePlan.id)) {
            creditedPlans.add(linePlan.id);
            totalPlanCredits += linePlan.aiCredits ?? 0;
            appliedNames.push(linePlan.name);
          }
        }

        /**
         * A tenant holding a plan on an axis HAS that axis. A personal tenant
         * who just bought a combo is a Personal + Business account from this
         * update on — the tab, the switcher and company creation all key off
         * `account_type`, and leaving it would hide the half they paid for.
         * Only ever widens; only written when it changes.
         */
        const widened = widenAccountType(currentTenant.accountType, axesWritten);
        if (widened !== currentTenant.accountType) axisColumns.accountType = widened;

        // Credits are added in-database (not currentBalance + n) so a concurrent
        // grant cannot be lost. RETURNING gives the ledger the resulting balance
        // from the same statement, so the history cannot drift from the column.
        const [granted] = await tx.update(tenants)
          .set({
            ...axisColumns,
            ...(totalPlanCredits > 0
              ? { aiCreditsBalance: creditBalanceDelta(totalPlanCredits) }
              : {}),
            ...(payment.plan.isLifetime ? { amcLastPaidAt, amcNextDueDate } : {})
          })
          .where(eq(tenants.id, payment.tenantId))
          .returning({ aiCreditsBalance: tenants.aiCreditsBalance });

        await recordCreditMovement(tx as any, {
          tenantId: payment.tenantId,
          userId: user.id,
          amount: totalPlanCredits,
          balanceAfter: granted?.aiCreditsBalance ?? totalPlanCredits,
          reason: CREDIT_REASONS.plan_grant,
          // No companyId: a grant tops up the ONE shared wallet and belongs to
          // no single workspace.
          description: `Plan '${appliedNames.join(' + ')}' purchased — ${totalPlanCredits.toLocaleString()} AI credits granted.`,
        });

        await writeAudit({
          tenantId: payment.tenantId,
          userId: user.id,
          action: ACTIONS.payment.verify,
          details: auditSentence('verify', {
            kind: 'payment',
            name: razorpay_order_id,
            note: upgradeMonths !== null
              ? `₹${Number(payment.amount)} to upgrade to ${appliedNames.join(' + ')} for the remaining ${upgradeMonths} months`
              : `₹${Number(payment.amount)} for the ${appliedNames.join(' + ')} plan`,
          }),
          req,
          entityType: 'payments',
          entityId: payment.id,
        }, tx);
      } else if ((payment.addonsPurchased && Array.isArray(payment.addonsPurchased) && payment.addonsPurchased.length > 0) || (payment.addonId && payment.addon)) {
        let totalAddonCredits = 0;

        if (payment.addonsPurchased && Array.isArray(payment.addonsPurchased)) {
          for (const item of payment.addonsPurchased) {
            let expiresAt: Date | null = null;
            if (item.duration === 'MONTHLY') {
              expiresAt = new Date();
              expiresAt.setMonth(expiresAt.getMonth() + 1);
            } else if (item.duration === 'YEARLY') {
              expiresAt = new Date();
              expiresAt.setFullYear(expiresAt.getFullYear() + 1);
            }

            /**
             * ── GRANT WHAT WAS CHARGED FOR ────────────────────────────────
             * `addonsPurchased` was rewritten by create-order with the parsed
             * quantities, so this is the number the customer actually paid on.
             * It is parsed again anyway — a payment row can predate 0061 and
             * carry no quantity at all, which means one unit.
             *
             * The Razorpay webhook does exactly this. The two are the same
             * grant reached two ways, and a quantity honoured in one and not
             * the other is someone who paid for five seats and got one, with
             * a captured payment and a valid row to say everything went fine.
             */
            const quantity = parseAddonQuantity(item.quantity) ?? 1;

            await tx.insert(tenantAddons).values({
              tenantId: payment.tenantId,
              addonId: item.id,
              quantity,
              expiresAt,
              isActive: true,
            });

            const addonResult = await tx.select().from(addons).where(eq(addons.id, item.id)).limit(1);
            const addonObj = addonResult[0];
            if (addonObj?.aiCredits) {
              totalAddonCredits += addonObj.aiCredits * quantity;
            }
          }
        } else if (payment.addonId && payment.addon) {
          await tx.insert(tenantAddons).values({
            tenantId: payment.tenantId,
            addonId: payment.addonId,
          });
          if (payment.addon.aiCredits) {
            totalAddonCredits += payment.addon.aiCredits;
          }
        }

        if (totalAddonCredits > 0) {
          const [afterAddons] = await tx.update(tenants)
            .set({ aiCreditsBalance: creditBalanceDelta(totalAddonCredits) })
            .where(eq(tenants.id, payment.tenantId))
            .returning({ aiCreditsBalance: tenants.aiCreditsBalance });

          await recordCreditMovement(tx as any, {
            tenantId: payment.tenantId,
            userId: user.id,
            amount: totalAddonCredits,
            balanceAfter: afterAddons?.aiCreditsBalance ?? totalAddonCredits,
            reason: CREDIT_REASONS.addon_grant,
            description: `Add-ons purchased — ${totalAddonCredits.toLocaleString()} AI credits granted.`,
          });
        }

        await writeAudit({
          tenantId: payment.tenantId,
          userId: user.id,
          action: ACTIONS.payment.verify,
          details: auditSentence('verify', {
            kind: 'payment',
            name: razorpay_order_id,
            note: `₹${Number(payment.amount)} for add-ons, granting ${totalAddonCredits} AI credits`,
          }),
          req,
          entityType: 'payments',
          entityId: payment.id,
        }, tx);
      } else if (payment.paymentRef?.startsWith('invoice:')) {
        const invoiceId = payment.paymentRef.split(':')[1];
        
        // Update the invoice status
        await tx.update(invoices)
          .set({ status: 'paid', updatedAt: new Date() })
          .where(eq(invoices.id, invoiceId));

        // Check if invoice type was amc
        const invoiceRecord = await tx.query.invoices.findFirst({
          where: eq(invoices.id, invoiceId)
        });

        if (invoiceRecord?.invoiceType === 'amc') {
          // Increment amcNextDueDate by 1 year
          const nextDate = currentTenant.amcNextDueDate ? new Date(currentTenant.amcNextDueDate) : new Date();
          nextDate.setFullYear(nextDate.getFullYear() + 1);

          await tx.update(tenants)
            .set({ 
              amcLastPaidAt: new Date(),
              amcNextDueDate: nextDate,
              updatedAt: new Date()
            })
            .where(eq(tenants.id, payment.tenantId));

          await writeAudit({
            tenantId: payment.tenantId,
            userId: user.id,
            action: ACTIONS.payment.verify,
            details: auditSentence('verify', {
              kind: 'AMC payment',
              name: razorpay_order_id,
              note: `₹${Number(payment.amount)}, next due ${nextDate.toISOString().slice(0, 10)}`,
            }),
            req,
            entityType: 'payments',
          entityId: payment.id,
          }, tx);
        }
      }
    });

    // Generate Invoice
    try {
      const invoiceUrl = await generateAndUploadInvoice(payment.id);
      if (invoiceUrl) {
        await db.update(payments).set({ invoiceUrl }).where(eq(payments.id, payment.id));
      }
    } catch (invErr) {
      console.error('Invoice generation failed:', invErr);
    }

    return NextResponse.json({
      success: true,
      message: 'Payment verified and subscription activated.',
    });
  } catch (error) {
    return serverError(error, 'saving verify');
  }
}
