import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db, withTenant } from '@/lib/db';
import { payments } from '@/db/schema';
import { getUserFromRequest } from '@/lib/auth';
import { generateInvoiceBuffer } from '@/lib/invoiceGenerator';
import { serverError } from '@/lib/routeError';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Serves a paid payment's invoice PDF to the tenant that paid for it.
 *
 * The stored `invoiceUrl` points at the Azure container, which does not allow
 * public access, so the browser cannot open it. The PDF is built on demand
 * instead, after confirming the payment belongs to the caller's tenant.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
    }

    if (user.role !== 'SUPER_ADMIN' && !user.tenantId) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }

    const { id } = await params;
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: 'Invoice not found.' }, { status: 404 });
    }

    const [payment] = user.role === 'SUPER_ADMIN'
      ? await db.select({ id: payments.id, status: payments.status }).from(payments).where(eq(payments.id, id))
      : await withTenant(user.tenantId, (tx) =>
          tx.select({ id: payments.id, status: payments.status })
            .from(payments)
            .where(and(eq(payments.id, id), eq(payments.tenantId, user.tenantId))),
        );

    if (!payment || payment.status !== 'captured') {
      return NextResponse.json({ error: 'Invoice not found.' }, { status: 404 });
    }

    const invoice = await generateInvoiceBuffer(payment.id);
    if (!invoice) {
      return NextResponse.json({ error: 'Failed to generate invoice.' }, { status: 500 });
    }

    return new NextResponse(invoice.buffer as unknown as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${invoice.fileName}"`,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (error) {
    return serverError(error, 'serving invoice');
  }
}
