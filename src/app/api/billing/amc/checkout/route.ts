import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { eq, and } from 'drizzle-orm';
import { getUserFromRequest } from '@/lib/auth';
import Razorpay from 'razorpay';
import { payments, invoices } from '@/db/schema';

export async function POST(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const { invoiceId } = await req.json();
    if (!invoiceId) {
      return NextResponse.json({ success: false, error: 'Invoice ID required' }, { status: 400 });
    }

    const invoice = await db.query.invoices.findFirst({
      where: (inv, { eq, and }) => and(
        eq(inv.id, invoiceId),
        eq(inv.tenantId, user.tenantId),
        eq(inv.status, 'pending')
      )
    });

    if (!invoice) {
      return NextResponse.json({ success: false, error: 'Invoice not found or already paid' }, { status: 404 });
    }

    // Initialize Razorpay
    const razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID || '',
      key_secret: process.env.RAZORPAY_KEY_SECRET || ''
    });

    const amountInPaise = Math.round(Number(invoice.amount) * 100);

    // Create Razorpay order
    const orderOptions = {
      amount: amountInPaise,
      currency: invoice.currency || 'INR',
      receipt: invoice.invoiceNumber,
    };

    const order = await razorpay.orders.create(orderOptions);

    // Record the payment intent in db
    const [paymentRecord] = await db.insert(payments).values({
      tenantId: user.tenantId,
      amount: invoice.amount.toString(),
      currency: invoice.currency || 'INR',
      razorpayOrderId: order.id,
      paymentMethod: 'RAZORPAY',
      status: 'created',
      // `email` is nullable since 0040 and this column is NOT NULL. An admin
      // should always have an address, but the audit trail must not be able to
      // take a null from a row that does not — the id still says who acted.
      initiatedBy: user.email ?? user.id,
      // Store invoiceId in paymentRef or notes, since payments doesn't directly link to invoice
      paymentRef: `invoice:${invoice.id}`
    }).returning();

    // Also update invoice with Razorpay invoice id if needed, but orderId is tracked via payment
    
    return NextResponse.json({
      success: true,
      keyId: process.env.RAZORPAY_KEY_ID,
      amount: amountInPaise,
      currency: orderOptions.currency,
      orderId: order.id,
      paymentId: paymentRecord.id
    });
  } catch (error) {
    console.error('AMC checkout error:', error);
    return NextResponse.json({ success: false, error: 'Failed to initiate checkout' }, { status: 500 });
  }
}
