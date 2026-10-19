import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { systemConfigs, tenants } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { getUserFromRequest } from '@/lib/auth';
import { requireActivePlan } from '@/lib/planGate';
import { serverError } from '@/lib/routeError';
import { aiCreditMultiplier } from '@/lib/account/seatCounts';

export async function GET(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const gate = requireActivePlan(user);
    if (gate) return gate;

    if (!user.tenantId) {
      return NextResponse.json({ error: 'Tenant context missing' }, { status: 400 });
    }

    const tenantResult = await db.query.tenants.findFirst({
      where: eq(tenants.id, user.tenantId)
    });

    if (!tenantResult) {
       return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
    }

    const configRes = await db.query.systemConfigs.findFirst();
    
    // Default base costs if config missing
    const baseRecordAnalysis = parseFloat(configRes?.aiCostRecordAnalysis as string) || 1.00;
    const baseCategoryAnalysis = parseFloat(configRes?.aiCostCategoryAnalysis as string) || 2.00;
    const basePortfolioAnalysis = parseFloat(configRes?.aiCostPortfolioAnalysis as string) || 5.00;
    const baseBulkScan = parseFloat(configRes?.aiCostBulkScan as string) || 10.00;

    // The same multiplier executeTenantWithRotation charges with, so the price
    // shown on /billing/credits is the price deducted. Household seats unless
    // the request names a company (?companyId=).
    const companyParam = new URL(req.url).searchParams.get('companyId');
    const multiplier = await aiCreditMultiplier(user.tenantId, companyParam || null);

    return NextResponse.json({
      success: true,
      costs: {
        recordAnalysis: baseRecordAnalysis * multiplier,
        categoryAnalysis: baseCategoryAnalysis * multiplier,
        portfolioAnalysis: basePortfolioAnalysis * multiplier,
        bulkScan: baseBulkScan * multiplier,
      },
      baseCosts: {
        recordAnalysis: baseRecordAnalysis,
        categoryAnalysis: baseCategoryAnalysis,
        portfolioAnalysis: basePortfolioAnalysis,
        bulkScan: baseBulkScan,
      },
      multiplier,
      creditsBalance: tenantResult.aiCreditsBalance
    });
  } catch (error: any) {
    return serverError(error, 'loading costs');
  }
}
