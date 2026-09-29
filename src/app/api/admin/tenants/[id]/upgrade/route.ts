import { NextResponse } from 'next/server';
import { db } from '@/db';
import { tenants, subscriptionPlans } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { getUserFromRequest } from '@/lib/auth';
import { applyPlanToTenant, planExpiry } from '@/lib/planProvisioning';
import { serverError } from '@/lib/routeError';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getUserFromRequest(request);
    if (!user || user.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ success: false, error: 'Access denied. Super Admin only.' }, { status: 403 });
    }

    const { id: tenantId } = await params;
    if (!tenantId) {
      return NextResponse.json({ success: false, error: 'Tenant ID required' }, { status: 400 });
    }

    const body = await request.json();
    const { planId, reason } = body;

    if (!planId || !reason) {
      return NextResponse.json({ success: false, error: 'Plan ID and override reason are required' }, { status: 400 });
    }

    // Verify tenant exists
    const existingTenant = await db.query.tenants.findFirst({
      where: eq(tenants.id, tenantId)
    });

    if (!existingTenant) {
      return NextResponse.json({ success: false, error: 'Tenant not found' }, { status: 404 });
    }

    // Verify plan exists by UUID
    const plan = await db.query.subscriptionPlans.findFirst({
      where: eq(subscriptionPlans.id, planId)
    });

    if (!plan) {
      return NextResponse.json({ success: false, error: 'Invalid subscription plan' }, { status: 400 });
    }

    // Extend an unexpired term rather than resetting it to today.
    const newExpiry = planExpiry(plan, existingTenant.subscriptionExpiry);

    // Perform update — applies the plan, the expiry, and the plan's AI credits.
    const { creditsGranted } = await db.transaction(async (tx) => {
      return applyPlanToTenant(tx as any, {
        tenantId,
        plan,
        expiry: newExpiry,
        userId: user.id,
        action: 'tenant.manual_upgrade',
        reason: `${reason} (previous plan: ${existingTenant.subscriptionPlanId || 'none'})`,
      });
    });

    return NextResponse.json({
      success: true,
      creditsGranted,
      message: 'Tenant plan manually upgraded successfully'
    });

  } catch (error: any) {
    return serverError(error, 'upgrading this tenant');
  }
}
