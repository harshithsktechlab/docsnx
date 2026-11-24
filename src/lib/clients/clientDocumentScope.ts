/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   ONE CLIENT'S DOCUMENTS, AS A LIST                                      ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The client page lists a client's documents in the same table the Document
 * Manager uses, through the same routes (`GET /api/documents`, `bulk-delete`,
 * `bulk-download`) — which are, by design, the company's OWN documents and leave
 * the client modules out. A request that names a client (`?clientId=`) is the one
 * exception, and this is the one place that decides whether it may be:
 *
 *   the company      already proven by the caller (`resolveUtilityCompany`)
 *   the client       must be a live client of THAT company in THIS tenant — read
 *                    from the database, never trusted for what the URL says
 *   the permission   `action` on the client TYPE's module (`biz_client_individual`
 *                    / `biz_client_company`), the same key the client pages use
 *   the categories  only that module's, narrowed to the ones the member may
 *                    `action` — a document under a category they are denied is
 *                    simply absent, like everywhere else
 *
 * A client of another company, a deleted client and a malformed id all answer the
 * same 403 / 400 a denied module does, so a client id cannot be probed.
 *
 * Lives beside, not inside, clientScope.ts: that file is imported by the record
 * handler, and this one imports the handler.
 */
import { NextResponse } from 'next/server';
import { and, eq, isNull } from 'drizzle-orm';
import { withTenant } from '@/lib/db';
import { clients } from '@/db/schema';
import { hasPermission } from '@/lib/auth';
import { type CategoryKey } from '@/lib/documentCategories';
import { type ClientType, CLIENT_MODULE_BY_TYPE, isClientType } from '@/lib/clientCategories';
import { activeCategoryKeys } from '@/lib/taxonomyRegistry';
import type { RecordAction } from '@/lib/records/handler';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ClientDocumentScope {
  clientId: string;
  clientName: string;
  type: ClientType;
  /** The client type's categories the member may `action`. Never empty. */
  keys: CategoryKey[];
}

export async function resolveClientDocumentScope(
  user: any,
  companyId: string | null | undefined,
  rawClientId: string,
  action: RecordAction,
): Promise<{ error: Response } | ClientDocumentScope> {
  // A client belongs to a company workspace; there is no household version.
  if (!companyId) {
    return { error: NextResponse.json({ error: 'Client documents belong to a company workspace.' }, { status: 400 }) };
  }
  // Shape-checked before it reaches a uuid column: a malformed value is a 400, not a 500.
  if (!UUID_RE.test(rawClientId)) {
    return { error: NextResponse.json({ error: 'Invalid client' }, { status: 400 }) };
  }
  const forbidden = () => ({ error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) });

  const [client] = await withTenant(user.tenantId, (tx) => tx
    .select({ id: clients.id, clientType: clients.clientType, displayName: clients.displayName })
    .from(clients)
    .where(and(
      eq(clients.id, rawClientId.toLowerCase()),
      eq(clients.tenantId, user.tenantId),
      // The PROVEN company: another company's client is unreachable through this one.
      eq(clients.companyId, companyId),
      isNull(clients.deletedAt),
    ))
    .limit(1));
  if (!client || !isClientType(client.clientType)) return forbidden();

  const moduleKey = CLIENT_MODULE_BY_TYPE[client.clientType];
  if (!await hasPermission(user, moduleKey, action)) return forbidden();

  // Only this module's categories, asked per category like every other list — a
  // sub-category override can deny one of them.
  const keys: CategoryKey[] = [];
  for (const row of await activeCategoryKeys()) {
    if (row.moduleKey !== moduleKey) continue;
    if (await hasPermission(user, row.moduleKey, action, row.documentKey)) {
      keys.push({ moduleKey: row.moduleKey, documentKey: row.documentKey });
    }
  }
  if (keys.length === 0) return forbidden();

  return { clientId: client.id, clientName: client.displayName, type: client.clientType, keys };
}
