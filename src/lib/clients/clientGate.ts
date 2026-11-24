/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE CLIENT ROUTES' GATE                                                ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Every /api/clients route asks the same four questions in the same order, so
 * they are asked once, here:
 *
 *   1. who      authenticated, and not a platform role (a SUPER_ADMIN has no
 *               tenant data to read)
 *   2. which    `resolveUtilityCompany` PROVES the company in the query —
 *               hasCompanyAccess, the BUSINESS plan, onboarding — and a client
 *               ALWAYS has one: absent is a 400, because there is no household
 *               version of a client
 *   3. what     `hasPermission` on the client type's own module key
 *               (`biz_client_individual` / `biz_client_company`), so a member can
 *               be granted individual clients and not company ones
 *   4. 403      never 404: an unreachable company and a missing one answer alike
 *
 * Returns the proven company NAME as well, because an audit line needs words and
 * `auditSentence` refuses to print a uuid.
 */
import { NextResponse } from 'next/server';
import { and, eq, isNull } from 'drizzle-orm';
import { withTenant } from '@/lib/db';
import { companies } from '@/db/schema';
import { getUserFromRequest, hasPermission } from '@/lib/auth';
import { resolveUtilityCompany } from '@/lib/records/companyScope';
import { typeEnabledFor, typeNotEnabledMessage } from '@/lib/clients/clientTypes';
import { CLIENT_MODULE_BY_TYPE, type ClientType, isClientType } from '@/lib/clientCategories';
import type { RecordAction } from '@/lib/records/handler';

export interface ClientGate {
  user: any;
  companyId: string;
  companyName: string;
}

export function clientTypeFromRequest(req: Request): ClientType | null {
  const raw = new URL(req.url).searchParams.get('type');
  return isClientType(raw) ? raw : null;
}

/**
 * Steps 1-2: who, and which company. Used directly by the `[id]` routes, which
 * learn the client's TYPE only by loading the row, and then check permission for
 * it with `canOnClientType`.
 */
export async function gateClientWorkspace(
  req: Request,
): Promise<{ error: Response } | ClientGate> {
  const user = await getUserFromRequest(req);
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  if (user.role === 'SUPER_ADMIN') {
    return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }

  const scope = await resolveUtilityCompany(req, user);
  if ('error' in scope) return scope;
  if (!scope.companyId) {
    return {
      error: NextResponse.json(
        { error: 'Client Documents belong to a company. Choose one first.' },
        { status: 400 },
      ),
    };
  }

  // `hasCompanyAccess` (inside resolveUtilityCompany) proved the row exists and
  // is this tenant's; this reads it for the name only.
  const [company] = await withTenant(user.tenantId, (tx) => tx
    .select({ name: companies.name })
    .from(companies)
    .where(and(
      eq(companies.id, scope.companyId!),
      eq(companies.tenantId, user.tenantId),
      isNull(companies.deletedAt),
    ))
    .limit(1));
  if (!company) return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };

  return { user, companyId: scope.companyId, companyName: company.name };
}

/** Step 3: may this member do `action` to clients of `type`? */
export async function canOnClientType(
  user: any,
  type: ClientType,
  action: RecordAction,
): Promise<boolean> {
  return hasPermission(user, CLIENT_MODULE_BY_TYPE[type], action);
}

export const FORBIDDEN = () => NextResponse.json({ error: 'Forbidden' }, { status: 403 });

/** Steps 1-3 for a route that already knows the type. */
export async function gateClients(
  req: Request,
  type: ClientType,
  action: RecordAction,
): Promise<{ error: Response } | ClientGate> {
  const gated = await gateClientWorkspace(req);
  if ('error' in gated) return gated;
  if (!await canOnClientType(gated.user, type, action)) return { error: FORBIDDEN() };

  // The company must have chosen to keep this KIND of client (Client Documents →
  // Change client types). A kind it has not turned on behaves as if nothing about
  // it exists: its clients, its subcategories and its uploads are all refused.
  const { enabled, chosen } = await typeEnabledFor(gated.user.tenantId, gated.companyId, type);
  if (!enabled) {
    return {
      error: NextResponse.json(
        { error: typeNotEnabledMessage(type, chosen), code: 'CLIENT_TYPE_NOT_ENABLED' },
        { status: 409 },
      ),
    };
  }
  return gated;
}
