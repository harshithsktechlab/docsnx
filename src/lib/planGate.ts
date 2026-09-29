/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   planGate — one answer to "has this tenant's subscription lapsed?"      ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * An expired tenant may still SIGN IN, and may still reach exactly two things:
 * Billing (so the admin can renew) and Settings. Everything else — every record,
 * every document, the dashboard, search, AI, sync, and the account export — is
 * closed until the plan is paid.
 *
 * The rule lived in three places before this file: `getUserFromRequest` computed
 * `isExpired`, `hasPermission` denied on it, and `/api/auth/me` forgot to report
 * it at all — which is why the client-side lock never actually engaged. It is
 * computed here now and read everywhere else.
 */

/** Machine-readable discriminator on the 402 body. Clients branch on this. */
export const PLAN_EXPIRED_CODE = 'PLAN_EXPIRED';

export const PLAN_EXPIRED_MESSAGE =
  'Your plan has expired. Renew your subscription to regain access.';

/**
 * The same sentence, naming which half lapsed.
 *
 * Only ever different from the message above on a `both` tenant holding two
 * separate plans — a tenant with one account, or one combined plan, reads
 * "Your plan" either way. Worth the branch because on the day those dates do
 * differ, "your plan has expired" shown inside a company the customer has paid
 * for is a support ticket, not a message.
 */
export function planExpiredMessage(axis: 'personal' | 'business'): string {
  return axis === 'business'
    ? 'Your Business plan has expired. Renew it to regain access to your companies.'
    : 'Your Personal plan has expired. Renew it to regain access to your household records.';
}

/**
 * Modules that stay readable while the plan is expired, because they are the
 * renewal path itself: locking an admin out of the invoice they have to pay is
 * a deadlock, not a lockdown.
 *
 * Consulted by BOTH `hasPermission` (server) and `clientCan` (browser) — the two
 * must agree exactly, so neither gets its own copy of this set.
 */
export const PLAN_EXEMPT_MODULES: ReadonlySet<string> = new Set(['invoices']);

export interface PlanStatus {
  /** Has a plan been assigned at all? A tenant without one is sent to /billing. */
  hasPlan: boolean;
  /** Assigned, but its term has passed. */
  isExpired: boolean;
  /** When the term ends/ended. `null` means lifetime — it never expires. */
  expiresAt: Date | null;
}

/**
 * Reads a tenant row's subscription state.
 *
 * A `null` `subscriptionExpiry` is NOT expired: lifetime plans and freshly
 * created tenants both carry null (see `planExpiry` in planProvisioning.ts,
 * which returns null for `isLifetime` / no duration). Treating null as expired
 * would lock out every paying lifetime customer, so the null branch is load
 * bearing.
 */
export function planStatus(tenant: any): PlanStatus {
  const expiresAt = tenant?.subscriptionExpiry ? new Date(tenant.subscriptionExpiry) : null;
  return {
    hasPlan: !!tenant?.subscriptionPlanId,
    isExpired: expiresAt ? expiresAt.getTime() < Date.now() : false,
    expiresAt,
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   THE TWO AXES
   ──────────────────────────────────────────────────────────────────────────
   A tenant may hold a personal subscription and a business one. Everything
   that answers "has THIS been paid for" lives here, beside `planStatus`, which
   all of it is built on.

   What a plan COVERS and COSTS — which tab it is sold in, its seat and company
   allowances, how a cart is priced — is src/lib/billingAxis.ts, which imports
   from this file. The dependency runs one way on purpose: these two were
   briefly circular, and a cycle between the module every gated route imports
   and the module the billing page imports is not a thing to leave lying around.
   ══════════════════════════════════════════════════════════════════════════ */

/** The two halves of an account. Not a permission — an axis of billing. */
export type AccountAxis = 'personal' | 'business';


export const ACCOUNT_AXES: readonly AccountAxis[] = ['personal', 'business'];

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   WHICH AXES A TENANT ACTUALLY HAS                                       ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `tenants.account_type` — 'personal' | 'business' | 'both'. This is what makes
 * "the whole account is locked" mean different things for different tenants
 * without a branch at every call site:
 *
 *   personal tenant → one axis  → its plan lapsing closes everything
 *   business tenant → one axis  → its plan lapsing closes everything
 *   both            → two axes  → closed only when BOTH are dead
 *
 * The `both` case is not a special rule: a plan whose `appliesTo` is 'both' is
 * written to each axis with the SAME expiry (see `planColumnsForAxis`), so its
 * two axes die on the same day and the account closes as one. Should a `both`
 * tenant ever hold two separate plans with different dates, the same rule read
 * on a different day gives independent halves — which is the point of expressing
 * it this way rather than hard-coding today's product.
 *
 * An unrecognised value falls back to personal, matching the column default and
 * every tenant that predates the business account.
 */
export function axesForAccountType(
  accountType: string | null | undefined,
): AccountAxis[] {
  if (accountType === 'both') return [...ACCOUNT_AXES];
  if (accountType === 'business') return ['business'];
  return ['personal'];
}


/**
 * Enough of a tenant row to answer a billing question. Duck-typed rather than
 * `InferSelectModel<typeof tenants>` so this module stays free of the schema —
 * and so `/api/auth/me`'s trimmed payload can be passed straight in.
 */
export interface BillingTenant {
  subscriptionPlanId?: string | null;
  subscriptionExpiry?: Date | string | null;
  businessPlanId?: string | null;
  businessPlanExpiry?: Date | string | null;
  maxMembers?: number | null;
  extraMembers?: number | null;
  extraMembersPerCompany?: number | null;
  extraCompanies?: number | null;
}

/**
 * The two plan columns for one axis, reshaped into the pair `planStatus()`
 * reads.
 *
 * This reshape is the whole trick that lets one expiry implementation serve
 * both halves — see the module header.
 */
export function axisRow(
  tenant: BillingTenant | null | undefined,
  axis: AccountAxis,
): { subscriptionPlanId: string | null; subscriptionExpiry: Date | string | null } {
  if (axis === 'business') {
    return {
      subscriptionPlanId: tenant?.businessPlanId ?? null,
      subscriptionExpiry: tenant?.businessPlanExpiry ?? null,
    };
  }
  return {
    subscriptionPlanId: tenant?.subscriptionPlanId ?? null,
    subscriptionExpiry: tenant?.subscriptionExpiry ?? null,
  };
}

/** `planStatus()` for one axis of a tenant. */
export function axisStatus(
  tenant: BillingTenant | null | undefined,
  axis: AccountAxis,
): PlanStatus {
  return planStatus(axisRow(tenant, axis));
}


/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   "EXPIRED" AND "UNPAID" ARE NOT THE SAME QUESTION                       ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * EXPIRED — a plan was bought and its term has passed.
 * UNPAID   — expired, OR never bought at all.
 *
 * They have always had different consumers, and conflating them breaks a
 * different thing in each direction:
 *
 *   · THE SERVER GATES ASK "EXPIRED". `requireActivePlan` has only ever 402'd
 *     on a lapsed term, never on a missing plan — a tenant part-way through
 *     signup has no plan yet, and 402-ing them would refuse every route between
 *     registration and checkout.
 *   · THE CLIENT LOCK ASKS "UNPAID". Shell has always redirected on
 *     `isExpired || !hasPlan`, because a workspace with no subscription has
 *     nothing to show and the answer is the same screen either way.
 *
 * Both are asked only of the axes `account_type` says exist, which is the point
 * of the pair: a `business` tenant has no personal plan and must not be judged
 * for lacking one.
 */
function axisIs(
  tenant: BillingTenant | null | undefined,
  axis: AccountAxis,
  mode: 'expired' | 'unpaid',
): boolean {
  const status = axisStatus(tenant, axis);
  return mode === 'unpaid' ? (!status.hasPlan || status.isExpired) : status.isExpired;
}

/** Every axis this tenant has has EXPIRED. What `requireActivePlan` asks. */
export function tenantFullyExpired(
  tenant: (BillingTenant & { accountType?: string | null }) | null | undefined,
): boolean {
  return axesForAccountType(tenant?.accountType)
    .every((axis) => axisIs(tenant, axis, 'expired'));
}

/**
 * Every axis this tenant has is UNPAID — expired or never bought. The client's
 * whole-app lock, and what /api/auth/me reports as `fullyLapsed`.
 */
export function tenantFullyLapsed(
  tenant: (BillingTenant & { accountType?: string | null }) | null | undefined,
): boolean {
  return axesForAccountType(tenant?.accountType)
    .every((axis) => axisIs(tenant, axis, 'unpaid'));
}

/**
 * ── IS THIS ONE WORKSPACE CLOSED? ───────────────────────────────────────────
 *
 * The axis of a request is decided by ONE rule, written here so no route has to
 * remember it: a company id means business, its absence means the household.
 *
 * That rule is already enforced upstream — `gateCompany` refuses a `biz_*` scope
 * with no company and a personal scope with one — so by the time anything calls
 * this, the pair has been proven consistent.
 */
export function axisFor(companyId: string | null | undefined): AccountAxis {
  return companyId ? 'business' : 'personal';
}

function workspaceIs(
  tenant: (BillingTenant & { accountType?: string | null }) | null | undefined,
  companyId: string | null | undefined,
  mode: 'expired' | 'unpaid',
): boolean {
  const axis = axisFor(companyId);
  /**
   * A workspace on an axis the tenant does not have is not closed, it is absent
   * — and answering `true` would shut a company workspace on a tenant whose
   * `account_type` has simply not been switched to 'both' yet. The app would
   * look expired to someone who has paid, which is the worst failure available
   * here. The account-level gate is what refuses those; this reports payment.
   */
  if (!axesForAccountType(tenant?.accountType).includes(axis)) return false;
  return axisIs(tenant, axis, mode);
}

/** This workspace's plan has EXPIRED. What `requireActivePlanFor` asks. */
export function workspaceExpired(
  tenant: (BillingTenant & { accountType?: string | null }) | null | undefined,
  companyId: string | null | undefined,
): boolean {
  return workspaceIs(tenant, companyId, 'expired');
}

/** This workspace is UNPAID — expired or never bought. The client's lock. */
export function workspaceLapsed(
  tenant: (BillingTenant & { accountType?: string | null }) | null | undefined,
  companyId: string | null | undefined,
): boolean {
  return workspaceIs(tenant, companyId, 'unpaid');
}


/** Days from now until `expiresAt`, or null when there is no expiry. Negative once past. */
export function daysUntil(expiresAt: Date | string | null | undefined): number | null {
  if (!expiresAt) return null;
  const ms = new Date(expiresAt).getTime() - Date.now();
  return Math.ceil(ms / (24 * 60 * 60 * 1000));
}

/**
 * The route guard. Returns a 402 response to return as-is, or `null` to carry on.
 *
 *   const gate = requireActivePlan(user);
 *   if (gate) return gate;
 *
 * 402 rather than 403 on purpose: "you have not paid" and "you are not permitted"
 * are different conditions with different fixes, and the client has to tell them
 * apart to decide between the lock screen and a plain error.
 *
 * SUPER_ADMIN is exempt — it is a platform role and owns no tenant plan.
 *
 * Built with the standard `Response.json` rather than `NextResponse` so this
 * module stays importable from the browser bundle: `clientCan` needs
 * PLAN_EXEMPT_MODULES from here, and pulling `next/server` into a client graph
 * breaks the build.
 */
export function requireActivePlan(user: any): Response | null {
  if (!user) return null; // callers handle 401 themselves, before this.
  if (user.role === 'SUPER_ADMIN') return null;

  /**
   * ── THE ACCOUNT-LEVEL GATE: EVERY AXIS THIS TENANT HAS ───────────────────
   *
   * It used to read the personal columns alone, which was right while a tenant
   * had one subscription and is now wrong in both directions:
   *
   *   · a `business` tenant has NO personal plan, so `planStatus` reported
   *     "not expired" forever and the account never locked at all, however long
   *     its business plan had been dead;
   *   · a `both` tenant's lapsed household closed its paid companies.
   *
   * `tenantFullyLapsed` asks only the axes `account_type` says exist, so a
   * one-account tenant still locks on its one plan and a `both` tenant locks
   * only when both are dead. A combined plan writes the same expiry to both
   * axes, so it closes the account as one — no special case for it here.
   */
  const lapsed = user.tenant
    ? tenantFullyExpired(user.tenant)
    // The tenant row was not loaded. `isExpired` is computed by
    // `getUserFromRequest` from the same helper, so this is the same answer
    // one hop later rather than a weaker one.
    : !!user.isExpired;
  if (!lapsed) return null;

  const status = user.tenant ? planStatus(user.tenant) : null;
  return Response.json(
    {
      error: PLAN_EXPIRED_MESSAGE,
      code: PLAN_EXPIRED_CODE,
      expiredAt: status?.expiresAt ? status.expiresAt.toISOString() : null,
    },
    { status: 402 },
  );
}

/**
 * The gate for ONE workspace, given the company it is scoped to.
 *
 * `companyId` must be one a gate has already PROVEN — `resolveUtilityCompany`
 * or `gateCompany`. This function decides payment, never access, and would
 * happily report on a company the caller cannot reach.
 *
 * ── CALL IT AFTER THE COMPANY IS RESOLVED, NOT BEFORE ────────────────────────
 * Every company-aware route used to call `requireActivePlan` at the top of the
 * handler, before it knew which workspace it was in. That ordering is the whole
 * bug: it answered for the household on a request about a company.
 * `tests/planAxisGate.test.ts` is what stops it coming back.
 */
export function requireActivePlanFor(
  user: any,
  companyId: string | null | undefined,
): Response | null {
  if (!user) return null;
  if (user.role === 'SUPER_ADMIN') return null;
  if (!user.tenant) return requireActivePlan(user);

  const axis = axisFor(companyId);
  if (!workspaceExpired(user.tenant, companyId)) return null;

  const status = axisStatus(user.tenant, axis);
  return Response.json(
    {
      error: planExpiredMessage(axis),
      code: PLAN_EXPIRED_CODE,
      /** Which half to renew. The client uses it to open the right billing tab. */
      axis,
      expiredAt: status.expiresAt ? status.expiresAt.toISOString() : null,
    },
    { status: 402 },
  );
}
