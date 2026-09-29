import { NextResponse } from 'next/server';
import { withTenant } from '@/lib/db';
import { notifications } from '@/db/schema';
import { getUserFromRequest } from '@/lib/auth';
import { eq, and } from 'drizzle-orm';
import { serverError } from '@/lib/routeError';

/**
 * Mark ONE notification read — what clicking a row in the bell now does, in
 * place of the DELETE it used to fire.
 *
 * Self-scoped with no admin branch, unlike DELETE below: an admin removing a
 * stale notice from a member's bell is a housekeeping action, but marking it
 * READ on their behalf would tell that member they have already seen something
 * they have not.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;

    const updated = await withTenant(user.tenantId, async (tx) =>
      await tx
        .update(notifications)
        .set({ isRead: true })
        .where(and(
          eq(notifications.id, id),
          eq(notifications.tenantId, user.tenantId),
          eq(notifications.userId, user.id),
        ))
        .returning()
    );

    if (updated.length === 0) {
      return NextResponse.json({ error: 'Not Found' }, { status: 404 });
    }

    return NextResponse.json({ success: true, notification: updated[0] });
  } catch (error) {
    return serverError(error, 'marking notification read');
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;

    const removed = await withTenant(user.tenantId, async (tx) => {
      const notificationResult = await tx
        .select()
        .from(notifications)
        .where(and(eq(notifications.id, id), eq(notifications.tenantId, user.tenantId)))
        .limit(1);
      const notification = notificationResult[0];

      // Must be in the caller's tenant AND either their own notification or an
      // admin acting within the tenant. Prevents same-tenant cross-user deletes.
      const isAdmin = user.role === 'TENANT_ADMIN' || user.role === 'SUPER_ADMIN';
      if (!notification || (notification.userId !== user.id && !isAdmin)) {
        return false;
      }

      await tx.delete(notifications).where(and(
        eq(notifications.id, id),
        eq(notifications.tenantId, user.tenantId),
      ));
      return true;
    });

    if (!removed) {
      return NextResponse.json({ error: 'Not Found' }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return serverError(error, 'deleting notification');
  }
}
