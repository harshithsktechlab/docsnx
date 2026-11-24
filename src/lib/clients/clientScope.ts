/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   NAMING THE CLIENT ON A RECORD REQUEST                                  ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The two client record scopes (`biz_client_individual`, `biz_client_company`)
 * are reached with the same URL shape as every other module —
 * `/api/modules/<module>/<documentKey>?companyId=<uuid>` — plus one more name:
 * `&clientId=<uuid>`. A client document belongs to a company workspace AND to a
 * client, and a request that names no client is refused: there is no meaningful
 * "all clients' PAN cards" list to show a member who may be handling a
 * competitor's customers.
 *
 * This is called from `withRecordScope` once the COMPANY has been proven, and
 * proves the client the same way the company was proven — from the URL, against
 * the database, scoped to the session's tenant and the proven company. A
 * `clientId` is never trusted for what it says.
 *
 * ── TWO THINGS IT DECIDES ──────────────────────────────────────────────────
 *   which client   `ctx.clientId`, which `createRecord` writes and every query
 *                  in handler.ts filters on
 *   which keys     for an ADD, the subcategories the company has TICKED for this
 *                  client type (plus the catch-all). View and edit keep the whole
 *                  set, so a document filed under a subcategory that was later
 *                  un-ticked stays readable and editable.
 */
import { NextResponse } from 'next/server';
import { and, eq, isNull } from 'drizzle-orm';
import { withTenant } from '@/lib/db';
import { clients } from '@/db/schema';
import { type ClientType, clientTypeOfModule, isClientCatchAll } from '@/lib/clientCategories';
import type { CategoryKey } from '@/lib/documentCategories';
import { loadEnabledDocumentKeys } from '@/lib/clients/clientSettings';
import { typeEnabledFor, typeNotEnabledMessage } from '@/lib/clients/clientTypes';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function clientIdFromRequest(req: Request): string | null | undefined {
  const raw = new URL(req.url).searchParams.get('clientId');
  if (raw === null || raw === '') return null;
  return UUID_RE.test(raw) ? raw.toLowerCase() : undefined;
}

/**
 * Is `clientId` a live client of THIS company, of the type this scope serves?
 *
 * The one proof, used by the request gate below and by the scan save route (which
 * has no URL to read the client from — it is named per record in the body, and
 * trusted no more for that).
 */
export async function clientBelongsToScope(
  user: any,
  companyId: string,
  clientId: string,
  scope: string,
): Promise<boolean> {
  const type = clientTypeOfModule(scope);
  if (!type || !UUID_RE.test(clientId)) return false;
  const [client] = await withTenant(user.tenantId, (tx) => tx
    .select({ id: clients.id, clientType: clients.clientType })
    .from(clients)
    .where(and(
      eq(clients.id, clientId),
      eq(clients.tenantId, user.tenantId),
      // The PROVEN company, so another company's client is unreachable here.
      eq(clients.companyId, companyId),
      isNull(clients.deletedAt),
    ))
    .limit(1));
  return Boolean(client && client.clientType === type);
}

/** Why an add was refused for a client type nothing has been configured for. */
export const NOT_CONFIGURED_MESSAGE =
  'Choose the document types you keep for these clients first — open Client Documents → Configure subcategories.';

/**
 * For an ADD, the keys narrowed to what the company has ticked for this client
 * type, plus the catch-all — but ONLY once at least one subcategory is ticked.
 * Configuring comes first: until then nothing, Others included, may be filed, so a
 * client's documents never land in a type the company has not chosen. Any other
 * action keeps the whole set, so a document filed under a since-unticked
 * subcategory stays readable and editable.
 */
export async function keysForClientAction(
  user: any,
  companyId: string,
  type: ClientType,
  action: string,
  keys: readonly CategoryKey[],
): Promise<readonly CategoryKey[]> {
  if (action !== 'add') return keys;
  // A kind the company has not turned on takes no documents at all.
  if (!(await typeEnabledFor(user.tenantId, companyId, type)).enabled) return [];
  const enabled = new Set(await withTenant(user.tenantId, (tx) =>
    loadEnabledDocumentKeys(tx, user.tenantId, companyId, type)));
  if (enabled.size === 0) return [];
  return keys.filter((k) => isClientCatchAll(k) || enabled.has(k.documentKey));
}

export async function gateClientScope(
  req: Request,
  user: any,
  scope: string,
  companyId: string,
  action: string,
  keys: readonly CategoryKey[],
): Promise<{ error: Response } | { clientId: string; keys: readonly CategoryKey[] }> {
  const type = clientTypeOfModule(scope);
  if (!type) return { error: NextResponse.json({ error: 'Unknown module' }, { status: 404 }) };

  const clientId = clientIdFromRequest(req);
  if (clientId === undefined) {
    return { error: NextResponse.json({ error: 'Invalid client' }, { status: 400 }) };
  }
  if (clientId === null) {
    return { error: NextResponse.json({ error: 'Choose a client first.' }, { status: 400 }) };
  }

  // The same 403 a denied module gets and never a 404, so a client id cannot be
  // probed for existence.
  if (!await clientBelongsToScope(user, companyId, clientId, scope)) {
    return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }

  const allowed = await keysForClientAction(user, companyId, type, action, keys);
  if (action === 'add' && allowed.length === 0) {
    // Not turned on at all (or not chosen yet): say THAT, which is the first thing
    // to fix, rather than the subcategory message.
    const types = await typeEnabledFor(user.tenantId, companyId, type);
    if (!types.enabled) {
      return {
        error: NextResponse.json(
          { error: typeNotEnabledMessage(type, types.chosen), code: 'CLIENT_TYPE_NOT_ENABLED' },
          { status: 409 },
        ),
      };
    }
    // Configuration comes next. A distinct, readable refusal — not the bare 403 a
    // denied permission gets, which would read as "you may not" when the truth is
    // "not set up yet".
    return {
      error: NextResponse.json(
        { error: NOT_CONFIGURED_MESSAGE, code: 'CLIENT_NOT_CONFIGURED' },
        { status: 409 },
      ),
    };
  }
  return { clientId, keys: allowed };
}

/**
 * A `RecordContext` for ONE client of a client scope, for callers (the scan
 * save) that build contexts themselves. Throws with a user-readable message — the
 * save route reports it against the one record rather than failing the batch.
 */
export async function contextForClient<C extends { scope: string; keys: readonly CategoryKey[]; companyId: string | null }>(
  user: any,
  base: C,
  clientId: unknown,
): Promise<C & { clientId: string }> {
  if (!base.companyId) throw new Error('Client documents belong to a company workspace.');
  if (typeof clientId !== 'string' || !clientId) {
    throw new Error('Choose which client this document belongs to.');
  }
  if (!await clientBelongsToScope(user, base.companyId, clientId, base.scope)) {
    throw new Error('That client is not available in this company.');
  }
  const type = clientTypeOfModule(base.scope)!;
  const keys = await keysForClientAction(user, base.companyId, type, 'add', base.keys);
  if (keys.length === 0) {
    const types = await typeEnabledFor(user.tenantId, base.companyId, type);
    throw new Error(types.enabled ? NOT_CONFIGURED_MESSAGE : typeNotEnabledMessage(type, types.chosen));
  }
  return { ...base, keys, clientId: clientId.toLowerCase() };
}
