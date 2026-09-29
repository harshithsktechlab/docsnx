import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getUserFromRequest } from '@/lib/auth';
import { 
  loadContextFile, 
  buildRawContext, 
  saveContextFile, 
  optimizeContextWithAI 
} from '@/lib/context-manager.mjs';
import { writeAudit, ACTIONS, auditSentence } from '@/lib/audit';
import { serverError } from '@/lib/routeError';

async function checkAdminAuth(req: Request) {
  const user = await getUserFromRequest(req);
  if (!user) {
    return { error: 'Unauthorized', status: 401 };
  }
  if (user.role !== 'SUPER_ADMIN') {
    return { error: 'Forbidden: Super Admin access required', status: 403 };
  }
  return { user };
}

export async function GET(req: Request) {
  try {
    const authResult = await checkAdminAuth(req);
    if (authResult.error) {
      return NextResponse.json({ error: authResult.error }, { status: authResult.status });
    }

    let contextData = loadContextFile();
    let autoCreated = false;
    
    if (!contextData) {
      console.log('AI_CONTEXT.md not found. Generating initial context...');
      const rawContent = buildRawContext();
      saveContextFile(rawContent);
      contextData = loadContextFile();
      autoCreated = true;
    }

    const estTokens = Math.round((contextData?.content?.length || 0) / 4);

    return NextResponse.json({
      success: true,
      context: contextData,
      estTokens,
      autoCreated,
      hasGeminiKey: !!process.env.GEMINI_API_KEY
    });
  } catch (error) {
    return serverError(error, 'loading context');
  }
}

export async function POST(req: Request) {
  try {
    const authResult = await checkAdminAuth(req);
    if (authResult.error) {
      return NextResponse.json({ error: authResult.error }, { status: authResult.status });
    }
    const { user } = authResult;

    console.log('Re-scanning workspace context...');
    const rawContent = buildRawContext();
    saveContextFile(rawContent);
    const contextData = loadContextFile();
    const estTokens = Math.round((contextData?.content?.length || 0) / 4);

    // Create audit log
    await writeAudit({
      tenantId: user!.tenantId,
      userId: user!.id,
      action: ACTIONS.ai.update_context,
      details: auditSentence('update_context', {
        kind: 'AI context file',
        note: `now ${contextData.size} bytes`,
      }),
      req,
      entityType: 'tenants',
      entityId: user!.tenantId,
    });

    return NextResponse.json({
      success: true,
      message: 'Context refreshed successfully.',
      context: contextData,
      estTokens,
      hasGeminiKey: !!process.env.GEMINI_API_KEY
    });
  } catch (error: any) {
    return serverError(error, 'rebuilding the AI context');
  }
}

export async function PUT(req: Request) {
  try {
    const authResult = await checkAdminAuth(req);
    if (authResult.error) {
      return NextResponse.json({ error: authResult.error }, { status: authResult.status });
    }
    const { user } = authResult;

    let contextData = loadContextFile();
    if (!contextData) {
      const rawContent = buildRawContext();
      saveContextFile(rawContent);
      contextData = loadContextFile();
    }

    console.log('Optimizing context with Gemini...');
    const rawLen = contextData.content.length;
    
    const optimizedContent = await optimizeContextWithAI(contextData.content);
    saveContextFile(optimizedContent);
    
    const updatedContext = loadContextFile();
    const estTokens = Math.round((updatedContext?.content?.length || 0) / 4);
    const optLen = updatedContext.content.length;
    const savings = Math.round(((rawLen - optLen) / rawLen) * 100);

    // Create audit log
    await writeAudit({
      tenantId: user!.tenantId,
      userId: user!.id,
      action: ACTIONS.ai.optimize_context,
      details: auditSentence('optimize_context', {
        kind: 'AI context file',
        note: `${savings}% fewer tokens`,
      }),
      req,
      entityType: 'tenants',
      entityId: user!.tenantId,
    });

    return NextResponse.json({
      success: true,
      message: 'AI Context optimized successfully.',
      context: updatedContext,
      estTokens,
      savings,
      hasGeminiKey: !!process.env.GEMINI_API_KEY
    });
  } catch (error: any) {
    return serverError(error, 'optimising the AI context');
  }
}
