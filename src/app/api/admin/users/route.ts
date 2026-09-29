import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { users, tenants } from '@/db/schema';
import { getUserFromRequest } from '@/lib/auth';
import { eq, desc, isNull, and, inArray } from 'drizzle-orm';
import bcrypt from 'bcrypt';
import { serverError } from '@/lib/routeError';

export async function GET(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user || user.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const allUsers = await db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        role: users.role,
        tenantId: users.tenantId,
        createdAt: users.createdAt,
        tenantName: tenants.name,
      })
      .from(users)
      .leftJoin(tenants, eq(users.tenantId, tenants.id))
      .where(and(
        isNull(users.deletedAt),
        inArray(users.role, ['SUPER_ADMIN', 'TENANT_ADMIN'])
      ))
      .orderBy(desc(users.createdAt));

    return NextResponse.json({ success: true, users: allUsers });
  } catch (error) {
    return serverError(error, 'loading users');
  }
}

export async function POST(req: Request) {
  try {
    const admin = await getUserFromRequest(req);
    if (!admin || admin.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { name, email, password, role, tenantId } = await req.json();

    if (!name || !email || !password) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const existingUser = await db.query.users.findFirst({
      where: and(eq(users.email, email), isNull(users.deletedAt))
    });

    if (existingUser) {
      return NextResponse.json({ error: 'Email already exists' }, { status: 400 });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const result = await db.insert(users).values({
      name,
      email,
      passwordHash,
      role: role || 'STANDARD',
      tenantId: tenantId || null,
      requiresPasswordChange: true
    }).returning({
      id: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
      tenantId: users.tenantId
    });

    return NextResponse.json({ success: true, user: result[0] });
  } catch (error) {
    return serverError(error, 'saving users');
  }
}
