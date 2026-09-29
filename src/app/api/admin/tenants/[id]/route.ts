import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { tenants } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { getUserFromRequest } from '@/lib/auth';
import { encryptField } from '@/lib/fieldCrypto';
import { writeAudit, ACTIONS, auditSentence } from '@/lib/audit';
import { serverError } from '@/lib/routeError';

/** Trims, and turns an emptied-out field into a NULL rather than an empty string. */
function optionalText(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

// PUT — Update tenant settings and details (Super Admin only)
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getUserFromRequest(req);
    if (!user || user.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Access denied. Super Admin only.' }, { status: 403 });
    }

    const { id } = await params;
    const {
      name, apiKey, clearApiKey, aiProvider, aiModel, subscriptionPlanId,
      subscriptionExpiry, isActive,
      billingName, billingGst, billingAddress, billingEmail, billingPhone, contactName,
    } = await req.json();

    if (!name) {
      return NextResponse.json({ error: 'Name is required.' }, { status: 400 });
    }

    const existing = await db.query.tenants.findFirst({
      where: eq(tenants.id, id),
      columns: { id: true, name: true },
    });
    if (!existing) {
      return NextResponse.json({ error: 'Tenant not found.' }, { status: 404 });
    }

    const expiryDate = subscriptionExpiry ? new Date(subscriptionExpiry) : null;

    /**
     * Three states, not two. The listing no longer ships the stored key — it
     * held the CIPHERTEXT, and the form pushed it straight back here to be
     * encrypted a second time, so any edit that left the field alone corrupted
     * the key. An absent `apiKey` now means "leave it"; only an explicit
     * `clearApiKey` removes one.
     */
    const apiKeyValue = clearApiKey === true
      ? null
      : (typeof apiKey === 'string' && apiKey.trim() ? encryptField(apiKey.trim()) : undefined);

    const [updatedTenant] = await db.update(tenants).set({
      name: name.trim(),
      apiKey: apiKeyValue,
      aiProvider: aiProvider || undefined,
      aiModel: aiModel || undefined,
      subscriptionPlanId: subscriptionPlanId || undefined,
      subscriptionExpiry: subscriptionExpiry !== undefined ? expiryDate : undefined,
      isActive: isActive !== undefined ? isActive : undefined,
      billingName: optionalText(billingName),
      billingGst: optionalText(billingGst),
      billingAddress: optionalText(billingAddress),
      billingEmail: optionalText(billingEmail),
      billingPhone: optionalText(billingPhone),
      contactName: optionalText(contactName),
      updatedAt: new Date(),
    }).where(eq(tenants.id, id)).returning();

    // Lands under the tenant it concerns, matching the credits route. The key
    // itself never reaches the trail — audit rows are not encrypted.
    await writeAudit({
      tenantId: id,
      userId: user.id,
      action: ACTIONS.tenant.update,
      entityType: 'tenants',
      entityId: id,
      details: auditSentence('update', {
        kind: 'workspace',
        name: updatedTenant.name,
        note: clearApiKey === true
          ? 'stored AI key removed'
          : (apiKeyValue ? 'stored AI key replaced' : null),
      }),
    });

    return NextResponse.json({
      success: true,
      tenant: { ...updatedTenant, apiKey: undefined, googleDriveTokens: undefined, hasCustomApiKey: Boolean(updatedTenant.apiKey) },
    });
  } catch (error) {
    return serverError(error, 'updating tenant');
  }
}

// DELETE — Delete tenant (Super Admin only)
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getUserFromRequest(req);
    if (!user || user.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Access denied. Super Admin only.' }, { status: 403 });
    }

    const { id } = await params;

    // Check if it's the tenant the Super Admin is logged into
    if (user.tenantId === id) {
      return NextResponse.json({ error: 'Cannot delete the tenant you are currently logged into.' }, { status: 400 });
    }

    const existing = await db.query.tenants.findFirst({
      where: eq(tenants.id, id),
      columns: { id: true, name: true },
    });
    if (!existing) {
      return NextResponse.json({ error: 'Tenant not found.' }, { status: 404 });
    }

    await db.delete(tenants).where(eq(tenants.id, id));

    /**
     * Filed under the ACTING admin's tenant, not the deleted one.
     * `audit_logs.tenant_id` cascades on tenant delete, so a row written
     * against `id` would be erased by the very statement above — the only
     * surviving place for the record of an erasure is the erasing party.
     */
    if (user.tenantId) {
      await writeAudit({
        tenantId: user.tenantId,
        userId: user.id,
        action: ACTIONS.tenant.delete,
        entityType: 'tenants',
        entityId: id,
        details: auditSentence('delete', {
          kind: 'workspace',
          name: existing.name,
          note: 'all data for this workspace was erased',
        }),
      });
    }

    return NextResponse.json({ success: true, message: 'Tenant deleted successfully.' });
  } catch (error) {
    return serverError(error, 'deleting tenant');
  }
}
