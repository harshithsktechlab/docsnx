import { NextResponse } from 'next/server';
import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import { db, withTenant } from '@/lib/db';
import { companyAccess, tenants, users } from '@/db/schema';
import { getUserFromRequest } from '@/lib/auth';
import { revokeMemberAccess } from '@/lib/account/memberRemoval';
import { writeAudit, ACTIONS, auditSentence } from '@/lib/audit';
import { serverError } from '@/lib/routeError';

const bodySchema = z.object({
  userId: z.string().uuid(),
  action: z.enum(['accept', 'decline']),
});

/**
 * Answers an invitation to join another tenant (POST /api/users made it).
 *
 * ── WHY NO CODE IS ASKED FOR ──────────────────────────────────────────────────
 * The caller is already signed in as this person, so their identity was proved
 * moments ago with the password that belongs to it. The invitation names a seat
 * with the SAME `identity_id` as the caller's session — resolved in the
 * database below, not taken from the request — so nobody can answer, or even
 * learn of, an invitation addressed to someone else.
 *
 * The seat exists in the inviting tenant already and is counted against its
 * member limit; accepting only makes it usable, declining gives the seat back.
 */
export async function POST(req: Request) {
  try {
    const current = await getUserFromRequest(req);
    if (!current || !current.identityId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Choose accept or decline for an invitation.' }, { status: 400 });
    }
    const { userId, action } = parsed.data;

    const [seat] = await db
      .select()
      .from(users)
      .where(and(
        eq(users.id, userId),
        eq(users.identityId, current.identityId),
        eq(users.membershipStatus, 'pending'),
        isNull(users.deletedAt),
      ))
      .limit(1);

    if (!seat) {
      return NextResponse.json({ error: 'That invitation was not found. It may have been withdrawn.' }, { status: 404 });
    }

    const tenant = await db.query.tenants.findFirst({
      where: eq(tenants.id, seat.tenantId),
      columns: { id: true, name: true, isActive: true, deletedAt: true },
    });
    if (!tenant || tenant.deletedAt || !tenant.isActive) {
      return NextResponse.json({ error: 'That account is no longer available.' }, { status: 410 });
    }

    const now = new Date();

    if (action === 'accept') {
      await withTenant(seat.tenantId, async (tx) => {
        await tx.update(users)
          .set({
            membershipStatus: 'active',
            // Their password already exists (it is the identity's), so they are
            // not waiting on /activate in this tenant either.
            activatedAt: seat.activatedAt ?? now,
            updatedAt: now,
          })
          .where(and(eq(users.id, seat.id), eq(users.tenantId, seat.tenantId)));

        await writeAudit({
          tenantId: seat.tenantId,
          userId: seat.id,
          action: ACTIONS.auth.membership_accepted,
          details: auditSentence('membership_accepted', {
            kind: 'invitation to join',
            name: tenant.name,
            member: seat.name,
          }),
          req,
          entityType: 'users',
          entityId: seat.id,
        }, tx);
      });

      return NextResponse.json({ success: true, status: 'active', tenantName: tenant.name });
    }

    await withTenant(seat.tenantId, async (tx) => {
      await revokeMemberAccess(tx, { id: current.id, tenantId: seat.tenantId }, { id: seat.id, email: seat.email });
      await tx.delete(companyAccess).where(eq(companyAccess.userId, seat.id));
      await tx.update(users)
        .set({ membershipStatus: 'declined' })
        .where(and(eq(users.id, seat.id), eq(users.tenantId, seat.tenantId)));

      await writeAudit({
        tenantId: seat.tenantId,
        userId: seat.id,
        action: ACTIONS.auth.membership_declined,
        details: auditSentence('membership_declined', {
          kind: 'invitation to join',
          name: tenant.name,
          member: seat.name,
        }),
        req,
        entityType: 'users',
        entityId: seat.id,
      }, tx);
    });

    return NextResponse.json({ success: true, status: 'declined' });
  } catch (error) {
    return serverError(error, 'answering this invitation');
  }
}
