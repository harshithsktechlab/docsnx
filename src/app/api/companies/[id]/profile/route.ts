/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   /api/companies/<id>/profile — the company's own identity               ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * What /api/profiles is to a member, this is to a company: legal name, entity
 * type, registration number, tax identifiers, registered address, contact.
 *
 * ── ITS GATE IS NOT THE MEMBER ROUTES' ─────────────────────────────────────
 * Who may reach a company is decided by /api/users, TENANT_ADMIN-only, because
 * that is a structural decision. Reading the company's GST number is not —
 * an accountant added to Acme needs it, and gating this on the admin role would
 * mean the one person who never files anything is the only one who can see the
 * details every filing needs. So the gate is the ordinary two-part answer:
 *
 *   hasCompanyAccess   WHICH company — and it is what proves the company
 *                      exists, is live, is THIS tenant's and is reachable
 *   hasPermission      WHAT may be done to it, on the `profiles` key
 *
 * `profiles` rather than a new permission key on purpose. It is already one of
 * the four SHARED_UTILITY_KEYS — the utilities that exist in both accounts, where
 * the permission says "you may use Profiles" and the company on the request says
 * WHICH profile. Minting a `company_profiles` key instead would create a module
 * nobody is seeded with, which `hasPermission` denies outright, so every
 * existing business member would be locked out of a page built for them.
 *
 * ── 403, NEVER 404 ─────────────────────────────────────────────────────────
 * A company that does not exist, belongs to another tenant, is retired, or is
 * simply not this member's gets the same answer. Distinguishing them would let a
 * member enumerate the tenant's companies — the same rule `resolveUtilityCompany`
 * states for the utilities.
 */
import { NextResponse } from 'next/server';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { withTenant } from '@/lib/db';
import { companies, companyProfiles } from '@/db/schema';
import { getUserFromRequest, hasCompanyAccess, hasPermission } from '@/lib/auth';
import { requireActivePlanFor } from '@/lib/planGate';
import { isUuid } from '@/lib/documentCategoryResolver';
import {
  encryptJsonKeys, decryptJsonKeys, COMPANY_TAX_KEYS,
} from '@/lib/records/jsonFieldCrypto';
import { writeAudit, ACTIONS, auditSentence } from '@/lib/audit';
import { serverError } from '@/lib/routeError';

export const dynamic = 'force-dynamic';

/**
 * Free text, all of it optional — this is a form the user fills in over time,
 * not a record that must be complete to exist. `.passthrough()` is deliberately
 * NOT used: an unknown key would be persisted into the jsonb and read back
 * forever, and the fields are enumerated here precisely so the shape of the
 * stored document is decided in this file rather than by whatever a client posts.
 */
const text = z.string().trim().max(255).optional();
const putSchema = z.object({
  identityDetails: z.object({
    legalName: text,
    entityType: text,
    registrationNumber: text,
    incorporatedOn: text,
  }).strict().optional(),
  taxDetails: z.object({
    gstNumber: text,
    panNumber: text,
    tanNumber: text,
  }).strict().optional(),
  addressDetails: z.object({
    registeredAddress: z.string().trim().max(2000).optional(),
    operatingAddress: z.string().trim().max(2000).optional(),
  }).strict().optional(),
  contactDetails: z.object({
    email: text,
    phone: text,
    website: text,
  }).strict().optional(),
}).strict();

/**
 * Authenticate, prove the company, and check one verb on `profiles`.
 *
 * Returns the company's NAME as well as its id — the audit line needs words,
 * and `auditSentence` refuses to print a uuid.
 */
async function gate(req: Request, id: string, action: 'view' | 'edit') {
  const user = await getUserFromRequest(req);
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };

  // The BUSINESS axis: a company profile is a company's, so it is the business
  // plan that decides whether it is readable — not the household's, and not the
  // account-level "everything is dead" answer.
  const planGate = requireActivePlanFor(user, id);
  if (planGate) return { error: planGate };

  // Refused before it reaches a query: `companies.id` is a uuid column, so a
  // malformed segment is a Postgres type error mid-request — a 500 on what is
  // really a bad value in a URL.
  const forbidden = NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  if (!isUuid(id)) return { error: forbidden };

  if (!await hasCompanyAccess(user, id)) return { error: forbidden };
  if (!await hasPermission(user, 'profiles', action)) return { error: forbidden };

  // `hasCompanyAccess` has already proven this row exists and is this tenant's;
  // this reads it only for the name.
  const [company] = await withTenant(user.tenantId, (tx) => tx
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .where(and(
      eq(companies.id, id),
      eq(companies.tenantId, user.tenantId),
      isNull(companies.deletedAt),
    ))
    .limit(1));
  if (!company) return { error: forbidden };

  return { user, company };
}

/** The stored form → what the client sees. Tax identifiers come back plaintext. */
function forClient(row: any) {
  if (!row) return row;
  return { ...row, taxDetails: decryptJsonKeys(row.taxDetails, COMPANY_TAX_KEYS) };
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const gated = await gate(req, id, 'view');
    if ('error' in gated) return gated.error;
    const { user } = gated;

    const profile = await withTenant(user.tenantId, async (tx) => {
      const [existing] = await tx
        .select()
        .from(companyProfiles)
        .where(and(
          eq(companyProfiles.companyId, id),
          // Redundant with the company check above and kept anyway: the RLS
          // policy and the Drizzle predicate are two independent statements of
          // the same rule, and AGENTS.md §6 asks for both.
          eq(companyProfiles.tenantId, user.tenantId),
          isNull(companyProfiles.deletedAt),
        ))
        .limit(1);
      if (existing) return existing;

      // Created empty on first read, exactly as /api/profiles does, so the form
      // has a row to PUT against and the page never has to special-case "no
      // profile yet".
      const [created] = await tx.insert(companyProfiles).values({
        tenantId: user.tenantId,
        companyId: id,
        identityDetails: {},
        taxDetails: {},
        addressDetails: {},
        contactDetails: {},
      }).returning();
      return created;
    });

    return NextResponse.json({ success: true, profile: forClient(profile) });
  } catch (error) {
    return serverError(error, 'loading the company profile');
  }
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const gated = await gate(req, id, 'edit');
    if ('error' in gated) return gated.error;
    const { user, company } = gated;

    const parsed = putSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message || 'Invalid input' },
        { status: 400 },
      );
    }
    const body = parsed.data;

    // A section the client did not send is a section it is not editing — the
    // page saves one tab at a time. Absent must therefore leave the stored
    // value alone, which is why this is built key by key rather than spread.
    const patch: Record<string, any> = { updatedAt: new Date() };
    if (body.identityDetails !== undefined) patch.identityDetails = body.identityDetails;
    if (body.taxDetails !== undefined) {
      patch.taxDetails = encryptJsonKeys(body.taxDetails, COMPANY_TAX_KEYS);
    }
    if (body.addressDetails !== undefined) patch.addressDetails = body.addressDetails;
    if (body.contactDetails !== undefined) patch.contactDetails = body.contactDetails;

    const profile = await withTenant(user.tenantId, async (tx) => {
      const [row] = await tx.insert(companyProfiles)
        .values({
          tenantId: user.tenantId,
          companyId: id,
          identityDetails: patch.identityDetails ?? {},
          taxDetails: patch.taxDetails ?? {},
          addressDetails: patch.addressDetails ?? {},
          contactDetails: patch.contactDetails ?? {},
        })
        .onConflictDoUpdate({ target: companyProfiles.companyId, set: patch })
        .returning();

      await writeAudit({
        tenantId: user.tenantId,
        userId: user.id,
        action: ACTIONS.company.update,
        // The COMPANY's name, never a field value: audit rows are not encrypted
        // and are never purged, and the GST number that was just saved has no
        // business being written back out in plaintext beside it.
        details: auditSentence('update', {
          kind: 'company profile',
          name: company.name,
        }),
        req,
        entityType: 'company_profiles',
        entityId: row?.id,
      }, tx);

      return row;
    });

    return NextResponse.json({ success: true, profile: forClient(profile) });
  } catch (error) {
    return serverError(error, 'updating the company profile');
  }
}
