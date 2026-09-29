# docsnx — Manual Test Case Suite (Master Plan)

> **Scope:** Manual, module-wise functional test cases for the docsnx multi-tenant records
> management platform. Covers **UI validation**, **field & business rule validation**,
> **end-to-end workflows**, and **database validation**.
>
> **Explicitly out of scope:** API/contract test cases (no direct HTTP request/response
> test cases are included). All verification is performed through the browser UI, with the
> database used only as a *post-condition assertion* mechanism.

---

## 1. Test Suite Index

| File | Module(s) Covered | Prefix |
|---|---|---|
| [TC-01-authentication-session.md](TC-01-authentication-session.md) | Registration, Email OTP Verification, Login, Forgot/Reset Password, Logout, Session & JWT, Rate Limiting | `AUTH` |
| [TC-02-onboarding-shell-navigation.md](TC-02-onboarding-shell-navigation.md) | Onboarding wizard, App Shell, Sidebar navigation, Theme, Font-size, PWA, "More" page | `SHL` |
| [TC-03-members-permissions.md](TC-03-members-permissions.md) | Members (Users), Roles, Per-module Permission Matrix, Member limits | `MEM` |
| [TC-04-profiles.md](TC-04-profiles.md) | Profiles (personal / education / shopping / legal details), auto-profile enrichment | `PRF` |
| [TC-05-documents.md](TC-05-documents.md) | Document Vault (upload, categories, replace, AI auto-fill, download/share) | `DOC` |
| [TC-06-passwords.md](TC-06-passwords.md) | Password Manager (encrypted credential vault, reveal, copy, generator) | `PWD` |
| [TC-07-todos.md](TC-07-todos.md) | To-Dos (assignment, status, due dates, push notification flag) | `TDO` |
| [TC-08-care-and-safety.md](TC-08-care-and-safety.md) | Medical Records, LIC & Mediclaim, Important Contacts | `MED`, `LIC`, `EMC` |
| [TC-09-bank-cards-trading.md](TC-09-bank-cards-trading.md) | Bank & Cards (bank accounts + credit cards), Trading & Demat | `BNK`, `CRD`, `TRD` |
| [TC-10-investments-vehicles.md](TC-10-investments-vehicles.md) | Investments (property/shares/MF/gold), Vehicles | `INV`, `VEH` |
| [TC-11-enterprise-vaults.md](TC-11-enterprise-vaults.md) | Tax & Compliance, Loans & Debts, Wills & Estate, Utility Bills, Corporate Compliance, Employment & Payroll | `TAX`, `LON`, `WIL`, `UTL`, `CRP`, `EMP` |
| [TC-12-warranty-rentals.md](TC-12-warranty-rentals.md) | Warranty & AMC, Rentals & Subscriptions | `WRN`, `RNT` |
| [TC-13-followups-notifications-search.md](TC-13-followups-notifications-search.md) | Follow-Up / renewal alerts, Notifications, Global Search | `FUP`, `NTF`, `SRC` |
| [TC-14-ai-analysis-and-settings.md](TC-14-ai-analysis-and-settings.md) | AI Analysis, Bulk Scan, AI Settings (BYO key), AI Costs & Credits, AI Privacy Shield | `AIA`, `BLK`, `AIS` |
| [TC-15-billing-payments-invoices.md](TC-15-billing-payments-invoices.md) | Billing, Plans, Add-ons, Discount codes, Razorpay checkout, AMC lock, Invoices | `BIL`, `INVC` |
| [TC-16-backup-drive-account.md](TC-16-backup-drive-account.md) | Backup & Export, Google Drive Zero-Knowledge Sync, Account Data Export & Deletion | `BKP`, `ZKD`, `ACC` |
| [TC-17-audit-logs.md](TC-17-audit-logs.md) | Audit Logs viewer & audit-trail completeness | `AUD` |
| [TC-18-super-admin-console.md](TC-18-super-admin-console.md) | Super Admin: Tenants, Users, Plans, Add-ons, Discounts, Payments, Platform Settings, SMTP, AI Keys | `SAD` |
| [TC-19-security-tenant-isolation.md](TC-19-security-tenant-isolation.md) | Cross-cutting: tenant isolation, IDOR, encryption at rest, masking, secret leakage, soft delete | `SEC` |
| [TC-20-non-functional-ui-ux.md](TC-20-non-functional-ui-ux.md) | Responsive layout, Accessibility, Performance, Browser matrix, Error/empty/loading states | `NFR` |

---

## 2. Application Under Test

| Item | Value |
|---|---|
| Product | docsnx — multi-tenant member management SaaS vault |
| Stack | Next.js 15.1 (App Router), React 19, TypeScript, Drizzle ORM, PostgreSQL, Tailwind CSS v3 + Radix UI |
| Local URL | `http://localhost:3005` (or the port set in `.env.local` / `PORT`) |
| DB | PostgreSQL — connection string in `DATABASE_URL` (`.env.local`) |
| Roles | `SUPER_ADMIN`, `TENANT_ADMIN`, `STANDARD` |
| Session | JWT signed with `JWT_SECRET`, 7-day expiry, `HttpOnly` cookie named `auth_token` |
| Record modules | 19 tenant-scoped record vaults + billing/admin/AI modules |

### 2.1 Module → Route → Table → Permission-key map

| Module | UI Route | DB Table | Permission key |
|---|---|---|---|
| Profiles | `/profile` | `profiles` | `profiles` |
| Members | `/users` | `users`, `permissions` | *(admin-only; no permission row)* |
| Documents | `/documents` | `documents` | `documents` |
| Passwords | `/passwords` | `passwords` | `passwords` |
| To-Dos | `/todos` | `todos` | `todos` |
| Medical Records | `/medical` | `medical_records` | `medical` |
| LIC & Mediclaim | `/lic-mediclaim` | `lic_mediclaims` | `lic_mediclaim` |
| Important Contacts | `/important-contacts` | `emergency_contacts` | `emergency_contacts` |
| Bank & Cards | `/bank-info` | `bank_infos`, `credit_cards` | `bank_info` |
| Trading | `/trading` | `trading_demats` | `trading` |
| Investments | `/investments` | `investments` | `investments` |
| Vehicles | `/vehicles` | `vehicles` | `vehicles` |
| Tax & Compliance | `/tax-compliance` | `tax_compliances` | `tax_compliance` |
| Loans & Debts | `/loans-debt` | `loans_debts` | `loans_debt` |
| Wills & Estate | `/wills-estate` | `wills_estates` | `wills_estate` |
| Warranty & AMC | `/warranty` | `warranty_amcs` | `warranty` |
| Rentals & Subscriptions | `/rentals` | `contract_agreements` | `rentals` |
| Utility Bills | `/utility-bills` | `utility_bills` | `utility_bills` |
| Corporate Compliance | `/corporate-compliance` | `corporate_compliances` | `corporate_compliance` |
| Employment & Payroll | `/employment-payroll` | `employment_payrolls` | `employment_payroll` |
| Audit Logs | `/audit-logs` | `audit_logs` | `audit_logs` |

---

## 3. Test Environment Setup

### 3.1 Pre-requisites

1. Application running: `npm run dev` (dev) or `docker compose up -d` (prod-like).
2. `.env.local` populated with at minimum: `DATABASE_URL`, `JWT_SECRET`, `ENCRYPTION_SECRET`,
   `APP_URL`. Optional integrations: `AZURE_STORAGE_CONNECTION_STRING`, Razorpay keys,
   Google OAuth client, Gemini/OpenAI keys.
3. Database schema up to date: `npx drizzle-kit push` (dev) / `npx drizzle-kit migrate` (prod).
4. SMTP configured under **Super Admin → SMTP** (needed for OTP and password-reset emails).
5. At least one `subscription_plans` row with `is_default = true` **must** exist — registration
   is blocked without it.
6. A `psql` client (or any SQL tool) connected to the same database for the DB validation cases.

### 3.2 Required test data

| Alias | Purpose | How to create |
|---|---|---|
| `TENANT_A` | Primary test tenant | Register via `/register` as "QA Household A" |
| `TENANT_B` | Isolation counterpart tenant | Register via `/register` as "QA Household B" |
| `ADMIN_A` | `TENANT_ADMIN` of TENANT_A | Created automatically during TENANT_A registration |
| `ADMIN_B` | `TENANT_ADMIN` of TENANT_B | Created automatically during TENANT_B registration |
| `USER_A1` | `STANDARD` user in TENANT_A, all permissions granted | Created via `/users` |
| `USER_A2` | `STANDARD` user in TENANT_A, **view-only** on every module | Created via `/users`, permissions edited |
| `USER_A3` | `STANDARD` user in TENANT_A, **no permission** on `passwords` and `bank_info` | Created via `/users` |
| `SUPERADMIN` | Platform `SUPER_ADMIN` | Seed with `node create-admin.mjs` or set `role='SUPER_ADMIN'` directly |
| `EXPIRED_T` | Tenant with `subscription_expiry` in the past | Set via SQL (see §3.3) |
| `INACTIVE_T` | Tenant with `is_active = false` | Set via SQL or Super Admin console |

### 3.3 Useful test-data SQL snippets

```sql
-- Force a tenant's subscription to be expired
UPDATE tenants SET subscription_expiry = now() - interval '1 day' WHERE name = 'QA Household A';

-- Restore a tenant's subscription
UPDATE tenants SET subscription_expiry = now() + interval '365 days' WHERE name = 'QA Household A';

-- Suspend / re-activate a tenant
UPDATE tenants SET is_active = false WHERE name = 'QA Household A';

-- Read back the raw (hashed) OTP for a pending registration
SELECT email, email_verified, email_verification_otp, email_verification_otp_expiry
FROM users WHERE email = 'qa.admin.a@example.com';

-- Expire an OTP to test the expiry path
UPDATE users SET email_verification_otp_expiry = now() - interval '1 minute'
WHERE email = 'qa.admin.a@example.com';

-- Expire a password reset token
UPDATE users SET reset_token_expiry = now() - interval '1 minute'
WHERE email = 'qa.admin.a@example.com';

-- Top up / zero out AI credits
UPDATE tenants SET ai_credits_balance = 0 WHERE name = 'QA Household A';

-- Capture tenant ids used repeatedly below
SELECT id, name FROM tenants WHERE name IN ('QA Household A', 'QA Household B');
```

### 3.4 Test-data reset

```sql
-- Full teardown for a QA tenant (cascades to all tenant-scoped tables)
DELETE FROM tenants WHERE name IN ('QA Household A', 'QA Household B');
DELETE FROM trial_used_emails WHERE email LIKE 'qa.%@example.com';
```

> **Never run these against production.** `drizzle-kit drop`, `DROP DATABASE`, `TRUNCATE`, and
> destructive `drizzle-kit push` are forbidden per project policy.

---

## 4. Test Case Conventions

### 4.1 ID scheme

`<MODULE>-<CATEGORY>-<NNN>`

| Category code | Meaning |
|---|---|
| `UI` | UI rendering / layout / state / interaction validation |
| `FLD` | Field-level validation (required, format, length, boundary, character set) |
| `BR` | Business rule validation (permissions, limits, quotas, lifecycle, computed values) |
| `E2E` | End-to-end workflow spanning multiple screens/modules |
| `DB` | Database validation (assertion executed via SQL after a UI action) |

Example: `PWD-FLD-004` = Passwords module, field validation, case 4.

### 4.2 Scenario type tags

Each case is tagged with one of: **Positive**, **Negative**, **Boundary**, **Edge**.

### 4.3 Result columns

Every table carries an **Actual Result** and **Status** column to be filled during execution.
Leave `—` until executed; then record the observed behaviour verbatim and set Status to
one of `Pass` / `Fail` / `Blocked` / `N/A`.

### 4.4 Defect severity guide

| Severity | Definition |
|---|---|
| **S1 — Critical** | Data loss, cross-tenant data leak, plaintext secret exposure, auth bypass, app unusable |
| **S2 — High** | Core module workflow broken, incorrect financial/credit computation, missing audit log for a mutation |
| **S3 — Medium** | Validation missing or wrong message, incorrect filter/sort, broken non-critical UI state |
| **S4 — Low** | Cosmetic, copy, spacing, minor inconsistency |

---

## 5. Database Validation Conventions

Every DB validation case follows the same three-column contract requested for this suite:

| Column | Meaning |
|---|---|
| **SQL Query** | The exact query to run (bind the ids/emails you created in §3.2) |
| **Expected Result** | The row count, column values, or shape that must be observed |
| **Actual Result** | Filled during execution — paste the actual returned value |

### 5.1 Placeholders used throughout

| Placeholder | Substitute with |
|---|---|
| `:tenant_a` | UUID of TENANT_A |
| `:tenant_b` | UUID of TENANT_B |
| `:user_a1` | UUID of USER_A1 |
| `:record_id` | UUID of the record created by the preceding UI step |
| `:email_a` | Email of ADMIN_A |

### 5.2 Recurring assertion patterns

These patterns repeat across every record module; the per-module files reference them by name.

**P1 — Tenant stamping.** Every row created through the UI must carry the *session* tenant id,
never a value supplied by the client.

```sql
SELECT tenant_id FROM <table> WHERE id = ':record_id';
-- Expected: exactly :tenant_a
```

**P2 — Audit timestamps.** `created_at` and `updated_at` are mandatory and non-null; `updated_at`
must advance on edit.

```sql
SELECT created_at IS NOT NULL AS has_created,
       updated_at IS NOT NULL AS has_updated,
       updated_at >= created_at AS ordered
FROM <table> WHERE id = ':record_id';
-- Expected: t, t, t
```

**P3 — Soft delete.** Deleting from the UI must set `deleted_at` (on tables that have it) rather
than removing the row; the row must disappear from list views.

```sql
SELECT deleted_at FROM <table> WHERE id = ':record_id';
-- Expected: a non-null timestamp (row still present)
```

**P4 — Audit log written.** Every create/update/delete must append to `audit_logs`.

```sql
SELECT action, resource, details, created_at
FROM audit_logs
WHERE tenant_id = ':tenant_a'
ORDER BY created_at DESC LIMIT 5;
-- Expected: top row corresponds to the action just performed
```

**P5 — Encryption at rest.** Sensitive columns must contain AES-256-GCM ciphertext in the form
`iv:salt:tag:ciphertext` (4 colon-separated hex groups; legacy 3-group form also accepted),
never plaintext.

```sql
SELECT <column> ~ '^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$' AS is_ciphertext
FROM <table> WHERE id = ':record_id';
-- Expected: t
```

**P6 — Blind index.** Columns with a `*_hash` sibling must store a deterministic, non-null
HMAC and the hash must NOT equal the plaintext.

```sql
SELECT <column>_hash IS NOT NULL AS has_index,
       <column>_hash <> '<plaintext value>' AS not_plaintext
FROM <table> WHERE id = ':record_id';
-- Expected: t, t
```

**P7 — Cross-tenant isolation.** A record created in TENANT_A must never be visible to, or
mutable by, a TENANT_B session.

```sql
SELECT count(*) FROM <table> WHERE id = ':record_id' AND tenant_id = ':tenant_b';
-- Expected: 0
```

> ⚠️ **Known environment caveat:** Postgres RLS is currently **disabled** on the tables in the
> development database, and a number of routes read via the plain `db` client rather than the
> `withTenant` wrapper. Isolation therefore rests on the explicit `tenant_id` predicate alone.
> Cases in [TC-19](TC-19-security-tenant-isolation.md) test this deliberately — treat any
> cross-tenant read/write as **S1 Critical**. Do not "fix" this by enabling RLS on individual
> tables during a test run; log the defect instead.

---

## 6. Global Regression Checklist (run once per release)

| # | Check | Expected | Actual | Status |
|---|---|---|---|---|
| G-01 | Register → verify OTP → onboarding → dashboard | Completes without error | — | — |
| G-02 | Login as each of the three roles | Correct landing page & nav per role | — | — |
| G-03 | Create one record in every one of the 19 vault modules | All succeed, all appear in list | — | — |
| G-04 | Edit + delete one record per module | Soft-deleted; removed from list | — | — |
| G-05 | Global search returns hits across modules | Results grouped by module | — | — |
| G-06 | Follow-up page shows expiring items | Items ≤15 days appear | — | — |
| G-07 | Backup export downloads a complete JSON | All 19 modules keyed in the file | — | — |
| G-08 | Audit log shows every mutation from G-03/G-04 | One row per mutation | — | — |
| G-09 | Cross-tenant probe of 3 random record URLs | 403/404 for all | — | — |
| G-10 | No `passwordHash`, plaintext password, CVV, or full card number in any UI/page source | Absent everywhere | — | — |
| G-11 | Expired subscription blocks module access | Access denied banner/redirect | — | — |
| G-12 | Dark/light theme + font-size toggles persist across reload | Persisted | — | — |

---

## 7. Execution Log

| Run # | Date | Build / commit | Environment | Executed by | Pass | Fail | Blocked | Notes |
|---|---|---|---|---|---|---|---|---|
| 1 | | | | | | | | |
| 2 | | | | | | | | |
