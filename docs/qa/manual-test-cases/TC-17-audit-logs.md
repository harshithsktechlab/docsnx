# TC-17 — Audit Logs

**Prefix:** `AUD` · **Route:** `/audit-logs` · **Table:** `audit_logs`
**Permission key:** `audit_logs` (permission-gated, no sidebar entry for standard users)

## Module Reference

| Aspect | Detail |
|---|---|
| Access rule | Requires `hasPermission(user, 'audit_logs', 'view')` **AND** role ∈ {`TENANT_ADMIN`, `SUPER_ADMIN`}. A `STANDARD` user with `canView` on `audit_logs` is still refused — *"Forbidden. Admin credentials required."* |
| Scope | Always filtered by `tenant_id` = the session tenant |
| Ordering & limit | `created_at DESC`, **hard-capped at 100 rows** (no pagination) |
| Columns returned | id, tenantId, userId, action, details, ipAddress, createdAt, plus the joined user's name and email |
| Deleted actor | `LEFT JOIN` on users — a log whose user was deleted still renders (user block null) |
| Client filtering | Free-text filter across action, details and user name ("Filter by action, description, or user…") |
| Badge colouring | `REGISTER`/`CREATE` → one variant, `UPDATE` → another, `DELETE` → another, everything else → default |
| Immutability | The UI offers no edit or delete for log rows |

### Known action vocabulary

Two naming conventions coexist — verb-first (`CREATE_DOCUMENT`) for the original modules and
noun-first (`TAX_COMPLIANCE_CREATED`) for the six enterprise vaults.

| Group | Actions |
|---|---|
| Auth | `REGISTER_TENANT`, `VERIFY_EMAIL_OTP`, `PASSWORD_RESET_REQUESTED`, `PASSWORD_RESET_SUCCESSFUL` |
| Users | `CREATE_USER`, `UPDATE_USER`, `DELETE_USER` |
| Profiles | `UPDATE_PROFILE` |
| Documents | `CREATE_DOCUMENT`, `UPDATE_DOCUMENT`, `DELETE_DOCUMENT` |
| Passwords | `CREATE_PASSWORD`, `UPDATE_PASSWORD`, `DELETE_PASSWORD` |
| Medical | `CREATE_MEDICAL_RECORD`, `UPDATE_MEDICAL_RECORD`, `DELETE_MEDICAL_RECORD` |
| LIC | `CREATE_LIC_MEDICLAIM`, `UPDATE_LIC_MEDICLAIM`, `DELETE_LIC_MEDICLAIM` |
| Bank / Cards | `CREATE_BANK_INFO`, `UPDATE_BANK_INFO`, `DELETE_BANK_INFO`, `CREATE_CREDIT_CARD`, `UPDATE_CREDIT_CARD`, `DELETE_CREDIT_CARD` |
| Trading | `CREATE_TRADING_DEMAT`, `UPDATE_TRADING_DEMAT`, `DELETE_TRADING_DEMAT` |
| Investments | `CREATE_INVESTMENT`, `UPDATE_INVESTMENT`, `DELETE_INVESTMENT` |
| Vehicles | `CREATE_VEHICLE`, `UPDATE_VEHICLE`, `DELETE_VEHICLE`, `GENERATE_FOLLOWUPS` |
| Warranty | `CREATE_WARRANTY`, `UPDATE_WARRANTY`, `DELETE_WARRANTY` |
| Rentals | `CREATE_CONTRACT`, `UPDATE_CONTRACT`, `DELETE_CONTRACT` |
| Emergency | `CREATE_EMERGENCY_CONTACT`, `UPDATE_EMERGENCY_CONTACT`, `DELETE_EMERGENCY_CONTACT` |
| To-Dos | `CREATE_TODO`, `UPDATE_TODO`, `DELETE_TODO` |
| Enterprise vaults | `TAX_COMPLIANCE_*`, `WILLS_ESTATE_*`, `LOAN_DEBT_*`, `UTILITY_BILL_*`, `CORPORATE_COMPLIANCE_*`, `EMPLOYMENT_PAYROLL_*` (each `_CREATED` / `_UPDATED` / `_DELETED`) |
| Billing | `PAYMENT_VERIFIED`, `PAYMENT_CAPTURED_WEBHOOK`, `PAYMENT_FAILED_WEBHOOK`, `CREATE_SUBSCRIPTION_PLAN`, `UPDATE_SUBSCRIPTION_PLAN`, `DEACTIVATE_SUBSCRIPTION_PLAN`, `CREATE_ADDON`, `UPDATE_ADDON`, `DEACTIVATE_ADDON`, `GRANT_ADDON` |
| Data / AI | `RESTORE_BACKUP`, `BYOD_GOOGLE_DRIVE_SYNC`, `UPDATE_AI_CONTEXT`, `OPTIMIZE_AI_CONTEXT` |

---

## 1. UI Validation Test Cases

| TC ID | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| AUD-UI-001 | Positive | Open `/audit-logs` as TENANT_ADMIN on a brand-new tenant. | At least the `REGISTER_TENANT` and `VERIFY_EMAIL_OTP` entries render; no error. | — | — |
| AUD-UI-002 | Positive | Open `/audit-logs` after several mutations. | Rows show action badge, details text, actor name/email, IP address and a timestamp. | — | — |
| AUD-UI-003 | Positive | Inspect the ordering. | Newest first (`created_at DESC`) — the most recent action is at the top. | — | — |
| AUD-UI-004 | Positive | Inspect the action badges for a create, an update and a delete. | Three visually distinct badge variants; the mapping matches the documented rule. | — | — |
| AUD-UI-005 | Edge | Inspect a badge for an action outside the CREATE/UPDATE/DELETE families (e.g. `GENERATE_FOLLOWUPS`, `PAYMENT_VERIFIED`). | Falls back to the default variant — no broken/unstyled badge. | — | — |
| AUD-UI-006 | Positive | Type into the filter box ("Filter by action, description, or user…"). | The list filters live across action, details and user name; clearing restores the full list. | — | — |
| AUD-UI-007 | Positive | Filter by a lowercase fragment of an uppercase action (e.g. `create_doc`). | Matches — filtering is case-insensitive. | — | — |
| AUD-UI-008 | Negative | Filter by a string matching nothing. | Empty state: "No audit logs matched search criteria" — not a blank page. | — | — |
| AUD-UI-009 | Negative | Trigger a fetch failure (offline) and open `/audit-logs`. | An error state is shown; the page does not hang on a spinner. | — | — |
| AUD-UI-010 | Positive | Observe the page while loading. | Skeleton/loading state, then rows. | — | — |
| AUD-UI-011 | Edge | Inspect a log entry whose actor user has since been deleted. | The row still renders with the action/details; the user column shows a graceful placeholder — never `undefined` or a crash. | — | — |
| AUD-UI-012 | Edge | Inspect an entry with a very long `details` string. | Truncated or wrapped in the row; the full text remains accessible (tooltip/expand); the layout does not break. | — | — |
| AUD-UI-013 | Edge | Create a record whose name is `<script>alert(1)</script>`, then view its audit entry. | The details text renders as literal text — no script execution on the audit page. | — | — |
| AUD-UI-014 | Positive | View `/audit-logs` at 375px, 768px and 1440px. | Rows reflow/stack; any table scrolls inside its own container; no horizontal page scroll. | — | — |
| AUD-UI-015 | Positive | Look for edit/delete controls on a log row. | **None exist** — audit entries are immutable from the UI. | — | — |
| AUD-UI-016 | Boundary | Generate more than 100 audit entries, then open the page. | Exactly the newest 100 render. Confirm the UI communicates the cap (e.g. "showing latest 100"). A silent truncation with no indicator ⇒ **S3**. | — | — |
| AUD-UI-017 | Positive | Reach `/audit-logs` from `/more`. | The link is present for admins and navigates correctly. | — | — |
| AUD-UI-018 | Positive | Check the sidebar for an Audit Logs entry. | No sidebar nav item exists for tenant users — the module is reached via `/more` or a direct URL, matching the module registry. | — | — |

---

## 2. Business Rule Test Cases

### 2.1 Access control

| TC ID | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| AUD-BR-001 | Positive | Open `/audit-logs` as `TENANT_ADMIN`. | Access granted; only this tenant's entries are shown. | — | — |
| AUD-BR-002 | Negative | Open `/audit-logs` as a `STANDARD` user **with** `canView` granted on `audit_logs`. | Still refused — *"Forbidden. Admin credentials required."* The role check is additional to the permission check. | — | — |
| AUD-BR-003 | Negative | Open `/audit-logs` as a `STANDARD` user with no `audit_logs` permission row. | Refused. | — | — |
| AUD-BR-004 | Negative | Open `/audit-logs` with no session. | Redirected to `/login`. | — | — |
| AUD-BR-005 | Negative | Open `/audit-logs` with the subscription expired. | Refused — `hasPermission` denies everything for an expired tenant. | — | — |
| AUD-BR-006 | **Security** | As ADMIN_B, open `/audit-logs` after generating activity in TENANT_A. | Zero TENANT_A entries appear. Any cross-tenant log row ⇒ **S1**. | — | — |
| AUD-BR-007 | Business rule | Open `/audit-logs` as `SUPER_ADMIN`. | `audit_logs` is in the SUPER_ADMIN allow-list, but the query filters by `user.tenantId`. Record actual — a SUPER_ADMIN with no tenant context should see an empty/graceful result, never another tenant's log. | — | — |

### 2.2 Audit completeness — one row per mutation

Run each row: perform the action in the UI, then immediately check the top of `/audit-logs`.

| TC ID | Module / Action | Expected action value | Expected details content | Actual Result | Status |
|---|---|---|---|---|---|
| AUD-BR-010 | Register a tenant | `REGISTER_TENANT` | Workspace name; pending OTP verification | — | — |
| AUD-BR-011 | Verify email OTP | `VERIFY_EMAIL_OTP` | The verified email address | — | — |
| AUD-BR-012 | Request a password reset | `PASSWORD_RESET_REQUESTED` | The target email | — | — |
| AUD-BR-013 | Complete a password reset | `PASSWORD_RESET_SUCCESSFUL` | The user's email; **no password value** | — | — |
| AUD-BR-014 | Create / edit / delete a member | `CREATE_USER` / `UPDATE_USER` / `DELETE_USER` | Member name or email; **no `passwordHash`** | — | — |
| AUD-BR-015 | Save a profile | `UPDATE_PROFILE` | Which profile was updated; **no PAN/Aadhaar/passport value** | — | — |
| AUD-BR-016 | Upload / replace / delete a document | `CREATE_DOCUMENT` / `UPDATE_DOCUMENT` / `DELETE_DOCUMENT` | Document name and category; **no document number** | — | — |
| AUD-BR-017 | Create / edit / delete a credential | `CREATE_PASSWORD` / `UPDATE_PASSWORD` / `DELETE_PASSWORD` | Credential title; **no password** | — | — |
| AUD-BR-018 | Create / edit / delete a medical record | `CREATE_MEDICAL_RECORD` / `UPDATE_…` / `DELETE_…` | Patient name and record type | — | — |
| AUD-BR-019 | Create / edit / delete a policy | `CREATE_LIC_MEDICLAIM` / `UPDATE_…` / `DELETE_…` | Policy name. **Check for the full policy number — see AUD-BR-030** | — | — |
| AUD-BR-020 | Create / edit / delete a bank record | `CREATE_BANK_INFO` / `UPDATE_…` / `DELETE_…` | Bank name; **no full account number** | — | — |
| AUD-BR-021 | Create / edit / delete a credit card | `CREATE_CREDIT_CARD` / `UPDATE_…` / `DELETE_…` | Card name; **no PAN, no CVV** | — | — |
| AUD-BR-022 | Create / edit / delete a trading account | `CREATE_TRADING_DEMAT` / `UPDATE_…` / `DELETE_…` | Broker name. **Check for the client ID — see AUD-BR-030** | — | — |
| AUD-BR-023 | Create / edit / delete an investment | `CREATE_INVESTMENT` / `UPDATE_…` / `DELETE_…` | Investment title and category | — | — |
| AUD-BR-024 | Create / edit / delete a vehicle; generate follow-ups | `CREATE_VEHICLE` / `UPDATE_…` / `DELETE_…` / `GENERATE_FOLLOWUPS` | Vehicle name and number; the follow-up entry states how many tasks were created | — | — |
| AUD-BR-025 | Create / edit / delete a warranty, rental, important contact, to-do | `CREATE_WARRANTY`, `CREATE_CONTRACT`, `CREATE_EMERGENCY_CONTACT`, `CREATE_TODO` (+ UPDATE/DELETE) | Record identifier in each case | — | — |
| AUD-BR-026 | Create / edit / delete in each of the six enterprise vaults | `TAX_COMPLIANCE_*`, `WILLS_ESTATE_*`, `LOAN_DEBT_*`, `UTILITY_BILL_*`, `CORPORATE_COMPLIANCE_*`, `EMPLOYMENT_PAYROLL_*` | Record title; **no encrypted identifier** | — | — |
| AUD-BR-027 | Complete a payment | `PAYMENT_VERIFIED` (and `PAYMENT_CAPTURED_WEBHOOK` from the webhook) | Amount, plan/add-on; **no card data** | — | — |
| AUD-BR-028 | Fail a payment | `PAYMENT_FAILED_WEBHOOK` | Failure reason | — | — |
| AUD-BR-029 | Restore a backup; sync to Drive | `RESTORE_BACKUP`; `BYOD_GOOGLE_DRIVE_SYNC` | Scope of the restore; modules synced | — | — |

### 2.3 Secret-leak and integrity rules

| TC ID | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| AUD-BR-030 | **Security** | Create a policy with number `123456789` and a trading account with client ID `AB1234`, then read their audit entries. | The details text must not contain either value. **The LIC create path writes `(policyNumber)` and the trading create path writes the client ID into `details`** — if reproduced, log as **S2** (secret persisted in an audit trail). | — | — |
| AUD-BR-031 | Security | Scan every audit entry produced during a full regression pass for secrets. | No password, CVV, full card number, full account number, OTP, reset token or API key appears in any `details` value. | — | — |
| AUD-BR-032 | Security | Confirm audit rows cannot be modified from the app. | No UI affordance to edit or delete a log entry; no route exposed for it. | — | — |
| AUD-BR-033 | Business rule | Perform a mutation that **fails** (e.g. a rejected validation). | **No** audit row is written for the failed attempt — the log reflects committed changes only. Record actual. | — | — |
| AUD-BR-034 | Business rule | Perform a mutation as USER_A1 while acting on behalf of another holder. | `user_id` records the **acting** user, not the holder. | — | — |
| AUD-BR-035 | Edge | Delete the user who generated log entries. | Because `audit_logs.user_id` is `on delete cascade`, their entries are removed with them. Confirm this is the intended retention policy — losing the trail of a departed user is a compliance concern ⇒ raise **S3** if unintended. | — | — |
| AUD-BR-036 | Edge | Check the `ip_address` column on entries created from the browser. | Record actual — most write paths do not populate `ip_address`, so it is likely NULL for record mutations. Flag as **S3** if IP capture was expected. | — | — |
| AUD-BR-037 | Business rule | Delete the tenant, then query `audit_logs` for it. | All entries cascade away. Confirm whether any platform-level retention exists for compliance. | — | — |
| AUD-BR-038 | Boundary | Perform 150 mutations, then compare the UI with the database. | The DB holds all 150; the UI shows the newest 100 only. | — | — |
| AUD-BR-039 | Positive | Perform a mutation and note the wall-clock time. | The entry's timestamp is within a few seconds of the action and is rendered in the viewer's local timezone consistently. | — | — |

---

## 3. Database Validation Test Cases

| TC ID | Validation Point | SQL Query | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| AUD-DB-001 | Entry written with correct tenant and actor | `SELECT tenant_id, user_id, action, details, created_at FROM audit_logs WHERE tenant_id = ':tenant_a' ORDER BY created_at DESC LIMIT 1;` | `tenant_id = :tenant_a`; `user_id` = the acting user; action matches what was just done | — | — |
| AUD-DB-002 | Registration writes exactly one entry | `SELECT count(*) FROM audit_logs WHERE tenant_id = ':tenant_a' AND action = 'REGISTER_TENANT';` | `1` | — | — |
| AUD-DB-003 | Every mutation in a CRUD cycle is logged | Create, edit and delete one document, then: `SELECT action FROM audit_logs WHERE tenant_id = ':tenant_a' AND action IN ('CREATE_DOCUMENT','UPDATE_DOCUMENT','DELETE_DOCUMENT') ORDER BY created_at;` | Three rows in chronological order | — | — |
| AUD-DB-004 | Ordering is by `created_at DESC` in the UI | `SELECT action, created_at FROM audit_logs WHERE tenant_id = ':tenant_a' ORDER BY created_at DESC LIMIT 10;` | The same sequence as the top 10 rows on screen | — | — |
| AUD-DB-005 | 100-row cap | `SELECT count(*) FROM audit_logs WHERE tenant_id = ':tenant_a';` after 150 mutations | DB ≥ 150 while the UI shows 100 | — | — |
| AUD-DB-006 | `details` is mandatory and never empty | `SELECT count(*) FROM audit_logs WHERE tenant_id = ':tenant_a' AND (details IS NULL OR details = '');` | `0` | — | — |
| AUD-DB-007 | `action` is mandatory and never empty | `SELECT count(*) FROM audit_logs WHERE tenant_id = ':tenant_a' AND (action IS NULL OR action = '');` | `0` | — | — |
| AUD-DB-008 | Timestamps present | `SELECT count(*) FROM audit_logs WHERE created_at IS NULL;` | `0` | — | — |
| AUD-DB-009 | **No plaintext password in any entry** | `SELECT count(*) FROM audit_logs WHERE details LIKE '%SecretPassword123%';` | `0` | — | — |
| AUD-DB-010 | **No account number in any entry** | `SELECT count(*) FROM audit_logs WHERE details LIKE '%50100234567890%';` | `0` | — | — |
| AUD-DB-011 | **No card number or CVV** | `SELECT count(*) FROM audit_logs WHERE details LIKE '%4111111111111111%' OR details ILIKE '%cvv%';` | `0` | — | — |
| AUD-DB-012 | **Policy number leak check** | `SELECT count(*) FROM audit_logs WHERE tenant_id = ':tenant_a' AND details LIKE '%123456789%';` | Expected `0`. A hit confirms AUD-BR-030 for the LIC path ⇒ **S2** | — | — |
| AUD-DB-013 | **Client ID leak check** | `SELECT count(*) FROM audit_logs WHERE tenant_id = ':tenant_a' AND details LIKE '%AB1234%';` | Expected `0`. A hit confirms AUD-BR-030 for the trading path ⇒ **S2** | — | — |
| AUD-DB-014 | No OTP or reset token in the log | `SELECT count(*) FROM audit_logs WHERE details ~ '\m[0-9]{6}\M' AND action IN ('VERIFY_EMAIL_OTP','PASSWORD_RESET_REQUESTED');` | `0` | — | — |
| AUD-DB-015 | No API key in the log | `SELECT count(*) FROM audit_logs WHERE details LIKE 'AIza%' OR details LIKE '%sk-%';` | `0` | — | — |
| AUD-DB-016 | Actor belongs to the logged tenant | `SELECT count(*) FROM audit_logs a JOIN users u ON u.id = a.user_id WHERE a.tenant_id <> u.tenant_id;` | `0` | — | — |
| AUD-DB-017 | Cross-tenant isolation (P7) | `SELECT count(*) FROM audit_logs WHERE tenant_id = ':tenant_b' AND created_at > now() - interval '10 minutes';` | Whatever this returns, none of it appears in TENANT_A's `/audit-logs` | — | — |
| AUD-DB-018 | No row without a tenant | `SELECT count(*) FROM audit_logs WHERE tenant_id IS NULL;` | `0` | — | — |
| AUD-DB-019 | Action vocabulary is from the known set | `SELECT DISTINCT action FROM audit_logs WHERE tenant_id = ':tenant_a' ORDER BY 1;` | Every value appears in the Module Reference table above — no typos, no ad-hoc strings | — | — |
| AUD-DB-020 | Failed mutations wrote nothing | Trigger a validation failure, then: `SELECT count(*) FROM audit_logs WHERE tenant_id = ':tenant_a' AND created_at > now() - interval '1 minute';` | `0` | — | — |
| AUD-DB-021 | Actor delete cascades entries | Delete a member who generated entries, then: `SELECT count(*) FROM audit_logs WHERE user_id = ':deleted_user_id';` | `0` | — | — |
| AUD-DB-022 | Tenant delete cascades entries | Delete a throwaway tenant, then: `SELECT count(*) FROM audit_logs WHERE tenant_id = ':tenant_x';` | `0` | — | — |
| AUD-DB-023 | `ip_address` population | `SELECT count(*) FILTER (WHERE ip_address IS NOT NULL) AS with_ip, count(*) AS total FROM audit_logs WHERE tenant_id = ':tenant_a';` | Record actual — a `with_ip` of 0 confirms AUD-BR-036 | — | — |
| AUD-DB-024 | Mutation count vs. log count | Count the mutations performed during a scripted regression pass and compare with `SELECT count(*) FROM audit_logs WHERE tenant_id = ':tenant_a' AND created_at > ':run_start';` | Equal — every mutation produced exactly one entry, none missing and none duplicated | — | — |
| AUD-DB-025 | Rows are append-only | Capture `SELECT id, action, details FROM audit_logs WHERE tenant_id = ':tenant_a' ORDER BY created_at LIMIT 10;`, exercise the app, then re-run. | The first 10 rows are byte-for-byte identical — existing entries are never rewritten | — | — |

---

## 4. End-to-End Workflow Test Cases

| TC ID | Workflow | Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| AUD-E2E-001 | Full-lifecycle trail | 1. Register a tenant and verify OTP.<br>2. Add a member.<br>3. Create one record in 5 different modules.<br>4. Edit 2 of them.<br>5. Delete 1.<br>6. Open `/audit-logs`. | The trail reads as a complete, chronological story: register → verify → create user → 5 creates → 2 updates → 1 delete, with the correct actor on every row. | — | — |
| AUD-E2E-002 | Multi-actor attribution | 1. ADMIN_A creates a document.<br>2. USER_A1 edits it.<br>3. ADMIN_A deletes it.<br>4. Review the three entries. | Each entry names the correct acting user — never the record's holder or the tenant admin by default. | — | — |
| AUD-E2E-003 | Secret-leak sweep | 1. Create a credential, a bank account, a card, a policy and a trading account, each with known sensitive values.<br>2. Run AUD-DB-009 … AUD-DB-015. | All queries return `0`; any hit is logged with its exact action and details text. | — | — |
| AUD-E2E-004 | Cross-tenant isolation | 1. Generate 20 mutations in TENANT_B.<br>2. Log in as ADMIN_A and open `/audit-logs`.<br>3. Filter aggressively for TENANT_B's record names. | Zero results; the DB confirms TENANT_B's entries exist but are unreachable from TENANT_A. | — | — |
| AUD-E2E-005 | Permission gate | 1. Grant USER_A2 `canView` on `audit_logs`.<br>2. Log in as USER_A2 and open `/audit-logs`.<br>3. Promote USER_A2 to `TENANT_ADMIN` and retry. | Refused in step 2 (role check); granted in step 3. | — | — |
| AUD-E2E-006 | Retention & cap | 1. Generate 150 mutations.<br>2. Compare the UI list against the database.<br>3. Delete the acting user and re-check. | UI capped at 100; DB holds all 150; after the user delete their entries are gone (cascade) — record the compliance impact. | — | — |
| AUD-E2E-007 | Billing trail | 1. Purchase a plan.<br>2. Purchase an add-on.<br>3. Trigger a failed payment.<br>4. Review `/audit-logs`. | `PAYMENT_VERIFIED`, `GRANT_ADDON` / add-on purchase and `PAYMENT_FAILED_WEBHOOK` all present with correct amounts and no card data. | — | — |
