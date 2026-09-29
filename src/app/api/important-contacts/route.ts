import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { emergencyContacts } from '@/db/schema';
import { getUserFromRequest, hasPermission } from '@/lib/auth';
import {
  accountScopeFor, inCompanyOf, resolveUtilityCompany,
} from '@/lib/records/companyScope';
import { eq, and, asc, or, ilike } from 'drizzle-orm';
import { writeAudit, ACTIONS, auditSentence } from '@/lib/audit';
import { serverError } from '@/lib/routeError';

export async function GET(req: NextRequest) {
  try {
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

    const { searchParams } = new URL(req.url);
    const roleParam = searchParams.get('role');
    const q = searchParams.get('q');

    const conditions = [eq(emergencyContacts.tenantId, user.tenantId), inCompanyOf(emergencyContacts.companyId, scope.companyId)];

    if (roleParam) {
      conditions.push(eq(emergencyContacts.role, roleParam));
    }

    if (q) {
      conditions.push(
        or(
          ilike(emergencyContacts.name, `%${q}%`),
          ilike(emergencyContacts.role, `%${q}%`)
        ) as any
      );
    }

    const emergencyContactsList = await db.query.emergencyContacts.findMany({
      where: and(...conditions),
      orderBy: [asc(emergencyContacts.name)],
    });

    return NextResponse.json({ success: true, emergencyContacts: emergencyContactsList });
  } catch (error) {
    return serverError(error, 'listing important contacts');
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (user.role === 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const allowed = await hasPermission(user, 'emergency_contacts', 'add');
    if (!allowed) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Which account this request is for. The same value scopes every statement
    // below, read and write alike — a predicate that guards only the lookup
    // guards nothing once the update is a separate statement.
    const scope = await resolveUtilityCompany(req, user);
    if ('error' in scope) return scope.error;

    const body = await req.json();
    const { name, role, phoneNumber, email, address, notes } = body;

    if (!name || !role || !phoneNumber) {
      return NextResponse.json({ error: 'Missing required fields: name, role, or phoneNumber' }, { status: 400 });
    }

    const [emergencyContact] = await db.insert(emergencyContacts).values({
      // Derived from the proven scope, never accepted from the body: the
      // CHECK constraint keeping these two in step is the backstop, not the plan.
      companyId: scope.companyId,
      accountScope: accountScopeFor(scope.companyId),
      tenantId: user.tenantId,
      name,
      role,
      phoneNumber,
      email: email || null,
      address: address || null,
      notes: notes || null
    }).returning();

    // Log action
    await writeAudit({
      tenantId: user.tenantId,
      userId: user.id,
      // The workspace this row was created in, already proven by
      // `resolveUtilityCompany`. Files the event in that workspace's tab.
      companyId: scope.companyId,
      action: ACTIONS.emergency_contact.create,
      details: auditSentence('create', { kind: 'important contact', name, note: `listed as ${role}` }),
      req,
      entityType: 'emergency_contacts',
      entityId: emergencyContact?.id,
    });

    return NextResponse.json({ success: true, emergencyContact }, { status: 201 });
  } catch (error) {
    return serverError(error, 'creating important contact');
  }
}
