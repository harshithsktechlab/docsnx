import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { tenants } from '@/db/schema';
import { getUserFromRequest } from '@/lib/auth';
import { eq } from 'drizzle-orm';
import { serverError } from '@/lib/routeError';

export async function GET(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user || user.role !== 'TENANT_ADMIN') {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }

    const tenantRecords = await db.select().from(tenants).where(eq(tenants.id, user.tenantId)).limit(1);
    const tenant = tenantRecords[0];

    if (!tenant) {
      return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
    }

    return NextResponse.json({
      billingName: tenant.billingName || '',
      billingGst: tenant.billingGst || '',
      billingAddress: tenant.billingAddress || '',
    });
  } catch (error) {
    return serverError(error, 'fetching tenant billing profile');
  }
}

export async function POST(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user || user.role !== 'TENANT_ADMIN') {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }

    const { billingName, billingGst, billingAddress } = await req.json();

    await db.update(tenants).set({
      billingName,
      billingGst,
      billingAddress
    }).where(eq(tenants.id, user.tenantId));

    return NextResponse.json({ success: true });
  } catch (error) {
    return serverError(error, 'updating tenant billing profile');
  }
}
