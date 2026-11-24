/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   WHICH KINDS OF CLIENT A COMPANY KEEPS — Individual, Company, or Both   ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Chosen ONCE per company workspace, by a workspace admin, the first time Client
 * Documents is opened. Only the chosen kind(s) get a tab, can have subcategories
 * configured, can have clients added, and can receive documents. A kind that is
 * not enabled behaves exactly as one nothing is configured for: the scan ignores
 * it, an upload to it is refused, and nothing about it is offered.
 *
 * NO ROW = NOT CHOSEN. Nothing is inferred from earlier configuration, so every
 * company sees the chooser once (drizzle/0099).
 *
 * ── A KIND WITH CLIENTS CANNOT BE TURNED OFF ───────────────────────────────
 * Turning a kind off would hide its clients, and their documents with them. So it
 * is refused while any live client of that kind exists, and the answer says how
 * many are in the way — the admin removes them first, deliberately, the way a
 * company that holds records is removed.
 *
 * Every query: `withTenant` AND an explicit tenant predicate (AGENTS.md §6).
 */
import { and, count, eq, isNull } from 'drizzle-orm';
import { withTenant } from '@/lib/db';
import { clients, clientTypeSettings } from '@/db/schema';
import { type ClientType, CLIENT_TYPES } from '@/lib/clientCategories';

/** Anything that can run a select: a `withTenant` transaction. */
type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

export interface ClientTypes {
  /** False until a workspace admin has chosen. */
  chosen: boolean;
  individual: boolean;
  company: boolean;
}

export const NOT_CHOSEN: ClientTypes = { chosen: false, individual: false, company: false };

export async function loadClientTypes(tx: Tx, tenantId: string, companyId: string): Promise<ClientTypes> {
  const [row] = await tx
    .select({
      individual: clientTypeSettings.individualEnabled,
      company: clientTypeSettings.companyEnabled,
    })
    .from(clientTypeSettings)
    .where(and(
      eq(clientTypeSettings.tenantId, tenantId),
      eq(clientTypeSettings.companyId, companyId),
      isNull(clientTypeSettings.deletedAt),
    ))
    .limit(1);
  return row ? { chosen: true, individual: row.individual, company: row.company } : NOT_CHOSEN;
}

/** The kinds that are enabled, in the order the tabs appear. */
export function enabledTypes(types: ClientTypes): ClientType[] {
  return CLIENT_TYPES.filter((t) => types[t]);
}

export function isTypeEnabled(types: ClientTypes, type: ClientType): boolean {
  return types.chosen && types[type];
}

/** Said when a request names a kind the company has not turned on. */
export function typeNotEnabledMessage(type: ClientType, chosen: boolean): string {
  const noun = type === 'company' ? 'company' : 'individual';
  return chosen
    ? `This company does not keep ${noun} clients. A workspace admin can turn them on under Client Documents → Change client types.`
    : 'Choose which kinds of client this company keeps first — open Client Documents.';
}

/** Is `type` enabled for this company? One query; for gates that have no types in hand. */
export async function typeEnabledFor(
  tenantId: string,
  companyId: string,
  type: ClientType,
): Promise<{ enabled: boolean; chosen: boolean }> {
  const types = await withTenant(tenantId, (tx) => loadClientTypes(tx, tenantId, companyId));
  return { enabled: isTypeEnabled(types, type), chosen: types.chosen };
}

export async function countLiveClients(tx: Tx, tenantId: string, companyId: string, type: ClientType): Promise<number> {
  const [{ n }] = await tx
    .select({ n: count() })
    .from(clients)
    .where(and(
      eq(clients.tenantId, tenantId),
      eq(clients.companyId, companyId),
      eq(clients.clientType, type),
      isNull(clients.deletedAt),
    ));
  return n;
}

export type SaveResult =
  | { ok: true; types: ClientTypes; before: ClientTypes }
  | { ok: false; error: string; blocked: Partial<Record<ClientType, number>> };

/**
 * Make the choice exactly `{ individual, company }` (at least one true — the
 * route and the CHECK constraint both insist).
 *
 * A kind being turned OFF is checked against live clients, whether or not there
 * was a stored choice before: a client that exists without one (data from before
 * this setting) is just as hidden by turning its kind off.
 */
export async function saveClientTypes(
  tenantId: string,
  companyId: string,
  wanted: { individual: boolean; company: boolean },
): Promise<SaveResult> {
  return withTenant(tenantId, async (tx) => {
    const before = await loadClientTypes(tx, tenantId, companyId);

    const blocked: Partial<Record<ClientType, number>> = {};
    for (const type of CLIENT_TYPES) {
      if (wanted[type]) continue;
      const n = await countLiveClients(tx, tenantId, companyId, type);
      if (n > 0) blocked[type] = n;
    }
    const blockedTypes = Object.keys(blocked) as ClientType[];
    if (blockedTypes.length > 0) {
      const parts = blockedTypes.map((t) => {
        const n = blocked[t]!;
        return `${n} ${t === 'company' ? 'company' : 'individual'} client${n === 1 ? '' : 's'}`;
      });
      return {
        ok: false as const,
        blocked,
        error: `You still have ${parts.join(' and ')}. Remove ${blockedTypes.length === 1 && blocked[blockedTypes[0]] === 1 ? 'that client' : 'those clients'} first, then turn this off.`,
      };
    }

    if (before.chosen) {
      await tx.update(clientTypeSettings)
        .set({ individualEnabled: wanted.individual, companyEnabled: wanted.company, updatedAt: new Date() })
        .where(and(
          eq(clientTypeSettings.tenantId, tenantId),
          eq(clientTypeSettings.companyId, companyId),
          isNull(clientTypeSettings.deletedAt),
        ));
    } else {
      await tx.insert(clientTypeSettings).values({
        tenantId,
        companyId,
        individualEnabled: wanted.individual,
        companyEnabled: wanted.company,
      });
    }

    return { ok: true as const, before, types: { chosen: true, ...wanted } };
  });
}
