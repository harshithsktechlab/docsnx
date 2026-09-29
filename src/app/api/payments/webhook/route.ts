import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { payments } from '@/db/schema';
import { verifyWebhookSignature } from '@/lib/razorpay';
import { applyPlanToTenant } from '@/lib/planProvisioning';
import { eq } from 'drizzle-orm';
import { writeAudit, ACTIONS, auditSentence } from '@/lib/audit';

export async function POST(req: Request) {
  try {
    const rawBody = await req.text();
    const signature = req.headers.get('x-razorpay-signature');

    if (!signature) {
      return NextResponse.json({ error: 'Missing signature header.' }, { status: 400 });
    }

    const isValid = verifyWebhookSignature(rawBody, signature);

    if (!isValid) {
      console.error('Webhook signature verification failed.');
      return NextResponse.json({ error: 'Invalid webhook signature.' }, { status: 400 });
    }

    const payload = JSON.parse(rawBody);
    const event = payload.event;

    if (event === 'payment.captured') {
      await handlePaymentCaptured(payload);
    } else if (event === 'payment.failed') {
      await handlePaymentFailed(payload);
    }

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    console.error('Webhook processing error:', error);
    return NextResponse.json({ success: true }, { status: 200 });
  }
}

async function handlePaymentCaptured(payload: any) {
  const razorpayOrderId = payload.payload?.payment?.entity?.order_id;

  if (!razorpayOrderId) {
    console.error('Webhook: Missing order_id in payment.captured payload.');
    return;
  }

  const payment = await db.query.payments.findFirst({
    where: eq(payments.razorpayOrderId, razorpayOrderId),
    with: { plan: true },
  });

  if (!payment) {
    console.error(`Webhook: Payment not found for order ${razorpayOrderId}.`);
    return;
  }

  if (payment.status === 'captured') {
    return;
  }

  const paymentEntity = payload.payload?.payment?.entity;

  await db.transaction(async (tx) => {
    await tx.update(payments)
      .set({
        razorpayPaymentId: paymentEntity?.id || null,
        status: 'captured',
      })
      .where(eq(payments.id, payment.id));

    if (payment.plan) {
      // Applies the plan, the expiry, and the plan's AI credits together —
      // previously this granted the plan but left the tenant on zero credits.
      await applyPlanToTenant(tx as any, {
        tenantId: payment.tenantId,
        plan: payment.plan,
        action: ACTIONS.payment.capture_webhook,
        reason: `Webhook: order ${razorpayOrderId}, amount ₹${Number(payment.amount)}`,
      });
    } else {
      await writeAudit({
        tenantId: payment.tenantId,
        action: ACTIONS.payment.capture_webhook,
        // No `req`: this is a Razorpay server-to-server callback, so the client
        // IP would be Razorpay's edge, not an acting user's.
        details: auditSentence('capture_webhook', {
          kind: 'payment',
          name: razorpayOrderId,
          note: `₹${Number(payment.amount)}, with no plan attached`,
        }),
        entityType: 'payments',
        entityId: payment.id,
      }, tx);
    }
  });
}

async function handlePaymentFailed(payload: any) {
  const razorpayOrderId = payload.payload?.payment?.entity?.order_id;

  if (!razorpayOrderId) {
    console.error('Webhook: Missing order_id in payment.failed payload.');
    return;
  }

  const paymentResult = await db.select().from(payments).where(eq(payments.razorpayOrderId, razorpayOrderId)).limit(1);
  const payment = paymentResult[0];

  if (!payment) {
    console.error(`Webhook: Payment not found for order ${razorpayOrderId}.`);
    return;
  }

  if (payment.status === 'captured' || payment.status === 'failed') {
    return;
  }

  // Status change and its audit row commit together, matching
  // handlePaymentCaptured above — a failed payment must never be recorded
  // without its trail, or vice versa.
  await db.transaction(async (tx) => {
    await tx.update(payments)
      .set({ status: 'failed' })
      .where(eq(payments.id, payment.id));

    await writeAudit({
      tenantId: payment.tenantId,
      action: ACTIONS.payment.fail_webhook,
      // No `req`: server-to-server callback, see handlePaymentCaptured above.
      details: auditSentence('fail_webhook', {
        kind: 'payment',
        name: razorpayOrderId,
        note: `₹${Number(payment.amount)}`,
      }),
      entityType: 'payments',
      entityId: payment.id,
    }, tx);
  });
}
