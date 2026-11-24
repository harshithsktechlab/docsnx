/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   /api/clients/subcategories — which subcategories this company uses     ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 *   GET  ?companyId=&type=   every subcategory a client of that type can have,
 *                            grouped by its source module, with its tick
 *   PUT  ?companyId=&type=   { keys: string[] } — make the ticked set EXACTLY this
 *
 * Individual clients list the PERSONAL subcategories (PAN card, policies, ITR…);
 * company clients list the BUSINESS ones. The `keys` are the derived document
 * keys the GET returned — see src/lib/clientCategories.ts.
 *
 * Presence is enabled and the default is none (src/lib/clients/clientSettings.ts).
 * Unticking never touches documents already filed.
 *
 * `edit` on the client type's permission is the gate: choosing what a company
 * tracks for its clients is a configuration act, not a record act.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withTenant } from '@/lib/db';
import { writeAudit, auditSentence } from '@/lib/audit';
import { recordAction } from '@/lib/auditActions';
import { serverError } from '@/lib/routeError';
import { CLIENT_MODULE_BY_TYPE } from '@/lib/clientCategories';
import { clientTypeFromRequest, gateClients } from '@/lib/clients/clientGate';
import {
  listConfigurable, replaceEnabledDocumentKeys, selectableDocumentKeys,
} from '@/lib/clients/clientSettings';

export const dynamic = 'force-dynamic';

const putSchema = z.object({
  // A generous ceiling: the largest taxonomy is ~110 rows.
  keys: z.array(z.string().min(1).max(60)).max(500),
}).strict();

export async function GET(req: Request) {
  try {
    const type = clientTypeFromRequest(req);
    if (!type) return NextResponse.json({ error: 'type must be individual or company' }, { status: 400 });

    const gated = await gateClients(req, type, 'view');
    if ('error' in gated) return gated.error;
    const { user, companyId } = gated;

    const groups = await withTenant(user.tenantId, (tx) =>
      listConfigurable(tx, user.tenantId, companyId, type));
    const enabledCount = groups.reduce((n, g) => n + g.items.filter((i) => i.enabled).length, 0);

    return NextResponse.json({ success: true, type, groups, enabledCount });
  } catch (error) {
    return serverError(error, 'loading the client subcategories');
  }
}

export async function PUT(req: Request) {
  try {
    const type = clientTypeFromRequest(req);
    if (!type) return NextResponse.json({ error: 'type must be individual or company' }, { status: 400 });

    const gated = await gateClients(req, type, 'edit');
    if ('error' in gated) return gated.error;
    const { user, companyId, companyName } = gated;

    let body: unknown;
    try { body = await req.json(); } catch { body = null; }
    const parsed = putSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message || 'Invalid input' }, { status: 400 });
    }

    // Every key must be a real, active subcategory for THIS client type. An
    // unknown or retired one is refused rather than skipped, so a stale page
    // learns it is stale instead of silently saving less than it showed.
    const allowed = await selectableDocumentKeys(type);
    const keys = [...new Set(parsed.data.keys)];
    const unknown = keys.filter((k) => !allowed.has(k));
    if (unknown.length > 0) {
      return NextResponse.json(
        { error: 'Some of these subcategories are no longer available. Reload and try again.' },
        { status: 400 },
      );
    }

    const diff = await replaceEnabledDocumentKeys(user.tenantId, companyId, type, keys);

    await writeAudit({
      tenantId: user.tenantId,
      userId: user.id,
      companyId,
      action: recordAction(CLIENT_MODULE_BY_TYPE[type], 'update'),
      details: auditSentence('update', {
        kind: `${type} client subcategories`,
        name: companyName,
        note: `${diff.added.length} added, ${diff.removed.length} removed`,
      }),
      req,
      entityType: 'client_subcategory_settings',
    });

    return NextResponse.json({ success: true, added: diff.added.length, removed: diff.removed.length, enabledCount: keys.length });
  } catch (error) {
    return serverError(error, 'saving the client subcategories');
  }
}
