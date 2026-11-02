import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { withTenant } from '@/lib/db';
import { tenants } from '@/db/schema';
import { getUserFromRequest } from '@/lib/auth';
import { zodFieldErrors, firstFieldError } from '@/lib/zodFieldErrors';
import { writeAudit, ACTIONS, auditSentence } from '@/lib/audit';
import { serverError } from '@/lib/routeError';
import { namesCollide } from '@/lib/workspaceName';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   Naming the workspace — the question /register used to ask first        ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * "Workspace Name" was the very first field on the sign-up form: asked of a
 * stranger, before they had seen a single screen of the product, and the one
 * answer they could never revise afterwards — only PUT /api/admin/tenants/[id]
 * can rename a tenant, and that is a platform-operator route.
 *
 * So the question moved to the onboarding wizard's Welcome step, and this is
 * where it lands. Until it is answered the row carries the name
 * `defaultWorkspaceName` derived from the admin's own at registration
 * (src/lib/workspaceName.ts), which is what the wizard prefills the input with.
 *
 * ── NOT PLAN-GATED, DELIBERATELY ──────────────────────────────────────────
 * Every other tenant-scoped route calls `requireActivePlan`. This one must not:
 * the wizard runs before billing, and `/api/onboarding/*` is exempt from the
 * onboarding gate for exactly this reason (see src/lib/onboardingGate.ts) —
 * gating a step of setup on having finished setup deadlocks the account.
 */
const workspaceSchema = z.object({
  name: z.string()
    .trim()
    .min(2, 'Workspace name is too short')
    .max(255, 'Workspace name must be at most 255 characters'),
  // A combo account names its personal side too (0089). Required for one and
  // refused for the rest — checked against the tenant row below, since the
  // account type is not in the body and must not be taken from it.
  personalName: z.string()
    .trim()
    .min(2, 'Personal workspace name is too short')
    .max(255, 'Personal workspace name must be at most 255 characters')
    .optional(),
});

export async function POST(req: Request) {
  try {
    const user = await getUserFromRequest(req);

    // Only the admin names the workspace. A member can exist before setup is
    // finished — the wizard's Members step creates them — and they are held on
    // /onboarding too, so this has to refuse them the same way every other step
    // does rather than letting a member rename the account they joined.
    if (!user || user.role !== 'TENANT_ADMIN') {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const parsed = workspaceSchema.safeParse(await req.json());
    if (!parsed.success) {
      // Same `fieldErrors` contract the register form and the record forms
      // speak, keyed by the input's id.
      const fieldErrors = zodFieldErrors(parsed.error);
      return NextResponse.json(
        { success: false, error: firstFieldError(fieldErrors), fieldErrors },
        { status: 400 },
      );
    }

    const { name, personalName } = parsed.data;

    const outcome = await withTenant(user.tenantId, async (tx) => {
      const [tenant] = await tx.select({ accountType: tenants.accountType })
        .from(tenants)
        .where(eq(tenants.id, user.tenantId))
        .limit(1);
      const isCombo = tenant?.accountType === 'both';

      if (isCombo && !personalName) {
        return { error: 'Give your personal workspace a name as well.', field: 'personalName' };
      }
      if (isCombo && namesCollide(name, personalName)) {
        return { error: 'Your personal workspace and business account need different names.', field: 'personalName' };
      }

      // `tenants.id` IS the tenant id — there is no `tenantId` column to filter
      // on here, and the id comes from the session, never from the body. Same
      // shape as the update in POST /api/onboarding/complete.
      await tx.update(tenants)
        .set({
          name,
          ...(isCombo ? { personalWorkspaceName: personalName } : {}),
          updatedAt: new Date(),
        })
        .where(eq(tenants.id, user.tenantId));

      await writeAudit({
        tenantId: user.tenantId,
        userId: user.id,
        action: ACTIONS.tenant.update,
        resource: 'Tenant',
        details: auditSentence('update', {
          kind: isCombo ? 'business account name' : 'workspace name',
          name,
          note: 'set during onboarding',
        }),
        req,
        entityType: 'tenants',
        entityId: user.tenantId,
      }, tx);
      if (isCombo) {
        await writeAudit({
          tenantId: user.tenantId,
          userId: user.id,
          action: ACTIONS.tenant.update,
          resource: 'Tenant',
          details: auditSentence('update', {
            kind: 'personal workspace name',
            name: personalName!,
            note: 'set during onboarding',
          }),
          req,
          entityType: 'tenants',
          entityId: user.tenantId,
        }, tx);
      }
      return null;
    });

    if (outcome) {
      return NextResponse.json(
        { success: false, error: outcome.error, fieldErrors: { [outcome.field]: outcome.error } },
        { status: 400 },
      );
    }

    return NextResponse.json({ success: true, name, personalName: personalName ?? null });
  } catch (error: any) {
    return serverError(error, 'saving your workspace name');
  }
}
