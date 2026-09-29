import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiKeys } from '@/db/schema';
import { eq, sql } from 'drizzle-orm';
import { getUserFromRequest } from '@/lib/auth';
import { classifyAIError, getErrorMessage } from '@/lib/aiKeyManager';
import { decryptField } from '@/lib/fieldCrypto';
import { DEFAULT_GEMINI_MODEL, DEFAULT_OPENAI_MODEL } from '@/lib/aiModels';
import { GoogleGenAI } from '@google/genai';
import OpenAI from 'openai';
import { serverError } from '@/lib/routeError';

/**
 * POST /api/admin/ai-keys/test
 * Tests an API key (by id) by sending a simple prompt and measuring latency.
 */
export async function POST(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user || user.role !== 'SUPER_ADMIN') {
      return NextResponse.json({ error: 'Access denied. Super Admin only.' }, { status: 403 });
    }

    const { id } = await req.json();

    if (!id) {
      return NextResponse.json({ error: 'Key ID is required.' }, { status: 400 });
    }

    const [keyRecord] = await db.select().from(apiKeys).where(eq(apiKeys.id, id));
    if (!keyRecord) {
      return NextResponse.json({ error: 'API key not found.' }, { status: 404 });
    }

    const startTime = Date.now();
    let testResult: string | null = null;
    let success = false;
    let errorMessage: string | null = null;
    const rawApiKey = decryptField(keyRecord.apiKey) || keyRecord.apiKey;

    try {
      if (keyRecord.provider === 'openai') {
        const client = new OpenAI({ apiKey: rawApiKey });
        const response = await client.chat.completions.create({
          model: keyRecord.model || DEFAULT_OPENAI_MODEL,
          messages: [{ role: 'user', content: 'Reply with exactly: "DocsNX AI key is working correctly." and nothing else.' }],
          max_tokens: 30,
        });
        testResult = response.choices[0]?.message?.content || 'Response received.';
        success = true;
      } else {
        // Gemini
        const client = new GoogleGenAI({ apiKey: rawApiKey });
        const response = await client.models.generateContent({
          model: keyRecord.model || DEFAULT_GEMINI_MODEL,
          contents: 'Reply with exactly: "DocsNX AI key is working correctly." and nothing else.',
        });
        testResult = response.text || 'Response received.';
        success = true;
      }
    } catch (err: any) {
      const errCode = classifyAIError(err);
      // getErrorMessage already handles the unknown-code fallback and keeps
      // this untyped index off AI_ERROR_MESSAGES.
      errorMessage = getErrorMessage(errCode) || err.message || 'Test failed.';
      success = false;

      // Update error count in DB
      await db.update(apiKeys)
        .set({
          errorCount: sql`${apiKeys.errorCount} + 1`,
          lastError: String(err.message || err).slice(0, 500),
        })
        .where(eq(apiKeys.id, id));
    }

    const latencyMs = Date.now() - startTime;

    return NextResponse.json({
      success,
      testResult,
      errorMessage,
      latencyMs,
      provider: keyRecord.provider,
      model: keyRecord.model,
    });
  } catch (error) {
    return serverError(error, 'testing AI key');
  }
}
