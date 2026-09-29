/**
 * What is filed under one member — the list the removal picker renders.
 *
 * Removing a member asks the admin which of that person's records should go
 * with them, and this is what fills that dialog. It exists as its own route
 * rather than as a field on GET /api/users/[id] because it is paged and
 * searchable: a member with three hundred records is a scroll, not a payload.
 *
 * ⚠ WHAT THIS MAY RETURN. Titles, category labels and dates. Nothing else.
 * `listHolderRecords` enforces that in its projection, and the reason is worth
 * repeating at the route: this endpoint exists to help someone confirm a
 * deletion, and widening it to "show a bit more detail" would turn a
 * confirmation dialog into a way to read the vault. No `passwordEncrypted`, no
 * record payload, no sealed field (AGENTS.md §6).
 *
 * Admin-only, like every other verb under /api/users/[id] — a standard member
 * has no business enumerating another member's records.
 */
import { NextResponse } from 'next/server';
import { and, eq, isNull } from 'drizzle-orm';
import { withTenant } from '@/lib/db';
import { users } from '@/db/schema';
import { getUserFromRequest } from '@/lib/auth';
import { requireActivePlan } from '@/lib/planGate';
import { parseQueryParams } from '@/lib/api-pagination';
import { listHolderRecords } from '@/lib/account/memberRemoval';
import { serverError } from '@/lib/routeError';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const currentUser = await getUserFromRequest(req);
    if (!currentUser || (currentUser.role !== 'TENANT_ADMIN' && currentUser.role !== 'SUPER_ADMIN')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
    }
    const gate = requireActivePlan(currentUser);
    if (gate) return gate;

    // Resolve the member against THIS tenant before using their id as a holder
    // filter. `id` is a path param and therefore untrusted; this lookup is what
    // makes it safe to scope by, and a member of another tenant 404s here
    // rather than reaching the record queries at all.
    const target = await withTenant(currentUser.tenantId, async (tx) => {
      return tx.query.users.findFirst({
        where: and(
          eq(users.id, id),
          eq(users.tenantId, currentUser.tenantId),
          isNull(users.deletedAt),
        ),
        columns: { id: true, name: true, role: true },
      });
    });

    if (!target) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }
    if (target.role === 'SUPER_ADMIN' && currentUser.role === 'TENANT_ADMIN') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const query = parseQueryParams(req);
    const limit = Math.min(query.limit, 200);
    const records = await listHolderRecords(currentUser, target.id, {
      search: query.search,
      limit,
      offset: (query.page - 1) * limit,
    });

    return NextResponse.json({
      success: true,
      holder: { id: target.id, name: target.name },
      ...records,
      pagination: { page: query.page, limit },
    });
  } catch (error) {
    return serverError(error, 'listing member records');
  }
}
