import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db, withTenant } from '@/lib/db';
import { users } from '@/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import { comparePassword, getUserFromRequest } from '@/lib/auth';
import { toDialString, isBlankPhone } from '@/lib/phone';
import { contactEditProblem } from '@/lib/userContactValidation';
import {
  isDuplicatePhone, DUPLICATE_PHONE_MESSAGE,
  isDuplicateEmail, DUPLICATE_EMAIL_MESSAGE,
} from '@/lib/dbErrors';
import { writeAudit, ACTIONS, auditSentence } from '@/lib/audit';
import { accountSecretRateLimiter } from '@/lib/rateLimit';
import { serverError } from '@/lib/routeError';

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   EDIT YOUR OWN NAME, EMAIL AND MOBILE                                   ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Every signed-in person — member or admin — edits THEIR OWN row here. The
 * target is `user.id` from the session and never anything in the body, and the
 * schema below has no `role`, `tenantId`, `permissions` or sign-in switch, so
 * this route cannot be used to touch anyone else or to widen one's own access
 * (`.strict()` makes a body that tries a 400 rather than a silent ignore).
 *
 * Email and mobile are the login identities, so changing either needs the
 * CURRENT PASSWORD again: a stolen session alone must not be able to repoint
 * the account at an address the thief controls. A name change does not.
 *
 * Deliberately no `requireActivePlan`: this is the person's own credentials,
 * not workspace data, and a member of a lapsed workspace still owns them.
 */
const bodySchema = z.object({
  name: z.string().trim().min(1, 'Name is required.').max(255).optional(),
  email: z.string().trim().max(255).optional(),
  phoneNumber: z.string().trim().max(50).optional(),
  currentPassword: z.string().max(128).optional(),
}).strict();

export async function PATCH(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message || 'Invalid input' },
        { status: 400 },
      );
    }
    const { name, email, phoneNumber, currentPassword } = parsed.data;

    // `getUserFromRequest` strips the hash, so the row is read again here.
    const current = await withTenant(user.tenantId, (tx) => tx.query.users.findFirst({
      where: and(eq(users.id, user.id), eq(users.tenantId, user.tenantId), isNull(users.deletedAt)),
    }));
    if (!current) return NextResponse.json({ error: 'User not found' }, { status: 404 });

    // '' is a deliberate clear for a member (their email is optional).
    const cleanEmail = email !== undefined ? (email.toLowerCase() || null) : undefined;
    const emailChanged = cleanEmail !== undefined && cleanEmail !== (current.email ?? null);
    const phoneChanged = phoneNumber !== undefined
      && toDialString(phoneNumber) !== (current.phoneDial ?? null);

    const mergedEmail = cleanEmail !== undefined ? cleanEmail : current.email;
    const mergedPhone = phoneNumber !== undefined ? phoneNumber : current.phoneNumber;
    const problem = contactEditProblem({
      role: current.role,
      email: mergedEmail,
      phoneNumber: mergedPhone,
      signInDisabled: !!current.signInDisabledAt,
    });
    if (problem) return NextResponse.json({ error: problem }, { status: 400 });

    if (emailChanged || phoneChanged) {
      if (!currentPassword) {
        return NextResponse.json(
          { error: 'Enter your current password to change your email or mobile number.' },
          { status: 403 },
        );
      }
      const limit = accountSecretRateLimiter.check(`profile:${user.id}`);
      if (!limit.success) {
        return NextResponse.json(
          { error: 'Too many attempts. Please try again later.' },
          { status: 429, headers: { 'Retry-After': String(Math.ceil((limit.resetTime - Date.now()) / 1000)) } },
        );
      }
      if (!(await comparePassword(currentPassword, current.passwordHash))) {
        return NextResponse.json({ error: 'Your current password is incorrect.' }, { status: 403 });
      }
    }

    const updateData: Partial<typeof users.$inferInsert> = {};
    if (name !== undefined && name !== current.name) updateData.name = name;
    if (phoneChanged) {
      updateData.phoneNumber = isBlankPhone(phoneNumber) ? null : phoneNumber;
      // Always in the same statement as phoneNumber — see users.phone_dial.
      updateData.phoneDial = toDialString(phoneNumber!);
    }
    if (emailChanged) {
      if (cleanEmail) {
        // Same unscoped lookup as PUT /api/users/[id]: an address is unique across
        // live accounts platform-wide, so it must not be filtered to this tenant.
        const existing = await db.query.users.findFirst({
          where: and(isNull(users.deletedAt), eq(users.email, cleanEmail)),
        });
        if (existing && existing.id !== user.id) {
          return NextResponse.json({ error: DUPLICATE_EMAIL_MESSAGE }, { status: 400 });
        }
      }
      updateData.email = cleanEmail;
    }

    if (Object.keys(updateData).length === 0) {
      return NextResponse.json({ success: true, changed: false });
    }

    const updated = await withTenant(user.tenantId, async (tx) => {
      const [row] = await tx.update(users)
        .set({ ...updateData, updatedAt: new Date() })
        .where(and(eq(users.id, user.id), eq(users.tenantId, user.tenantId)))
        .returning();

      const fields = [
        updateData.name !== undefined && 'name',
        phoneChanged && 'mobile number',
        emailChanged && 'email',
      ].filter(Boolean).join(', ');
      await writeAudit({
        tenantId: user.tenantId,
        userId: user.id,
        action: ACTIONS.user.update,
        details: auditSentence('update', {
          kind: 'member',
          name: row.name,
          note: `changed their own ${fields}`,
        }),
        req,
        entityType: 'users',
        entityId: user.id,
      }, tx);
      return row;
    });

    const { passwordHash: _omit, resetToken: _t, resetTokenExpiry: _e, ...safeUser } = updated;
    return NextResponse.json({ success: true, changed: true, user: safeUser });
  } catch (error) {
    if (isDuplicatePhone(error)) {
      return NextResponse.json({ error: DUPLICATE_PHONE_MESSAGE }, { status: 400 });
    }
    if (isDuplicateEmail(error)) {
      return NextResponse.json({ error: DUPLICATE_EMAIL_MESSAGE }, { status: 400 });
    }
    return serverError(error, 'updating your details');
  }
}
