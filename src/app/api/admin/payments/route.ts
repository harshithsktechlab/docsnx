import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { payments, tenants, subscriptionPlans, addons, tenantAddons } from '@/db/schema';
import { getUserFromRequest } from '@/lib/auth';
import { eq, desc, sql } from 'drizzle-orm';
import { applyPlanToTenant, adjustTenantCredits, planExpiry } from '@/lib/planProvisioning';
import { ACTIONS, auditSentence } from '@/lib/audit';
import { CREDIT_REASONS } from '@/lib/creditLedger';
import { serverError } from '@/lib/routeError';

export async function GET(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user || user.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }

    const allPayments = await db.select({
      id: payments.id,
      amount: payments.amount,
      currency: payments.currency,
      status: payments.status,
      razorpayOrderId: payments.razorpayOrderId,
      createdAt: payments.createdAt,
      initiatedBy: payments.initiatedBy,
      invoiceUrl: payments.invoiceUrl,
      paymentMethod: payments.paymentMethod,
      paymentRef: payments.paymentRef,
      tenantName: tenants.name,
      planName: subscriptionPlans.name,
      addonName: addons.name
    })
    .from(payments)
    .leftJoin(tenants, eq(payments.tenantId, tenants.id))
    .leftJoin(subscriptionPlans, eq(payments.planId, subscriptionPlans.id))
    .leftJoin(addons, eq(payments.addonId, addons.id))
    .orderBy(desc(payments.createdAt));

    return NextResponse.json({ payments: allPayments });
  } catch (error) {
    return serverError(error, 'fetching payments');
  }
}

export async function POST(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user || user.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }

    const body = await req.json();
    const { tenantId, planId, addonId, amount, currency, paymentRef } = body;

    if (!tenantId || !amount) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const newPayment = await db.insert(payments).values({
      tenantId,
      // `payments.initiated_by` is NOT NULL and this is an audit trail, so it
      // falls back to the user id rather than dropping who did it. `email` is
      // nullable since 0040; an admin should always have one, but the column
      // must not be able to take a null from a row that does not.
      planId: planId || null,
      addonId: addonId || null,
      amount,
      currency: currency || 'INR',
      status: 'captured',
      paymentMethod: 'MANUAL',
      paymentRef: paymentRef || null,
      // `email` is nullable since 0040 and this column is NOT NULL. An admin
      // should always have an address, but the audit trail must not be able to
      // take a null from a row that does not — the id still says who acted.
      initiatedBy: user.email ?? user.id,
    }).returning();

    // Both branches below go through the planProvisioning helpers rather than
    // updating `tenants` directly. That is what writes the audit row and the
    // credit-ledger row a manually recorded payment was previously missing —
    // the balance moved with nothing anywhere to explain why.
    if (planId) {
      const plan = await db.query.subscriptionPlans.findFirst({
        where: (p, { eq }) => eq(p.id, planId)
      });
      if (plan) {
        // Preserve this route's historical fallback: a plan with no
        // durationDays gets a year here, where planExpiry() alone would treat
        // it as lifetime.
        const expiry = planExpiry(plan) ?? (() => {
          const fallback = new Date();
          fallback.setDate(fallback.getDate() + 365);
          return plan.isLifetime ? null : fallback;
        })();

        await applyPlanToTenant(db, {
          tenantId,
          plan,
          expiry,
          userId: user.id,
          action: ACTIONS.payment.edit_manual,
          reason: `Manual payment recorded by ${user.email}. Ref: ${paymentRef || 'n/a'}`,
          extraTenantValues: { isActive: true },
        });
      }
    } else if (addonId) {
      const addon = await db.query.addons.findFirst({
        where: (a, { eq }) => eq(a.id, addonId)
      });
      if (addon) {
        let addonExpiry = new Date();
        if (addon.billingCycle === 'YEARLY') {
          addonExpiry.setFullYear(addonExpiry.getFullYear() + 1);
        } else {
          addonExpiry.setMonth(addonExpiry.getMonth() + 1);
        }
        await db.insert(tenantAddons).values({
          tenantId,
          addonId,
          expiresAt: addonExpiry,
          isActive: true
        });

        if (addon.aiCredits > 0) {
          await adjustTenantCredits(db, {
            tenantId,
            amount: addon.aiCredits,
            userId: user.id,
            action: ACTIONS.addon.grant,
            details: auditSentence('grant', {
              kind: 'AI credits',
              note: `${addon.aiCredits} from the ${addon.name} add-on on a manually recorded payment`,
            }),
            reason: CREDIT_REASONS.addon_grant,
            ledgerDescription: `Add-on '${addon.name}' — ${addon.aiCredits.toLocaleString()} AI credits granted.`,
          });
        }
      }
    }

    return NextResponse.json({ success: true, payment: newPayment[0] });
  } catch (error) {
    return serverError(error, 'saving payments');
  }
}
