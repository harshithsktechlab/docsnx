import { pgTable, uuid, varchar, text, boolean, jsonb, timestamp, integer, bigint, decimal, pgEnum, uniqueIndex, index } from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";

export const roleEnum = pgEnum("role", ["SUPER_ADMIN", "TENANT_ADMIN", "STANDARD"]);

export const tenants = pgTable("tenants", {
  billingName: varchar("billing_name", { length: 255 }),
  billingGst: varchar("billing_gst", { length: 50 }),
  billingAddress: text("billing_address"),
  /**
   * The BILLING contact, added by 0044 — routinely not the person who signs in.
   *
   * Deliberately not `users.email` / `users.phone_number`: those carry
   * platform-wide partial unique indexes over live rows (one live account per
   * address, one per handset), so a shared accounts inbox or a corporate
   * landline cannot go in them — and must not, since neither is a sign-in
   * identity. NULL means "no separate billing contact"; readers fall back to
   * the tenant's TENANT_ADMIN.
   */
  billingEmail: varchar("billing_email", { length: 255 }),
  billingPhone: varchar("billing_phone", { length: 50 }),
  contactName: varchar("contact_name", { length: 255 }),
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 255 }).notNull(),
  apiKey: text("api_key"), // encrypted at rest
  aiProvider: varchar("ai_provider", { length: 50 }).default("gemini").notNull(),
  // Keep in sync with DEFAULT_GEMINI_MODEL in src/lib/aiModels.ts — Drizzle
  // bakes defaults into SQL and cannot read a TS constant. Changed by
  // drizzle/0030_gemini_3_flash_lite.sql.
  aiModel: varchar("ai_model", { length: 50 }).default("gemini-3.1-flash-lite").notNull(),
  /**
   * ── THE PERSONAL AXIS OF THE SUBSCRIPTION ────────────────────────────────
   *
   * These two are the household's plan, and since 0057 they mean only that.
   * They are deliberately NOT renamed to say so: `planStatus()`
   * (src/lib/planGate.ts), `requireActivePlan`, `getUserFromRequest` and every
   * route that gates on a plan read them, and a rename would be a flag day
   * across the codebase to gain a longer identifier.
   *
   * The business half lives in `businessPlanId` / `businessPlanExpiry` below,
   * which take the same two names with a prefix so `planStatus()` — duck-typed
   * on `subscriptionPlanId` / `subscriptionExpiry` — can be handed either half
   * through `personalAxis()` / `businessAxis()` in src/lib/billingAxis.ts.
   */
  subscriptionPlanId: uuid("subscription_plan_id").references(() => subscriptionPlans.id, { onDelete: 'set null' }),
  subscriptionExpiry: timestamp("subscription_expiry", { withTimezone: true }),
  /**
   * ── THE BUSINESS AXIS ────────────────────────────────────────────────────
   *
   * The business account's own plan. A plan whose `appliesTo` is 'both' is
   * written to BOTH axes at once — the same plan id in two columns, each with
   * its own expiry — so nothing has to consult the plan row to answer "is the
   * business side paid up".
   *
   * NULL means no business subscription, which is NOT the same as a NULL
   * `businessPlanExpiry` — that means lifetime. `planStatus()` already draws
   * that distinction for the personal side and draws it identically here.
   *
   * ⚠ There is deliberately no per-COMPANY plan. Companies are capped BY the
   * business plan (`maxCompanies`), not billed individually; see the header of
   * drizzle/0057_account_axis_billing.sql.
   */
  businessPlanId: uuid("business_plan_id").references(() => subscriptionPlans.id, { onDelete: 'set null' }),
  businessPlanExpiry: timestamp("business_plan_expiry", { withTimezone: true }),
  /**
   * Add-on seats, at the same grain as the plan's own allowance: PER COMPANY.
   * Mirrors `extraMembers`, which is the personal roster's.
   */
  extraMembersPerCompany: integer("extra_members_per_company").default(0).notNull(),
  /** Add-on companies, on top of the business plan's `maxCompanies`. */
  extraCompanies: integer("extra_companies").default(0).notNull(),
  /**
   * The ONE AI wallet, and it stays one. Split per workspace it would need a
   * transfer UI, a top-up per company and an answer to "which pot does a
   * cross-workspace search spend from" — none of which was asked for. The
   * per-workspace view people want is HISTORY, and that is
   * `credit_transactions.companyId`.
   */
  aiCreditsBalance: integer("ai_credits_balance").default(0).notNull(),
  googleDriveEnabled: boolean("google_drive_enabled").default(false).notNull(),
  googleDriveTokens: jsonb("google_drive_tokens"),
  // The tenant's dedicated /DocsNX_Data folder, and the file id of each synced
  // module inside it — without these every sync would create duplicates instead
  // of updating in place. Neither is secret; the tokens above are.
  googleDriveFolderId: varchar("google_drive_folder_id", { length: 128 }),
  googleDriveFileIds: jsonb("google_drive_file_ids"),
  // Which Google account is linked, so an admin can tell at a glance whether the
  // grant landed on the account they intended.
  googleAccountEmail: varchar("google_account_email", { length: 255 }),
  /**
   * The tenant's MEASURED Google Drive consumption, last time we read it.
   *
   * Cached here rather than fetched per request because the super admin's
   * workspace list would otherwise be one Drive round-trip per tenant, and a
   * per-process memory cache would be empty after every deploy.
   *
   * NULL means "never read" — NOT "empty". Nothing may bill a tenant for a
   * NULL and no write may be refused on one: a missing metric is not a full
   * disk, which is why checkStorageLimit() still fails open to `unlimited`
   * when these are unset. Cleared wherever the grant dies, so a stale number
   * cannot outlive the connection it described.
   */
  driveUsageBytes: bigint("drive_usage_bytes", { mode: 'number' }),
  driveLimitBytes: bigint("drive_limit_bytes", { mode: 'number' }),
  driveQuotaCheckedAt: timestamp("drive_quota_checked_at", { withTimezone: true }),
  /**
   * Where this tenant's record content lives: 'drive' (encrypted on their Google
   * Drive) or 'db' (legacy flat upload). Resolved via getVaultMode(), which
   * downgrades to 'db' for any tenant without a usable Drive grant — so this
   * column only ever *opts out* a Drive-enabled tenant, never opts one in.
   * Flipping a tenant back to 'db' reverts the read path with no deploy.
   */
  vaultMode: varchar("vault_mode", { length: 16 }).default('drive').notNull(),
  /**
   * Which workspaces this tenant has: 'personal' | 'business' | 'both'.
   *
   * Chosen at signup and changeable afterwards. It decides whether the app
   * renders a workspace switcher, whether onboarding demands a company, and
   * which half of the taxonomy the nav and the AI classifier are built from.
   *
   * NOT a permission. A tenant on 'personal' that somehow holds business
   * records still has them; this gates the UI and the onboarding requirement,
   * while `company_access` gates the data. Defaults to 'personal' so every row
   * that existed before this column keeps exactly the app it had.
   */
  accountType: varchar("account_type", { length: 16 }).default('personal').notNull(),
  hasCompletedOnboarding: boolean("has_completed_onboarding").default(false).notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  maxMembers: integer("max_members").default(1),
  extraMembers: integer("extra_members").default(0),
  amcLastPaidAt: timestamp("amc_last_paid_at", { withTimezone: true }),
  amcNextDueDate: timestamp("amc_next_due_date", { withTimezone: true }),
  /**
   * How far the expiry-reminder sequence has got for the CURRENT term: 'T-7',
   * 'T-3', 'T-1' or 'EXPIRED'. Without it the daily job would email, push and
   * bell every user every day for as long as a plan stays lapsed.
   *
   * Cleared by `applyPlanToTenant`, so a renewal re-arms the whole sequence.
   *
   * THE PERSONAL AXIS'S, like the `subscriptionExpiry` it counts down. The
   * business pair is below. One shared column could not hold two ladders: a
   * household plan reaching 'EXPIRED' would make `stageAlreadySent` swallow
   * every business notice behind it, and a company's plan would lapse in
   * silence.
   */
  planNoticeStage: varchar("plan_notice_stage", { length: 16 }),
  planNoticeSentAt: timestamp("plan_notice_sent_at", { withTimezone: true }),
  /**
   * The same ladder for `businessPlanExpiry`. Cleared by the business branch of
   * `planColumnsForAxis` (src/lib/billingAxis.ts), exactly as the pair above is
   * cleared by the personal one.
   */
  businessPlanNoticeStage: varchar("business_plan_notice_stage", { length: 16 }),
  businessPlanNoticeSentAt: timestamp("business_plan_notice_sent_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: 'cascade' }).notNull(),
  /**
   * NULLABLE since 0040, and no longer carrying a table-level UNIQUE.
   *
   * A member added by a tenant admin is identified by their MOBILE NUMBER; the
   * email address is optional and is never verified. Requiring one meant a
   * tenant admin who genuinely had no address for a family member had to invent
   * a fake one — which then sat in the column looking exactly like a real
   * address, and would have received first-login codes.
   *
   * Mandatory-ness is now a per-role app rule, not a column constraint:
   * `validateUserContacts` (src/lib/userContactValidation.ts) still demands an
   * address for TENANT_ADMIN and SUPER_ADMIN, for whom it is the billing and
   * password-reset channel of record.
   *
   * The old `users_email_unique` table constraint was replaced by a PARTIAL
   * unique index (see below) — a plain UNIQUE cannot express "over live rows
   * only", and NULLs must not be made to collide.
   */
  email: varchar("email", { length: 255 }),
  passwordHash: text("password_hash").notNull(),
  requiresPasswordChange: boolean("requires_password_change").default(true).notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  /** As typed and as displayed: '+91 98765 43210'. Never matched on directly. */
  phoneNumber: varchar("phone_number", { length: 50 }),
  /**
   * `phoneNumber` run through `toDialString` (src/lib/phone.ts): digits only,
   * country code included, no '+'. Added by 0039.
   *
   * This is the column sign-in matches on, because `phone_number` holds a
   * display value and three spellings of one handset will not `eq()` each other.
   * Every write site that sets `phoneNumber` MUST set this in the same
   * statement — a row where they disagree is a member who cannot sign in.
   *
   * Carries a partial unique index over live rows (see below), so the pre-auth
   * lookup can resolve a number to exactly one account without a tenant to
   * scope by.
   */
  phoneDial: varchar("phone_dial", { length: 20 }),
  role: roleEnum("role").default("STANDARD").notNull(),
  /**
   * ── WHICH ACCOUNT THIS MEMBER WAS ADDED TO: 'personal' | 'business' ───────
   *
   * The Add-member screen has always asked this question — it decides which
   * half of the taxonomy the new member is seeded with — and then threw the
   * answer away. This column keeps it, so the ROSTER can be split the same way
   * the records already are: `/users` lists the household's members and
   * `/business/<id>/users` lists that company's, with nothing in both.
   *
   * ── IT GATES ONE THING, AND EXACTLY ONE ───────────────────────────────────
   *
   * This note used to read "NOT A PERMISSION, and nothing may start gating on
   * it". That was true of the app it was written for and is recorded here
   * rather than deleted, because the reasoning still holds everywhere it
   * applied: what stops a business member reading household DOCUMENTS is the
   * seeded permission split — `hasPermission` denies outright when no row
   * matches (tests/memberAccountScope.test.ts) — plus `company_access`. None of
   * that consults this column and none of it should start.
   *
   * What changed is that four module keys are now seeded to BOTH halves on
   * purpose — `passwords`, `todos`, `emergency_contacts`, `profiles` — because a
   * company needs its own credentials, tasks and contacts. For those,
   * `hasPermission` genuinely cannot tell the accounts apart: one key, two
   * workspaces. The `company_id` predicate was supposed to carry the separation
   * instead, and it does for a company — but its other value is NULL, the
   * household, which any caller reaches by naming nothing at all. So a business
   * member was reading the household's passwords with every gate answering yes.
   *
   * `hasPersonalAccess` (src/lib/auth.ts) closes that, and this column is what
   * it reads. So:
   *
   *   THIS COLUMN GATES     reachability of the HOUSEHOLD half, and nothing
   *                         else. It is to `company_id IS NULL` what
   *                         `company_access` is to `company_id = <id>`.
   *   IT STILL DOES NOT     decide what a member may DO in either half. That is
   *                         `hasPermission`, on the seeded rows, as before.
   *
   * Deleting it would now be a disclosure as well as a UI regression.
   *
   * ── IT DESCRIBES STANDARD MEMBERS ─────────────────────────────────────────
   * A TENANT_ADMIN spans both accounts: they create the companies, and
   * `hasPermission` and `hasCompanyAccess` both short-circuit for them. Their
   * value is left at the default and no reader should consult it — the roster
   * queries in /api/users and /api/members list an admin in every workspace
   * explicitly instead.
   *
   * ── IMMUTABLE AFTER CREATION ──────────────────────────────────────────────
   * Set once by POST /api/users and never edited. A member is the `holder` of
   * every record filed under them; moving them to the other account would leave
   * those records pointing at a holder that workspace cannot list. Changing
   * accounts is a remove-and-re-add, not a field edit.
   *
   * Defaults to 'personal' so every row that existed before this column keeps
   * exactly the workspace it had; the migration then promotes anyone holding a
   * `company_access` row.
   */
  accountScope: varchar("account_scope", { length: 16 }).default('personal').notNull(),
  resetToken: varchar("reset_token", { length: 255 }),
  resetTokenExpiry: timestamp("reset_token_expiry", { withTimezone: true }),
  /**
   * ── TWO CHANNELS, TWO FLAGS, TWO CODES ────────────────────────────────────
   *
   * `email_verified` means the EMAIL address was proved, and since 0052 it
   * means only that. `phone_verified` below means the handset was proved. Which
   * of the two an account must clear before its first session is a role rule,
   * written down once in `requiredChannels()` (src/lib/otpChallenge.ts):
   *
   *   STANDARD                    phone only. Their address is optional and is
   *                               NEVER verified, so no code is ever mailed to
   *                               it — see the header of otpChallenge.ts.
   *   TENANT_ADMIN / SUPER_ADMIN  BOTH. They receive two INDEPENDENT six-digit
   *                               codes, one per channel, and must redeem both.
   *
   * ── WHAT 0052 CHANGED, AND WHY THE COMMENT ABOVE THIS ONE IS GONE ─────────
   * Until 0052 a tenant admin was sent ONE code down both channels, so
   * redeeming it proved they held the inbox OR the handset — never both. And a
   * member's WhatsApp code was stored in `email_verification_otp`, a column no
   * email had ever carried, leaving `email_verified` to mean "mobile verified"
   * for one role and "email verified" for another. That double meaning is what
   * the new columns retire.
   *
   * DEFAULT false on both since 0039/0052. 0052 backfills
   * `phone_verified = email_verified` for every existing row, so no account
   * that had already cleared the old single challenge is ever re-challenged.
   */
  emailVerified: boolean("email_verified").default(false).notNull(),
  emailVerificationOtp: varchar("email_verification_otp", { length: 255 }),
  emailVerificationOtpExpiry: timestamp("email_verification_otp_expiry", { withTimezone: true }),
  /**
   * The WhatsApp half of the same challenge. Added by 0052.
   *
   * A separate code, not a copy: `issueOtpChallenge` re-rolls on a collision so
   * one set of digits can never satisfy both boxes. Stored as `hashToken(otp)`
   * exactly like its email counterpart, so a database read cannot replay it.
   */
  phoneVerified: boolean("phone_verified").default(false).notNull(),
  phoneVerificationOtp: varchar("phone_verification_otp", { length: 255 }),
  phoneVerificationOtpExpiry: timestamp("phone_verification_otp_expiry", { withTimezone: true }),
  /**
   * The DPDPA consent recorded at registration, with the moment and the address
   * it was given from. There was a second flag beside this one,
   * `consent_ai_processing`, asked as a separate checkbox on the register form —
   * dropped by 0060 along with its box. Nothing ever read it: no AI route, no
   * prompt builder and no Drive sync consulted it.
   */
  consentDataProcessing: boolean("consent_data_processing").default(false).notNull(),
  consentTimestamp: timestamp("consent_timestamp", { withTimezone: true }),
  consentIpAddress: varchar("consent_ip_address", { length: 45 }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  /**
   * Set when a tenant admin turns this member's sign-in OFF. Added by 0063.
   *
   * NOT a removal. The member stays in the roster and in every holder picker,
   * so the admin can keep filing records under them, and they still count
   * toward `max_members`. Permissions and vault keys are kept, so clearing
   * this puts them back exactly as they were. `getUserFromRequest` refuses a
   * session for a row with this set, which ends any session already open.
   */
  signInDisabledAt: timestamp("sign_in_disabled_at", { withTimezone: true }),
}, (table) => {
  return {
    /**
     * One live account per handset, PLATFORM-WIDE. Added by 0039.
     *
     * Not tenant-scoped, and it cannot be: sign-in resolves the number before
     * there is a session, so there is no tenant to scope by. The consequence is
     * a product rule, not just a constraint — one person cannot hold a member
     * seat in two tenants under the same mobile number.
     *
     * Partial on two counts. `phone_dial IS NOT NULL` because a great many rows
     * have no number and NULLs must not collide (Postgres would allow that
     * anyway; the predicate keeps the index small). `deleted_at IS NULL` because
     * a soft-deleted account must not hold its number hostage against the person
     * re-registering — and it matches the sign-in lookup, which filters the same
     * way.
     */
    phoneDialIdx: uniqueIndex("users_phone_dial_uq")
      .on(table.phoneDial)
      .where(sql`phone_dial IS NOT NULL AND deleted_at IS NULL`),

    /**
     * One live account per email address. Added by 0040, replacing the baseline
     * `users_email_unique` table constraint.
     *
     * The constraint had to go because the column became nullable and a plain
     * UNIQUE cannot carry a predicate. Shaped exactly like the phone index
     * above, and for the same two reasons: NULLs must not collide (many member
     * rows now have no address at all), and a soft-deleted account must not
     * hold an address hostage against the person re-registering.
     *
     * NOTE the second half is a REAL RELAXATION of the old constraint: two
     * soft-deleted rows may now share an address, and a live row may take one a
     * deleted row still holds. That matches how `users_phone_dial_uq` and the
     * sign-in lookup in src/lib/authLookup.ts already treat deleted rows.
     */
    emailIdx: uniqueIndex("users_email_uq")
      .on(table.email)
      .where(sql`email IS NOT NULL AND deleted_at IS NULL`),
  };
});

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   PERMISSIONS — two grains, most-specific-wins                           ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * A row is either
 *   • the MODULE DEFAULT   — `document_key IS NULL`, one per (user, module); or
 *   • a SUB-CATEGORY OVERRIDE — `document_key` set, which wins over the default
 *     for that one category and nothing else.
 *
 * Added by 0024. Before it, access was module-grained, so denying a workspace
 * member "Bank locker agreement" meant denying them all of Bank & Investments.
 *
 * Write overrides SPARINGLY — only where a sub-category genuinely differs from
 * its module default. A full 83-row-per-user matrix is not the intent and makes
 * a newly added category invisible rather than inherited.
 *
 * `module` also carries the non-taxonomy keys (`passwords`, `todos`,
 * `emergency_contacts`, `audit_logs`, `invoices`); those only ever have a
 * default row, since they have no sub-categories.
 *
 * The unique index is on `coalesce(document_key, '')` rather than the bare
 * column: in Postgres NULLs are distinct, so a plain 3-column unique index
 * would happily let one user hold five conflicting module-default rows.
 */
export const permissions = pgTable("permissions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id, { onDelete: 'cascade' }).notNull(),
  module: varchar("module", { length: 100 }).notNull(),
  /** NULL = the module default. Set = an override for that sub-category. */
  documentKey: varchar("document_key", { length: 60 }),
  canView: boolean("can_view").default(false).notNull(),
  canAdd: boolean("can_add").default(false).notNull(),
  canEdit: boolean("can_edit").default(false).notNull(),
  canDelete: boolean("can_delete").default(false).notNull(),
  canShare: boolean("can_share").default(false).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => {
  return {
    userModuleDocIdx: uniqueIndex("permissions_user_module_doc_idx")
      .on(table.userId, table.module, sql`coalesce(${table.documentKey}, '')`),
  };
});

export const profiles = pgTable("profiles", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id, { onDelete: 'cascade' }).unique().notNull(),
  personalDetails: jsonb("personal_details"),
  educationDetails: jsonb("education_details"),
  shoppingDetails: jsonb("shopping_details"),
  legalDetails: jsonb("legal_details"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   COMPANIES — the business account's unit of ownership                   ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * A tenant whose `account_type` includes business holds one or more companies.
 * A company is to a business record what a `holder` is to a personal one: the
 * "Belongs to" axis. It is NOT a second tenant — billing, the Drive grant, the
 * encryption key and the member list all stay at tenant level.
 *
 * ── THE ID IS THE DRIVE FOLDER NAME, AND THE NAME IS NOT ────────────────────
 * Records live under `business/<id>/…` on the tenant's Drive. Two reasons, both
 * already doctrine in src/lib/vault/vaultNaming.ts:
 *
 *   · Drive folder names are PLAINTEXT. They appear in the owner's Drive UI and
 *     in Google's index even though the contents are ciphertext — which is why
 *     document files are named by opaque ids. A company name there would leak
 *     the tenant's business identity to Google.
 *   · A path segment must be IMMUTABLE. Renaming one orphans everything beneath
 *     it, and `name` below is user-editable by design.
 *
 * So the folder is the UUID and the name lives only here.
 */
export const companies = pgTable("companies", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: 'cascade' }).notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  /** The company's own folder under `DocsNX_Data/business/`. Cached like the tenant's. */
  driveFolderId: varchar("drive_folder_id", { length: 128 }),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (table) => {
  return {
    /**
     * One live company per name per tenant, case-insensitively. Two companies
     * called "Acme" in one sidebar is a support ticket, not a feature. Partial
     * on `deleted_at` so a removed company does not hold its name hostage.
     */
    tenantNameIdx: uniqueIndex("companies_tenant_name_uq")
      .on(table.tenantId, sql`lower(name)`)
      .where(sql`deleted_at IS NULL`),
    tenantIdx: index("companies_tenant_idx")
      .on(table.tenantId)
      .where(sql`deleted_at IS NULL`),
  };
});

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   COMPANY ACCESS — which companies a member may reach at all             ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The COMPANY grain of permission. A row means "this member may reach this
 * company"; the existing `permissions` rows then decide what they may do to
 * each module and sub-category INSIDE it.
 *
 * Deliberately not a `company_id` column on `permissions`. That would make the
 * matrix companies x 28 modules x 151 sub-categories and add a third
 * resolution step to `hasPermission`, which every one of the ~137 API routes
 * calls. Two clean grains beat one combinatorial one.
 *
 * A TENANT_ADMIN needs no row — `hasCompanyAccess` short-circuits for them, the
 * same way `hasPermission` already does. No verb columns for the same reason:
 * this table answers reachability, not what may be done.
 *
 * ⚠ Scoped through `user_id -> users` and carrying NO tenant column, so its RLS
 * policy is the `userScopedTables` shape in scripts/apply-rls.js — the same one
 * `permissions` uses.
 */
export const companyAccess = pgTable("company_access", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id, { onDelete: 'cascade' }).notNull(),
  companyId: uuid("company_id").references(() => companies.id, { onDelete: 'cascade' }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => {
  return {
    userCompanyIdx: uniqueIndex("company_access_user_company_uq")
      .on(table.userId, table.companyId),
    // Serves "who can reach this company", which the company admin screen asks.
    companyIdx: index("company_access_company_idx").on(table.companyId),
  };
});

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   COMPANY PROFILES — the company's own identity                          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * What `profiles` is to a member, this is to a company: the details that
 * describe the thing itself rather than any record it holds. Legal name, entity
 * type, CIN, GST and PAN, registered address, contact.
 *
 * ── WHY A TABLE AND NOT COLUMNS ON `companies` ─────────────────────────────
 * `companies.name` is the DISPLAY name and `companies.id` is a Drive path
 * segment — that row is structural, read on every navigation, and deliberately
 * tiny. A company's paperwork identity is a different thing with a different
 * lifetime: it grows, it is edited rarely, and half of it is encrypted. Bolting
 * it onto `companies` would put ciphertext in the row the workspace switcher
 * reads a dozen times a session.
 *
 * Shaped like `profiles` — four jsonb sections rather than thirty columns — for
 * the same reason that table is: the fields are a form, not a schema, and
 * adding one must not be a migration.
 *
 * ── THE TAX IDS ARE CIPHERTEXT ─────────────────────────────────────────────
 * `taxDetails.{gstNumber,panNumber,tanNumber}` are stored through
 * `encryptField` and decrypted on read, exactly as `profiles.legalDetails`
 * handles PAN/Aadhaar/passport. See src/lib/records/jsonFieldCrypto.ts, which
 * both routes now share.
 *
 * ── WHY `tenant_id` WHEN `company_id` ALREADY IMPLIES IT ───────────────────
 * The RLS policy. `scripts/apply-rls.js` gives a tenant-scoped table the
 * predicate `tenant_id = current_setting('app.tenant_id')`, which needs the
 * column on the table itself; the alternative is the EXISTS-subquery shape used
 * for `permissions` and `company_access`, and those two have no tenant column
 * available at all. A company profile does, so it takes the simpler policy.
 */
export const companyProfiles = pgTable("company_profiles", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: 'cascade' }).notNull(),
  /** One profile per company. CASCADE: a profile has no meaning without its company. */
  companyId: uuid("company_id").references(() => companies.id, { onDelete: 'cascade' }).unique().notNull(),
  /** Legal name, entity type, CIN/LLPIN, date of incorporation. */
  identityDetails: jsonb("identity_details"),
  /** GST, PAN, TAN — the three values inside are ENCRYPTED. */
  taxDetails: jsonb("tax_details"),
  /** Registered and operating addresses. */
  addressDetails: jsonb("address_details"),
  /** Company email, phone, website. Not a member's contact details. */
  contactDetails: jsonb("contact_details"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (table) => {
  return {
    tenantIdx: index("company_profiles_tenant_idx")
      .on(table.tenantId)
      .where(sql`deleted_at IS NULL`),
  };
});

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   DOCUMENT CATEGORY MASTER — GLOBAL reference table (no tenant column)   ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * 83 rows, identical for every tenant: the 82-row taxonomy plus Uncategorized.
 * Since drizzle/0036 that is the WHOLE table — every row is active, and there
 * are no retired ones sitting behind them. There is nothing tenant-specific
 * here, so reads need NO tenant predicate and the table carries NO RLS policy —
 * see scripts/apply-rls.js, which is why it is absent from both lists there.
 *
 * It used to have a nullable tenant_id (NULL = system row, NOT NULL = one
 * tenant's private custom category). That was dropped in
 * drizzle/0006_document_categories_drop_tenant.sql; per-tenant custom
 * categories no longer exist and must not be reintroduced by adding the column
 * back — half the codebase assumes a category id means the same thing to
 * everyone.
 *
 * The rows are defined in src/lib/documentCategories.ts (single source of
 * truth). The natural key is the PAIR (module_key, document_key) — there is no
 * dotted `code` column; it was dropped in
 * drizzle/0012_document_categories_composite_key.sql because its first half
 * only duplicated module_key. Both halves are IMMUTABLE: renaming either
 * orphans every document resolved from it AND breaks the Drive AAD its
 * ciphertext is bound to. Retire a row with isActive=false; never DELETE,
 * since documents.categoryId is ON DELETE RESTRICT.
 *
 * ── THE ONE EXCEPTION TO "NEVER DELETE" ────────────────────────────────────
 * The rule above is about a category something POINTS AT. A retired row that
 * nothing references at all is a tombstone, not a category, and drizzle/0036
 * reaped the 15 `<module>/miscellaneous` ones 0017 added and 0023 retired.
 *
 * That is the only sanctioned deletion, and it was only sanctioned because all
 * THREE reference classes were empty first — the guards in 0036 assert each:
 *   1. `documents`, by categoryId AND by the denormalised key pair, INCLUDING
 *      soft-deleted rows (they are restorable, so they still count);
 *   2. `document_category_fields`, whose FK is ON DELETE **CASCADE** and would
 *      therefore take an encrypt policy with it, silently;
 *   3. `permissions`, which names the taxonomy by string with no FK at all, so
 *      nothing else in the database would notice a dangling grant.
 * Anything short of all three empty: retire it, do not delete it.
 *
 * `document_key` is unique only WITHIN a module — `registration_certificate`
 * exists under both `vehicle` and `business` — so never key on it alone.
 */
export const documentCategories = pgTable("document_categories", {
  id: uuid("id").primaryKey().defaultRandom(),
  moduleNo: integer("module_no").notNull(),
  moduleKey: varchar("module_key", { length: 60 }).notNull(),
  documentKey: varchar("document_key", { length: 60 }).notNull(),
  moduleName: varchar("module_name", { length: 120 }).notNull(),
  documentName: varchar("document_name", { length: 200 }).notNull(),
  sortOrder: integer("sort_order").default(0).notNull(),
  isSystem: boolean("is_system").default(false).notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => {
  return {
    keyIdx: uniqueIndex("document_categories_key_idx").on(table.moduleKey, table.documentKey),
    // Serves the dropdown query: WHERE is_active ORDER BY module_no, sort_order
    lookupIdx: index("document_categories_lookup_idx")
      .on(table.moduleNo, table.sortOrder),
  };
});

export const documents = pgTable("documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: 'cascade' }).notNull(),
  userId: uuid("user_id").references(() => users.id, { onDelete: 'cascade' }).notNull(),
  holderId: uuid("holder_id").references(() => users.id, { onDelete: 'set null' }),
  /**
   * The BUSINESS "belongs to". NULL means a personal record.
   *
   * The company analogue of `holderId` above, and the two are mutually
   * exclusive in practice: a business record belongs to a company, a personal
   * one to a member. ON DELETE RESTRICT, not CASCADE — deleting a company must
   * not silently take its documents with it; the company is soft-deleted and
   * its records are dealt with deliberately.
   */
  companyId: uuid("company_id").references(() => companies.id, { onDelete: 'restrict' }),
  /**
   * 'personal' | 'business'. Redundant with `company_id IS NULL`, deliberately.
   *
   * This is the key `documents` will be LIST-partitioned on when volume needs
   * it, and a partition key may not be an expression over a nullable FK — it
   * has to be a stored, NOT NULL column. Writing it now means that partitioning
   * stays a pure DDL migration with no application change.
   *
   * Anything that reads it must treat it as a mirror of `company_id`, never as
   * an independent fact: the CHECK constraint in drizzle/0050 keeps the two in
   * step, and code should filter on whichever the query already has.
   */
  accountScope: varchar("account_scope", { length: 16 }).default('personal').notNull(),
  isGlobal: boolean("is_global").default(false).notNull(),
  title: varchar("title", { length: 255 }).notNull(),
  // Master-list FK. The legacy free-text `category` column it replaced was
  // dropped in 0016 along with LEGACY_CATEGORY_MAP; every row now resolves
  // through this FK or through the denormalised pair below.
  categoryId: uuid("category_id").references(() => documentCategories.id, { onDelete: 'restrict' }),
  /**
   * How the client fetches the bytes: `/api/records/<module>/<id>/file`, an app
   * route that decrypts on the way out — NOT the Drive webViewLink, which would
   * hand the user raw ciphertext.
   *
   * NULLABLE since 0016. `documents` now holds every module's records, and a
   * bank account or an investment has no file at all.
   */
  filePath: text("file_path"),
  /** The SOURCE file's name, e.g. `Passport_scan.pdf`. NULL when file-less. */
  fileName: varchar("file_name", { length: 255 }),
  /** The SOURCE file's type. NULL when file-less. */
  mimeType: varchar("mime_type", { length: 100 }),
  /**
   * Plaintext byte count — what storage quota bills against. For a multi-page
   * document this is the SUM over its pages, so a single SUM() still answers
   * "how much does this tenant use".
   */
  fileSize: integer("file_size").default(0).notNull(),
  /**
   * How many pages the source file was split into. 0 when file-less, 1 for a
   * plain image, N for a PDF.
   *
   * Here rather than only in the Drive JSON so a list can render "3 pages"
   * without opening the store. The per-page detail — each page's own Drive
   * object id, size and hash — lives in the record's `pages` array on Drive.
   */
  pageCount: integer("page_count").default(0).notNull(),

  // ── Vault columns (null on legacy/'db'-mode rows) ────────────────────────
  /**
   * Denormalised documentCategories.(moduleKey, documentKey) — together they
   * derive the Drive folder path Documents/<module_key>/<document_key>/.
   */
  categoryModuleKey: varchar("category_module_key", { length: 60 }),
  categoryDocumentKey: varchar("category_document_key", { length: 60 }),
  /** Drive's API takes file IDs; a URL cannot fetch, update or trash a file. */
  fileDriveId: varchar("file_drive_id", { length: 128 }),
  /** The category's JSON store on Drive, denormalised from vault_json_files. */
  jsonDriveId: varchar("json_drive_id", { length: 128 }),
  /** Which tenant key version sealed this. Without it, rotation is impossible. */
  keyVersion: integer("key_version"),
  /** sha256 of the PLAINTEXT — makes a re-upload verifiable and idempotent. */
  contentHash: varchar("content_hash", { length: 64 }),
  /**
   * sha256 of the bytes the user actually HANDED US, before any page splitting.
   *
   * The file-identity arm of the duplicate check — see duplicateMatch.ts. The
   * title and filename arms are scoped to one sub-category, so the same PDF
   * re-uploaded under a different name, or filed somewhere else, was caught only
   * when its identifier had been read off the page. This is the arm that catches
   * it regardless: identical bytes are identical bytes.
   *
   * NOT `contentHash`, which is the hash of the primary PAGE after splitting and
   * is therefore known only once the Drive objects exist — far too late for a
   * check whose whole job is to refuse the write. This one is computed from the
   * upload in hand, before anything is stored.
   *
   * NULL on every row written before this column existed, and on every file-less
   * record (a bank account has no bytes). A NULL never matches anything, so the
   * arm is simply silent for those; they take a hash the next time they are
   * saved. No backfill is possible — the plaintext is sealed per page on Drive.
   */
  sourceHash: varchar("source_hash", { length: 64 }),
  /** Ciphertext size on Drive. fileSize stays the user-meaningful number. */
  encryptedSize: integer("encrypted_size"),
  /**
   * pending → the row exists but its Drive objects may not. Written first so a
   * mid-upload failure leaves a visible row instead of a silent Drive orphan.
   * Lists filter on 'active'.
   */
  status: varchar("status", { length: 24 }).default('active').notNull(),

  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (table) => {
  return {
    tenantCategoryIdx: index("documents_tenant_category_idx").on(table.tenantId, table.categoryId),
    tenantStatusIdx: index("documents_tenant_status_idx")
      .on(table.tenantId, table.status)
      .where(sql`${table.deletedAt} IS NULL`),
    // The business list query: one company's live records. Leads with tenantId
    // so it also serves as a covering prefix for the personal path, and so the
    // table stays partition-ready (every index leads with the partition key).
    tenantCompanyStatusIdx: index("documents_tenant_company_status_idx")
      .on(table.tenantId, table.companyId, table.status)
      .where(sql`${table.deletedAt} IS NULL`),
    // Serves the revival lookup: re-uploading a document finds the row the user
    // deleted earlier — same tenant, same category, most recent tombstone — and
    // reuses it. Partial, so it covers only the deleted rows.
    tenantDeletedCategoryIdx: index("documents_tenant_deleted_category_idx")
      .on(table.tenantId, table.categoryId, sql`${table.deletedAt} DESC`)
      .where(sql`${table.status} = 'deleted'`),
    // The file-identity arm runs on EVERY write that carries bytes, so it is
    // the one duplicate lookup that must not be a scan. Partial on both counts:
    // a deleted row is never reported as a duplicate (the user cannot see it),
    // and a file-less record has no hash to match on.
    /**
     * The ONE index that does not lead with tenant_id, and deliberately so.
     *
     * Three super-admin screens count documents across every tenant, which no
     * tenant-leading index can serve. The predicate mirrors `visibleDocument()`
     * literally — Postgres only uses a partial index when it can prove the
     * query's WHERE implies it, so a change to one without the other silently
     * returns the planner to a seq scan with no error and no symptom beyond the
     * screens getting slower. See drizzle/0051.
     */
    categoryVisibleIdx: index("documents_category_visible_idx")
      .on(table.categoryModuleKey, table.categoryDocumentKey)
      .where(sql`deleted_at IS NULL AND status = 'active'`),
    tenantSourceHashIdx: index("documents_tenant_source_hash_idx")
      .on(table.tenantId, table.sourceHash)
      .where(sql`${table.deletedAt} IS NULL AND ${table.sourceHash} IS NOT NULL`),
  };
});


export const passwords = pgTable("passwords", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: 'cascade' }).notNull(),
  userId: uuid("user_id").references(() => users.id, { onDelete: 'cascade' }).notNull(),
  holderId: uuid("holder_id").references(() => users.id, { onDelete: 'set null' }),
  /** The business "belongs to". NULL = personal. See documents.companyId. */
  companyId: uuid("company_id").references(() => companies.id, { onDelete: 'restrict' }),
  /** Mirror of `company_id`, kept for the same partitioning reason as documents. */
  accountScope: varchar("account_scope", { length: 16 }).default('personal').notNull(),
  isGlobal: boolean("is_global").default(false).notNull(),
  title: varchar("title", { length: 255 }).notNull(),
  category: varchar("category", { length: 100 }).notNull(),
  url: text("url"),
  username: varchar("username", { length: 255 }).notNull(),
  /** Login identifiers, kept plaintext so SQL search keeps working. */
  email: varchar("email", { length: 255 }),
  phone: varchar("phone", { length: 40 }),
  /**
   * @deprecated The secret now lives in the tenant's Drive store, sealed with
   * the tenant key. Nullable so new rows leave it empty; kept only so existing
   * rows stay readable during the transition, and dropped once nothing reads it.
   */
  passwordEncrypted: text("password_encrypted"),
  notes: text("notes"),
  customFields: jsonb("custom_fields"),

  // ── Vault columns ────────────────────────────────────────────────────────
  // No file_drive_id or content_hash: a credential has no bytes, only a record,
  // so it uses the JSON store alone.
  // Passwords have no taxonomy row of their own: the module half is the
  // constant PASSWORD_MODULE_KEY and the document half is slugifyCategory()
  // of the free-text `category` above. See src/lib/vault/vaultNaming.ts.
  categoryModuleKey: varchar("category_module_key", { length: 60 }),
  categoryDocumentKey: varchar("category_document_key", { length: 60 }),
  jsonDriveId: varchar("json_drive_id", { length: 128 }),
  jsonUrl: text("json_url"),
  keyVersion: integer("key_version"),
  status: varchar("status", { length: 24 }).default('active').notNull(),

  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (table) => {
  return {
    tenantStatusIdx: index("passwords_tenant_status_idx")
      .on(table.tenantId, table.status)
      .where(sql`${table.deletedAt} IS NULL`),
    tenantCompanyStatusIdx: index("passwords_tenant_company_status_idx")
      .on(table.tenantId, table.companyId, table.status)
      .where(sql`${table.deletedAt} IS NULL`),
    tenantCategoryKeyIdx: index("passwords_tenant_category_key_idx")
      .on(table.tenantId, table.categoryModuleKey, table.categoryDocumentKey),
  };
});


// Append-only: no updatedAt, and deliberately no deletedAt — an audit trail that
// can be edited or soft-deleted is not an audit trail. Write rows via
// writeAudit() in src/lib/audit.ts, never with a raw insert.
export const auditLogs = pgTable("audit_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: 'cascade' }).notNull(),
  userId: uuid("user_id").references(() => users.id, { onDelete: 'cascade' }),
  /**
   * ── WHICH WORKSPACE THIS EVENT HAPPENED IN. NULL = the household. ────────
   *
   * What gives /audit-logs a tab per workspace. Written from the company id the
   * route has ALREADY PROVEN (`resolveUtilityCompany` / `companyIdFromRequest`),
   * never from one re-read off the request inside writeAudit.
   *
   * ⚠ ON DELETE CASCADE — deliberately unlike `creditTransactions.companyId`
   * (SET NULL) and unlike every record table (RESTRICT). Neither alternative
   * works here:
   *   · RESTRICT would make erasing a company impossible until its history was
   *     deleted by hand, and a company erasure is now a supported action.
   *   · SET NULL is worse than either: NULL reads as "the household", so
   *     erasing Acme would silently move every trace of Acme's activity into
   *     the PERSONAL audit tab — one workspace's history surfacing in another's,
   *     inside the feature whose whole purpose is keeping them apart.
   *
   * CASCADE is coherent because the trail describes records the erasure
   * destroys. The fact OF the erasure is not lost: eraseCompanyWorkspace writes
   * its summary row at TENANT level (companyId null) before deleting the
   * company, so that row is not a child of what it describes.
   */
  companyId: uuid("company_id").references(() => companies.id, { onDelete: 'cascade' }),
  action: varchar("action", { length: 255 }).notNull(),
  resource: varchar("resource", { length: 255 }),
  // entityType/entityId identify the record this event describes. No FK on
  // entityId on purpose: an audit row must survive deletion of its record.
  entityType: varchar("entity_type", { length: 100 }),
  entityId: uuid("entity_id"),
  details: text("details").notNull(),
  ipAddress: varchar("ip_address", { length: 100 }),
  userAgent: varchar("user_agent", { length: 500 }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => {
  return {
    // Serves the default list query (tenant + newest-first) and the date-range filter.
    tenantCreatedIdx: index("audit_logs_tenant_created_idx").on(table.tenantId, table.createdAt),
    // Serves the per-workspace tab. Both indexes are needed: the Summary tab
    // has no company predicate at all, so it cannot use this one.
    tenantCompanyCreatedIdx: index("audit_logs_tenant_company_created_idx")
      .on(table.tenantId, table.companyId, table.createdAt),
    // Serves the action filter and the SELECT DISTINCT action that builds it.
    tenantActionIdx: index("audit_logs_tenant_action_idx").on(table.tenantId, table.action),
    // Serves "show me the history of this record".
    tenantEntityIdx: index("audit_logs_tenant_entity_idx").on(table.tenantId, table.entityType, table.entityId),
  };
});

export const apiKeys = pgTable("api_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  label: varchar("label", { length: 255 }).notNull(),
  apiKey: text("api_key").notNull(),
  provider: varchar("provider", { length: 50 }).default("gemini").notNull(),
  // See the note on tenants.aiModel above.
  model: varchar("model", { length: 50 }).default("gemini-3.1-flash-lite").notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  priority: integer("priority").default(0).notNull(),
  dailyUsage: integer("daily_usage").default(0).notNull(),
  dailyLimit: integer("daily_limit").default(1500).notNull(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  lastResetAt: timestamp("last_reset_at", { withTimezone: true }).defaultNow().notNull(),
  errorCount: integer("error_count").default(0).notNull(),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const aiApiKeys = pgTable("ai_api_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").unique().notNull(),
  name: varchar("name", { length: 255 }),
  provider: varchar("provider", { length: 50 }).default("GEMINI").notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  usageCount: integer("usage_count").default(0).notNull(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const systemConfigs = pgTable("system_configs", {
  platformName: varchar("platform_name", { length: 255 }),
  platformGstin: varchar("platform_gstin", { length: 50 }),
  platformAddress: text("platform_address"),
  platformStateCode: varchar("platform_state_code", { length: 10 }),
  platformLogo: text("platform_logo"),
  platformEmail: varchar("platform_email", { length: 255 }),
  platformPhone: varchar("platform_phone", { length: 50 }),
  id: uuid("id").primaryKey().defaultRandom(),
  smtpHost: varchar("smtp_host", { length: 255 }).notNull(),
  smtpPort: integer("smtp_port").notNull(),
  smtpUser: varchar("smtp_user", { length: 255 }).notNull(),
  smtpPassword: text("smtp_password").notNull(),
  smtpSecure: boolean("smtp_secure").default(true).notNull(),
  smtpFrom: varchar("smtp_from", { length: 255 }).notNull(),

  // ─── WhatsApp (Evolution API) ────────────────────────────────────────────
  // The platform's outbound WhatsApp sender, configured exactly like SMTP
  // above: one gateway for the whole platform, edited by a SUPER_ADMIN at
  // /admin/whatsapp rather than baked into the environment. `whatsappInstance`
  // is the name of the Evolution instance (the linked handset) messages leave
  // from — the engine can hold many, and this column is which one is ours.
  //
  // `whatsappApiKey` is ENCRYPTED at rest via src/lib/encryption.ts, like
  // `smtp_password`; it is a bearer credential for the whole engine, not a
  // per-message secret. It is never returned to the browser.
  whatsappEnabled: boolean("whatsapp_enabled").default(false).notNull(),
  whatsappApiUrl: varchar("whatsapp_api_url", { length: 255 }),
  whatsappApiKey: text("whatsapp_api_key"),
  whatsappInstance: varchar("whatsapp_instance", { length: 255 }),
  aiCostRecordAnalysis: decimal("ai_cost_record_analysis", { precision: 10, scale: 2 }).default("1.00").notNull(),
  aiCostCategoryAnalysis: decimal("ai_cost_category_analysis", { precision: 10, scale: 2 }).default("2.00").notNull(),
  aiCostPortfolioAnalysis: decimal("ai_cost_portfolio_analysis", { precision: 10, scale: 2 }).default("5.00").notNull(),
  aiCostBulkScan: decimal("ai_cost_bulk_scan", { precision: 10, scale: 2 }).default("10.00").notNull(),
  maxUploadBytes: integer("max_upload_bytes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const tenantAiUsages = pgTable("tenant_ai_usages", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: 'cascade' }).notNull(),
  modelName: varchar("model_name", { length: 100 }).notNull(),
  promptTokens: integer("prompt_tokens").default(0).notNull(),
  completionTokens: integer("completion_tokens").default(0).notNull(),
  cost: decimal("cost", { precision: 10, scale: 5 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Every movement of a tenant's AI credit balance — the history behind
 * `tenants.ai_credits_balance`.
 *
 * `tenant_ai_usages` above is NOT this and cannot substitute for it: it records
 * prompt tokens and a USD estimate, carries no action name, and logs calls made
 * on the tenant's OWN api key, which cost zero credits. A credit history
 * derived from it would be invented.
 *
 * APPEND-ONLY, like `audit_logs`: no `updated_at`, no `deleted_at`. A ledger row
 * that can be edited or hidden is not a ledger. Corrections are expressed as a
 * new compensating row.
 *
 * `balance_after` is denormalised on purpose. It is captured from the same
 * `UPDATE … RETURNING` that moved the balance, so a reader never has to re-sum
 * the whole history to render one page — and a row whose `balance_after`
 * disagrees with the running total is direct evidence of a write that bypassed
 * the helpers in src/lib/planProvisioning.ts.
 */
export const creditTransactions = pgTable("credit_transactions", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: 'cascade' }).notNull(),
  /** Acting member. NULL for system, webhook and cron movements — they have no user. */
  userId: uuid("user_id").references(() => users.id, { onDelete: 'set null' }),
  /**
   * ── WHICH WORKSPACE SPENT IT. ATTRIBUTION ONLY. ──────────────────────────
   *
   * There is still exactly ONE wallet (`tenants.aiCreditsBalance`); this column
   * exists so the credits page can show a tab per workspace. It does not create
   * a second pot and nothing may treat it as one.
   *
   * NULL covers two cases that are the same for accounting: the personal
   * workspace, and every GRANT — a plan or add-on grant lands in the shared
   * wallet and belongs to no single workspace.
   *
   * ⚠ ON DELETE SET NULL, unlike `auditLogs.companyId` which cascades. This
   * table is the running total behind `balanceAfter`; deleting rows out of the
   * middle of it when a company is erased would leave arithmetic that no longer
   * reconciles to the balance it explains. An erased company's spending
   * survives as unattributed — the credits really were spent, and they did not
   * come back.
   */
  companyId: uuid("company_id").references(() => companies.id, { onDelete: 'set null' }),
  /** Signed: positive grants credits, negative spends them. Never zero. */
  amount: integer("amount").notNull(),
  balanceAfter: integer("balance_after").notNull(),
  /** A CREDIT_REASONS code from src/lib/creditLedger.ts. */
  reason: varchar("reason", { length: 64 }).notNull(),
  /**
   * Human-readable sentence shown to the tenant. Like audit details, this is
   * never encrypted and never purged — keep credentials and PII out of it.
   */
  description: text("description").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => {
  return {
    // The one access pattern: this tenant's rows, newest first.
    tenantCreatedIdx: index("credit_transactions_tenant_created_idx")
      .on(table.tenantId, table.createdAt),
    // Serves the per-workspace ledger tab. The index above cannot: it has no
    // company column, and the tab query always carries a company predicate.
    tenantCompanyCreatedIdx: index("credit_transactions_tenant_company_created_idx")
      .on(table.tenantId, table.companyId, table.createdAt),
  };
});

export const creditTransactionsRelations = relations(creditTransactions, ({ one }) => ({
  tenant: one(tenants, { fields: [creditTransactions.tenantId], references: [tenants.id] }),
  user: one(users, { fields: [creditTransactions.userId], references: [users.id] }),
  company: one(companies, { fields: [creditTransactions.companyId], references: [companies.id] }),
}));

export const emergencyContacts = pgTable("emergency_contacts", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: 'cascade' }).notNull(),
  /**
   * The BUSINESS account axis. NULL = a personal row. See documents.companyId —
   * same shape, same reasoning, so there is one rule to remember at every read.
   */
  companyId: uuid("company_id").references(() => companies.id, { onDelete: 'restrict' }),
  /** Mirror of `company_id`, kept in step by a CHECK constraint (drizzle/0053). */
  accountScope: varchar("account_scope", { length: 16 }).default('personal').notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  role: varchar("role", { length: 100 }).notNull(),
  phoneNumber: varchar("phone_number", { length: 50 }).notNull(),
  email: varchar("email", { length: 255 }),
  address: text("address"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});


export const todos = pgTable("todos", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: 'cascade' }).notNull(),
  /**
   * The BUSINESS account axis. NULL = a personal row. See documents.companyId —
   * same shape, same reasoning, so there is one rule to remember at every read.
   */
  companyId: uuid("company_id").references(() => companies.id, { onDelete: 'restrict' }),
  /** Mirror of `company_id`, kept in step by a CHECK constraint (drizzle/0053). */
  accountScope: varchar("account_scope", { length: 16 }).default('personal').notNull(),
  task: text("task").notNull(),
  dueDate: timestamp("due_date", { withTimezone: true }),
  status: varchar("status", { length: 50 }).default("PENDING").notNull(),
  assigneeId: uuid("assignee_id").references(() => users.id, { onDelete: 'set null' }),
  creatorId: uuid("creator_id").references(() => users.id, { onDelete: 'cascade' }).notNull(),
  pushNotification: boolean("push_notification").default(false).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const notifications = pgTable("notifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: 'cascade' }).notNull(),
  userId: uuid("user_id").references(() => users.id, { onDelete: 'cascade' }).notNull(),
  /**
   * The BUSINESS account axis. NULL = a personal or account-level notice. See
   * documents.companyId — same shape, same ON DELETE RESTRICT reasoning.
   *
   * What the bell filters on: the panel shows the workspace you are standing in
   * and nothing else, the same rule /follow-up already applies to the reminders
   * these notices are made from. One mixed list counted a company's licence
   * renewals in the household's badge.
   */
  companyId: uuid("company_id").references(() => companies.id, { onDelete: 'restrict' }),
  /**
   * ── THE ONE account_scope THAT IS NOT A MIRROR OF company_id ─────────────
   *
   * Four other tables carry this column as a strict mirror, held there by a
   * CHECK (drizzle/0053): 'personal' with no company, 'business' with one. This
   * one takes a THIRD value, 'account', and its CHECK is widened to allow it.
   *
   * 'account' means a notice that must be reachable from EVERY workspace, and
   * only the two billing ladders file one. The reason is the rule the GET
   * handler is built around — "locking the bell would mean the one message that
   * explains the lockdown is the one message the user cannot receive". A
   * business-plan notice has no company to be filed under, and filing it as
   * 'business' would hide it from the TENANT_ADMIN working in Personal, who is
   * the only person able to pay it.
   *
   * So: 'personal' | 'business' | 'account'. Anything with a company uses
   * `accountScopeFor()` (src/lib/records/companyScope.ts) and can only be one of
   * the first two.
   */
  accountScope: varchar("account_scope", { length: 16 }).default('personal').notNull(),
  title: varchar("title", { length: 255 }).notNull(),
  message: text("message").notNull(),
  link: text("link").notNull(),
  isRead: boolean("is_read").default(false).notNull(),
  /**
   * ── WHAT STOPS A DAILY JOB SAYING THE SAME THING EVERY DAY ───────────────
   *
   * Set by writers that run on a schedule and would otherwise re-announce a
   * standing fact. A record whose insurance lapses in nine days is equally true
   * tomorrow; without this the cron would file a fresh notice each morning until
   * the policy was renewed, and the bell would become the thing users stop
   * opening.
   *
   * The unique index below is the whole mechanism — the cron inserts with
   * `onConflictDoNothing()` and lets Postgres decide whether the notice is new.
   * That is deliberately not a "have I sent this?" SELECT: two overlapping runs
   * would both read "no" and both insert.
   *
   * NULL for the event-driven writers (a to-do assignment, a manual POST) —
   * those describe something that just happened, which cannot repeat. Postgres
   * treats NULLs as distinct, so any number of them coexist under the index.
   */
  dedupeKey: varchar("dedupe_key", { length: 255 }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => {
  return {
    // Per RECIPIENT, not per tenant: every member of a workspace gets their own
    // copy of the same notice, and a tenant-wide key would deliver it to
    // whichever member the cron happened to reach first.
    dedupeIdx: uniqueIndex("notifications_tenant_user_dedupe_idx")
      .on(table.tenantId, table.userId, table.dedupeKey),
    // The bell's own query: one recipient's rows in one workspace. Every read
    // in /api/notifications now carries all three, and without this the panel
    // falls back to scanning a member's whole history to draw one workspace.
    workspaceIdx: index("notifications_tenant_user_company_idx")
      .on(table.tenantId, table.userId, table.companyId),
  };
});

export const trialUsedEmails = pgTable("trial_used_emails", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: varchar("email", { length: 255 }).unique().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   THE ONLY THING THAT SURVIVES AN ACCOUNT DELETION                       ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * One row per member of a workspace that was erased through
 * /api/account/delete. Name, phone and email — nothing else. No documents, no
 * records, no backup: the deletion permanently removes the tenant's rows, the
 * ciphertext in their Google Drive and any legacy /uploads file, and Drive's
 * 30-day trash is bypassed on purpose.
 *
 * Two structural choices carry the whole point of the table:
 *
 *  • `tenant_id` is a PLAIN uuid with NO references(). An FK to `tenants` would
 *    cascade this row away together with the very tenant it exists to record.
 *
 *  • NO tenant_id RLS policy — it appears in no list in scripts/apply-rls.js.
 *    The standard `tenant_id = current_setting('app.tenant_id')` predicate
 *    would make every row invisible the moment its tenant stopped existing,
 *    which is every row here by construction.
 *
 * Because there is no policy, nothing scopes a SELECT on this table. Keep it
 * out of every tenant-facing query. The ONE reader is
 * `findErasedAccount` (src/lib/account/erasedAccountLookup.ts), which login
 * and forgot-password consult when no live user matches an identifier, so the
 * person who erased their account and forgot can be told so rather than
 * "Invalid credentials". It reads `erased_at`, `role` and `tenant_name` only —
 * never the ciphertext columns.
 *
 * `trial_used_emails` above is NOT cleared by the deletion (it has no FK to
 * `tenants`, so it already survives on its own) — that is what stops a
 * delete-and-resignup from claiming a second free trial.
 */
export const deletedAccounts = pgTable("deleted_accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** The erased tenant. Intentionally FK-free — see the note above. */
  tenantId: uuid("tenant_id").notNull(),
  tenantName: varchar("tenant_name", { length: 255 }),
  /**
   * encryptField() ciphertext — sealed under the app-level ENCRYPTION_SECRET,
   * never the tenant key, which is destroyed along with the tenant. `text`
   * rather than `varchar` because ciphertext is longer than its plaintext.
   */
  name: text("name").notNull(),
  phoneNumber: text("phone_number"),
  /**
   * Cleartext and NOT unique. Cleartext because `trial_used_emails` already
   * stores it that way, so this adds no exposure and support can correlate the
   * two. Not unique because re-registration with the same address is allowed —
   * this table records an erasure, it does not blacklist anyone.
   *
   * NULLABLE since 0040, for the same reason `users.email` is: a member may
   * never have had an address. It was `notNull`, so erasing a tenant that
   * contained one email-less member would have failed this insert — and by the
   * rule in /api/account/delete, a failed retention insert BLOCKS THE DELETION
   * OUTRIGHT. Someone exercising their right to erasure would have been refused
   * because a relative had no email address.
   */
  email: varchar("email", { length: 255 }),
  /**
   * `blindIndex(phone_dial)` — a keyed hash of the normalised number, so the
   * lookup above can match a mobile-number sign-in the way it matches an
   * email. Added by 0062. A key to find the row by, not the number: nothing
   * about the handset can be read back out of it; `phone_number` beside it
   * stays ciphertext. Nullable for the same reason `email` is.
   */
  phoneDialIndex: varchar("phone_dial_index", { length: 64 }),
  role: roleEnum("role").notNull(),
  /** When the erasure ran. Distinct from `deleted_at` elsewhere in this schema, which means "soft-deleted". */
  erasedAt: timestamp("erased_at", { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => {
  return {
    emailIdx: index("deleted_accounts_email_idx").on(table.email),
  };
});

export const subscriptionPlans = pgTable("subscription_plans", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 255 }).notNull(),
  /**
   * The MONTHLY price. NULLABLE since 0058, and the null is meaningful: "not
   * sold on this cycle".
   *
   * Every plan in the live price list is annual, and until the column allowed a
   * null that was unrepresentable — 0 renders "Free" and lets someone check out
   * a year's product for nothing, while the annual figure here sells a year's
   * plan for one month (`expiryForCycle('MONTHLY')`).
   *
   * Readers already coped: `getPlanPrice` coalesces, and the cycle <option>
   * guards plus `defaultDuration` in UnifiedCheckoutModal.jsx test for null, so
   * a plan without one opens on YEARLY and never offers MONTHLY.
   */
  price: decimal("price", { precision: 12, scale: 2 }),
  priceYearly: decimal("price_yearly", { precision: 12, scale: 2 }),
  priceOneTime: decimal("price_one_time", { precision: 12, scale: 2 }),
  priceUsd: decimal("price_usd", { precision: 12, scale: 2 }),
  priceYearlyUsd: decimal("price_yearly_usd", { precision: 12, scale: 2 }),
  priceOneTimeUsd: decimal("price_one_time_usd", { precision: 12, scale: 2 }),
  amcAmount: decimal("amc_amount", { precision: 12, scale: 2 }).default("0").notNull(),
  amcAmountUsd: decimal("amc_amount_usd", { precision: 12, scale: 2 }),
  aiCredits: integer("ai_credits").default(0).notNull(),
  /**
   * PERSONAL member seats. Unchanged in meaning by 0057 on purpose — every
   * existing reader (`/api/users`, the admin tenant screens, the AI cost
   * multiplier) keeps working untouched, and the business side gets its own
   * counter below rather than overloading this one.
   */
  maxMembers: integer("max_members").default(1).notNull(),
  /**
   * ── WHICH ACCOUNT THIS PLAN COVERS: 'personal' | 'business' | 'both' ──────
   *
   * The billing screen has two tabs, and this is what decides which one a plan
   * is offered in. A 'both' plan appears in each and, when bought, is written
   * to both of the tenant's axes at once.
   *
   * Defaults to 'personal' because that is what every plan sold so far IS:
   * they were all bought by households and sit in `tenants.subscriptionPlanId`,
   * which 0057 defines as the personal axis. Any other default would silently
   * re-describe live subscriptions.
   */
  appliesTo: varchar("applies_to", { length: 16 }).default('personal').notNull(),
  /**
   * Member seats IN EACH COMPANY. Not a business-wide pool.
   *
   * A business plan sells "N companies, M members in each", so a tenant on 3×10
   * may hold thirty employees across the account and still be refused an
   * eleventh on one company. Zero on a personal-only plan, which is correct.
   *
   * Counted against `company_access` rows for the company being joined, never
   * against `users.account_scope` — see seatPredicate in
   * src/lib/account/seatCounts.ts.
   */
  maxMembersPerCompany: integer("max_members_per_company").default(0).notNull(),
  /**
   * How many companies the business account may hold. This is the ONLY thing
   * that meters companies — they carry no subscription of their own — so
   * `POST /api/companies` checks it against `maxCompanies + extraCompanies`.
   */
  maxCompanies: integer("max_companies").default(0).notNull(),
  storageLimitGB: integer("storage_limit_gb").default(1).notNull(),
  isDefault: boolean("is_default").default(false).notNull(),
  badgeColor: varchar("badge_color", { length: 50 }).default('secondary').notNull(),
  durationDays: integer("duration_days"),
  isLifetime: boolean("is_lifetime").default(false),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const addons = pgTable("addons", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  price: decimal("price", { precision: 12, scale: 2 }),
  priceYearly: decimal("price_yearly", { precision: 12, scale: 2 }),
  priceOneTime: decimal("price_one_time", { precision: 12, scale: 2 }),
  priceUsd: decimal("price_usd", { precision: 12, scale: 2 }),
  priceYearlyUsd: decimal("price_yearly_usd", { precision: 12, scale: 2 }),
  priceOneTimeUsd: decimal("price_one_time_usd", { precision: 12, scale: 2 }),
  billingCycle: varchar("billing_cycle", { length: 50 }).default("MONTHLY").notNull(),
  aiCredits: integer("ai_credits").default(0).notNull(),
  /** Seats on the PERSONAL roster, on top of the plan's `maxMembers`. */
  extraMembers: integer("extra_members").default(0).notNull(),
  /**
   * Seats in EACH company, on top of the plan's `maxMembersPerCompany`. Same
   * grain as that column — a business plan sells "N companies, M members in
   * each", so this raises M and not a tenant-wide total.
   */
  extraMembersPerCompany: integer("extra_members_per_company").default(0).notNull(),
  /** Companies, on top of the plan's `maxCompanies`. */
  extraCompanies: integer("extra_companies").default(0).notNull(),
  storageLimitGB: integer("storage_limit_gb").default(0).notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const tenantAddons = pgTable("tenant_addons", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: 'cascade' }).notNull(),
  addonId: uuid("addon_id").references(() => addons.id, { onDelete: 'cascade' }).notNull(),
  /**
   * How many units of this add-on the tenant bought. Added by 0061, when the
   * checkout stopped being a checkbox and started selling "3 extra members".
   *
   * Multiplies the add-on's own grant — see `activeAddonSeats` in
   * src/lib/account/seatCounts.ts, which is the only reader that matters: one
   * row at quantity 3 of a "+1 member" add-on is three seats. CHECK (> 0) in
   * the database, clamped to 1..20 by the API before it is ever priced.
   */
  quantity: integer("quantity").default(1).notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  purchasedAt: timestamp("purchased_at", { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const payments = pgTable("payments", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: 'cascade' }).notNull(),
  planId: uuid("plan_id").references(() => subscriptionPlans.id, { onDelete: 'set null' }),
  addonId: uuid("addon_id").references(() => addons.id, { onDelete: 'set null' }),
  planBillingCycle: varchar("plan_billing_cycle", { length: 50 }),
  addonsPurchased: jsonb("addons_purchased"),
  /**
   * Which account this payment bought for: 'personal' | 'business' | 'both'.
   *
   * NULLABLE, and the null is meaningful rather than missing data: it marks a
   * payment taken before 0057, when a tenant had only one account to buy. The
   * billing history reads those into the Personal tab, which is where they
   * belong — see the `appliesTo` filter in /api/payments/history.
   */
  appliesTo: varchar("applies_to", { length: 16 }),
  /**
   * The line items of a COMBINED checkout — one order paying for the personal
   * plan and the business plan together:
   *   [{ planId, appliesTo, billingCycle, amount }]
   *
   * jsonb rather than a child table for exactly the reason `addonsPurchased`
   * above is: this is a frozen record of what was bought at a price that may no
   * longer exist, not a live relation anything joins to.
   *
   * `planId` below still carries the primary line, so the invoice generator and
   * the admin screens keep working without reading this.
   */
  plansPurchased: jsonb("plans_purchased"),
  invoiceUrl: text("invoice_url"),
  razorpayOrderId: varchar("razorpay_order_id", { length: 255 }),
  razorpayPaymentId: varchar("razorpay_payment_id", { length: 255 }),
  razorpaySignature: varchar("razorpay_signature", { length: 255 }),
  paymentMethod: varchar("payment_method", { length: 50 }).default("RAZORPAY").notNull(),
  paymentRef: varchar("payment_ref", { length: 255 }),
  amount: decimal("amount", { precision: 12, scale: 2 }).notNull(),
  currency: varchar("currency", { length: 10 }).default("INR").notNull(),
  status: varchar("status", { length: 50 }).default("created").notNull(),
  initiatedBy: varchar("initiated_by", { length: 50 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const invoices = pgTable("invoices", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: 'cascade' }).notNull(),
  invoiceNumber: varchar("invoice_number", { length: 100 }).notNull(),
  invoiceType: varchar("invoice_type", { length: 50 }).default("standard").notNull(),
  clientName: varchar("client_name", { length: 255 }).notNull(),
  clientEmail: varchar("client_email", { length: 255 }),
  clientGstin: varchar("client_gstin", { length: 50 }),
  clientAddress: text("client_address"),
  clientStateCode: varchar("client_state_code", { length: 10 }),
  clientPhone: varchar("client_phone", { length: 50 }),
  amount: decimal("amount", { precision: 12, scale: 2 }).notNull(),
  baseAmount: decimal("base_amount", { precision: 12, scale: 2 }).default("0").notNull(),
  gstAmount: decimal("gst_amount", { precision: 12, scale: 2 }).default("0").notNull(),
  gstType: varchar("gst_type", { length: 50 }).default("EXEMPT").notNull(),
  currency: varchar("currency", { length: 10 }).default("INR").notNull(),
  status: varchar("status", { length: 50 }).default("pending").notNull(), // pending, paid, overdue, cancelled
  dueDate: timestamp("due_date", { withTimezone: true }).notNull(),
  issuedDate: timestamp("issued_date", { withTimezone: true }).defaultNow().notNull(),
  notes: text("notes"),
  items: jsonb("items"), // array of { description, quantity, price }
  paymentLink: text("payment_link"),
  razorpayInvoiceId: varchar("razorpay_invoice_id", { length: 255 }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const usersRelations = relations(users, ({ one, many }) => ({
  tenant: one(tenants, { fields: [users.tenantId], references: [tenants.id] }),
  profile: one(profiles, { fields: [users.id], references: [profiles.userId] }),
  permissions: many(permissions),
  documents: many(documents, { relationName: "userDocuments" }),
  heldDocuments: many(documents, { relationName: "holderDocuments" }),
  devices: many(userDevices),
}));

export const documentsRelations = relations(documents, ({ one }) => ({
  user: one(users, { fields: [documents.userId], references: [users.id], relationName: "userDocuments" }),
  holder: one(users, { fields: [documents.holderId], references: [users.id], relationName: "holderDocuments" }),
  /**
   * The company half of "Belongs to" — null on a personal row.
   *
   * The business counterpart of `holder` above, and it exists for the same
   * reason: the list has to NAME who a record belongs to. `holderDisplayName`
   * (records/docMetadata.ts) had only members to answer with, so every business
   * row rendered '-' in the Holder column while the upload form had plainly
   * said "Belongs to: <company>".
   *
   * A relation over a column that already exists — no migration.
   */
  company: one(companies, {
    fields: [documents.companyId],
    references: [companies.id],
  }),
  // Named `categoryRef`, NOT `category`: the legacy varchar column is still
  // called `category`, and a relation of the same name silently overwrites the
  // column in every db.query result object.
  categoryRef: one(documentCategories, {
    fields: [documents.categoryId],
    references: [documentCategories.id],
  }),
}));

export const documentCategoriesRelations = relations(documentCategories, ({ many }) => ({
  documents: many(documents),
}));

export const permissionsRelations = relations(permissions, ({ one }) => ({
  user: one(users, { fields: [permissions.userId], references: [users.id] }),
}));

export const profilesRelations = relations(profiles, ({ one }) => ({
  user: one(users, { fields: [profiles.userId], references: [users.id] }),
}));

export const todosRelations = relations(todos, ({ one }) => ({
  assignee: one(users, { fields: [todos.assigneeId], references: [users.id], relationName: "todoAssignee" }),
  creator: one(users, { fields: [todos.creatorId], references: [users.id], relationName: "todoCreator" }),
}));


export const passwordsRelations = relations(passwords, ({ one }) => ({
  user: one(users, { fields: [passwords.userId], references: [users.id], relationName: "userPasswords" }),
  holder: one(users, { fields: [passwords.holderId], references: [users.id], relationName: "holderPasswords" }),
}));


export const paymentsRelations = relations(payments, ({ one }) => ({
  plan: one(subscriptionPlans, { fields: [payments.planId], references: [subscriptionPlans.id] }),
  addon: one(addons, { fields: [payments.addonId], references: [addons.id] }),
}));

export const invoicesRelations = relations(invoices, ({ one }) => ({
  tenant: one(tenants, { fields: [invoices.tenantId], references: [tenants.id] }),
}));

export const auditLogsRelations = relations(auditLogs, ({ one }) => ({
  user: one(users, { fields: [auditLogs.userId], references: [users.id] }),
  tenant: one(tenants, { fields: [auditLogs.tenantId], references: [tenants.id] }),
  company: one(companies, { fields: [auditLogs.companyId], references: [companies.id] }),
}));

export const aiAnalysisCache = pgTable("ai_analysis_cache", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: 'cascade' }).notNull(),
  userId: uuid("user_id").references(() => users.id, { onDelete: 'cascade' }),
  category: varchar("category", { length: 100 }).notNull().default('all'),
  /**
   * Which workspace was analysed. NULL is the household.
   *
   * Part of the cache KEY, not decoration: without it two companies analysing
   * `biz_licenses` share one row, so the second reads the first's summarised
   * records and then overwrites them. See migration 0054.
   */
  companyId: uuid("company_id").references(() => companies.id, { onDelete: 'restrict' }),
  analysisData: jsonb("analysis_data").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const aiAnalysisCacheRelations = relations(aiAnalysisCache, ({ one }) => ({
  tenant: one(tenants, { fields: [aiAnalysisCache.tenantId], references: [tenants.id] }),
  user: one(users, { fields: [aiAnalysisCache.userId], references: [users.id] }),
  company: one(companies, { fields: [aiAnalysisCache.companyId], references: [companies.id] }),
}));

export const addonsRelations = relations(addons, ({ many }) => ({
  tenantAddons: many(tenantAddons),
}));

export const tenantAddonsRelations = relations(tenantAddons, ({ one }) => ({
  tenant: one(tenants, { fields: [tenantAddons.tenantId], references: [tenants.id] }),
  addon: one(addons, { fields: [tenantAddons.addonId], references: [addons.id] }),
}));

export const discountCodes = pgTable("discount_codes", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: varchar("code", { length: 100 }).unique().notNull(),
  type: varchar("type", { length: 50 }).default("PERCENTAGE").notNull(),
  discountPct: integer("discount_pct").notNull(),
  discountAmount: decimal("discount_amount", { precision: 12, scale: 2 }),
  maxUses: integer("max_uses"),
  maxUsesPerTenant: integer("max_uses_per_tenant"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  planId: uuid("plan_id").references(() => subscriptionPlans.id, { onDelete: 'set null' }),
  addonId: uuid("addon_id").references(() => addons.id, { onDelete: 'set null' }),
  billingCycle: varchar("billing_cycle", { length: 50 }),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const discountUsages = pgTable("discount_usages", {
  id: uuid("id").primaryKey().defaultRandom(),
  discountCodeId: uuid("discount_code_id").references(() => discountCodes.id, { onDelete: 'cascade' }).notNull(),
  tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: 'cascade' }).notNull(),
  paymentId: uuid("payment_id").references(() => payments.id, { onDelete: 'set null' }),
  amountSaved: decimal("amount_saved", { precision: 12, scale: 2 }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const discountUsagesRelations = relations(discountUsages, ({ one }) => ({
  discountCode: one(discountCodes, { fields: [discountUsages.discountCodeId], references: [discountCodes.id] }),
  tenant: one(tenants, { fields: [discountUsages.tenantId], references: [tenants.id] }),
  payment: one(payments, { fields: [discountUsages.paymentId], references: [payments.id] }),
}));

export const discountCodesRelations = relations(discountCodes, ({ one, many }) => ({
  plan: one(subscriptionPlans, { fields: [discountCodes.planId], references: [subscriptionPlans.id] }),
  addon: one(addons, { fields: [discountCodes.addonId], references: [addons.id] }),
  usages: many(discountUsages),
}));

export const userDevices = pgTable("user_devices", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: 'cascade' }).notNull(),
  userId: uuid("user_id").references(() => users.id, { onDelete: 'cascade' }).notNull(),
  fcmToken: varchar("fcm_token", { length: 500 }).unique().notNull(),
  platform: varchar("platform", { length: 50 }).notNull(),
  lastActiveAt: timestamp("last_active_at", { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const userDevicesRelations = relations(userDevices, ({ one }) => ({
  user: one(users, { fields: [userDevices.userId], references: [users.id] }),
  tenant: one(tenants, { fields: [userDevices.tenantId], references: [tenants.id] }),
}));

// ─── 6 Additional High-Value Enterprise Record Vaults ────────────────────────


/* ══════════════════════════════════════════════════════════════════════════
 *  VAULT — two-tier field encryption
 *
 *  Record content lives on the tenant's Google Drive, split into two tiers:
 *
 *    OPEN   — de-identified attributes (amounts, dates, categories, masked
 *             free text). Sealed with the APP key, so AI analysis, reminders
 *             and cron keep working when nobody is logged in.
 *    SEALED — personally identifying fields and document bytes. Sealed with
 *             the VAULT key, which only a member's browser can unwrap.
 *             The server never holds it.
 *
 *  Both tiers are AES-256-GCM on Drive; "open" means *we* can read it, not
 *  that Google can.
 * ═════════════════════════════════════════════════════════════════════════ */

/**
 * The app-held tenant key, wrapped by ENCRYPTION_SECRET (envelope encryption).
 *
 * A table rather than a `tenants` column because rotation needs several live
 * versions at once: content sealed under v1 must stay readable while v2 becomes
 * the write key. `documents.key_version` / `vault_json_files.key_version` name
 * the version, so decryption never needs a try-every-key loop.
 *
 * The partial unique index on status='active' is what makes concurrent first
 * use safe — two simultaneous requests both INSERT ... ON CONFLICT DO NOTHING,
 * one wins, and both then SELECT the winner.
 */
export const tenantEncryptionKeys = pgTable("tenant_encryption_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: 'cascade' }).notNull(),
  version: integer("version").default(1).notNull(),
  /** encryptField(base64(32 random bytes)) — never the raw key. */
  wrappedKey: text("wrapped_key").notNull(),
  /**
   * HMAC(dek,'docsnx.keycheck.v1'). Load-bearing: decryptField returns the
   * literal string '[Decryption Failed]' instead of throwing, so without this
   * check a wrong ENCRYPTION_SECRET would silently yield a garbage key and
   * encrypt everything unrecoverably.
   */
  keyCheck: varchar("key_check", { length: 64 }).notNull(),
  algo: varchar("algo", { length: 32 }).default('AES-256-GCM').notNull(),
  /** active | retiring | retired */
  status: varchar("status", { length: 16 }).default('active').notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  rotatedAt: timestamp("rotated_at", { withTimezone: true }),
  retiredAt: timestamp("retired_at", { withTimezone: true }),
}, (table) => {
  return {
    tenantVersionIdx: uniqueIndex("tenant_encryption_keys_tenant_version_idx")
      .on(table.tenantId, table.version),
    activeIdx: uniqueIndex("tenant_encryption_keys_active_idx")
      .on(table.tenantId)
      .where(sql`${table.status} = 'active'`),
  };
});

/**
 * Per-member wrapped copies of the workspace vault key.
 *
 * One random 32-byte key per tenant, generated in the browser and never stored
 * in readable form anywhere. Each row holds THE SAME key encrypted under a KEK
 * derived from that member's vault passphrase — which is how a workspace shares
 * records without sharing a secret, and why changing a passphrase re-wraps one
 * row and re-encrypts no data at all.
 *
 * The vault passphrase is deliberately NOT the login password: the server
 * receives the login password to verify it, so reusing it would hand the server
 * KEK material at every login and make "DocsNX cannot read your PII" untrue.
 *
 * `source='recovery_code'` is the second wrapped copy issued at setup. Without
 * it a forgotten passphrase is unrecoverable — there is no admin path, by
 * construction.
 */
export const userVaultKeys = pgTable("user_vault_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: 'cascade' }).notNull(),
  userId: uuid("user_id").references(() => users.id, { onDelete: 'cascade' }).notNull(),
  /** passphrase | recovery_code */
  source: varchar("source", { length: 24 }).default('passphrase').notNull(),
  version: integer("version").default(1).notNull(),
  /** The vault key, AES-GCM encrypted under this member's passphrase-derived KEK. */
  wrappedKey: text("wrapped_key").notNull(),
  kdf: varchar("kdf", { length: 24 }).default('PBKDF2-SHA256').notNull(),
  /** Per-user random. Never the tenant UUID — that is public and shared. */
  kdfSalt: varchar("kdf_salt", { length: 64 }).notNull(),
  kdfIterations: integer("kdf_iterations").default(600000).notNull(),
  /** Proves an unwrap actually succeeded rather than producing garbage. */
  keyCheck: varchar("key_check", { length: 64 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => {
  return {
    memberSourceIdx: uniqueIndex("user_vault_keys_member_source_idx")
      .on(table.tenantId, table.userId, table.source, table.version),
    tenantIdx: index("user_vault_keys_tenant_idx").on(table.tenantId),
  };
});

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   ENCRYPTION POLICY — ONE ROW PER CATEGORY, CSV OF FIELDS TO ENCRYPT     ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * ONE ROW PER ACTIVE CATEGORY — 83 of them — and none for a retired one.
 *
 * That invariant is enforced by drizzle/0035, which asserts it after deleting
 * the 15 rows 0023 orphaned when it retired the per-module `miscellaneous`
 * buckets. Before that the table carried 98 rows, and the 15 extras were dead
 * weight the seed script never addressed: NULL `fields`, empty CSV lists, and
 * an `encrypted_fields` last written by 0008/0015/0018. A retired category has
 * no policy row and needs none — nothing can file a record under one.
 *
 * `encryptedFields` is a comma-separated list of the extracted keys that must
 * be sealed under the vault key:
 *
 *   identity.pan_card → 'pan_number,father_name,date_of_birth,holder_name,notes'
 *
 * Application is DYNAMIC — splitRecordFields() in src/lib/vault/fieldSplitter.ts
 * intersects this list with the keys actually present on the record, so a
 * category may name a field a given document does not carry and nothing breaks.
 *
 * NO tenant column: the policy is identical for every tenant, so this is a
 * plain global reference table with no RLS policy — see scripts/apply-rls.js,
 * where it appears in neither list. It had a nullable tenant_id until
 * drizzle/0008_document_category_fields_csv.sql; do not reintroduce it.
 *
 * ⚠ A key that is NOT named here is stored in the CLEAR. The list is the whole
 * policy, so it must be complete, and a category with no row at all encrypts
 * nothing. src/lib/documentCategoryFields.ts is the source of truth and carries
 * the per-field rationale; tests/documentCategoryFields.test.ts enforces that
 * every category has a row.
 *
 * ── THE CSV COLUMNS ARE THE DICTIONARY'S ANSWER, NOT THE OPERATOR'S ────────
 * `mandatory_fields`, `all_fields` and `ocr_fields` are written ONLY by
 * scripts/seed_document_category_fields.ts, from the compiled dictionary. They
 * know nothing about `document_category_field_overrides` — a field a super
 * admin hid, added, made mandatory or retired from OCR on /admin/document-fields
 * still reads here exactly as it shipped. Nothing in the app reads them for
 * that reason; the override-aware answers come from `loadCategoryFieldSpec`
 * (src/lib/records/categorySpec.ts) and from
 * `GET /api/modules/:moduleKey/:documentKey/fields`, which derives all three
 * lists from the effective spec. Ask those, never these, when the question is
 * "what does this sub-category do TODAY".
 *
 * `encrypted_fields` is the exception and is not a mere projection: it IS read
 * at runtime, by `loadEncryptionPolicy`, which applies the overrides over it.
 */
export const documentCategoryFields = pgTable("document_category_fields", {
  id: uuid("id").primaryKey().defaultRandom(),
  categoryId: uuid("category_id").references(() => documentCategories.id, { onDelete: 'cascade' }).notNull(),
  /**
   * Comma-separated extracted-field keys to encrypt, e.g.
   * `pan_number,father_name,date_of_birth`. Parse with parseEncryptedFields()
   * rather than a bare split — it trims and drops empties.
   */
  encryptedFields: text("encrypted_fields").default('').notNull(),
  /**
   * The category's FORM spec: every field it can carry, in order, with its
   * label, data type, required flag and validation rule.
   *
   * `encryptedFields` above answers "what do I seal"; this answers "what do I
   * collect, and what counts as a valid value". It exists as a column because
   * the browser needs the answer for ONE category and the compiled dictionary
   * (src/lib/documentCategoryFields.ts) is a thousand lines it must never ship.
   *
   * Seeded from DOCUMENT_CATEGORY_FIELD_SPECS — that file stays the source of
   * truth and `scripts/seed_document_category_fields.ts` re-materialises this.
   * Nullable so the 0025 migration is additive; readers fall back to the
   * compiled spec, the same fail-closed rule loadEncryptionPolicy follows.
   */
  fields: jsonb("fields"),
  /**
   * The field keys a record of this category cannot be saved without, e.g.
   * `document_title,pan_number`. A FLAT PROJECTION of the `isRequired` flags
   * inside `fields` above — never a second policy.
   *
   * Nothing validates against this column: the form and both write routes read
   * `isRequired` off the spec (src/lib/records/fieldValidation.ts). Editing it
   * to disagree with `fields` therefore changes nothing except what a SQL
   * reader is told. Edit the spec in src/lib/documentCategoryFields.ts and
   * re-run scripts/seed_document_category_fields.ts, which rewrites both.
   *
   * Seed-written, so it does not carry operator overrides — a field made
   * mandatory on /admin/document-fields is required by the form and absent
   * from here. See the table header.
   *
   * Parse with parseFieldCsv() rather than a bare split.
   */
  mandatoryFields: text("mandatory_fields").default('').notNull(),
  /**
   * Every field key the category declares, in the order the form renders them.
   *
   * Answers "what can this sub-category hold at all" without deserialising
   * `fields` — the question a report, an export mapping or an ops query asks.
   * Always a superset of both `mandatory_fields` and `encrypted_fields`.
   *
   * Includes the baseline `custom_fields` key. The user's OWN label/value rows
   * live inside that key's JSON and are record data, not taxonomy — they never
   * appear here.
   *
   * '' means NOT SEEDED (the 0033 migration adds the column empty), not "this
   * category has no fields"; readers fall back to the compiled spec, the same
   * rule loadCategoryFieldSpec follows.
   */
  allFields: text("all_fields").default('').notNull(),
  /**
   * The field keys a scan should try to READ off the document — `all_fields`
   * minus the two keys no document states (`holder_name`, answered by the
   * "Belongs to" picker; `custom_fields`, rows the user invents).
   *
   * Unlike its two siblings this one is not merely descriptive: `ocrFieldKeys`
   * in src/lib/documentCategoryFields.ts is what builds BOTH this column and
   * the ask-list `extractCategoryFields` (src/lib/ai.js) sends to the model, so
   * the row states the prompt that is actually issued — for a category nobody
   * has configured. The live ask-list is `ocrFieldKeys` applied to the
   * EFFECTIVE spec, so a field an operator retired or added moves the prompt
   * and leaves this column where the seed left it. See the table header.
   *
   * Being read is a separate axis from being SEALED. A key here may be `isPii`
   * and land in `encrypted_fields` too — extraction decides what is asked for,
   * the encrypt policy decides where the answer is stored.
   */
  ocrFields: text("ocr_fields").default('').notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => {
  return {
    // One policy row per category — the point of the 0008 restructure.
    categoryIdx: uniqueIndex("document_category_fields_category_idx").on(table.categoryId),
  };
});

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║   OPERATOR OVERRIDES — what a super admin changed, and only that         ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * One row per (category, field) an admin has configured on
 * /admin/document-fields. Everything else follows the compiled dictionary.
 *
 * ── WHY THIS IS NOT JUST AN EDIT TO document_category_fields ───────────────
 * That table is a COPY. src/lib/documentCategoryFields.ts is the source of
 * truth, and scripts/seed_document_category_fields.ts re-materialises all five
 * of its columns for all 83 rows on every run — deliberately, so a policy
 * cannot silently drift from the code that reasons about it. An admin edit
 * written there would be erased by the next deploy, with no warning and no
 * record of what was lost.
 *
 * Keeping overrides in their own table means the seed script needs no changes,
 * AND a later dictionary fix still reaches every field the admin has not
 * touched. Both halves matter: the first keeps admin choices, the second keeps
 * security fixes flowing.
 *
 * ── EVERY COLUMN IS NULLABLE, AND NULL IS NOT false ────────────────────────
 * NULL means "the admin has expressed no view — use the dictionary". `false`
 * means "the admin turned this off". Collapsing the two would make Reset
 * impossible and would freeze a field against every future dictionary change
 * on the strength of a value that only ever meant "unset".
 *
 * ── TWO KINDS OF ROW SINCE 0041 ────────────────────────────────────────────
 * `is_custom = false` is everything above: an ADJUSTMENT to a field the
 * dictionary declares.
 *
 * `is_custom = true` rows DEFINE a field the dictionary knows nothing about.
 * The NULL rule cannot apply to them — there is no dictionary answer behind a
 * NULL — so `field_label` and `data_type` are required by a CHECK constraint.
 * They live here rather than in a table of their own because this table
 * already has the one constraint they need: the unique index on
 * (category_id, field_key), which is what makes a custom key colliding with a
 * dictionary key impossible. Splitting them would also mean threading a second
 * loader through `loadEncryptionPolicy`, and the whole point of
 * src/lib/records/fieldOverrides.ts is that overrides are applied in exactly
 * two places.
 *
 * NO tenant column: the taxonomy is global and a super admin is a platform
 * role, so this carries no RLS policy — see scripts/apply-rls.js, where it
 * appears in neither list, and tests/rlsCoverage.test.ts, which exempts it
 * explicitly.
 *
 * ⚠ `fieldKey` is not editable through this table and never should be. It is
 * the join key already-sealed ciphertext is stored under; renaming one strands
 * that data beyond recovery. Retiring a field is `isHidden`, which stops it
 * being rendered or accepted while leaving existing values retrievable.
 */
export const documentCategoryFieldOverrides = pgTable("document_category_field_overrides", {
  id: uuid("id").primaryKey().defaultRandom(),
  categoryId: uuid("category_id").references(() => documentCategories.id, { onDelete: 'cascade' }).notNull(),
  /** Matches documentCategoryFields.fields[].fieldKey. Addressed, never renamed. */
  fieldKey: varchar("field_key", { length: 100 }).notNull(),

  /** Display label on the add form. Cosmetic — nothing resolves on it. */
  fieldLabel: varchar("field_label", { length: 200 }),
  /**
   * One of FIELD_DATA_TYPES. Drives value coercion (autofillCoerce) and
   * validation (fieldValidation), so changing it reinterprets values ALREADY
   * stored — text → date leaves an old 'N/A' in place, failing on next edit.
   */
  dataType: varchar("data_type", { length: 16 }),
  /** Sealed tier vs open tier. Unsealing is a forward privacy downgrade. */
  isPii: boolean("is_pii"),
  /** The form refuses to save without it. Never set on a hidden field. */
  isRequired: boolean("is_required"),
  /** Whether a scan is asked to read this off the document. */
  isPrinted: boolean("is_printed"),
  /**
   * Decides "is this write a duplicate of an existing record".
   *
   * The sharp one. An identifier must be unique PER RECORD, not per person: a
   * UAN or a PAN is one per person for life, so making one a payslip's identity
   * turns every month's slip into a duplicate of the last and overwrites it.
   */
  isIdentifier: boolean("is_identifier"),
  /**
   * Retire the field: not rendered, not accepted on write. The only safe form
   * of "delete" — the key survives so sealed values stay retrievable.
   */
  isHidden: boolean("is_hidden"),
  /** Position on the form. */
  sortOrder: integer("sort_order"),
  /**
   * The editable SUBSET of FieldValidation — example, maxLength, min, max,
   * notFuture, notPast. Merged OVER the compiled rule, never replacing it, so
   * the anchored regex patterns stay in code where they are testable.
   */
  validation: jsonb("validation"),

  /**
   * ── THE ONE COLUMN THAT CHANGES WHAT A ROW MEANS ─────────────────────────
   *
   * `false` (the default, and every row written before 0041): this row ADJUSTS
   * a field the dictionary declares. NULL columns mean "no view expressed".
   *
   * `true`: this row IS the field. A super admin created it on
   * /admin/document-fields and no compiled spec declares it, so there is
   * nothing behind a NULL to fall back to — which is why the table carries a
   * CHECK constraint requiring `field_label` and `data_type` on these rows.
   * `applyOverrides` appends them to the category's spec; everything
   * downstream — the encrypt policy, the allowlist, the OCR ask-list — reads
   * them like any other field, because they ARE any other field by then.
   *
   * It is also what makes Delete meaningful: a custom row may be removed
   * outright (the field stops existing), where a dictionary field can only be
   * retired with `is_hidden`.
   */
  isCustom: boolean("is_custom").default(false).notNull(),
  /**
   * Help text under the input. Applies to BOTH kinds of row — explaining what
   * "Assessment Year" means to the people filling it in is the common case,
   * and that field is a dictionary field.
   */
  description: text("description"),
  /**
   * How a CHOICE field is drawn: dropdown | radio | checkbox | chips.
   *
   * Presentation only, and deliberately separate from `data_type`. A dropdown
   * and a radio group are the same question — "choose one of these" — and
   * making them two data types would duplicate the validation rule, the AI
   * coercion and the OCR prompt for no gain, then let the copies drift. The
   * admin screen still offers "Dropdown" and "Radio buttons" as if they were
   * types; it stores (dataType, display).
   */
  display: varchar("display", { length: 16 }),
  /**
   * The permitted answers for `select` / `multiselect`: `[{ value, label }]`.
   *
   * `value` is what is stored and what a scan must snap its answer to; `label`
   * is what the form shows. Null for every other data type.
   */
  options: jsonb("options"),
  /**
   * Does this date drive a follow-up? Three-state, like its siblings.
   *
   * NULL falls back to REMINDER_FIELD_KEYS (src/lib/records/reminderPolicy.ts),
   * a hardcoded set of twelve keys — which is why, until this column, a custom
   * date could never produce a reminder and an existing one could never be
   * promoted to it. Only meaningful on `date`.
   */
  isReminder: boolean("is_reminder"),
  /**
   * How many days BEFORE the date the alert should reach the user.
   *
   * `is_reminder` says WHETHER a date alerts; this says how early. Three-state
   * like its siblings: NULL falls back to ALERT_DAYS_BY_KEY and then to
   * DEFAULT_ALERT_DAYS (15) — both src/lib/records/reminderPolicy.ts — which is
   * why 0 must never be written to mean "unset". Zero is a real answer, and it
   * means "tell me on the day it expires".
   *
   * Bounded 0…365 by a CHECK constraint (drizzle/0047), the same range
   * `normaliseAlertDays` and the admin API enforce. Beyond a year the reminder
   * is permanently on the follow-up page and stops being a reminder.
   *
   * NOT the last word. A user may set `alert_days_before` on one RECORD, and
   * that wins over this — see `recordAlertLeadDays`. This is the default every
   * record of the sub-category starts from.
   */
  alertDaysBefore: integer("alert_days_before"),

  /** Who last touched it. SET NULL so removing an admin keeps the override. */
  updatedBy: uuid("updated_by").references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => {
  return {
    // One override row per field per category — the row IS the field's config.
    fieldIdx: uniqueIndex("document_category_field_overrides_field_idx")
      .on(table.categoryId, table.fieldKey),
  };
});

/**
 * One row per encrypted JSON file on the tenant's Drive.
 *
 * Deliberately not named "blob" — src/lib/azureBlob.ts already owns that word
 * for Azure Blob Storage, and confusing the two would be expensive.
 *
 * `revision` is the staleness authority. If a JSON file fetched from Drive
 * carries a revision BEHIND the one recorded here, someone restored an older
 * copy from Drive's UI — that must hard-fail rather than silently overwrite
 * newer records with older ones.
 */
export const vaultJsonFiles = pgTable("vault_json_files", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").references(() => tenants.id, { onDelete: 'cascade' }).notNull(),
  /** documents | passwords */
  module: varchar("module", { length: 40 }).notNull(),
  /**
   * document_categories.(module_key, document_key), or PASSWORD_MODULE_KEY +
   * slugifyCategory() output for passwords.
   */
  categoryModuleKey: varchar("category_module_key", { length: 60 }).notNull(),
  categoryDocumentKey: varchar("category_document_key", { length: 60 }).notNull(),
  /**
   * Which company's store this is. NULL = the tenant's personal store.
   *
   * Part of the store's IDENTITY, not a detail: two companies filing into
   * `biz_tax/gst_returns` have two separate encrypted files in two separate
   * Drive folders, and one pointer row each. It is therefore in the unique
   * index below, wrapped in a coalesce — see the note there.
   */
  companyId: uuid("company_id").references(() => companies.id, { onDelete: 'restrict' }),
  // Drive's API takes file IDs, not URLs — a webViewLink cannot fetch, update
  // or trash a file.
  driveFileId: varchar("drive_file_id", { length: 128 }).notNull(),
  driveFolderId: varchar("drive_folder_id", { length: 128 }).notNull(),
  revision: integer("revision").default(0).notNull(),
  keyVersion: integer("key_version").default(1).notNull(),
  recordCount: integer("record_count").default(0).notNull(),
  byteSize: integer("byte_size").default(0).notNull(),
  driveModifiedTime: timestamp("drive_modified_time", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => {
  return {
    /**
     * One store per (tenant, company, module, category), as TWO PARTIAL indexes.
     *
     * The rule needs stating in two halves because in Postgres NULLs are
     * DISTINCT: a single 5-column unique index would let one tenant hold any
     * number of conflicting PERSONAL stores for one category, which is the
     * exact duplicate-store bug these exist to prevent.
     *
     * `permissions_user_module_doc_idx` says the same thing with a coalesce, and
     * that was the first attempt here. It is unusable at this table: Drizzle's
     * `onConflictDoUpdate` takes a column list, not an expression, so the
     * pointer upsert could not name it. Partial indexes are targetable with
     * `targetWhere` — and they are the shape `users_email_uq` already uses.
     */
    fileKeyIdx: uniqueIndex("vault_json_files_key_idx")
      .on(table.tenantId, table.module, table.categoryModuleKey, table.categoryDocumentKey)
      .where(sql`company_id IS NULL`),
    companyFileKeyIdx: uniqueIndex("vault_json_files_company_key_idx")
      .on(
        table.tenantId,
        table.companyId,
        table.module,
        table.categoryModuleKey,
        table.categoryDocumentKey,
      )
      .where(sql`company_id IS NOT NULL`),
  };
});


// Declared here rather than beside the other relations blocks: `relations()`
// evaluates its table argument eagerly, so it must run after the const above.
export const tenantEncryptionKeysRelations = relations(tenantEncryptionKeys, ({ one }) => ({
  tenant: one(tenants, { fields: [tenantEncryptionKeys.tenantId], references: [tenants.id] }),
}));

export const userVaultKeysRelations = relations(userVaultKeys, ({ one }) => ({
  tenant: one(tenants, { fields: [userVaultKeys.tenantId], references: [tenants.id] }),
  user: one(users, { fields: [userVaultKeys.userId], references: [users.id] }),
}));

export const documentCategoryFieldsRelations = relations(documentCategoryFields, ({ one }) => ({
  category: one(documentCategories, {
    fields: [documentCategoryFields.categoryId],
    references: [documentCategories.id],
  }),
}));

export const documentCategoryFieldOverridesRelations = relations(
  documentCategoryFieldOverrides,
  ({ one }) => ({
    category: one(documentCategories, {
      fields: [documentCategoryFieldOverrides.categoryId],
      references: [documentCategories.id],
    }),
    updatedByUser: one(users, {
      fields: [documentCategoryFieldOverrides.updatedBy],
      references: [users.id],
    }),
  }),
);

export const vaultJsonFilesRelations = relations(vaultJsonFiles, ({ one }) => ({
  tenant: one(tenants, { fields: [vaultJsonFiles.tenantId], references: [tenants.id] }),
}));

export const companiesRelations = relations(companies, ({ one, many }) => ({
  tenant: one(tenants, { fields: [companies.tenantId], references: [tenants.id] }),
  access: many(companyAccess),
  profile: one(companyProfiles, {
    fields: [companies.id],
    references: [companyProfiles.companyId],
  }),
}));

export const companyProfilesRelations = relations(companyProfiles, ({ one }) => ({
  tenant: one(tenants, { fields: [companyProfiles.tenantId], references: [tenants.id] }),
  company: one(companies, { fields: [companyProfiles.companyId], references: [companies.id] }),
}));

export const companyAccessRelations = relations(companyAccess, ({ one }) => ({
  user: one(users, { fields: [companyAccess.userId], references: [users.id] }),
  company: one(companies, { fields: [companyAccess.companyId], references: [companies.id] }),
}));
