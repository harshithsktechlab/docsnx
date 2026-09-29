import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { tenantAddons, addons, tenants } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { getUserFromRequest } from '@/lib/auth';
import { writeAudit, ACTIONS, auditSentence } from '@/lib/audit';
import { serverError } from '@/lib/routeError';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getUserFromRequest(req);
    if (!user || user.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Access denied. Super Admin only.' }, { status: 403 });
    }

    const { id: tenantId } = await params;

    const tenantAddonsList = await db.select({
      id: tenantAddons.id,
      tenantId: tenantAddons.tenantId,
      addonId: tenantAddons.addonId,
      isActive: tenantAddons.isActive,
      purchasedAt: tenantAddons.purchasedAt,
      expiresAt: tenantAddons.expiresAt,
      addon: {
        name: addons.name,
        price: addons.price,
        billingCycle: addons.billingCycle,
        aiCredits: addons.aiCredits,
        extraMembers: addons.extraMembers,
      }
    })
    .from(tenantAddons)
    .innerJoin(addons, eq(tenantAddons.addonId, addons.id))
    .where(eq(tenantAddons.tenantId, tenantId));

    return NextResponse.json({ success: true, tenantAddons: tenantAddonsList });
  } catch (error) {
    return serverError(error, 'listing tenant addons');
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getUserFromRequest(req);
    if (!user || user.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Access denied. Super Admin only.' }, { status: 403 });
    }

    const { id: tenantId } = await params;
    const { addonId, expiresAt } = await req.json();

    if (!addonId) {
      return NextResponse.json({ error: 'addonId is required.' }, { status: 400 });
    }

    const [addon] = await db.select().from(addons).where(eq(addons.id, addonId));
    if (!addon) {
      return NextResponse.json({ error: 'Add-on not found.' }, { status: 404 });
    }

    // Read for the audit line only: this row is written under the SUPER_ADMIN's
    // own tenant, so without the name it says nothing about who was granted it.
    const [recipient] = await db.select({ name: tenants.name })
      .from(tenants).where(eq(tenants.id, tenantId));

    const [grantedAddon] = await db.insert(tenantAddons).values({
      tenantId,
      addonId,
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      isActive: true,
    }).returning();

    await writeAudit({
      tenantId: user.tenantId,
      userId: user.id,
      action: ACTIONS.addon.grant,
      details: auditSentence('grant', {
        kind: 'add-on',
        name: addon.name,
        member: recipient?.name ?? null,
      }),
      req,
      entityType: 'tenant_addons',
      entityId: grantedAddon?.id,
    });

    return NextResponse.json({ success: true, tenantAddon: grantedAddon }, { status: 201 });
  } catch (error) {
    return serverError(error, 'granting addon');
  }
}
