/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   /api/clients/types — which kinds of client this company keeps          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 *   GET  ?companyId=   { chosen, individual, company, canChange }
 *   PUT  ?companyId=   { individual, company } — at least one true
 *
 * Individual, Company, or both — chosen once, the first time Client Documents is
 * opened, and only the chosen kind(s) are shown or usable (src/lib/clients/
 * clientTypes.ts). No stored choice means "not chosen yet", and `chosen: false`
 * is what makes the page show the chooser.
 *
 * ── WHO ────────────────────────────────────────────────────────────────────
 * READ: anyone who may view either kind of client — the page needs to know which
 * tabs to draw. CHANGE: a workspace admin (TENANT_ADMIN) only. It is a setup
 * decision for the whole company, not a record act: a member who could hide a tab
 * everyone else uses should not be one editing it.
 *
 * Turning a kind off is refused while it has live clients (409, with the count).
 * The audit line names the choice and the company, never any client data.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withTenant } from '@/lib/db';
import { writeAudit, auditSentence } from '@/lib/audit';
import { recordAction } from '@/lib/auditActions';
import { serverError } from '@/lib/routeError';
import { CLIENT_INDIVIDUAL_MODULE } from '@/lib/clientCategories';
import { FORBIDDEN, canOnClientType, gateClientWorkspace } from '@/lib/clients/clientGate';
import { loadClientTypes, saveClientTypes } from '@/lib/clients/clientTypes';

export const dynamic = 'force-dynamic';

const putSchema = z.object({
  individual: z.boolean(),
  company: z.boolean(),
}).strict().refine((v) => v.individual || v.company, { message: 'Choose at least one kind of client.' });

const describe = (v: { individual: boolean; company: boolean }) =>
  v.individual && v.company ? 'individual and company clients' : v.individual ? 'individual clients only' : 'company clients only';

export async function GET(req: Request) {
  try {
    const gated = await gateClientWorkspace(req);
    if ('error' in gated) return gated.error;
    const { user, companyId } = gated;

    // Anyone who may view either kind needs the answer to draw the page.
    const mayView = await canOnClientType(user, 'individual', 'view')
      || await canOnClientType(user, 'company', 'view');
    if (!mayView) return FORBIDDEN();

    const types = await withTenant(user.tenantId, (tx) => loadClientTypes(tx, user.tenantId, companyId));
    return NextResponse.json({ success: true, ...types, canChange: user.role === 'TENANT_ADMIN' });
  } catch (error) {
    return serverError(error, 'loading the client types');
  }
}

export async function PUT(req: Request) {
  try {
    const gated = await gateClientWorkspace(req);
    if ('error' in gated) return gated.error;
    const { user, companyId, companyName } = gated;

    if (user.role !== 'TENANT_ADMIN') {
      return NextResponse.json(
        { error: 'Only a workspace admin can choose which kinds of client this company keeps.' },
        { status: 403 },
      );
    }

    let body: unknown;
    try { body = await req.json(); } catch { body = null; }
    const parsed = putSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message || 'Invalid input' }, { status: 400 });
    }

    const result = await saveClientTypes(user.tenantId, companyId, parsed.data);
    if (!result.ok) {
      return NextResponse.json({ error: result.error, code: 'CLIENTS_EXIST', blocked: result.blocked }, { status: 409 });
    }

    await writeAudit({
      tenantId: user.tenantId,
      userId: user.id,
      companyId,
      action: recordAction(CLIENT_INDIVIDUAL_MODULE, 'update'),
      details: auditSentence('update', {
        kind: 'client types',
        name: companyName,
        note: `now ${describe(result.types)}`,
      }),
      req,
      entityType: 'client_type_settings',
    });

    return NextResponse.json({ success: true, ...result.types, canChange: true });
  } catch (error) {
    return serverError(error, 'saving the client types');
  }
}
