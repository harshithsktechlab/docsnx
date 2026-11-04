/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   WHAT AN INVITATION CALLS THE PLACE IT INVITES YOU TO                   ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * An invitation is a seat in a TENANT, but the person is being asked into one
 * half of it: the household (personal) or one or more companies (business). The
 * invite used to print `tenants.name` either way, so a member added inside the
 * "HSK TechLab" company was told they were invited to "Kishan Sanghani's
 * Workspace" — the account's umbrella name — and accepted into the wrong place
 * in their head.
 *
 *   personal seat   the personal workspace's name (`personalWorkspaceName`)
 *   business seat   the companies the seat was granted, by name
 *                   (no grant at all falls back to the account name)
 *
 * `seatWorkspaceLabel` is pure. `seatWorkspaceLabels` reads the grants for many
 * seats in one query, for the invitation list and the invite senders.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '@/lib/db';
import { companies, companyAccess } from '@/db/schema';
import { personalWorkspaceName } from '@/lib/workspaceName';

interface LabelTenant {
  name?: string | null;
  personalWorkspaceName?: string | null;
}

export function seatWorkspaceLabel(
  tenant: LabelTenant | null | undefined,
  accountScope: string | null | undefined,
  companyNames: readonly string[] = [],
): string {
  if (accountScope === 'business') {
    const names = [...new Set(companyNames.map((n) => n.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    if (names.length) return names.join(', ');
    return (tenant?.name || '').trim() || 'a workspace';
  }
  return personalWorkspaceName(tenant);
}

/** Company names granted to each seat, keyed by user id. Seats with no grant are absent. */
export async function companyNamesBySeat(userIds: readonly string[]): Promise<Map<string, string[]>> {
  const byUser = new Map<string, string[]>();
  if (!userIds.length) return byUser;

  const rows = await db
    .select({ userId: companyAccess.userId, name: companies.name })
    .from(companyAccess)
    .innerJoin(companies, eq(companies.id, companyAccess.companyId))
    .where(and(inArray(companyAccess.userId, [...userIds]), isNull(companies.deletedAt)));

  for (const r of rows) {
    const list = byUser.get(r.userId) ?? [];
    list.push(r.name);
    byUser.set(r.userId, list);
  }
  return byUser;
}

/** The label for one seat, reading its company grants. */
export async function labelForSeat(
  tenant: LabelTenant | null | undefined,
  seat: { id: string; accountScope?: string | null },
): Promise<string> {
  if (seat.accountScope !== 'business') return seatWorkspaceLabel(tenant, seat.accountScope);
  const grants = await companyNamesBySeat([seat.id]);
  return seatWorkspaceLabel(tenant, seat.accountScope, grants.get(seat.id) ?? []);
}
