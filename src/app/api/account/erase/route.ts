/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   POST /api/account/erase — delete ONE HALF of an account                ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The sibling of `DELETE /api/account/delete`, which erases the whole tenant.
 * This erases the personal half or the business half and leaves the other one
 * running.
 *
 * A THIRD target — one named company — deliberately does NOT live here. It has a
 * route already (`DELETE /api/companies/[id]`), that route is what the company
 * admin UI calls, and giving the same action two endpoints is how the two drift
 * into disagreeing about what "delete" means. That route now performs the real
 * erasure, under the same typed-name confirmation this one uses.
 *
 * ── WHY POST AND NOT DELETE ────────────────────────────────────────────────
 * There is no single resource being addressed. `DELETE /api/account` would mean
 * the whole account, which is the other route; this takes a target and erases a
 * partition of one. POST with an explicit `target` says that out loud, and makes
 * the two impossible to confuse in a log.
 *
 * ── THE CONFIRMATION IS LOAD-BEARING, NOT CEREMONIAL ───────────────────────
 * The same guard `/api/account/delete` uses, for the same reasons: this is
 * irreversible, there is no backup to restore from, and it destroys data in a
 * third party's storage (the tenant's own Google Drive). A verb-only call would
 * put all of that one stray fetch away.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { tenants } from '@/db/schema';
import { getUserFromRequest } from '@/lib/auth';
import {
  eraseBusinessWorkspace,
  erasePersonalWorkspace,
} from '@/lib/account/workspaceErasure';
import { serverError } from '@/lib/routeError';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  target: z.enum(['personal', 'business']),
  /** The workspace name, typed by hand. See the note above. */
  confirm: z.string().min(1).max(255),
});

export async function POST(req: NextRequest) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Same gate as the whole-account erasure. Not `hasPermission`: erasing half
    // an account is not an operation on a module, and no module permission
    // should ever add up to it.
    if (user.role !== 'TENANT_ADMIN') {
      return NextResponse.json(
        { error: 'Only Tenant Admins can delete an account.' },
        { status: 403 },
      );
    }

    // From the session, never the body (AGENTS.md §6). The body carries a
    // target and a confirmation string and nothing else.
    const tenantId = user.tenantId;

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      raw = null;
    }

    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }
    const { target, confirm } = parsed.data;

    const tenant = await db.query.tenants.findFirst({
      where: eq(tenants.id, tenantId),
      columns: { id: true, name: true, accountType: true },
    });
    if (!tenant) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }

    if (confirm.trim() !== tenant.name.trim()) {
      return NextResponse.json(
        { error: 'The workspace name does not match. Type it exactly to confirm.' },
        { status: 400 },
      );
    }

    /**
     * Refusing to erase the half that is the whole account.
     *
     * On a `personal`-only tenant "erase the business" would delete nothing and
     * report success — an admin would reasonably read that as their companies
     * being gone. Worse in the other direction: erasing the personal half of a
     * personal-only tenant would empty the account entirely while leaving the
     * tenant row, the plan and the bill in place. That is `/api/account/delete`,
     * and someone who means it should be sent there rather than arriving at it
     * sideways.
     */
    if (tenant.accountType !== 'both') {
      return NextResponse.json({
        error: tenant.accountType === target
          ? 'That is the only account you have. Use "Delete the entire account" instead.'
          : `This workspace has no ${target} account to delete.`,
      }, { status: 409 });
    }

    const actor = { id: user.id, tenantId };
    const outcome = target === 'personal'
      ? await erasePersonalWorkspace(actor, req)
      : await eraseBusinessWorkspace(actor, req);

    return NextResponse.json({
      success: true,
      target,
      /**
       * Reported rather than swallowed. Drive failures are never fatal (the
       * user asked for this and a Google outage must not block it), but the
       * admin is the only person who can go and remove what we could not —
       * so the answer has to say so.
       */
      ...outcome,
      message: target === 'personal'
        ? 'The personal account and everything in it has been permanently erased.'
        : 'The business account and every company in it has been permanently erased.',
    });
  } catch (error) {
    return serverError(error, 'erasing the workspace');
  }
}
