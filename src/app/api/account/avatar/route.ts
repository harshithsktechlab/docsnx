import { NextResponse } from 'next/server';
import { withTenant } from '@/lib/db';
import { userAvatars } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { getUserFromRequest } from '@/lib/auth';
import { MAX_AVATAR_BYTES, avatarUrl, sniffAvatarType } from '@/lib/avatarImage';
import { writeAudit, ACTIONS, auditSentence } from '@/lib/audit';
import { serverError } from '@/lib/routeError';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   YOUR OWN PROFILE PHOTO — upload and remove                             ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The target is always the session's user. The body is the raw image bytes
 * (the browser has already resized it); the stored type comes from the magic
 * bytes, not from the request. No `requireActivePlan`, as with the other
 * /api/account routes — this is the person's own profile, not workspace data.
 * Serving the image is `./[userId]/route.ts`.
 */
export async function PUT(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    // Refuse on the declared length first so an oversized body is never buffered.
    const declared = Number(req.headers.get('content-length') || 0);
    if (declared > MAX_AVATAR_BYTES + 1024) {
      return NextResponse.json({ error: 'That photo is too large. Choose a smaller one.' }, { status: 413 });
    }
    const bytes = new Uint8Array(await req.arrayBuffer());
    if (bytes.length === 0) {
      return NextResponse.json({ error: 'No photo was sent.' }, { status: 400 });
    }
    if (bytes.length > MAX_AVATAR_BYTES) {
      return NextResponse.json({ error: 'That photo is too large. Choose a smaller one.' }, { status: 413 });
    }
    const contentType = sniffAvatarType(bytes);
    if (!contentType) {
      return NextResponse.json({ error: 'Use a JPEG, PNG or WebP photo.' }, { status: 400 });
    }

    const now = new Date();
    const data = Buffer.from(bytes).toString('base64');
    await withTenant(user.tenantId, async (tx) => {
      await tx.insert(userAvatars)
        .values({ userId: user.id, tenantId: user.tenantId, contentType, data, updatedAt: now })
        .onConflictDoUpdate({
          target: userAvatars.userId,
          set: { contentType, data, updatedAt: now },
        });
      await writeAudit({
        tenantId: user.tenantId,
        userId: user.id,
        action: ACTIONS.user.update,
        details: auditSentence('update', { kind: 'member', name: user.name, note: 'changed their profile photo' }),
        req,
        entityType: 'users',
        entityId: user.id,
      }, tx);
    });

    return NextResponse.json({ success: true, avatarUrl: avatarUrl(user.id, now) });
  } catch (error) {
    return serverError(error, 'saving your photo');
  }
}

export async function DELETE(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    await withTenant(user.tenantId, async (tx) => {
      const removed = await tx.delete(userAvatars)
        .where(and(eq(userAvatars.userId, user.id), eq(userAvatars.tenantId, user.tenantId)))
        .returning({ userId: userAvatars.userId });
      if (removed.length === 0) return;
      await writeAudit({
        tenantId: user.tenantId,
        userId: user.id,
        action: ACTIONS.user.update,
        details: auditSentence('update', { kind: 'member', name: user.name, note: 'removed their profile photo' }),
        req,
        entityType: 'users',
        entityId: user.id,
      }, tx);
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return serverError(error, 'removing your photo');
  }
}
