import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { invoices } from '@/db/schema';
import { getUserFromRequest, hasPermission } from '@/lib/auth';
import { eq, and } from 'drizzle-orm';
import { serverError } from '@/lib/routeError';

export async function GET(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const allowed = await hasPermission(user, 'invoices', 'view');
    if (!allowed && user.role !== 'SUPER_ADMIN' && user.role !== 'TENANT_ADMIN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const status = searchParams.get('status');
    const tenantId = searchParams.get('tenantId');

    let conditions = user.role === 'SUPER_ADMIN' ? undefined : eq(invoices.tenantId, user.tenantId);
    
    if (user.role === 'SUPER_ADMIN' && tenantId) {
      conditions = conditions ? and(conditions, eq(invoices.tenantId, tenantId)) : eq(invoices.tenantId, tenantId);
    }

    if (status) {
      conditions = conditions ? and(conditions, eq(invoices.status, status)) as any : eq(invoices.status, status);
    }

    const records = await db.query.invoices.findMany({
      where: conditions,
      orderBy: (table, { desc }) => [desc(table.createdAt)]
    });

    return NextResponse.json({ success: true, invoices: records });
  } catch (error) {
    return serverError(error, 'fetching invoices');
  }
}

export async function POST(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const allowed = await hasPermission(user, 'invoices', 'add');
    if (!allowed && user.role !== 'SUPER_ADMIN' && user.role !== 'TENANT_ADMIN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    
    if (user.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Only Super Admin can create invoices' }, { status: 403 });
    }

    const body = await req.json();
    const { 
      tenantId,
      invoiceNumber, clientName, clientEmail, amount, 
      currency, gstType, clientGstin, clientAddress, clientStateCode, clientPhone,
      dueDate, items, notes, status, paymentLink 
    } = body;

    if (!invoiceNumber || !clientName || amount === undefined || !dueDate || !tenantId) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    let parsedAmount = parseFloat(amount);
    let calcBaseAmount = parsedAmount;
    let calcGstAmount = 0;

    if (gstType === 'CGST_SGST' || gstType === 'IGST') {
      calcBaseAmount = parsedAmount / 1.18;
      calcGstAmount = parsedAmount - calcBaseAmount;
    }

    const newInvoice = await db.insert(invoices).values({
      tenantId: tenantId,
      invoiceNumber,
      clientName,
      clientEmail,
      clientGstin,
      clientAddress,
      clientStateCode,
      clientPhone,
      amount: parsedAmount.toFixed(2),
      baseAmount: calcBaseAmount.toFixed(2),
      gstAmount: calcGstAmount.toFixed(2),
      gstType: gstType || 'EXEMPT',
      currency: currency || 'INR',
      dueDate: new Date(dueDate),
      status: status || 'pending',
      items: items || [],
      notes,
      paymentLink
    }).returning();

    return NextResponse.json({ success: true, invoice: newInvoice[0] });
  } catch (error) {
    return serverError(error, 'creating invoice');
  }
}
