import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { emergencyContacts } from '@/db/schema';
import { getUserFromRequest, hasPermission } from '@/lib/auth';
import {
  accountScopeFor, inCompanyOf, resolveUtilityCompany,
} from '@/lib/records/companyScope';
import { eq, and } from 'drizzle-orm';
import { writeAudit, ACTIONS, auditSentence } from '@/lib/audit';
import { serverError } from '@/lib/routeError';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (user.role === 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const allowed = await hasPermission(user, 'emergency_contacts', 'view');
    if (!allowed) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Which account this request is for. The same value scopes every statement
    // below, read and write alike — a predicate that guards only the lookup
    // guards nothing once the update is a separate statement.
    const scope = await resolveUtilityCompany(req, user);
    if ('error' in scope) return scope.error;

    const contact = await db.query.emergencyContacts.findFirst({
      where: and(eq(emergencyContacts.id, id), eq(emergencyContacts.tenantId, user.tenantId), inCompanyOf(emergencyContacts.companyId, scope.companyId)),
    });

    if (!contact) {
      return NextResponse.json({ error: 'Important contact not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true, emergencyContact: contact });
  } catch (error) {
    return serverError(error, 'loading important contact');
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (user.role === 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const allowed = await hasPermission(user, 'emergency_contacts', 'edit');
    if (!allowed) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Which account this request is for. The same value scopes every statement
    // below, read and write alike — a predicate that guards only the lookup
    // guards nothing once the update is a separate statement.
    const scope = await resolveUtilityCompany(req, user);
    if ('error' in scope) return scope.error;

    const contact = await db.query.emergencyContacts.findFirst({
      where: and(eq(emergencyContacts.id, id), eq(emergencyContacts.tenantId, user.tenantId), inCompanyOf(emergencyContacts.companyId, scope.companyId)),
    });

    if (!contact) {
      return NextResponse.json({ error: 'Important contact not found' }, { status: 404 });
    }

    let name, role, phoneNumber, email, address, notes;
    const contentType = req.headers.get('content-type') || '';

    if (contentType.includes('multipart/form-data')) {
      const formData = await req.formData();
      name = formData.get('name') as string | null;
      role = formData.get('role') as string | null;
      phoneNumber = formData.get('phoneNumber') as string | null;
      email = formData.get('email') as string | null;
      address = formData.get('address') as string | null;
      notes = formData.get('notes') as string | null;
    } else {
      const body = await req.json();
      name = body.name;
      role = body.role;
      phoneNumber = body.phoneNumber;
      email = body.email;
      address = body.address;
      notes = body.notes;
    }

    const updateData: any = {};
    if (name !== undefined && name !== null) updateData.name = name;
    if (role !== undefined && role !== null) updateData.role = role;
    if (phoneNumber !== undefined && phoneNumber !== null) updateData.phoneNumber = phoneNumber;
    if (email !== undefined && email !== null) updateData.email = email || null;
    if (address !== undefined && address !== null) updateData.address = address || null;
    if (notes !== undefined && notes !== null) updateData.notes = notes || null;

    const [updated] = await db.update(emergencyContacts)
      .set({ ...updateData, updatedAt: new Date() })
      .where(eq(emergencyContacts.id, id))
      .returning();

    // Log action
    await writeAudit({
      tenantId: user.tenantId,
      userId: user.id,
      // The workspace this record lives in, already proven by
      // `resolveUtilityCompany`. Files it in that workspace's audit tab.
      companyId: scope.companyId,
      action: ACTIONS.emergency_contact.update,
      details: auditSentence('update', { kind: 'important contact', name: updated?.name }),
      req,
      entityType: 'emergency_contacts',
      entityId: updated?.id,
    });

    return NextResponse.json({ success: true, emergencyContact: updated });
  } catch (error) {
    return serverError(error, 'updating important contact');
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (user.role === 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const allowed = await hasPermission(user, 'emergency_contacts', 'delete');
    if (!allowed) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Which account this request is for. The same value scopes every statement
    // below, read and write alike — a predicate that guards only the lookup
    // guards nothing once the update is a separate statement.
    const scope = await resolveUtilityCompany(req, user);
    if ('error' in scope) return scope.error;

    const contact = await db.query.emergencyContacts.findFirst({
      where: and(eq(emergencyContacts.id, id), eq(emergencyContacts.tenantId, user.tenantId), inCompanyOf(emergencyContacts.companyId, scope.companyId)),
    });

    if (!contact) {
      return NextResponse.json({ error: 'Important contact not found' }, { status: 404 });
    }

    await db.delete(emergencyContacts).where(eq(emergencyContacts.id, id));

    // Log action
    await writeAudit({
      tenantId: user.tenantId,
      userId: user.id,
      // The workspace this record lives in, already proven by
      // `resolveUtilityCompany`. Files it in that workspace's audit tab.
      companyId: scope.companyId,
      action: ACTIONS.emergency_contact.delete,
      details: auditSentence('delete', { kind: 'important contact', name: contact.name }),
      req,
      entityType: 'emergency_contacts',
      entityId: id,
    });

    return NextResponse.json({ success: true, message: 'Important contact deleted successfully' });
  } catch (error) {
    return serverError(error, 'deleting important contact');
  }
}
