import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { users, tenants } from '@/db/schema';
import { getUserFromRequest } from '@/lib/auth';
import { eq, desc, isNull, and, or, ilike, count } from 'drizzle-orm';
import bcrypt from 'bcrypt';
import { serverError } from '@/lib/routeError';

const ROLES = ['SUPER_ADMIN', 'TENANT_ADMIN', 'STANDARD'] as const;
const MAX_PAGE_SIZE = 100;

export async function GET(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user || user.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const params = new URL(req.url).searchParams;
    const page = Math.max(1, Math.floor(Number(params.get('page'))) || 1);
    const limit = Math.min(Math.max(1, Math.floor(Number(params.get('limit'))) || 25), MAX_PAGE_SIZE);
    const role = ROLES.find((r) => r === params.get('role'));
    const q = (params.get('q') || '').trim().slice(0, 100);

    const conditions = [isNull(users.deletedAt)];
    if (role) conditions.push(eq(users.role, role));
    if (q) {
      // Escape LIKE wildcards so a search for "50%" or "a_b" matches literally.
      const pattern = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
      conditions.push(or(
        ilike(users.name, pattern),
        ilike(users.email, pattern),
        ilike(tenants.name, pattern),
      )!);
    }
    const where = and(...conditions);

    const [{ total }] = await db
      .select({ total: count() })
      .from(users)
      .leftJoin(tenants, eq(users.tenantId, tenants.id))
      .where(where);

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
      .where(where)
      .orderBy(desc(users.createdAt), desc(users.id))
      .limit(limit)
      .offset((page - 1) * limit);

    return NextResponse.json({
      success: true,
      users: allUsers,
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
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
