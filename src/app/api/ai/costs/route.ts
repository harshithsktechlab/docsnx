import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { systemConfigs, tenants } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { getUserFromRequest } from '@/lib/auth';
import { requireActivePlan } from '@/lib/planGate';
import { serverError } from '@/lib/routeError';

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

    const multiplier = (tenantResult.maxMembers || 1) + (tenantResult.extraMembers || 0);

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
