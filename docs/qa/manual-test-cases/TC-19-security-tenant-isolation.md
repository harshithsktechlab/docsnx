# TC-19 — Cross-Cutting Security: Tenant Isolation · Encryption · Masking · Access Control

**Prefix:** `SEC` · **Applies to:** every module · **Tables:** all

> This file is the security regression suite. It is deliberately module-agnostic: the same
> probe is run against every record module. **Any failure in Sections 1, 2 or 3 is `S1 Critical`
> by default** — cross-tenant access, plaintext secrets and auth bypass are the three highest
> risks in this product.

---

## 0. Standing Context

### 0.1 The two isolation layers (per AGENTS.md §6)

1. **Postgres RLS** — `withTenant(tenantId, cb)` opens a transaction and runs
   `set_config('app.tenant_id', …)`; RLS policies then filter rows to that tenant.
2. **Explicit predicate** — every Drizzle `where` on a tenant table includes
   `eq(table.tenantId, user.tenantId)`, and reads add `isNull(table.deletedAt)`.

`tenantId`/`userId` used for scoping **always** come from the authenticated session,
never from the request body, query string or path.

### 0.2 ⚠️ Known environment gap — read before executing

The project has an open finding (`docs/security/rls-tenant-isolation-followup.md`):

- **RLS is enabled on 0 of 39 tables** in the running database.
- Only ~6 route files use `withTenant`; ~52 query tenant tables with the bare `db` client.
- Isolation therefore rests **entirely** on the application-layer `tenant_id` predicate,
  with no database-level backstop.

**Testing implications:**
- Section 1 (isolation probes) is the *only* thing standing between tenants — execute it in full,
  on every module, every release.
- Do **not** enable RLS on individual tables to "fix" a failure mid-run. `FORCE ROW LEVEL SECURITY`
  fails closed and will break every bare-`db` route. Log the defect instead.
- SEC-DB-001/002 below verify the gap's current state so each run records whether it has moved.

### 0.3 Test tenants

Use `TENANT_A` / `ADMIN_A` and `TENANT_B` / `ADMIN_B` from the master plan.
Populate **both** tenants with a record in every module before running this file.

---

## 1. Tenant Isolation Test Cases (highest priority)

### 1.1 The 4-probe matrix — run against every module

For each module, capture a TENANT_A record id, then log in as **ADMIN_B** and run all four probes.

| Probe | Action | Expected |
|---|---|---|
| **P-LIST** | Open the module list | The TENANT_A record is absent |
| **P-READ** | Navigate to the record's detail/edit URL using the TENANT_A id | 403 or 404; no data, not even masked fragments |
| **P-WRITE** | Submit an edit for that id | 403/404; TENANT_A's `updated_at` does **not** move |
| **P-DELETE** | Submit a delete for that id | 403/404; TENANT_A's row is untouched (`deleted_at` still null) |

| TC ID | Module | P-LIST | P-READ | P-WRITE | P-DELETE | Actual Result | Status |
|---|---|---|---|---|---|---|---|
| SEC-ISO-001 | Documents | ✗ | 403/404 | 403/404 | 403/404 | — | — |
| SEC-ISO-002 | Passwords | ✗ | 403/404 | 403/404 | 403/404 | — | — |
| SEC-ISO-003 | Medical Records | ✗ | 403/404 | 403/404 | 403/404 | — | — |
| SEC-ISO-004 | LIC & Mediclaim | ✗ | 403/404 | 403/404 | 403/404 | — | — |
| SEC-ISO-005 | Bank & Cards (bank_infos) | ✗ | 403/404 | 403/404 | 403/404 | — | — |
| SEC-ISO-006 | Credit Cards | ✗ | 403/404 | 403/404 | 403/404 | — | — |
| SEC-ISO-007 | Trading & Demat | ✗ | 403/404 | 403/404 | 403/404 | — | — |
| SEC-ISO-008 | Investments | ✗ | 403/404 | 403/404 | 403/404 | — | — |
| SEC-ISO-009 | Vehicles | ✗ | 403/404 | 403/404 | 403/404 | — | — |
| SEC-ISO-010 | Tax & Compliance | ✗ | 403/404 | 403/404 | 403/404 | — | — |
| SEC-ISO-011 | Loans & Debts | ✗ | 403/404 | 403/404 | 403/404 | — | — |
| SEC-ISO-012 | Wills & Estate | ✗ | 403/404 | 403/404 | 403/404 | — | — |
| SEC-ISO-013 | Utility Bills | ✗ | 403/404 | 403/404 | 403/404 | — | — |
| SEC-ISO-014 | Corporate Compliance | ✗ | 403/404 | 403/404 | 403/404 | — | — |
| SEC-ISO-015 | Employment & Payroll | ✗ | 403/404 | 403/404 | 403/404 | — | — |
| SEC-ISO-016 | Warranty & AMC | ✗ | 403/404 | 403/404 | 403/404 | — | — |
| SEC-ISO-017 | Rentals & Subscriptions | ✗ | 403/404 | 403/404 | 403/404 | — | — |
| SEC-ISO-018 | Important Contacts | ✗ | 403/404 | 403/404 | 403/404 | — | — |
| SEC-ISO-019 | To-Dos | ✗ | 403/404 | 403/404 | 403/404 | — | — |
| SEC-ISO-020 | Members (users) | ✗ | 403/404 | 403/404 | 403/404 | — | — |
| SEC-ISO-021 | Profiles | ✗ | 403/404 | 403/404 | 403/404 | — | — |
| SEC-ISO-022 | Notifications | ✗ | 403/404 | 403/404 | 403/404 | — | — |
| SEC-ISO-023 | Invoices | ✗ | 403/404 | 403/404 | 403/404 | — | — |
| SEC-ISO-024 | Payments | ✗ | 403/404 | 403/404 | 403/404 | — | — |
| SEC-ISO-025 | Audit Logs | ✗ | n/a | n/a | n/a | — | — |

### 1.2 Isolation on aggregate & derived surfaces

| TC ID | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| SEC-ISO-030 | Security | With both tenants populated, compare TENANT_A's `/dashboard` counters against the DB. | Each counter equals TENANT_A's row count only — TENANT_B's rows are excluded. | — | — |
| SEC-ISO-031 | Security | Run TENANT_A's global search for a term that exists only in TENANT_B. | Zero results; no masked fragment; no module heading appears. | — | — |
| SEC-ISO-032 | Security | Open TENANT_A's `/follow-up` with imminent expiries seeded in TENANT_B. | None of TENANT_B's items appear; the badge count excludes them. | — | — |
| SEC-ISO-033 | Security | Open TENANT_A's `/audit-logs` after 20 mutations in TENANT_B. | Zero TENANT_B entries. | — | — |
| SEC-ISO-034 | Security | Export the backup from TENANT_A. | The file contains zero TENANT_B rows; every `tenantId` inside equals TENANT_A. | — | — |
| SEC-ISO-035 | Security | Open TENANT_A's `/analysis` and `/ai-costs`. | Analysis reflects only TENANT_A's records; credits/usage figures are TENANT_A's. | — | — |
| SEC-ISO-036 | Security | Open TENANT_A's `/invoices` and payment history. | Only TENANT_A's billing documents. | — | — |
| SEC-ISO-037 | Security | Open the member dropdowns (holder/assignee) in every module as ADMIN_A. | Only TENANT_A's members are listed. | — | — |
| SEC-ISO-038 | Security | Check the notification bell as USER_A1 after generating notifications for USER_B1. | Nothing from TENANT_B appears. | — | — |

### 1.3 Request-supplied tenant/user identifiers (the trust rule)

| TC ID | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| SEC-ISO-040 | **Security** | As ADMIN_A, create a record while injecting `tenantId = :tenant_b` into the submitted form/payload (DevTools). | The record is created under **TENANT_A** — the server ignores the client-supplied tenant. A row landing in TENANT_B ⇒ **S1**. | — | — |
| SEC-ISO-041 | **Security** | As ADMIN_A, assign a record's holder/assignee to a TENANT_B `userId`. | Rejected ("Invalid user ID") or coerced to a TENANT_A user — never stored as a cross-tenant reference. | — | — |
| SEC-ISO-042 | **Security** | As ADMIN_A, attempt a payment order with `tenantId = :tenant_b`. | *"Access denied. Cannot create orders for other tenants."* | — | — |
| SEC-ISO-043 | Security | As ADMIN_A, restore a backup file whose internal `tenantId` was edited to TENANT_B. | All restored rows land under TENANT_A, or the import is rejected. | — | — |
| SEC-ISO-044 | Security | As ADMIN_A, apply a discount using TENANT_B's `tenantId` in the validate call. | The per-tenant usage check is evaluated against the session tenant, not the supplied one. | — | — |

### 1.4 File-level isolation

| TC ID | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| SEC-ISO-050 | **Security** | Upload a file in TENANT_A, capture its URL, then open that URL while logged in as ADMIN_B. | Access denied — uploaded files are authorised against the requester's tenant via the record that references them. | — | — |
| SEC-ISO-051 | **Security** | Open the same file URL with **no session at all** (private window). | Denied / redirected to login. A publicly fetchable vault file ⇒ **S1**. | — | — |
| SEC-ISO-052 | Security | Guess a neighbouring file name (increment the timestamp/random prefix) and fetch it. | 404 — no directory listing, no enumeration. | — | — |
| SEC-ISO-053 | Security | Delete the record that owns a file, then re-fetch the file URL as ADMIN_A. | Denied — with no owning record in the tenant, access is refused. | — | — |
| SEC-ISO-054 | Security | Fetch a TENANT_A file URL in both its stored form (`/uploads/<name>`) and its routed form (`/api/uploads/<name>`) as ADMIN_B. | Both denied. | — | — |

---

## 2. Encryption-at-Rest & Secret-Exposure Test Cases

### 2.1 Ciphertext coverage — one row per encrypted column

Create a record in each module with a **known** plaintext, then verify at rest.
Expected ciphertext shape: `iv:salt:tag:ciphertext` (4 hex groups; legacy 3-group also valid).

| TC ID | Table.Column | SQL Query | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| SEC-ENC-001 | `passwords.password_encrypted` | `SELECT count(*) FROM passwords WHERE tenant_id = ':tenant_a' AND password_encrypted !~ '^[0-9a-f]+:';` | `0` | — | — |
| SEC-ENC-002 | `bank_infos.account_number` | `SELECT count(*) FROM bank_infos WHERE tenant_id = ':tenant_a' AND account_number !~ '^[0-9a-f]+:';` | `0` | — | — |
| SEC-ENC-003 | `bank_infos.customer_id` | `SELECT count(*) FROM bank_infos WHERE tenant_id = ':tenant_a' AND customer_id IS NOT NULL AND customer_id !~ '^[0-9a-f]+:';` | `0` | — | — |
| SEC-ENC-004 | `bank_infos.net_banking_username` | `SELECT count(*) FROM bank_infos WHERE tenant_id = ':tenant_a' AND net_banking_username IS NOT NULL AND net_banking_username !~ '^[0-9a-f]+:';` | `0` | — | — |
| SEC-ENC-005 | `bank_infos.cards` | `SELECT count(*) FROM bank_infos WHERE tenant_id = ':tenant_a' AND cards IS NOT NULL AND cards->>'encryptedData' IS NULL;` | `0` | — | — |
| SEC-ENC-006 | `credit_cards.card_details_encrypted` | `SELECT count(*) FROM credit_cards WHERE tenant_id = ':tenant_a' AND card_details_encrypted !~ '^[0-9a-f]+:';` | `0` | — | — |
| SEC-ENC-007 | `trading_demats.client_id` | `SELECT count(*) FROM trading_demats WHERE tenant_id = ':tenant_a' AND client_id !~ '^[0-9a-f]+:';` | `0` | — | — |
| SEC-ENC-008 | `trading_demats.demat_account_number` | `SELECT count(*) FROM trading_demats WHERE tenant_id = ':tenant_a' AND demat_account_number IS NOT NULL AND demat_account_number !~ '^[0-9a-f]+:';` | `0` | — | — |
| SEC-ENC-009 | `trading_demats.login_username` | `SELECT count(*) FROM trading_demats WHERE tenant_id = ':tenant_a' AND login_username IS NOT NULL AND login_username !~ '^[0-9a-f]+:';` | `0` | — | — |
| SEC-ENC-010 | `lic_mediclaims.policy_number` | `SELECT count(*) FROM lic_mediclaims WHERE tenant_id = ':tenant_a' AND policy_number !~ '^[0-9a-f]+:';` | `0` | — | — |
| SEC-ENC-011 | `loans_debts.account_number` | `SELECT count(*) FROM loans_debts WHERE tenant_id = ':tenant_a' AND account_number !~ '^[0-9a-f]+:';` | `0` | — | — |
| SEC-ENC-012 | `utility_bills.consumer_number` | `SELECT count(*) FROM utility_bills WHERE tenant_id = ':tenant_a' AND consumer_number !~ '^[0-9a-f]+:';` | `0` | — | — |
| SEC-ENC-013 | `tax_compliances.acknowledgement_number` | `SELECT count(*) FROM tax_compliances WHERE tenant_id = ':tenant_a' AND acknowledgement_number IS NOT NULL AND acknowledgement_number !~ '^[0-9a-f]+:';` | `0` | — | — |
| SEC-ENC-014 | `corporate_compliances.registration_number` | `SELECT count(*) FROM corporate_compliances WHERE tenant_id = ':tenant_a' AND registration_number IS NOT NULL AND registration_number !~ '^[0-9a-f]+:';` | `0` | — | — |
| SEC-ENC-015 | `contract_agreements.account_number` | `SELECT count(*) FROM contract_agreements WHERE tenant_id = ':tenant_a' AND account_number IS NOT NULL AND account_number !~ '^[0-9a-f]+:';` | `0` | — | — |
| SEC-ENC-016 | `documents.metadata.documentNumber` | `SELECT count(*) FROM documents WHERE tenant_id = ':tenant_a' AND metadata->>'documentNumber' IS NOT NULL AND metadata->>'documentNumber' !~ '^[0-9a-f]+:';` | `0` | — | — |
| SEC-ENC-017 | `profiles.legal_details` (PAN/Aadhaar/passport) | `SELECT count(*) FROM profiles p JOIN users u ON u.id = p.user_id WHERE u.tenant_id = ':tenant_a' AND (p.legal_details->>'panNumber' IS NOT NULL AND p.legal_details->>'panNumber' !~ '^[0-9a-f]+:');` | `0` | — | — |
| SEC-ENC-018 | `tenants.api_key` | `SELECT count(*) FROM tenants WHERE api_key IS NOT NULL AND api_key !~ '^[0-9a-f]+:';` | `0` | — | — |
| SEC-ENC-019 | `api_keys.api_key` / `ai_api_keys.key` | `SELECT count(*) FROM api_keys WHERE api_key !~ '^[0-9a-f]+:';` and `SELECT count(*) FROM ai_api_keys WHERE key !~ '^[0-9a-f]+:';` | `0` for both | — | — |
| SEC-ENC-020 | `system_configs.smtp_password` | `SELECT smtp_password FROM system_configs LIMIT 1;` | Opaque — not the plaintext SMTP password | — | — |

### 2.2 Hashed bearer secrets (never reversibly encrypted)

| TC ID | Validation Point | SQL Query | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| SEC-ENC-030 | `users.password_hash` is bcrypt | `SELECT count(*) FROM users WHERE password_hash NOT LIKE '$2%';` | `0` | — | — |
| SEC-ENC-031 | `users.reset_token` is a hash, not the emailed token | `SELECT count(*) FROM users WHERE reset_token IS NOT NULL AND reset_token !~ '^[0-9a-f]{64}$';` | `0`; and the value never equals the token in the reset URL | — | — |
| SEC-ENC-032 | `users.email_verification_otp` is hashed | `SELECT count(*) FROM users WHERE email_verification_otp ~ '^[0-9]{6}$';` | `0` — a 6-digit value stored raw ⇒ **S1** | — | — |
| SEC-ENC-033 | No reversible encryption of bearer secrets | `SELECT count(*) FROM users WHERE reset_token ~ '^[0-9a-f]+:[0-9a-f]+:' OR email_verification_otp ~ '^[0-9a-f]+:[0-9a-f]+:';` | `0` — these must be hashed, not encrypted | — | — |

### 2.3 Blind-index correctness

| TC ID | Validation Point | SQL Query | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| SEC-ENC-040 | Every encrypted column with a `_hash` sibling has it populated | `SELECT count(*) FROM bank_infos WHERE tenant_id = ':tenant_a' AND account_number_hash IS NULL;` (repeat for `trading_demats.client_id_hash`, `lic_mediclaims.policy_number_hash`, `loans_debts.account_number_hash`, `utility_bills.consumer_number_hash`) | `0` for each | — | — |
| SEC-ENC-041 | Hash is never the plaintext | `SELECT count(*) FROM bank_infos WHERE account_number_hash = '50100234567890';` (repeat per column) | `0` for each | — | — |
| SEC-ENC-042 | Hash is deterministic | Two records with the same identifier: `SELECT count(DISTINCT account_number_hash) FROM bank_infos WHERE tenant_id = ':tenant_a' AND bank_name IN ('DupA','DupB');` | `1` | — | — |
| SEC-ENC-043 | Ciphertext is non-deterministic | Same two records: `SELECT count(DISTINCT account_number) FROM bank_infos WHERE tenant_id = ':tenant_a' AND bank_name IN ('DupA','DupB');` | `2` — random IV/salt per encryption | — | — |
| SEC-ENC-044 | Hash normalises trim/whitespace/case | Save `ab 1234` and `AB1234` as two trading records and compare `client_id_hash`. | Identical | — | — |
| SEC-ENC-045 | Blind indexes are stripped from client payloads | Inspect every list response for bank, trading, LIC, loans and utility bills. | No `*_hash` field is ever returned to the browser | — | — |

### 2.4 Round-trip integrity

| TC ID | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| SEC-ENC-050 | Positive | For each encrypted field, save a known value, reveal it and compare. | Byte-for-byte identical in every case. | — | — |
| SEC-ENC-051 | Edge | Save values containing colons, unicode, emoji, newlines and 1 000 characters into each encrypted field. | All round-trip exactly; the colon must not corrupt the `iv:salt:tag:ct` parsing. | — | — |
| SEC-ENC-052 | Edge | Save a value that *looks* like ciphertext (`aabb:ccdd:eeff:0011`). | Confirm it is not passed through unencrypted by the idempotency check. A stored plaintext ⇒ **S1**. | — | — |
| SEC-ENC-053 | Edge | Edit a record without touching its encrypted field, then reveal. | The original value is preserved and not double-encrypted. | — | — |
| SEC-ENC-054 | Edge | Clear an optional encrypted field and save. | The column becomes NULL — not an empty-string ciphertext. | — | — |
| SEC-ENC-055 | Edge | Change `ENCRYPTION_SECRET` (test environment only), reload records, then restore the secret. | Decryption fails gracefully with an error state; the app does not crash and never renders garbage as if it were the real value. | — | — |

---

## 3. Secret-Exposure Test Cases (never leaves the server / never displayed)

| TC ID | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| SEC-LEK-001 | **Security** | With DevTools open, exercise every page in the app as ADMIN_A and search all network responses for `passwordHash`. | Zero occurrences anywhere — `/api/auth/me`, `/users`, backup export, everywhere. Any hit ⇒ **S1**. | — | — |
| SEC-LEK-002 | **Security** | Load `/passwords` and inspect the list response. | No plaintext password and no `passwordEncrypted` field. | — | — |
| SEC-LEK-003 | **Security** | Load `/bank-info` and inspect the list response. | Account number, customer ID and net-banking username all masked; card numbers masked to last four; **CVV never present**. | — | — |
| SEC-LEK-004 | **Security** | Load `/trading` and inspect the list response. | Client ID masked; demat number and login username not returned in the clear. | — | — |
| SEC-LEK-005 | Security | Load `/lic-mediclaim`, `/loans-debt`, `/utility-bills`, `/tax-compliance`, `/corporate-compliance` and inspect each list response. | Every encrypted identifier is masked. | — | — |
| SEC-LEK-006 | Security | Load `/documents` and inspect the list response. | `metadata.documentNumber` is masked. | — | — |
| SEC-LEK-007 | Security | Load `/rentals` and inspect the list response. | Record actual — this list decrypts `account_number`; a fully revealed value in a list view ⇒ **S2**. | — | — |
| SEC-LEK-008 | Security | Inspect `/api/auth/me` and any settings payload after connecting Google Drive and saving a tenant AI key. | No Drive access/refresh token; no full AI key. | — | — |
| SEC-LEK-009 | Security | Save an SMTP password as SUPER_ADMIN, then re-open `/admin/smtp` and inspect the response. | The password is not returned in the clear. | — | — |
| SEC-LEK-010 | Security | Trigger a password reset and an OTP, then inspect every response and log. | The raw token/OTP appears only in the email — never in an API response, the DOM or a server log line visible to the client. | — | — |
| SEC-LEK-011 | Security | Grep the whole audit trail for known secrets after a full regression pass. | `SELECT count(*) FROM audit_logs WHERE details LIKE '%SecretPassword123%' OR details LIKE '%4111111111111111%' OR details LIKE '%50100234567890%';` returns `0`. | — | — |
| SEC-LEK-012 | Security | Repeat the sweep for the LIC policy number and trading client ID (known write paths). | Expected `0`; hits confirm the audit-leak defect ⇒ **S2**. | — | — |
| SEC-LEK-013 | **Security** | Run every AI feature (record analysis, category analysis, portfolio analysis, bulk scan, auto-fill) with the outbound payload captured. | None of the 16 forbidden keys present; Aadhaar/PAN/account/email/phone all masked; strings >300 chars truncated. | — | — |
| SEC-LEK-014 | Security | Inspect the persisted `ai_analysis` / `ai_analysis_cache` contents. | No secret and no unmasked PII stored in the cached analysis. | — | — |
| SEC-LEK-015 | Security | Run the Backup export and grep the file for `passwordHash`, CVV and known plaintext identifiers. | `passwordHash` absent; no CVV; identifiers only as ciphertext or masked. | — | — |
| SEC-LEK-016 | Security | Run the Drive ZK sync and open the resulting `.enc.json` files. | Opaque `ivHex:ciphertextHex` only — nothing readable. | — | — |
| SEC-LEK-017 | Security | Trigger a deliberate server error (e.g. malformed payload) and read the response. | A generic error message — no stack trace, SQL fragment, table name, connection string or env-var value. | — | — |
| SEC-LEK-018 | Security | View page source (server-rendered HTML) on every module page. | No secret or unmasked sensitive value is embedded in the initial HTML payload. | — | — |
| SEC-LEK-019 | Security | Inspect a push notification payload delivered to a device. | No secret, no other tenant's data. | — | — |
| SEC-LEK-020 | Security | Inspect the invoice PDF for a tenant. | Contains only that tenant's billing details — no other tenant's name, GSTIN or figures. | — | — |

---

## 4. Authentication & Session Security

| TC ID | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| SEC-AUT-001 | Security | Inspect the `auth_token` cookie after login. | `HttpOnly`, `SameSite=Strict`, `Path=/`, `Max-Age ≈ 604800`; `Secure` when served over HTTPS. | — | — |
| SEC-AUT-002 | Security | Attempt `document.cookie` in the console. | `auth_token` is not readable from JavaScript. | — | — |
| SEC-AUT-003 | Security | Tamper with one character of the JWT and reload. | Treated as unauthenticated; redirected to `/login`; no 500. | — | — |
| SEC-AUT-004 | Security | Present a JWT signed with a different secret. | Rejected. | — | — |
| SEC-AUT-005 | Security | Present an expired JWT. | Rejected; redirected to login. | — | — |
| SEC-AUT-006 | Security | Copy TENANT_A's valid `auth_token` into a browser and browse as that user. | Access is granted (session cookies are bearer credentials) — confirm this matches the intended model and that the cookie is never exposed anywhere it could be captured. | — | — |
| SEC-AUT-007 | Security | Log out, then press Back and attempt to re-render a module page. | No tenant data is rendered from cache; the user is redirected to login. | — | — |
| SEC-AUT-008 | Security | Reset the password, then use a session that was open before the reset. | Record actual — continued access after a credential change ⇒ **S2**. | — | — |
| SEC-AUT-009 | Security | Attempt ~10 rapid failed logins from one IP. | Rate-limited with 429 and a `Retry-After`. | — | — |
| SEC-AUT-010 | Security | Attempt ~10 rapid registrations from one IP. | Rate-limited with 429. | — | — |
| SEC-AUT-011 | Security | Compare the error for an unknown email vs. a wrong password. | Identical generic "Invalid credentials" — no user enumeration. | — | — |
| SEC-AUT-012 | Security | Submit a forgot-password request for an unknown address. | Generic success message — no enumeration. | — | — |
| SEC-AUT-013 | Security | Soft-delete a user, then attempt login. | Rejected. | — | — |
| SEC-AUT-014 | Security | Suspend a tenant, then attempt login as its user. | Rejected with the suspension message. | — | — |
| SEC-AUT-015 | Security | Expire a subscription, then attempt any module action. | Every permission check denies. | — | — |

---

## 5. Authorization & Privilege-Escalation Test Cases

| TC ID | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| SEC-AUZ-001 | **Security** | As a `STANDARD` user, attempt to create a user with `role = SUPER_ADMIN` (manipulated payload). | Rejected — standard users cannot create users at all. | — | — |
| SEC-AUZ-002 | **Security** | As a `TENANT_ADMIN`, attempt to create a `SUPER_ADMIN`. | *"Tenant Admins cannot create Super Admin users."* | — | — |
| SEC-AUZ-003 | **Security** | As a `STANDARD` user, attempt to promote yourself to `TENANT_ADMIN` via the profile/user edit path. | Rejected. Any success ⇒ **S1**. | — | — |
| SEC-AUZ-004 | Security | As a `STANDARD` user, attempt to edit your own `permissions` rows. | Rejected — permissions are admin-managed. | — | — |
| SEC-AUZ-005 | Security | As a `TENANT_ADMIN`, attempt every Super Admin route. | All refused. | — | — |
| SEC-AUZ-006 | **Security** | As `SUPER_ADMIN`, attempt every tenant module route, global search, follow-up, backup and AI analysis. | All redirected or refused; zero tenant data disclosed. | — | — |
| SEC-AUZ-007 | Security | Revoke a permission while the user is mid-session, then have them retry the action. | The action is refused once the change takes effect; record how long the stale permission remains usable. | — | — |
| SEC-AUZ-008 | Security | Delete a permission row entirely and attempt the module. | Denied — a missing row means no access (never default-allow). | — | — |
| SEC-AUZ-009 | Security | With `canView` only, attempt add/edit/delete on every module. | All mutations refused across all modules. | — | — |
| SEC-AUZ-010 | Security | With `canAdd` but not `canEdit`, attempt a document **replace**. | Refused — replace requires `edit`. | — | — |
| SEC-AUZ-011 | Security | With `canView` only, attempt Generate Follow-ups on a vehicle and an investment. | Both refused — the action requires `edit`. | — | — |
| SEC-AUZ-012 | Security | As a `STANDARD` user, attempt a payment order and a manual payment. | Both refused with the documented admin-only messages. | — | — |
| SEC-AUZ-013 | Security | As a `STANDARD` user, attempt account deletion. | *"Only Tenant Admins can delete the account."* | — | — |
| SEC-AUZ-014 | Security | As a `STANDARD` user with `canView` on `audit_logs`, open `/audit-logs`. | Refused — the role check is additional to the permission. | — | — |

---

## 6. Input-Handling Security Test Cases

| TC ID | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| SEC-INP-001 | Security | Enter `<script>alert(1)</script>` into every text field of every module; then view the list, detail, print, share and audit surfaces. | Rendered as literal text everywhere; no dialog fires anywhere. | — | — |
| SEC-INP-002 | Security | Enter `<img src=x onerror=alert(1)>` into a name field and view it in a dropdown, a notification and an invoice. | No execution on any surface. | — | — |
| SEC-INP-003 | Security | Enter `javascript:alert(1)` into a URL field (password entry, document link). | Not rendered as a clickable link that executes; sanitised or shown as text. | — | — |
| SEC-INP-004 | Security | Enter `' OR 1=1 --` and `'; DROP TABLE users; --` into search and login fields. | Treated as literal strings; no error; no extra rows; the schema is intact. | — | — |
| SEC-INP-005 | Security | Enter `%` and `_` into search fields. | Not interpreted as SQL wildcards that dump the dataset. | — | — |
| SEC-INP-006 | Security | Submit a deeply nested / very large JSON payload into a `customFields` field. | Handled or rejected cleanly; no 500 and no memory blow-up. | — | — |
| SEC-INP-007 | Security | Upload a file named `../../etc/passwd` and one named `..\..\win.ini`. | The stored path is sanitised; nothing is written outside the upload directory. | — | — |
| SEC-INP-008 | Security | Upload an SVG containing a script and open its preview. | Not rendered inline in a way that executes script; served as a download or sanitised. | — | — |
| SEC-INP-009 | Security | Upload an HTML file and open its URL directly. | Served as a download/attachment, not rendered as a page in the app's origin. | — | — |
| SEC-INP-010 | Security | Upload an executable or a double-extension file (`invoice.pdf.exe`). | Rejected or stored inert; never served with an executable content type. | — | — |
| SEC-INP-011 | Security | Submit a form with an oversized string (1 MB) in a `varchar(255)` field. | Rejected with a clean 400 — not a 500 or a truncated silent write. | — | — |
| SEC-INP-012 | Security | Submit a negative number into every monetary field across all modules. | Rejected consistently; no negative money is ever persisted. | — | — |
| SEC-INP-013 | Security | Submit a UUID-shaped but nonexistent id in every `[id]` route reachable from the UI. | 404 with no information disclosure about whether the id exists in another tenant. | — | — |
| SEC-INP-014 | Security | Submit a non-UUID id (e.g. `abc`) where a UUID is expected. | Clean 400 — not a 500 or a database error message. | — | — |

---

## 7. Infrastructure & Configuration Test Cases

| TC ID | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| SEC-CFG-001 | Security | Attempt to start the app without `JWT_SECRET`. | Fails fast with a clear error — never runs with an unsigned/default secret. | — | — |
| SEC-CFG-002 | Security | Attempt to start the app without `ENCRYPTION_SECRET`. | Fails fast — never runs with encryption silently disabled. | — | — |
| SEC-CFG-003 | Security | In a production-like deployment, check the response headers on any page. | HTTPS enforced; `Secure` cookie flag set; no server version disclosure. | — | — |
| SEC-CFG-004 | Security | Check that `.env.local`, database dumps and test credentials are not served by the web server. | All return 404. | — | — |
| SEC-CFG-005 | Security | Confirm `.env.local` and DB dumps are git-ignored. | `git status` shows them ignored; `git log` contains no committed secret. | — | — |

---

## 8. RLS / Defence-in-Depth State Verification

These record the current state of the known gap so each test run captures whether it has moved.

| TC ID | Validation Point | SQL Query | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| SEC-DB-001 | How many tables have RLS enabled | `SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relrowsecurity;` | Target: **39** (all tenant tables). Currently expected: **0** — record the actual and treat any regression from a previously higher number as a defect | — | — |
| SEC-DB-002 | Which tenant tables lack an isolation policy | `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace LEFT JOIN pg_policy p ON p.polrelid = c.oid WHERE n.nspname = 'public' AND c.relkind = 'r' AND p.polname IS NULL ORDER BY 1;` | Target: empty. Record the current list | — | — |
| SEC-DB-003 | Tables missing a `tenant_id` column that should have one | `SELECT table_name FROM information_schema.tables t WHERE table_schema = 'public' AND NOT EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_name = t.table_name AND c.column_name = 'tenant_id') ORDER BY 1;` | Only platform-global tables (`subscription_plans`, `addons`, `discount_codes`, `system_configs`, `api_keys`, `ai_api_keys`, `trial_used_emails`, `permissions`, `profiles`) | — | — |
| SEC-DB-004 | No tenant-scoped row has a null tenant | Run `SELECT count(*) FROM <table> WHERE tenant_id IS NULL;` for all 30 tenant tables | `0` for every one | — | — |
| SEC-DB-005 | No cross-tenant foreign-key references anywhere | For each table with `user_id`/`holder_id`: `SELECT count(*) FROM <table> t JOIN users u ON u.id = t.user_id WHERE t.tenant_id <> u.tenant_id;` | `0` for every one | — | — |
| SEC-DB-006 | No orphan rows pointing at deleted tenants | For each tenant table: `SELECT count(*) FROM <table> x LEFT JOIN tenants t ON t.id = x.tenant_id WHERE t.id IS NULL;` | `0` for every one | — | — |
| SEC-DB-007 | `withTenant` coverage baseline | Record the count from the follow-up doc's methodology (route files using `withTenant` vs. bare `db`). | Track the trend release over release; a decrease is a regression | — | — |

---

## 9. Security End-to-End Scenarios

| TC ID | Scenario | Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| SEC-E2E-001 | **Full cross-tenant assault** | 1. Populate TENANT_A with a record in all 19 modules plus files, invoices and notifications.<br>2. Capture every record id and file URL.<br>3. Log in as ADMIN_B.<br>4. Run all four probes (list/read/write/delete) against every id, plus every file URL, plus a global search for each record's distinctive text. | Every single attempt fails with 403/404 and zero disclosure; TENANT_A's `updated_at`/`deleted_at` values are all unchanged afterwards. | — | — |
| SEC-E2E-002 | **Secret-exposure sweep** | 1. Create a credential, a bank account with cards, a credit card, a trading account, a policy, a loan, a utility bill and a profile with PAN/Aadhaar.<br>2. Browse every page with DevTools recording.<br>3. Run the Backup export.<br>4. Run every AI feature.<br>5. Grep all captured traffic, the export file and `audit_logs` for the known plaintext values. | No plaintext secret appears in any response, file or log. Every hit is logged with its exact location. | — | — |
| SEC-E2E-003 | **Privilege-escalation sweep** | 1. Create USER_A2 (view-only) and USER_A3 (no permissions on two modules).<br>2. As each, attempt every mutation in every module, plus admin routes, plus account deletion, plus payment creation. | Every escalation attempt is refused; no role or permission can be self-modified. | — | — |
| SEC-E2E-004 | **Encryption regression** | 1. Save known values into all 16 encrypted columns.<br>2. Run the SEC-ENC-001…020 queries.<br>3. Reveal each value in the UI and compare. | Every column stores ciphertext; every reveal round-trips exactly. | — | — |
| SEC-E2E-005 | **Session & auth hardening** | 1. Run SEC-AUT-001…015 in sequence in one browser session. | Cookie flags correct; tampered/foreign/expired tokens all rejected; rate limits engage; no user enumeration. | — | — |
| SEC-E2E-006 | **Injection sweep** | 1. Run SEC-INP-001…014 against 5 representative modules (Documents, Passwords, Bank, Investments, To-Dos). | No script executes; no SQL error; no path traversal; no 500 from malformed input. | — | — |
| SEC-E2E-007 | **Deleted-data resurrection check** | 1. Create records in 5 modules.<br>2. Soft-delete them.<br>3. Check lists, global search, follow-ups, dashboard counts, analysis and the backup export. | Deleted records appear in **none** of these surfaces. Any surface that still shows them is a defect (search and follow-up are the known-risk paths). | — | — |
