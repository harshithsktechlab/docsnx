import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { addons } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { getUserFromRequest } from '@/lib/auth';
import { writeAudit, ACTIONS, auditSentence } from '@/lib/audit';
import { serverError } from '@/lib/routeError';

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getUserFromRequest(req);
    if (!user || user.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Access denied. Super Admin only.' }, { status: 403 });
    }

    const { id } = await params;
    const [existingAddon] = await db.select().from(addons).where(eq(addons.id, id));

    if (!existingAddon) {
      return NextResponse.json({ error: 'Add-on not found.' }, { status: 404 });
    }

    const { name, description, price, priceYearly, priceOneTime, priceUsd, priceYearlyUsd, priceOneTimeUsd, billingCycle, aiCredits, extraMembers, extraMembersPerCompany, extraCompanies, storageLimitGB, isActive } = await req.json();

    const [updatedAddon] = await db.update(addons).set({
      name: name !== undefined ? name.trim() : undefined,
      description: description !== undefined ? description : undefined,
      price: price !== undefined ? (price !== null && price !== '' ? String(price) : null) : undefined,
      priceYearly: priceYearly !== undefined ? (priceYearly !== null && priceYearly !== '' ? String(priceYearly) : null) : undefined,
      priceOneTime: priceOneTime !== undefined ? (priceOneTime !== null && priceOneTime !== '' ? String(priceOneTime) : null) : undefined,
      priceUsd: priceUsd !== undefined ? (priceUsd !== null && priceUsd !== '' ? String(priceUsd) : null) : undefined,
      priceYearlyUsd: priceYearlyUsd !== undefined ? (priceYearlyUsd !== null && priceYearlyUsd !== '' ? String(priceYearlyUsd) : null) : undefined,
      priceOneTimeUsd: priceOneTimeUsd !== undefined ? (priceOneTimeUsd !== null && priceOneTimeUsd !== '' ? String(priceOneTimeUsd) : null) : undefined,
      billingCycle: billingCycle !== undefined ? billingCycle : undefined,
      aiCredits: aiCredits !== undefined ? Number(aiCredits) : undefined,
      extraMembers: extraMembers !== undefined ? Number(extraMembers) : undefined,
      // Since 0058: an add-on can sell a company or a seat inside one, not just
      // a personal seat. Both are read at the same grain as the plan columns —
      // `extraMembersPerCompany` raises the per-company allowance, not a
      // tenant-wide total.
      extraMembersPerCompany: extraMembersPerCompany !== undefined ? Number(extraMembersPerCompany) : undefined,
      extraCompanies: extraCompanies !== undefined ? Number(extraCompanies) : undefined,
      storageLimitGB: storageLimitGB !== undefined ? Number(storageLimitGB) : undefined,
      isActive: isActive !== undefined ? isActive : undefined,
    }).where(eq(addons.id, id)).returning();

    await writeAudit({
      tenantId: user.tenantId,
      userId: user.id,
      action: ACTIONS.addon.update,
      details: auditSentence('update', { kind: 'add-on', name: updatedAddon.name }),
      req,
      entityType: 'addons',
      entityId: updatedAddon?.id,
    });

    return NextResponse.json({ success: true, addon: updatedAddon });
  } catch (error) {
    return serverError(error, 'updating addon');
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getUserFromRequest(req);
    if (!user || user.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Access denied. Super Admin only.' }, { status: 403 });
    }

    const { id } = await params;
    const [existingAddon] = await db.select().from(addons).where(eq(addons.id, id));

    if (!existingAddon) {
      return NextResponse.json({ error: 'Add-on not found.' }, { status: 404 });
    }

    const [deactivatedAddon] = await db.update(addons)
      .set({ isActive: false })
      .where(eq(addons.id, id))
      .returning();

    await writeAudit({
      tenantId: user.tenantId,
      userId: user.id,
      action: ACTIONS.addon.deactivate,
      details: auditSentence('deactivate', { kind: 'add-on', name: deactivatedAddon.name }),
      req,
      entityType: 'addons',
      entityId: deactivatedAddon?.id,
    });

    return NextResponse.json({ success: true, message: 'Add-on deactivated successfully.' });
  } catch (error) {
    return serverError(error, 'deactivating addon');
  }
}
