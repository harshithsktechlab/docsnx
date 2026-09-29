import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiKeys } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { getUserFromRequest } from '@/lib/auth';
import { encryptField } from '@/lib/fieldCrypto';
import { serverError } from '@/lib/routeError';


export const dynamic = 'force-dynamic';

function maskKey(key: string | null) {
  if (!key || key.length <= 8) return '****';
  return '****' + key.slice(-8);
}

// GET — Get single key (masked)
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getUserFromRequest(req);
    if (!user || user.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Access denied. Super Admin only.' }, { status: 403 });
    }

    const { id } = await params;
    const [key] = await db.select().from(apiKeys).where(eq(apiKeys.id, id));
    if (!key) return NextResponse.json({ error: 'Key not found' }, { status: 404 });

    return NextResponse.json({
      success: true,
      key: { ...key, apiKey: maskKey(key.apiKey), apiKeyMasked: true },
    });
  } catch (error) {
    // This catch logged nothing at all, so a failing key read left no trace on
    // either side of the wire.
    return serverError(error, 'loading this API key');
  }
}

// PUT — Update key (label, model, isActive, priority, dailyLimit, or replace apiKey)
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getUserFromRequest(req);
    if (!user || user.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Access denied. Super Admin only.' }, { status: 403 });
    }

    const { id } = await params;
    const body = await req.json();
    const { label, apiKey, provider, model, dailyLimit, priority, isActive } = body;

    const [existing] = await db.select().from(apiKeys).where(eq(apiKeys.id, id));
    if (!existing) return NextResponse.json({ error: 'Key not found' }, { status: 404 });

    const updateData: any = {};
    if (label !== undefined) updateData.label = label.trim();
    if (model !== undefined) updateData.model = model;
    if (provider !== undefined) updateData.provider = provider;
    if (dailyLimit !== undefined) updateData.dailyLimit = parseInt(dailyLimit);
    if (priority !== undefined) updateData.priority = parseInt(priority);
    if (isActive !== undefined) updateData.isActive = Boolean(isActive);
    // Only update apiKey if a new non-masked value is provided
    if (apiKey && !apiKey.startsWith('****')) updateData.apiKey = encryptField(apiKey.trim());

    const [updated] = await db.update(apiKeys)
      .set(updateData)
      .where(eq(apiKeys.id, id))
      .returning();

    return NextResponse.json({
      success: true,
      key: { ...updated, apiKey: maskKey(updated.apiKey), apiKeyMasked: true },
    });
  } catch (error) {
    return serverError(error, 'updating AI key');
  }
}

// DELETE — Remove a key
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getUserFromRequest(req);
    if (!user || user.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Access denied. Super Admin only.' }, { status: 403 });
    }

    const { id } = await params;
    const [existing] = await db.select().from(apiKeys).where(eq(apiKeys.id, id));
    if (!existing) return NextResponse.json({ error: 'Key not found' }, { status: 404 });

    await db.delete(apiKeys).where(eq(apiKeys.id, id));
    return NextResponse.json({ success: true, message: 'API key deleted.' });
  } catch (error) {
    return serverError(error, 'deleting AI key');
  }
}
