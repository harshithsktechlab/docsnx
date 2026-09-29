import { NextResponse } from 'next/server';
import { db } from '@/db';
import { discountCodes, discountUsages } from '@/db/schema';
import { getUserFromRequest } from '@/lib/auth';
import { eq, desc, count, countDistinct, sum, max } from 'drizzle-orm';
import { writeAudit, ACTIONS, auditSentence } from '@/lib/audit';

export async function GET(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user || user.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Access denied. Super Admin only.' }, { status: 403 });
    }

    // One `discount_usages` row is written per captured, discounted payment
    // (create-order's manual path and the Razorpay webhook), so these totals
    // are real redemptions, not checkout attempts. A deliberately cross-tenant
    // read, like every /api/admin route: it returns counts only, no tenant ids.
    const [discounts, usageRows] = await Promise.all([
      db.select().from(discountCodes).orderBy(desc(discountCodes.createdAt)),
      db.select({
        discountCodeId: discountUsages.discountCodeId,
        totalUses: count(),
        uniqueAccounts: countDistinct(discountUsages.tenantId),
        totalSaved: sum(discountUsages.amountSaved),
        lastUsedAt: max(discountUsages.usedAt),
      }).from(discountUsages).groupBy(discountUsages.discountCodeId),
    ]);

    const usageByCode = new Map(usageRows.map((row) => [row.discountCodeId, row]));
    const withUsage = discounts.map((discount) => {
      const row = usageByCode.get(discount.id);
      return {
        ...discount,
        usage: {
          totalUses: Number(row?.totalUses ?? 0),
          uniqueAccounts: Number(row?.uniqueAccounts ?? 0),
          // `sum()` over a decimal comes back from Postgres as a string.
          totalSaved: Number(row?.totalSaved ?? 0),
          lastUsedAt: row?.lastUsedAt ?? null,
        },
      };
    });

    return NextResponse.json({ success: true, discountCodes: withUsage });
  } catch (error: any) {
    console.error('Error fetching discount codes:', error);
    return NextResponse.json({ error: 'Failed to fetch discount codes' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user || user.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Access denied. Super Admin only.' }, { status: 403 });
    }

    const { 
      code, type, discountAmount, maxUses, maxUsesPerTenant, 
      expiresAt, planId, addonId, billingCycle, isActive 
    } = await req.json();

    if (!code || discountAmount === undefined || discountAmount === null) {
      return NextResponse.json({ error: 'code and discountAmount are required.' }, { status: 400 });
    }

    // Check uniqueness
    const existingCode = await db.select().from(discountCodes).where(eq(discountCodes.code, code.toUpperCase())).limit(1);
    if (existingCode.length > 0) {
      return NextResponse.json({ error: 'Discount code already exists.' }, { status: 400 });
    }

    const [newDiscountCode] = await db.insert(discountCodes).values({
      code: code.toUpperCase(),
      type: type || 'PERCENTAGE',
      discountPct: type === 'PERCENTAGE' ? Number(discountAmount) : 0,
      discountAmount: String(discountAmount),
      maxUses: maxUses ? Number(maxUses) : null,
      maxUsesPerTenant: maxUsesPerTenant ? Number(maxUsesPerTenant) : null,
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      planId: planId || null,
      addonId: addonId || null,
      billingCycle: billingCycle || null,
      isActive: isActive !== undefined ? isActive : true,
    }).returning();

    // Audit log
    await writeAudit({
      tenantId: user.tenantId, // Super admin's tenant
      userId: user.id,
      action: ACTIONS.discount_code.create,
      details: auditSentence('create', { kind: 'discount code', name: newDiscountCode.code }),
      entityType: 'discount_codes',
      entityId: newDiscountCode.id,
      req,
    });

    return NextResponse.json({ success: true, discountCode: newDiscountCode });
  } catch (error: any) {
    console.error('Error creating discount code:', error);
    return NextResponse.json({ error: 'Failed to create discount code' }, { status: 500 });
  }
}
