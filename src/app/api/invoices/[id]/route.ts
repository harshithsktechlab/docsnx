import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { invoices } from '@/db/schema';
import { getUserFromRequest, hasPermission } from '@/lib/auth';
import { eq, and } from 'drizzle-orm';
import { serverError } from '@/lib/routeError';

export async function GET(req: Request, context: any) {
  try {
    const { params } = context;
    const { id } = params;

    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const allowed = await hasPermission(user, 'invoices', 'view');
    if (!allowed && user.role !== 'SUPER_ADMIN' && user.role !== 'TENANT_ADMIN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const record = await db.query.invoices.findFirst({
      where: and(eq(invoices.id, id), eq(invoices.tenantId, user.tenantId))
    });

    if (!record) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true, invoice: record });
  } catch (error) {
    return serverError(error, 'fetching invoice');
  }
}

export async function PUT(req: Request, context: any) {
  try {
    const { params } = context;
    const { id } = params;

    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const allowed = await hasPermission(user, 'invoices', 'edit');
    if (!allowed && user.role !== 'SUPER_ADMIN' && user.role !== 'TENANT_ADMIN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await req.json();
    const { 
      clientName, clientEmail, amount, 
      currency, dueDate, items, notes, status, paymentLink 
    } = body;

    const updateData: any = { updatedAt: new Date() };
    if (clientName) updateData.clientName = clientName;
    if (clientEmail !== undefined) updateData.clientEmail = clientEmail;
    if (amount !== undefined) updateData.amount = amount.toString();
    if (currency) updateData.currency = currency;
    if (dueDate) updateData.dueDate = new Date(dueDate);
    if (status) updateData.status = status;
    if (items) updateData.items = items;
    if (notes !== undefined) updateData.notes = notes;
    if (paymentLink !== undefined) updateData.paymentLink = paymentLink;

    const updatedInvoice = await db.update(invoices)
      .set(updateData)
      .where(and(eq(invoices.id, id), eq(invoices.tenantId, user.tenantId)))
      .returning();

    if (!updatedInvoice.length) {
      return NextResponse.json({ error: 'Invoice not found or could not be updated' }, { status: 404 });
    }

    return NextResponse.json({ success: true, invoice: updatedInvoice[0] });
  } catch (error) {
    return serverError(error, 'updating invoice');
  }
}

export async function DELETE(req: Request, context: any) {
  try {
    const { params } = context;
    const { id } = params;

    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const allowed = await hasPermission(user, 'invoices', 'delete');
    if (!allowed && user.role !== 'SUPER_ADMIN' && user.role !== 'TENANT_ADMIN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const deletedInvoice = await db.delete(invoices)
      .where(and(eq(invoices.id, id), eq(invoices.tenantId, user.tenantId)))
      .returning();

    if (!deletedInvoice.length) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true, deleted: true });
  } catch (error) {
    return serverError(error, 'deleting invoice');
  }
}
