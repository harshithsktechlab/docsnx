import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { addons } from '@/db/schema';
import { eq, asc } from 'drizzle-orm';
import { getUserFromRequest } from '@/lib/auth';
import { serverError } from '@/lib/routeError';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const activeAddons = await db.select()
      .from(addons)
      .where(eq(addons.isActive, true))
      .orderBy(asc(addons.name));
      
    return NextResponse.json({ success: true, addons: activeAddons });
  } catch (error) {
    return serverError(error, 'listing active addons');
  }
}
