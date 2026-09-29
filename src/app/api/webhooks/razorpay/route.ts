import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { payments, tenantAddons, discountUsages } from '@/db/schema';
import { verifyWebhookSignature } from '@/lib/razorpay';
import { adjustTenantCredits, applyPlanToTenant } from '@/lib/planProvisioning';
import { CREDIT_REASONS } from '@/lib/creditLedger';
import { and, eq, ne } from 'drizzle-orm';
import { ACTIONS, auditSentence } from '@/lib/audit';
import { expiryForLine, type PlanLineItem } from '@/lib/billingAxis';
import { parseAddonQuantity } from '@/lib/addonQuantity';

export async function POST(req: Request) {
  try {
    const rawBody = await req.text();
    const signature = req.headers.get('x-razorpay-signature');

    if (!signature || !verifyWebhookSignature(rawBody, signature)) {
      return NextResponse.json({ error: 'Invalid or missing signature' }, { status: 400 });
    }

    const event = JSON.parse(rawBody);

    if (event.event === 'payment.captured') {
      const paymentData = event.payload.payment.entity;
      const orderId = paymentData.order_id;
      const notes = paymentData.notes;

      if (!notes || !notes.tenantId) {
         return NextResponse.json({ error: 'No tenantId in notes' }, { status: 400 });
      }

      // Razorpay retries webhooks. Only transition a payment that is not already
      // captured, so a redelivery returns zero rows and cannot grant credits twice.
      const paymentRet = await db.update(payments)
        .set({
           status: 'captured',
           razorpayPaymentId: paymentData.id,
           razorpaySignature: signature
        })
        .where(and(eq(payments.razorpayOrderId, orderId), ne(payments.status, 'captured')))
        .returning();

      if (notes.discountCodeId && paymentRet.length > 0) {
         await db.insert(discountUsages).values({
            discountCodeId: notes.discountCodeId,
            tenantId: notes.tenantId,
            paymentId: paymentRet[0].id,
            amountSaved: notes.amountSaved || '0'
         });
      }

      if (paymentRet.length > 0) {
        const payment = paymentRet[0];
        
        if (payment.planId) {
           /**
            * The primary line's expiry, the way `verify` derives it: from the
            * cart the order stored, falling back to the order notes for an
            * order placed before carts existed. An UPGRADE line carries an
            * anchored `expiresAt` — the term the tenant already holds — and
            * the old inline maths here would have given it one month.
            */
           const cart = Array.isArray(payment.plansPurchased) ? payment.plansPurchased as PlanLineItem[] : [];
           const primaryLine = cart.find((line) => line.planId === payment.planId)
             ?? { billingCycle: notes.planBillingCycle, expiresAt: notes.expiresAt || null };
           const expiry = expiryForLine(primaryLine);

           const plan = await db.query.subscriptionPlans.findFirst({
             where: (p, { eq: equals }) => equals(p.id, payment.planId!),
           });

           if (plan) {
             await applyPlanToTenant(db, {
               tenantId: payment.tenantId,
               plan,
               expiry,
               action: ACTIONS.payment.capture_webhook,
               reason: `Razorpay order ${orderId}`,
               extraTenantValues: { isActive: true },
             });
           }
        }

        if (payment.addonsPurchased && Array.isArray(payment.addonsPurchased) && payment.addonsPurchased.length > 0) {
           let addonCredits = 0;

           for (const item of payment.addonsPurchased) {
             let expiresAt = null;
             if (item.duration === 'MONTHLY') {
               expiresAt = new Date();
               expiresAt.setMonth(expiresAt.getMonth() + 1);
             } else if (item.duration === 'YEARLY') {
               expiresAt = new Date();
               expiresAt.setFullYear(expiresAt.getFullYear() + 1);
             }

             // The quantity the order was priced on. MUST match POST
             // /api/payments/verify line for line — this webhook is the same
             // grant reached the other way, and it is the path that runs when
             // the customer closes the tab before verify fires.
             const quantity = parseAddonQuantity(item.quantity) ?? 1;

             await db.insert(tenantAddons).values({
               tenantId: payment.tenantId,
               addonId: item.id,
               quantity,
               expiresAt,
               isActive: true
             });

             const addon = await db.query.addons.findFirst({
               where: (a, { eq: equals }) => equals(a.id, item.id),
             });
             addonCredits += (addon?.aiCredits || 0) * quantity;
           }

           if (addonCredits > 0) {
             await adjustTenantCredits(db, {
               tenantId: payment.tenantId,
               amount: addonCredits,
               action: ACTIONS.credits.addon_granted_webhook,
               details: auditSentence('addon_granted_webhook', {
                 kind: 'AI credits',
                 note: `${addonCredits} from add-ons on order ${orderId}`,
               }),
               reason: CREDIT_REASONS.addon_grant,
               ledgerDescription: `Add-ons purchased — ${addonCredits.toLocaleString()} AI credits granted.`,
             });
           }
        }
      }
    }

    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error('Webhook error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
