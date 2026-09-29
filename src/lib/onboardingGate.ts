/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   onboardingGate — one answer to "has this workspace been set up yet?"   ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * A tenant that has not finished the wizard has no Google Drive grant, and Drive
 * is where every file in DocsNX lives — Postgres keeps the metadata and nothing
 * else. So the app before setup is not a smaller app, it is one where every
 * upload fails and no screen can say why.
 *
 * The browser has bounced such a tenant to `/onboarding` for a long time
 * (`Shell.js`), but that was the whole enforcement: a direct call to
 * /api/documents answered normally. This is the server half, and it is written
 * beside `planGate.ts` on purpose — same shape, same call convention, same
 * placement in the request pipeline:
 *
 *     const gate = requireOnboarded(user);
 *     if (gate) return gate;
 *
 * ── WHERE IT IS WIRED ──────────────────────────────────────────────────────
 * Three places, all of which already carry the plan gate, and between them they
 * cover every route that reads or writes tenant records:
 *
 *   withRecordScope        (records/handler.ts)     every record/vault module
 *   resolveUtilityCompany  (records/companyScope.ts) documents, passwords, todos,
 *                          important contacts, follow-up, dashboard, analysis,
 *                          the scan routes, users and members
 *   /api/search            (its own requireActivePlan sits beside it)
 *
 * ── WHAT MUST STAY OPEN, AND WHY ───────────────────────────────────────────
 * The wizard itself runs on these, so gating any of them deadlocks setup — the
 * admin could neither finish nor leave:
 *
 *   /api/auth/*                        the session, and the Drive consent flow
 *   /api/onboarding/*                  the wizard's own steps
 *   /api/companies                     the Companies step (gates on
 *                                      `requireActivePlan` directly, not on
 *                                      `resolveUtilityCompany` — so it is
 *                                      untouched by the wiring above)
 *   /api/tenants/integrations/google   the Drive status the Storage step reads
 *   /api/billing/*, /api/payments/*    checkout happens BEFORE onboarding
 *   /api/sync/google-drive             nothing to sync yet, but harmless
 *   /api/notifications/*               device registration
 */

/** Machine-readable discriminator on the 403 body. Clients branch on this. */
export const ONBOARDING_INCOMPLETE_CODE = 'ONBOARDING_INCOMPLETE';

export const ONBOARDING_INCOMPLETE_MESSAGE =
  'Finish setting up your workspace before using DocsNX. Connecting your Google Drive is the last step — it is where your files are stored.';

/** Where the client should send the user to fix it. */
export const ONBOARDING_PATH = '/onboarding';

/**
 * Has this tenant finished the wizard?
 *
 * `undefined` — a tenant row that was not loaded, or a hand-built user in a test
 * — reads as DONE. Failing open here matches every other gate in this codebase
 * (see `requireActivePlan`'s fallback): the cost of a wrong `false` is a paying
 * customer locked out of their own records, which is far worse than a request
 * that slips through while a row is missing.
 */
export function tenantOnboarded(tenant: { hasCompletedOnboarding?: boolean | null } | null | undefined): boolean {
  return tenant?.hasCompletedOnboarding !== false;
}

/**
 * The route guard. Returns a 403 response to return as-is, or `null` to carry on.
 *
 * 403 rather than 402: "you have not finished setting up" is not a payment
 * problem, and the client has to tell the two apart to choose between the
 * billing screen and the wizard. `redirectTo` names the fix so a caller does not
 * have to hardcode the path.
 *
 * SUPER_ADMIN is exempt — it is a platform role and owns no tenant setup.
 *
 * Built with the standard `Response.json` rather than `NextResponse` so this
 * module stays importable from the browser bundle, for the same reason
 * `planGate.ts` is: pulling `next/server` into a client graph breaks the build.
 */
export function requireOnboarded(user: any): Response | null {
  if (!user) return null; // callers handle 401 themselves, before this.
  if (user.role === 'SUPER_ADMIN') return null;
  if (tenantOnboarded(user.tenant)) return null;

  return Response.json(
    {
      error: ONBOARDING_INCOMPLETE_MESSAGE,
      code: ONBOARDING_INCOMPLETE_CODE,
      redirectTo: ONBOARDING_PATH,
    },
    { status: 403 },
  );
}
