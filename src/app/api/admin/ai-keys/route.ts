import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiKeys } from '@/db/schema';
import { asc } from 'drizzle-orm';
import { getUserFromRequest } from '@/lib/auth';
import { encryptField } from '@/lib/fieldCrypto';
import { defaultModelFor } from '@/lib/aiModels';
import { serverError } from '@/lib/routeError';


export const dynamic = 'force-dynamic';

// Mask an API key — show only last 8 characters
function maskKey(key: string | null) {
  if (!key || key.length <= 8) return '****';
  return '****' + key.slice(-8);
}

// GET — List all API keys (Super Admin only)
export async function GET(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user || user.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Access denied. Super Admin only.' }, { status: 403 });
    }

    const keys = await db.select().from(apiKeys).orderBy(asc(apiKeys.priority), asc(apiKeys.createdAt));

    // Mask actual API key values for security
    const safeKeys = keys.map(k => ({
      ...k,
      apiKey: maskKey(k.apiKey),
      apiKeyMasked: true,
    }));

    return NextResponse.json({ success: true, keys: safeKeys });
  } catch (error) {
    return serverError(error, 'listing AI keys');
  }
}

// POST — Add a new API key
export async function POST(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user || user.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Access denied. Super Admin only.' }, { status: 403 });
    }

    const { label, apiKey, provider, model, dailyLimit, priority } = await req.json();

    if (!label || !apiKey) {
      return NextResponse.json({ error: 'Label and API Key are required.' }, { status: 400 });
    }

    const validProviders = ['gemini', 'openai'];
    const resolvedProvider = validProviders.includes(provider) ? provider : 'gemini';

    const defaultModel = defaultModelFor(resolvedProvider);

    const [newKey] = await db.insert(apiKeys).values({
      label: label.trim(),
      apiKey: encryptField(apiKey.trim()) as string, // encrypted at rest
      provider: resolvedProvider,
      model: model || defaultModel,
      dailyLimit: parseInt(dailyLimit) || (resolvedProvider === 'openai' ? 500 : 1500),
      priority: parseInt(priority) || 0,
      isActive: true,
      dailyUsage: 0,
      lastResetAt: new Date(),
    }).returning();

    return NextResponse.json({
      success: true,
      key: {
        ...newKey,
        apiKey: maskKey(newKey.apiKey),
        apiKeyMasked: true,
      },
    }, { status: 201 });
  } catch (error) {
    return serverError(error, 'creating AI key');
  }
}
