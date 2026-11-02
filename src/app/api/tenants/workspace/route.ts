import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { withTenant } from '@/lib/db';
import { tenants } from '@/db/schema';
import { getUserFromRequest } from '@/lib/auth';
import { requireActivePlan } from '@/lib/planGate';
import { zodFieldErrors, firstFieldError } from '@/lib/zodFieldErrors';
import { writeAudit, ACTIONS, auditSentence } from '@/lib/audit';
import { personalWorkspaceName, namesCollide } from '@/lib/workspaceName';
import { serverError } from '@/lib/routeError';

export const dynamic = 'force-dynamic';

/**
 * Renaming the workspace after onboarding — the tenant admin's own route.
 *
 * Until this existed the only ways to change `tenants.name` were the onboarding
 * wizard's Welcome step (once) and PUT /api/admin/tenants/[id], which is
 * SUPER_ADMIN-only. Companies were renameable (PUT /api/companies/[id]) but only
 * from inside a record form.
 *
 * ── TWO NAMES, ONE ROUTE ────────────────────────────────────────────────────
 * `name`         the account's name: the household for a personal tenant, the
 *                business account for a business or combo one.
 * `personalName` a combo tenant's personal side (`personal_workspace_name`,
 *                0089). Refused for any other account type — those have no
 *                separate personal name to set, and silently ignoring the field
 *                would tell the caller it had worked.
 *
 * On a combo tenant the two must not read as the same name; that is the whole
 * point of having two.
 *
 * Plan-gated like the company rename: unlike the onboarding route, this runs
 * after setup, when a lapsed plan is a real lock.
 */
const nameField = z.string()
  .trim()
  .min(2, 'Workspace name is too short')
  .max(255, 'Workspace name must be at most 255 characters');

const schema = z.object({
  name: nameField.optional(),
  personalName: nameField.optional(),
}).refine((v) => v.name !== undefined || v.personalName !== undefined, {
  message: 'Nothing to rename',
});

export async function PUT(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    if (user.role !== 'TENANT_ADMIN') {
      return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 });
    }
    const planGate = requireActivePlan(user);
    if (planGate) return planGate;

    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      const fieldErrors = zodFieldErrors(parsed.error);
      return NextResponse.json(
        { success: false, error: firstFieldError(fieldErrors) || 'Invalid input', fieldErrors },
        { status: 400 },
      );
    }
    const { name, personalName } = parsed.data;

    const result = await withTenant(user.tenantId, async (tx) => {
      const [tenant] = await tx.select({
        name: tenants.name,
        personalWorkspaceName: tenants.personalWorkspaceName,
        accountType: tenants.accountType,
      })
        .from(tenants)
        .where(eq(tenants.id, user.tenantId))
        .limit(1);
      if (!tenant) return { status: 404 as const, error: 'Not found' };

      const isCombo = tenant.accountType === 'both';
      if (personalName !== undefined && !isCombo) {
        return { status: 400 as const, error: 'Only a combo account has a separate personal workspace name.' };
      }

      const nextName = name ?? tenant.name;
      // What the personal side reads as today. A legacy combo tenant has no
      // personal name of its own, so it reads as the account name — and must
      // keep doing so when ONLY the account is renamed, rather than silently
      // following it. Hence the pin below.
      const personalNow = personalWorkspaceName(tenant);
      const nextPersonal = personalName ?? personalNow;

      if (isCombo && namesCollide(nextName, nextPersonal)) {
        return {
          status: 400 as const,
          error: 'Your personal workspace and business account need different names.',
        };
      }

      const pinPersonal = isCombo && personalName === undefined && !tenant.personalWorkspaceName;

      await tx.update(tenants)
        .set({
          ...(name !== undefined ? { name } : {}),
          ...(personalName !== undefined ? { personalWorkspaceName: personalName } : {}),
          ...(pinPersonal ? { personalWorkspaceName: personalNow } : {}),
          updatedAt: new Date(),
        })
        .where(eq(tenants.id, user.tenantId));

      if (name !== undefined) {
        await writeAudit({
          tenantId: user.tenantId,
          userId: user.id,
          action: ACTIONS.tenant.update,
          resource: 'Tenant',
          details: auditSentence('update', {
            kind: isCombo ? 'business account name' : 'workspace name',
            name,
            note: name === tenant.name ? undefined : `was "${tenant.name}"`,
          }),
          req,
          entityType: 'tenants',
          entityId: user.tenantId,
        }, tx);
      }
      if (personalName !== undefined) {
        const was = personalNow;
        await writeAudit({
          tenantId: user.tenantId,
          userId: user.id,
          action: ACTIONS.tenant.update,
          resource: 'Tenant',
          details: auditSentence('update', {
            kind: 'personal workspace name',
            name: personalName,
            note: personalName === was ? undefined : `was "${was}"`,
          }),
          req,
          entityType: 'tenants',
          entityId: user.tenantId,
        }, tx);
      }

      return {
        status: 200 as const,
        name: nextName,
        personalWorkspaceName: nextPersonal,
      };
    });

    if (result.status !== 200) {
      return NextResponse.json({ success: false, error: result.error }, { status: result.status });
    }
    return NextResponse.json({
      success: true,
      name: result.name,
      personalWorkspaceName: result.personalWorkspaceName,
    });
  } catch (error) {
    return serverError(error, 'renaming the workspace');
  }
}
