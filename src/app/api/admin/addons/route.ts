import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { addons } from '@/db/schema';
import { eq, asc } from 'drizzle-orm';
import { getUserFromRequest } from '@/lib/auth';
import { writeAudit, ACTIONS, auditSentence } from '@/lib/audit';
import { serverError } from '@/lib/routeError';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const allAddons = await db.select().from(addons).orderBy(asc(addons.name));
    return NextResponse.json({ success: true, addons: allAddons });
  } catch (error) {
    return serverError(error, 'listing addons');
  }
}

export async function POST(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user || user.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Access denied. Super Admin only.' }, { status: 403 });
    }

    const { name, description, price, priceYearly, priceOneTime, priceUsd, priceYearlyUsd, priceOneTimeUsd, billingCycle, aiCredits, extraMembers, extraMembersPerCompany, extraCompanies, storageLimitGB, isActive } = await req.json();

    if (!name) {
      return NextResponse.json({ error: 'name is required.' }, { status: 400 });
    }

    const [addon] = await db.insert(addons).values({
      name: name.trim(),
      description: description || null,
      price: price !== undefined && price !== null && price !== '' ? String(price) : null,
      priceYearly: priceYearly !== undefined && priceYearly !== null && priceYearly !== '' ? String(priceYearly) : null,
      priceOneTime: priceOneTime !== undefined && priceOneTime !== null && priceOneTime !== '' ? String(priceOneTime) : null,
      priceUsd: priceUsd !== undefined && priceUsd !== null && priceUsd !== '' ? String(priceUsd) : null,
      priceYearlyUsd: priceYearlyUsd !== undefined && priceYearlyUsd !== null && priceYearlyUsd !== '' ? String(priceYearlyUsd) : null,
      priceOneTimeUsd: priceOneTimeUsd !== undefined && priceOneTimeUsd !== null && priceOneTimeUsd !== '' ? String(priceOneTimeUsd) : null,
      billingCycle: billingCycle || 'MONTHLY',
      aiCredits: aiCredits !== undefined ? Number(aiCredits) : 0,
      extraMembers: extraMembers !== undefined ? Number(extraMembers) : 0,
      // Since 0058: an add-on can sell a company or a seat inside one, not just
      // a personal seat. Both are read at the same grain as the plan columns —
      // `extraMembersPerCompany` raises the per-company allowance, not a
      // tenant-wide total.
      extraMembersPerCompany: extraMembersPerCompany !== undefined ? Number(extraMembersPerCompany) : 0,
      extraCompanies: extraCompanies !== undefined ? Number(extraCompanies) : 0,
      storageLimitGB: storageLimitGB !== undefined ? Number(storageLimitGB) : 0,
      isActive: isActive !== undefined ? isActive : true,
    }).returning();

    await writeAudit({
      tenantId: user.tenantId,
      userId: user.id,
      action: ACTIONS.addon.create,
      details: auditSentence('create', { kind: 'add-on', name: addon.name }),
      req,
      entityType: 'addons',
      entityId: addon?.id,
    });

    return NextResponse.json({ success: true, addon }, { status: 201 });
  } catch (error) {
    return serverError(error, 'creating addon');
  }
}
