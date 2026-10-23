import { NextResponse } from 'next/server';
import { withTenant } from '@/lib/db';
import { userAvatars } from '@/db/schema';
import { and, eq } from 'drizzle-orm';
import { getUserFromRequest } from '@/lib/auth';
import { serverError } from '@/lib/routeError';

/**
 * Serve a profile photo to anyone signed in to the SAME workspace.
 *
 * The tenant comes from the caller's session, so a `userId` from another
 * tenant simply finds no row (the explicit predicate, and RLS behind it) and
 * answers 404 — never 403, which would confirm the id exists elsewhere.
 * `private` caching only: the URL carries `?v=<updated_at>`, so a new photo is a
 * new URL and a long browser cache is safe.
 */
export async function GET(req: Request, { params }: { params: Promise<{ userId: string }> }) {
  try {
    const { userId } = await params;
    const user = await getUserFromRequest(req);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    if (!/^[0-9a-f-]{36}$/i.test(userId)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const row = await withTenant(user.tenantId, (tx) => tx.query.userAvatars.findFirst({
      where: and(eq(userAvatars.userId, userId), eq(userAvatars.tenantId, user.tenantId)),
    }));
    if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });

    return new Response(Buffer.from(row.data, 'base64'), {
      status: 200,
      headers: {
        'Content-Type': row.contentType,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, max-age=31536000, immutable',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      },
    });
  } catch (error) {
    return serverError(error, 'loading a photo');
  }
}
