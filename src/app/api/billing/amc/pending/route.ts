import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getUserFromRequest } from '@/lib/auth';

export async function GET(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    // Find the pending AMC invoice
    const pendingInvoice = await db.query.invoices.findFirst({
      where: (inv, { eq, and }) => and(
        eq(inv.tenantId, user.tenantId),
        eq(inv.invoiceType, 'amc'),
        eq(inv.status, 'pending')
      ),
      orderBy: (inv, { desc }) => [desc(inv.createdAt)]
    });

    if (!pendingInvoice) {
      return NextResponse.json({ success: false, error: 'No pending AMC invoice found' });
    }

    return NextResponse.json({ success: true, invoice: pendingInvoice });
  } catch (error) {
    console.error('Fetch AMC pending error:', error);
    return NextResponse.json({ success: false, error: 'Failed to fetch invoice' }, { status: 500 });
  }
}
