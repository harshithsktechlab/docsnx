import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { profiles, users } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { getUserFromRequest, hasPermission } from '@/lib/auth';
import { writeAudit, ACTIONS, auditSentence } from '@/lib/audit';
import { serverError } from '@/lib/routeError';
import {
  encryptJsonKeys, decryptJsonKeys, PROFILE_LEGAL_KEYS,
} from '@/lib/records/jsonFieldCrypto';

// Legal identifiers (PAN/Aadhaar/passport) are stored encrypted in legalDetails.
// The key list and the two helpers moved to jsonFieldCrypto.ts when
// company_profiles needed the same rule for its GST/PAN/TAN — one copy, so the
// two cannot drift on the empty-string and idempotency edge cases.
function decryptProfileForClient(profile: any) {
  if (!profile?.legalDetails) return profile;
  return { ...profile, legalDetails: decryptJsonKeys(profile.legalDetails, PROFILE_LEGAL_KEYS) };
}
function encryptLegal(legalDetails: any) {
  return encryptJsonKeys(legalDetails, PROFILE_LEGAL_KEYS);
}

export async function GET(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const targetUserId = searchParams.get('userId') || user.id;

    // Access control
    if (targetUserId !== user.id) {
      const allowed = await hasPermission(user, 'profiles', 'view');
      if (!allowed) {
        return NextResponse.json({ error: 'Forbidden. Viewing other profiles denied.' }, { status: 403 });
      }
    }

    // Resolve target user
    const targetUser = await db.query.users.findFirst({
      where: and(eq(users.id, targetUserId), eq(users.tenantId, user.tenantId)),
    });

    if (!targetUser) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    let profile = await db.query.profiles.findFirst({
      where: eq(profiles.userId, targetUserId),
    });

    // Create empty profile if not exists
    if (!profile) {
      const [newProfile] = await db.insert(profiles).values({
        userId: targetUserId,
        personalDetails: {},
        educationDetails: {},
        shoppingDetails: {},
        legalDetails: {},
      }).returning();
      profile = newProfile;
    }

    return NextResponse.json({ success: true, profile: decryptProfileForClient(profile) });
  } catch (error) {
    return serverError(error, 'loading profile');
  }
}

export async function PUT(req: Request) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { userId, personalDetails, educationDetails, shoppingDetails, legalDetails } = await req.json();
    const targetUserId = userId || user.id;

    // Target user tenant check. The row's NAME is kept for the audit line,
    // which used to print the bare uuid this lookup already resolves.
    let targetName: string | null = user.name ?? null;
    if (targetUserId !== user.id) {
      const targetUser = await db.query.users.findFirst({
        where: and(eq(users.id, targetUserId), eq(users.tenantId, user.tenantId)),
      });
      if (!targetUser) {
        return NextResponse.json({ error: 'User not found' }, { status: 404 });
      }
      targetName = targetUser.name ?? null;

      const allowed = await hasPermission(user, 'profiles', 'edit');
      if (!allowed) {
        return NextResponse.json({ error: 'Forbidden. Modifying other profiles denied.' }, { status: 403 });
      }
    } else {
      // Standard users need permission to edit their own profile if permissions block it,
      // but usually editing their own profile is allowed. Let's verify standard permissions.
      const allowed = await hasPermission(user, 'profiles', 'edit');
      if (!allowed && user.role === 'STANDARD') {
        return NextResponse.json({ error: 'Forbidden. Editing denied.' }, { status: 403 });
      }
    }

    // Encrypt legal identifiers (PAN/Aadhaar/passport) before persisting.
    const encLegal = legalDetails !== undefined ? encryptLegal(legalDetails) : undefined;

    // Update profile (upsert)
    const updateData: any = {};
    if (personalDetails !== undefined) updateData.personalDetails = personalDetails;
    if (educationDetails !== undefined) updateData.educationDetails = educationDetails;
    if (shoppingDetails !== undefined) updateData.shoppingDetails = shoppingDetails;
    if (encLegal !== undefined) updateData.legalDetails = encLegal;

    // Always set updatedAt to trigger update
    updateData.updatedAt = new Date();

    const [profile] = await db.insert(profiles)
      .values({
        userId: targetUserId,
        personalDetails: personalDetails || {},
        educationDetails: educationDetails || {},
        shoppingDetails: shoppingDetails || {},
        legalDetails: encLegal || {},
      })
      .onConflictDoUpdate({
        target: profiles.userId,
        set: updateData
      })
      .returning();

    // Log action
    await writeAudit({
      tenantId: user.tenantId,
      userId: user.id,
      action: ACTIONS.profile.update,
      details: auditSentence('update', { kind: 'profile', member: targetName }),
      req,
      entityType: 'profiles',
      entityId: profile?.id,
    });

    return NextResponse.json({ success: true, profile: decryptProfileForClient(profile) });
  } catch (error) {
    return serverError(error, 'updating profile');
  }
}
