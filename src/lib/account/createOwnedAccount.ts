/**
 * A new account for a person who ALREADY has an identity (0082): a tenant with
 * them as its owner, on the same identity as their other seats.
 *
 * Shared by POST /api/account/create-personal (a signed-in member) and
 * POST /api/auth/register/invite/complete (an invited person choosing their own
 * account during signup). Tenant creation mirrors POST /api/auth/register: the
 * account arrives with NO plan and an expiry of "now" — see the long note there
 * for why `null` here would hand out an unlimited free workspace. It may start
 * a free trial from /billing, once per person.
 *
 * Runs inside the caller's transaction.
 */
import type { db } from '@/lib/db';
import { companies, profiles, tenants, users } from '@/db/schema';
import { newTenantPlanValues, recordSignupGrant } from '@/lib/planProvisioning';
import { defaultWorkspaceName } from '@/lib/workspaceName';
import { writeAudit, ACTIONS, auditSentence } from '@/lib/audit';

export interface OwnedAccountInput {
  identity: {
    id: string;
    email: string | null;
    passwordHash: string;
    phoneNumber: string | null;
    phoneDial: string | null;
  };
  /** The owner's name in the new account. */
  name: string;
  accountType: 'personal' | 'business' | 'both';
  companyName?: string | null;
  consentIpAddress: string;
  /** For the audit row's address and user agent. */
  req: Request;
  /** How the account came to be opened, for the audit sentence. */
  auditNote: string;
}

export async function createOwnedAccount(tx: typeof db, input: OwnedAccountInput) {
  const { identity, name, accountType, companyName, consentIpAddress, req, auditNote } = input;

  const planValues: ReturnType<typeof newTenantPlanValues> = {
    ...newTenantPlanValues(null),
    subscriptionExpiry: new Date(),
  };
  const workspaceName = defaultWorkspaceName(name);

  const [tenant] = await tx.insert(tenants).values({
    name: workspaceName,
    accountType,
    // May start the 7-day free trial from /billing (src/lib/trial.ts).
    trialEligible: true,
    ...planValues,
  }).returning();

  const [created] = await tx.insert(users).values({
    tenantId: tenant.id,
    identityId: identity.id,
    // Overwritten with the identity's own by the 0082 trigger; written so the
    // statement is valid on its own. Never a new password.
    email: identity.email,
    passwordHash: identity.passwordHash,
    name,
    phoneNumber: identity.phoneNumber,
    phoneDial: identity.phoneDial,
    role: 'TENANT_ADMIN',
    activatedAt: new Date(),
    consentDataProcessing: true,
    consentIpAddress,
    consentTimestamp: new Date(),
  }).returning();

  if (accountType !== 'personal' && companyName) {
    await tx.insert(companies).values({ tenantId: tenant.id, name: companyName });
  }

  await tx.insert(profiles).values({
    userId: created.id,
    personalDetails: {},
    educationDetails: {},
    shoppingDetails: {},
    legalDetails: {},
  });

  await writeAudit({
    tenantId: tenant.id,
    userId: created.id,
    action: ACTIONS.auth.personal_account_created,
    details: auditSentence('personal_account_created', {
      kind: 'account',
      name: workspaceName,
      note: auditNote,
    }),
    req,
    entityType: 'tenants',
    entityId: tenant.id,
  }, tx);

  await recordSignupGrant(tx as any, {
    tenantId: tenant.id,
    amount: planValues.aiCreditsBalance,
    businessAmount: planValues.aiCreditsBalanceBusiness,
    userId: created.id,
  });

  return created;
}
