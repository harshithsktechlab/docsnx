import { NextResponse } from 'next/server';
import { db } from '@/db';
import { payments } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { getUserFromRequest } from '@/lib/auth';
import { writeAudit, ACTIONS, auditSentence } from '@/lib/audit';
import { serverError } from '@/lib/routeError';

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getUserFromRequest(request);
    if (!user || user.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const { id: paymentId } = await params;
    if (!paymentId) {
      return NextResponse.json({ success: false, error: 'Payment ID required' }, { status: 400 });
    }

    const body = await request.json();
    const { amount, status, paymentRef } = body;

    // Verify payment exists
    const existingPayment = await db.query.payments.findFirst({
      where: eq(payments.id, paymentId)
    });

    if (!existingPayment) {
      return NextResponse.json({ success: false, error: 'Payment not found' }, { status: 404 });
    }

    // Only allow editing MANUAL payments
    if (existingPayment.paymentMethod !== 'MANUAL') {
      return NextResponse.json({ success: false, error: 'Cannot edit automated Razorpay payments' }, { status: 403 });
    }

    await db.transaction(async (tx) => {
      await tx.update(payments).set({
        amount: amount || existingPayment.amount,
        status: status || existingPayment.status,
        paymentRef: paymentRef !== undefined ? paymentRef : existingPayment.paymentRef,
        updatedAt: new Date()
      }).where(eq(payments.id, paymentId));

      await writeAudit({
        tenantId: existingPayment.tenantId,
        userId: user.id,
        action: ACTIONS.payment.edit_manual,
        // The before/after stated in words. This used to be a nested JSON
        // object, which the Details column rendered as one unreadable line.
        details: auditSentence('edit_manual', {
          kind: 'payment',
          name: existingPayment.paymentRef ?? paymentId,
          note: [
            amount !== undefined && `₹${existingPayment.amount} → ₹${amount}`,
            status && `${existingPayment.status} → ${status}`,
            paymentRef !== undefined && `reference ${existingPayment.paymentRef ?? 'none'} → ${paymentRef || 'none'}`,
          ].filter(Boolean).join(', ') || 'no fields changed',
        }),
        req: request,
        entityType: 'payments',
        entityId: paymentId,
      }, tx);
    });

    return NextResponse.json({ success: true, message: 'Payment updated successfully' });

  } catch (error: any) {
    return serverError(error, 'updating this payment');
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getUserFromRequest(request);
    if (!user || user.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const { id: paymentId } = await params;
    if (!paymentId) {
      return NextResponse.json({ success: false, error: 'Payment ID required' }, { status: 400 });
    }

    // Verify payment exists
    const existingPayment = await db.query.payments.findFirst({
      where: eq(payments.id, paymentId)
    });

    if (!existingPayment) {
      return NextResponse.json({ success: false, error: 'Payment not found' }, { status: 404 });
    }

    // Only allow deleting MANUAL payments
    if (existingPayment.paymentMethod !== 'MANUAL') {
      return NextResponse.json({ success: false, error: 'Cannot delete automated Razorpay payments' }, { status: 403 });
    }

    await db.transaction(async (tx) => {
      await tx.delete(payments).where(eq(payments.id, paymentId));

      await writeAudit({
        tenantId: existingPayment.tenantId,
        userId: user.id,
        action: ACTIONS.payment.delete_manual,
        details: auditSentence('delete_manual', {
          kind: 'payment',
          name: existingPayment.paymentRef ?? paymentId,
          note: `₹${existingPayment.amount}`,
        }),
        req: request,
        entityType: 'payments',
        entityId: paymentId,
      }, tx);
    });

    return NextResponse.json({ success: true, message: 'Payment deleted successfully' });

  } catch (error: any) {
    return serverError(error, 'deleting this payment');
  }
}
