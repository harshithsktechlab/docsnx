import { NextResponse } from 'next/server';
import { db } from '@/db';
import { discountCodes } from '@/db/schema';
import { getUserFromRequest } from '@/lib/auth';
import { eq } from 'drizzle-orm';
import { writeAudit, ACTIONS, auditSentence } from '@/lib/audit';

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getUserFromRequest(req);
    if (!user || user.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Access denied. Super Admin only.' }, { status: 403 });
    }

    const { id } = await params;
    const { 
      code, type, discountAmount, maxUses, maxUsesPerTenant, 
      expiresAt, planId, addonId, billingCycle, isActive 
    } = await req.json();

    const [existingCode] = await db.select().from(discountCodes).where(eq(discountCodes.id, id));
    if (!existingCode) {
      return NextResponse.json({ error: 'Discount code not found.' }, { status: 404 });
    }

    // Check uniqueness if code is changed
    if (code && code.toUpperCase() !== existingCode.code) {
      const dupe = await db.select().from(discountCodes).where(eq(discountCodes.code, code.toUpperCase())).limit(1);
      if (dupe.length > 0) {
        return NextResponse.json({ error: 'Discount code already exists.' }, { status: 400 });
      }
    }

    const [updatedDiscount] = await db.update(discountCodes).set({
      code: code ? code.toUpperCase() : undefined,
      type: type !== undefined ? type : undefined,
      discountPct: type === 'PERCENTAGE' ? Number(discountAmount) : 0,
      discountAmount: discountAmount !== undefined ? String(discountAmount) : undefined,
      maxUses: maxUses !== undefined ? (maxUses ? Number(maxUses) : null) : undefined,
      maxUsesPerTenant: maxUsesPerTenant !== undefined ? (maxUsesPerTenant ? Number(maxUsesPerTenant) : null) : undefined,
      expiresAt: expiresAt !== undefined ? (expiresAt ? new Date(expiresAt) : null) : undefined,
      planId: planId !== undefined ? (planId || null) : undefined,
      addonId: addonId !== undefined ? (addonId || null) : undefined,
      billingCycle: billingCycle !== undefined ? (billingCycle || null) : undefined,
      isActive: isActive !== undefined ? isActive : undefined,
      updatedAt: new Date(),
    }).where(eq(discountCodes.id, id)).returning();

    // Audit log
    await writeAudit({
      tenantId: user.tenantId,
      userId: user.id,
      action: ACTIONS.discount_code.update,
      details: auditSentence('update', { kind: 'discount code', name: updatedDiscount.code }),
      req,
      entityType: 'discount_codes',
      entityId: updatedDiscount?.id,
    });

    return NextResponse.json({ success: true, discountCode: updatedDiscount });
  } catch (error: any) {
    console.error('Error updating discount code:', error);
    return NextResponse.json({ error: 'Failed to update discount code' }, { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getUserFromRequest(req);
    if (!user || user.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Access denied. Super Admin only.' }, { status: 403 });
    }

    const { id } = await params;

    const [existingCode] = await db.select().from(discountCodes).where(eq(discountCodes.id, id));
    if (!existingCode) {
      return NextResponse.json({ error: 'Discount code not found.' }, { status: 404 });
    }

    // We do a hard delete or we can just deactivate.
    // Given the previous plan logic, I will do a hard delete, but deactivation is also possible.
    // The previous plans deleted, I will delete it.
    await db.delete(discountCodes).where(eq(discountCodes.id, id));

    // Audit log
    await writeAudit({
      tenantId: user.tenantId,
      userId: user.id,
      action: ACTIONS.discount_code.delete,
      details: auditSentence('delete', { kind: 'discount code', name: existingCode.code }),
      req,
      entityType: 'discount_codes',
      entityId: id,
    });

    return NextResponse.json({ success: true });
  } catch (error: any) {
    console.error('Error deleting discount code:', error);
    return NextResponse.json({ error: 'Failed to delete discount code' }, { status: 500 });
  }
}
