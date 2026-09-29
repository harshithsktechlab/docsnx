import { NextResponse } from 'next/server';
import { getUserFromRequest } from '@/lib/auth';
import { generateInvoiceBuffer } from '@/lib/invoiceGenerator';
import { sendInvoiceEmail } from '@/lib/mailer';
import { db } from '@/db';
import { users } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { serverError } from '@/lib/routeError';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getUserFromRequest(req);
    if (!user || user.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }

    const { id } = await params;

    const invoiceData = await generateInvoiceBuffer(id);
    
    if (!invoiceData) {
      return NextResponse.json({ error: 'Failed to generate invoice' }, { status: 404 });
    }

    const { buffer, fileName } = invoiceData;

    return new NextResponse(buffer as unknown as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${fileName}"`,
      },
    });
  } catch (error) {
    return serverError(error, 'downloading invoice');
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getUserFromRequest(req);
    if (!user || user.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }

    const { id } = await params;

    const invoiceData = await generateInvoiceBuffer(id);
    
    if (!invoiceData) {
      return NextResponse.json({ error: 'Failed to generate invoice' }, { status: 404 });
    }

    const { buffer, fileName, tenant } = invoiceData;
    
    // Find the tenant admin's email
    const tenantAdmins = await db.select().from(users).where(and(eq(users.tenantId, tenant.id), eq(users.role, 'TENANT_ADMIN')));
    
    if (tenantAdmins.length === 0) {
      return NextResponse.json({ error: 'No tenant admin found to send email to' }, { status: 404 });
    }
    
    const adminUser = tenantAdmins[0];

    // `email` is nullable since 0040. A TENANT_ADMIN is required to have one, so
    // this is an inconsistent row rather than a normal state — but "send the
    // invoice to null" is not a better answer than saying who it could not
    // reach, and the existing 404 above already covers "nobody to send to".
    if (!adminUser.email) {
      return NextResponse.json({ error: 'The tenant admin has no email address on file to send the invoice to' }, { status: 404 });
    }

    const result = await sendInvoiceEmail(adminUser.email, adminUser.name || 'Admin', buffer, fileName);
    
    if (result.success) {
      return NextResponse.json({ success: true, message: 'Email sent successfully' });
    } else {
      return NextResponse.json({ error: result.error || result.message }, { status: 500 });
    }
  } catch (error) {
    return serverError(error, 'saving invoice');
  }
}
