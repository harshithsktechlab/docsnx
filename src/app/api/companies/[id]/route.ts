/**
 * One company: rename it, or erase it.
 *
 * TENANT_ADMIN only, like its parent — a company is a structural object, and
 * the same admin owns the member list that reaches it.
 *
 * ── THE ID IS NOT RENAMEABLE, AND THE NAME IS NOT THE ID ───────────────────
 * `companies.id` is the Drive folder segment for every record the company
 * holds, so it is as immutable as a category key. `name` is display-only and
 * free to change — which is exactly why the folder is keyed on the id.
 *
 * ── DELETE IS AN ERASURE NOW, AND IT NO LONGER REFUSES ─────────────────────
 * It used to be a soft-delete that gave up entirely on a company still holding
 * documents — `documents.company_id` is ON DELETE RESTRICT, so retiring one
 * anyway would have left rows pointing at a company the UI no longer lists:
 * visible nowhere, deletable by nobody. The refusal was the right answer to a
 * retirement that could not clean up after itself.
 *
 * It is not a retirement any more. `eraseCompanyWorkspace` deletes the
 * company's records, its Drive subtree and the members who worked only on it
 * FIRST, so by the time the company row goes there is nothing left for RESTRICT
 * to protect — and nothing stranded. "Move your records out first" is gone.
 *
 * The price of that is a real confirmation. The body must carry the company's
 * own name, typed by hand, exactly as /api/account/delete demands the workspace
 * name: this destroys data in a third party's storage, keeps no backup, and a
 * verb-only DELETE would put all of it one stray fetch away.
 */
import { NextResponse } from 'next/server';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { withTenant } from '@/lib/db';
import { companies } from '@/db/schema';
import { getUserFromRequest } from '@/lib/auth';
import { requireActivePlan } from '@/lib/planGate';
import { writeAudit, ACTIONS, auditSentence } from '@/lib/audit';
import { eraseCompanyWorkspace } from '@/lib/account/workspaceErasure';
import { serverError } from '@/lib/routeError';

export const dynamic = 'force-dynamic';

const patchSchema = z.object({
  name: z.string().trim().min(1, 'A company name is required').max(255),
});

/** The company's own name, typed by hand. See the header's note on DELETE. */
const deleteSchema = z.object({
  confirm: z.string().min(1).max(255),
});

/** Admin-only, plan-active, and the id must be this tenant's. */
async function gate(req: Request, id: string) {
  const user = await getUserFromRequest(req);
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  if (user.role !== 'TENANT_ADMIN') {
    return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }
  const planGate = requireActivePlan(user);
  if (planGate) return { error: planGate };

  const [row] = await withTenant(user.tenantId, (tx) => tx
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .where(and(
      eq(companies.id, id),
      // Scoped by the SESSION's tenant, so an id from another workspace simply
      // does not resolve — the same 404 a fabricated id gets.
      eq(companies.tenantId, user.tenantId),
      isNull(companies.deletedAt),
    ))
    .limit(1));

  if (!row) return { error: NextResponse.json({ error: 'Not found' }, { status: 404 }) };
  return { user, company: row };
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const gated = await gate(req, id);
    if ('error' in gated) return gated.error;
    const { user, company } = gated;

    const parsed = patchSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message || 'Invalid input' },
        { status: 400 },
      );
    }

    await withTenant(user.tenantId, async (tx) => {
      await tx.update(companies)
        .set({ name: parsed.data.name, updatedAt: new Date() })
        .where(and(eq(companies.id, id), eq(companies.tenantId, user.tenantId)));

      await writeAudit({
        tenantId: user.tenantId,
        userId: user.id,
        action: ACTIONS.company.update,
        details: auditSentence('update', {
          kind: 'company',
          name: parsed.data.name,
          note: parsed.data.name === company.name ? undefined : `was "${company.name}"`,
        }),
        req,
        entityType: 'companies',
        entityId: id,
      }, tx);
    });

    return NextResponse.json({ success: true, company: { id, name: parsed.data.name } });
  } catch (error) {
    if (String((error as any)?.code) === '23505') {
      return NextResponse.json({ error: 'That company already exists.' }, { status: 409 });
    }
    return serverError(error, 'renaming the company');
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const gated = await gate(req, id);
    if ('error' in gated) return gated.error;
    const { user, company } = gated;

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      raw = null;
    }
    const parsed = deleteSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Type the company name to confirm deletion.' },
        { status: 400 },
      );
    }
    if (parsed.data.confirm.trim() !== company.name.trim()) {
      return NextResponse.json(
        { error: 'The company name does not match. Type it exactly to confirm deletion.' },
        { status: 400 },
      );
    }

    // Writes its own audit row, at TENANT level — a row filed under this
    // company would be destroyed by the cascade that removes it.
    const outcome = await eraseCompanyWorkspace({ id: user.id, tenantId: user.tenantId }, id, req);

    return NextResponse.json({
      success: true,
      // Reported rather than swallowed: Drive failures are never fatal, but the
      // admin is the only person who can remove what we could not.
      ...outcome,
      message: `${company.name} and everything filed under it has been permanently erased.`,
    });
  } catch (error) {
    return serverError(error, 'erasing the company');
  }
}
