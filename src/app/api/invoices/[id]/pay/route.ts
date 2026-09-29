import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { invoices } from '@/db/schema';
import { getUserFromRequest } from '@/lib/auth';
import { createOrder, getPublicKeyId } from '@/lib/razorpay';
import { eq, and } from 'drizzle-orm';
import { serverError } from '@/lib/routeError';

export async function POST(req: Request, context: any) {
  try {
    const { params } = context;
    const { id } = params;

    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
    }

    const record = await db.query.invoices.findFirst({
      where: and(eq(invoices.id, id), eq(invoices.tenantId, user.tenantId))
    });

    if (!record) {
      return NextResponse.json({ error: 'Invoice not found.' }, { status: 404 });
    }

    if (record.status === 'paid') {
      return NextResponse.json({ error: 'Invoice is already paid.' }, { status: 400 });
    }

    const amountInPaise = Math.round(Number(record.amount) * 100);

    if (amountInPaise <= 0) {
      return NextResponse.json({ error: 'Invalid invoice amount.' }, { status: 400 });
    }

    const receipt = `inv_${record.invoiceNumber}_${Date.now()}`;
    const notes = {
      tenantId: user.tenantId,
      invoiceId: record.id,
      invoiceNumber: record.invoiceNumber,
      clientName: record.clientName,
    };

    const order = await createOrder(amountInPaise, record.currency, receipt, notes);

    await db.update(invoices).set({
      razorpayInvoiceId: order.id,
      updatedAt: new Date()
    }).where(eq(invoices.id, record.id));

    return NextResponse.json({
      success: true,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: getPublicKeyId(),
    });
  } catch (error) {
    return serverError(error, 'creating invoice order');
  }
}
