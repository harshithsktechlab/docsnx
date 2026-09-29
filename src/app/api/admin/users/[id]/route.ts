import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { users } from '@/db/schema';
import { getUserFromRequest } from '@/lib/auth';
import { eq } from 'drizzle-orm';
import bcrypt from 'bcrypt';
import { serverError } from '@/lib/routeError';

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const admin = await getUserFromRequest(req);
    if (!admin || admin.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { name, email, password, role, tenantId } = await req.json();

    const updateData: any = {};
    if (name) updateData.name = name;
    if (email) updateData.email = email;
    if (role) updateData.role = role;
    if (tenantId) updateData.tenantId = tenantId;
    if (password) {
      updateData.passwordHash = await bcrypt.hash(password, 10);
      updateData.requiresPasswordChange = true;
    }

    const result = await db.update(users).set(updateData).where(eq(users.id, id)).returning();
    
    if (result.length === 0) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true, user: result[0] });
  } catch (error) {
    return serverError(error, 'updating users');
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const admin = await getUserFromRequest(req);
    if (!admin || admin.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    await db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, id));
    return NextResponse.json({ success: true });
  } catch (error) {
    return serverError(error, 'deleting users');
  }
}
