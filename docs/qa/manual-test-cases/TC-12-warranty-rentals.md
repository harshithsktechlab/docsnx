# TC-12 — Warranty & AMC · Rentals & Subscriptions

**Prefixes:** `WRN`, `RNT` · **Routes:** `/warranty`, `/rentals`
**Tables:** `warranty_amcs`, `contract_agreements` · **Permission keys:** `warranty`, `rentals`

> Both modules are **holder-scoped, not owner-scoped**: they have `holder_id` and an
> `is_global` flag that **defaults to `true`** (visible to the all members), and neither table
> has a `user_id` or a `deleted_at` column — **deletes are hard deletes**.

---

# PART A — Warranty & AMC (`WRN`)

## Module Reference

| Aspect | Detail |
|---|---|
| Required fields | Appliance Name*, Company*, Type*, Expiry Date* — otherwise *"Missing required fields: applianceName, company, type, or expiryDate"* |
| Optional | Purchase Date, Support Contact, Notes, File, Holder |
| Types | `WARRANTY` (Warranty), `AMC` (Annual Maintenance Contract) |
| Holder options | "Global (All Members)" (`none` → `holder_id = null`, `is_global = true`) or a specific member |
| Column limits | `appliance_name` 255 · `company` 255 · `type` 50 · `support_contact` 255 |
| Follow-ups | Expiry within 15 days surfaces on `/follow-up` |
| Delete | Hard delete (no `deleted_at`) |

## A1. UI Validation

| TC ID | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| WRN-UI-001 | Positive | Open `/warranty` empty and populated. | Empty state with CTA; populated view shows appliance, company, type badge, expiry and holder. | — | — |
| WRN-UI-002 | Positive | Inspect the Type badge on a Warranty vs. an AMC record. | Visually distinct badges with the correct labels. | — | — |
| WRN-UI-003 | Positive | View a record whose expiry is in the past. | Flagged as expired. | — | — |
| WRN-UI-004 | Positive | View a record expiring in 10 days. | Flagged as expiring soon with the correct day count. | — | — |
| WRN-UI-005 | Positive | Use the Type filter. | Filters correctly between Warranty and AMC. | — | — |
| WRN-UI-006 | Positive | Use the Holder filter. | Filters to that member's records plus global ones (confirm the intended inclusion of globals and record actual). | — | — |
| WRN-UI-007 | Positive | Search "appliances, brands, notes". | Live filtering across appliance name, company and notes. | — | — |
| WRN-UI-008 | Positive | Open the Add dialog. | Appliance Name, Company, Type select ("Select Type"), Purchase Date, Expiry Date, Support Contact, Notes, file picker, Holder select ("Select Holder" incl. "Global (All Members)"). | — | — |
| WRN-UI-009 | Positive | Save a valid record. | Spinner; success toast; list refreshes with the record. | — | — |
| WRN-UI-010 | Positive | Edit / Delete. | Edit pre-fills everything; Delete confirms first. | — | — |
| WRN-UI-011 | Positive | Attach and preview a warranty card PDF/photo. | Inline preview; Download available. | — | — |
| WRN-UI-012 | Positive | View at 375px. | Cards stack; long company names wrap; no horizontal page scroll. | — | — |
| WRN-UI-013 | Positive | As a view-only user, open `/warranty`. | Add/Edit/Delete hidden or disabled. | — | — |

## A2. Field Validation

| TC ID | Field | Type | Input / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|---|
| WRN-FLD-001 | All required | Negative | Submit with Appliance Name, Company, Type and Expiry Date blank. | *"Missing required fields: applianceName, company, type, or expiryDate"*; no row created. | — | — |
| WRN-FLD-002 | Each required field | Negative | Omit exactly one required field at a time (4 runs). | Each rejected with the same message. | — | — |
| WRN-FLD-003 | Appliance Name | Boundary | 255 / 256 characters. | 255 accepted; 256 rejected. | — | — |
| WRN-FLD-004 | Company | Boundary | 255 / 256 characters. | 255 accepted; 256 rejected. | — | — |
| WRN-FLD-005 | Type | Positive | `WARRANTY` and `AMC`. | Both saved and filterable. | — | — |
| WRN-FLD-006 | Type | Boundary | 50 / 51 characters (via a manipulated value). | 50 accepted; 51 rejected. | — | — |
| WRN-FLD-007 | Type | Negative | An arbitrary value outside the two options. | Rejected or normalised — an unknown type must not break the filter tabs. Record actual. | — | — |
| WRN-FLD-008 | Expiry Date | Positive | A future date. | Accepted; drives follow-up alerts. | — | — |
| WRN-FLD-009 | Expiry Date | Edge | A past date. | Accepted; shown as expired. | — | — |
| WRN-FLD-010 | Expiry Date | Boundary | Exactly today; exactly 15 days out; exactly 16 days out. | Today and 15 days appear on `/follow-up`; 16 days does not. | — | — |
| WRN-FLD-011 | Purchase Date | Edge | Purchase Date **after** the Expiry Date. | Record actual — an inconsistent pair should be flagged. | — | — |
| WRN-FLD-012 | Purchase Date | Edge | Blank. | Accepted (nullable). | — | — |
| WRN-FLD-013 | Support Contact | Boundary | 255 / 256 characters. | 255 accepted; 256 rejected. | — | — |
| WRN-FLD-014 | Support Contact | Positive | A phone number and an email address. | Both accepted verbatim. | — | — |
| WRN-FLD-015 | Notes | Boundary | 10 000-character note. | Accepted (text column) and fully retrievable. | — | — |
| WRN-FLD-016 | Notes | Edge | Multi-line note. | Line breaks preserved. | — | — |
| WRN-FLD-017 | Holder | Positive | Assign to a specific member. | `holder_id` set; the member's name shows on the card. | — | — |
| WRN-FLD-018 | Holder | Positive | Choose "Global (All Members)". | `holder_id = null`; the record is visible to all members. | — | — |
| WRN-FLD-019 | Holder | Negative | Assign to a user id from another tenant (manipulated). | Rejected; no cross-tenant holder is stored. | — | — |
| WRN-FLD-020 | File | Boundary | Attach a file breaching the storage quota. | Record actual — this route does not visibly gate on `checkStorageLimit`; if the upload succeeds past the quota, raise **S3** (quota bypass). | — | — |
| WRN-FLD-021 | All | Edge | `<script>alert(1)</script>` in Appliance Name and Notes. | Rendered as literal text. | — | — |
| WRN-FLD-022 | All | Edge | Double-click Save. | Exactly one record created. | — | — |

## A3. Business Rules

| TC ID | Type | Rule / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| WRN-BR-001 | Positive | Create a record without choosing a holder. | `is_global` defaults to `true` and `holder_id` is NULL — visible to the all members. | — | — |
| WRN-BR-002 | Positive | Create a holder-specific record, then log in as a **different** member with `canView`. | Confirm the intended visibility of holder-specific records and record actual. | — | — |
| WRN-BR-003 | Business rule | Set an expiry 10 days out and open `/follow-up`. | The item appears under renewals with the correct day count and links to `/warranty`. | — | — |
| WRN-BR-004 | Business rule | Set an expiry 5 days in the past. | Shown as overdue with "overdue by 5 days". | — | — |
| WRN-BR-005 | Business rule | Set an expiry 30 days out. | Does **not** appear on `/follow-up` (outside the 15-day threshold). | — | — |
| WRN-BR-006 | Negative | View-only user attempts add/edit/delete. | All refused. | — | — |
| WRN-BR-007 | Negative | User with no `warranty` permission row opens the module. | Access denied; nav entry hidden. | — | — |
| WRN-BR-008 | Negative | ADMIN_B attempts to view/edit/delete a TENANT_A warranty id. | 403/404; record unchanged. | — | — |
| WRN-BR-009 | Positive | Delete a record. | Removed from the list; because this table has no `deleted_at`, the row is hard-deleted. | — | — |
| WRN-BR-010 | Positive | Create/edit/delete and check `/audit-logs`. | One entry per mutation. | — | — |
| WRN-BR-011 | Business rule | Delete the holder user, then view the record. | `holder_id` becomes NULL (`set null`); the record survives as global. | — | — |
| WRN-BR-012 | Business rule | Include warranties in the Backup export. | Present under `warrantyAmcs`. | — | — |
| WRN-BR-013 | Negative | Subscription expired → open `/warranty`. | Access blocked. | — | — |

## A4. Database Validation

| TC ID | Validation Point | SQL Query | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| WRN-DB-001 | Tenant stamping (P1) | `SELECT tenant_id, appliance_name, company, type FROM warranty_amcs WHERE id = ':record_id';` | `tenant_id = :tenant_a`; values as entered | — | — |
| WRN-DB-002 | `is_global` defaults to true | Create without choosing a holder, then: `SELECT is_global, holder_id FROM warranty_amcs WHERE id = ':record_id';` | `t`, `NULL` | — | — |
| WRN-DB-003 | Holder-specific record stored correctly | `SELECT is_global, holder_id FROM warranty_amcs WHERE id = ':holder_record_id';` | `holder_id` = the chosen member; `is_global` per the UI selection | — | — |
| WRN-DB-004 | Expiry date is mandatory and non-null | `SELECT count(*) FROM warranty_amcs WHERE tenant_id = ':tenant_a' AND expiry_date IS NULL;` | `0` | — | — |
| WRN-DB-005 | Purchase date nullable | `SELECT purchase_date IS NULL FROM warranty_amcs WHERE id = ':record_no_purchase';` | `t` | — | — |
| WRN-DB-006 | Type constrained | `SELECT DISTINCT type FROM warranty_amcs WHERE tenant_id = ':tenant_a';` | Only `WARRANTY` and `AMC` | — | — |
| WRN-DB-007 | Audit timestamps (P2) | `SELECT created_at IS NOT NULL, updated_at IS NOT NULL, updated_at >= created_at FROM warranty_amcs WHERE id = ':record_id';` | `t, t, t` | — | — |
| WRN-DB-008 | Hard delete (no soft-delete column) | Delete via the UI, then: `SELECT count(*) FROM warranty_amcs WHERE id = ':record_id';` | `0` | — | — |
| WRN-DB-009 | No `deleted_at` column exists | `SELECT count(*) FROM information_schema.columns WHERE table_name = 'warranty_amcs' AND column_name = 'deleted_at';` | `0` — confirms the hard-delete design | — | — |
| WRN-DB-010 | Cross-tenant isolation (P7) | `SELECT count(*) FROM warranty_amcs WHERE id = ':record_id' AND tenant_id = ':tenant_b';` | `0` | — | — |
| WRN-DB-011 | Holder is same-tenant | `SELECT count(*) FROM warranty_amcs w JOIN users u ON u.id = w.holder_id WHERE w.tenant_id <> u.tenant_id;` | `0` | — | — |
| WRN-DB-012 | Follow-up threshold matches the DB | `SELECT count(*) FROM warranty_amcs WHERE tenant_id = ':tenant_a' AND expiry_date <= now() + interval '15 days';` | Matches the number of warranty entries on `/follow-up` | — | — |
| WRN-DB-013 | File metadata | `SELECT file_path IS NOT NULL AS has_file, file_size FROM warranty_amcs WHERE id = ':record_id';` | `t` and bytes > 0 when attached | — | — |
| WRN-DB-014 | Holder delete nullifies, does not cascade | Delete the holder user, then: `SELECT holder_id FROM warranty_amcs WHERE id = ':record_id';` | `NULL`; the row still exists | — | — |
| WRN-DB-015 | Audit log per mutation (P4) | `SELECT action, details FROM audit_logs WHERE tenant_id = ':tenant_a' ORDER BY created_at DESC LIMIT 3;` | Entries matching the create/update/delete performed | — | — |
| WRN-DB-016 | No row without a tenant | `SELECT count(*) FROM warranty_amcs WHERE tenant_id IS NULL;` | `0` | — | — |

---

# PART B — Rentals & Subscriptions (`RNT`)

## Module Reference

| Aspect | Detail |
|---|---|
| Route / table / key | `/rentals` · `contract_agreements` · `rentals` |
| Required fields | Type*, Name*, Provider*, End Date* — otherwise *"Missing required fields: type, name, provider, or endDate"* |
| Optional | Account Number, Start Date, Amount, Billing Cycle, Notes, File, Holder |
| Types | `RENTAL` (Rental Lease), `SUBSCRIPTION` (Digital Subscription), `UTILITY` (Utility Service), `MAINTENANCE` (Maintenance) |
| Billing cycles | `monthly`, `quarterly`, `half-yearly`, `yearly`, `one-time` |
| Encrypted at rest | `account_number` |
| Amount handling | Parsed with `parseFloat`; a non-numeric string becomes **NULL** (silently) — see RNT-FLD-011 |
| Money precision | `amount` decimal(12,2) |
| Holder options | "Global (All Members)" (default `is_global = true`) or a specific member |
| Delete | Hard delete (no `deleted_at`) |

## B1. UI Validation

| TC ID | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| RNT-UI-001 | Positive | Open `/rentals` empty and populated. | Empty state with CTA; populated view shows name, provider, type badge, amount, billing cycle and end date. | — | — |
| RNT-UI-002 | Positive | Inspect the Account Number in the list. | Confirm the display policy (masked vs. revealed) and record actual — the list route decrypts this field, so a fully revealed account number in a list view should be raised as **S2**. | — | — |
| RNT-UI-003 | Positive | View a contract ending in 10 days. | Flagged as expiring; appears on `/follow-up`. | — | — |
| RNT-UI-004 | Positive | View a contract that has already ended. | Flagged as expired/overdue. | — | — |
| RNT-UI-005 | Positive | Use the Category (type) filter. | Filters correctly across all four types. | — | — |
| RNT-UI-006 | Positive | Use the Holder filter. | Filters to that member plus global records. | — | — |
| RNT-UI-007 | Positive | Search "contracts, providers, notes". | Live filtering across name, provider and notes. | — | — |
| RNT-UI-008 | Positive | Open the Add dialog. | Type select ("Select Category"), Name, Provider, Account Number, Start Date, End Date, Amount, Billing Cycle select ("Select Cycle"), Notes, file picker, Holder select. | — | — |
| RNT-UI-009 | Positive | Save a valid contract. | Spinner; success toast; list refreshes. | — | — |
| RNT-UI-010 | Positive | Edit / Delete. | Edit pre-fills everything including the decrypted account number; Delete confirms first. | — | — |
| RNT-UI-011 | Positive | View at 375px. | Cards stack; amounts and dates wrap; no horizontal page scroll. | — | — |
| RNT-UI-012 | Positive | As a view-only user, open `/rentals`. | Add/Edit/Delete hidden or disabled. | — | — |

## B2. Field Validation

| TC ID | Field | Type | Input / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|---|
| RNT-FLD-001 | All required | Negative | Submit with Type, Name, Provider and End Date blank. | *"Missing required fields: type, name, provider, or endDate"*; no row created. | — | — |
| RNT-FLD-002 | Each required field | Negative | Omit exactly one required field at a time (4 runs). | Each rejected with the same message. | — | — |
| RNT-FLD-003 | Type | Positive | Each of RENTAL / SUBSCRIPTION / UTILITY / MAINTENANCE. | All saved and filterable. | — | — |
| RNT-FLD-004 | Type | Boundary | 100 / 101 characters (manipulated). | 100 accepted; 101 rejected. | — | — |
| RNT-FLD-005 | Name | Boundary | 255 / 256 characters. | 255 accepted; 256 rejected. | — | — |
| RNT-FLD-006 | Provider | Boundary | 255 / 256 characters. | 255 accepted; 256 rejected. | — | — |
| RNT-FLD-007 | Account Number | Positive | `Consumer ID 12345`. | Saved encrypted at rest; correct on reveal. | — | — |
| RNT-FLD-008 | Account Number | Edge | Blank. | Stored as NULL, not an empty ciphertext. | — | — |
| RNT-FLD-009 | Amount | Positive | `15000`. | Stored as `15000.00`. | — | — |
| RNT-FLD-010 | Amount | Boundary | `0`, `0.01`, `9999999999.99` (precision 12,2), and one over precision. | First three accepted exactly; over-precision rejected cleanly. | — | — |
| RNT-FLD-011 | Amount | **Negative** | Enter a non-numeric amount such as `abc` or `15,000`. | **The route parses with `parseFloat` and silently stores NULL when the parse fails.** Expected: a validation error naming the field. If the record saves with a blank amount and no warning, raise **S3** (silent data loss). | — | — |
| RNT-FLD-012 | Amount | Negative | `-5000`. | Rejected. Record actual — `parseFloat` accepts negatives, so silent acceptance is likely ⇒ **S3**. | — | — |
| RNT-FLD-013 | Amount | Edge | `1000.555` (3 decimals). | Rounded to 2 decimals per scale; record the rounding. | — | — |
| RNT-FLD-014 | Amount | Edge | Blank. | Accepted; stored as NULL; renders cleanly (not `NaN` or `0.00` implying zero cost). | — | — |
| RNT-FLD-015 | Billing Cycle | Positive | Each of monthly / quarterly / half-yearly / yearly / one-time. | All saved and displayed. | — | — |
| RNT-FLD-016 | Billing Cycle | Boundary | 50 / 51 characters (manipulated). | 50 accepted; 51 rejected. | — | — |
| RNT-FLD-017 | End Date | Positive | A future date. | Accepted; drives follow-up alerts. | — | — |
| RNT-FLD-018 | End Date | Boundary | Exactly today; 15 days out; 16 days out. | Today and 15 days appear on `/follow-up`; 16 days does not. | — | — |
| RNT-FLD-019 | Start Date | Edge | Start Date **after** the End Date. | Record actual — an inverted contract period should be flagged. | — | — |
| RNT-FLD-020 | Start Date | Edge | Blank. | Accepted (nullable). | — | — |
| RNT-FLD-021 | Notes | Boundary | 10 000-character note. | Accepted and fully retrievable. | — | — |
| RNT-FLD-022 | Holder | Positive | Global vs. a specific member. | Both persist correctly. | — | — |
| RNT-FLD-023 | Holder | Negative | Assign to another tenant's user id. | Rejected. | — | — |
| RNT-FLD-024 | File | Boundary | Attach a file breaching the storage quota. | Record actual — if the upload succeeds past the quota, raise **S3** (quota bypass). | — | — |
| RNT-FLD-025 | All | Edge | `<script>alert(1)</script>` in Name and Notes. | Rendered as literal text. | — | — |
| RNT-FLD-026 | All | Edge | Double-click Save. | Exactly one record created. | — | — |

## B3. Business Rules

| TC ID | Type | Rule / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| RNT-BR-001 | Positive | Create without choosing a holder. | `is_global` defaults to `true`, `holder_id` NULL. | — | — |
| RNT-BR-002 | Security | Save an account number, then inspect the DB row. | `account_number` is ciphertext; the plaintext appears nowhere in the row. | — | — |
| RNT-BR-003 | Security | Open `/rentals` and inspect the list network payload. | Determine whether the account number is returned decrypted in full. If so, raise **S2** — list views elsewhere in the product mask this class of field. | — | — |
| RNT-BR-004 | Positive | Reveal/edit and compare the account number with what was entered. | Byte-for-byte identical. | — | — |
| RNT-BR-005 | Business rule | Set an End Date 10 days out and open `/follow-up`. | The contract appears under renewals with the correct day count. | — | — |
| RNT-BR-006 | Business rule | Set an End Date 5 days in the past. | Shown as overdue with "overdue by 5 days". | — | — |
| RNT-BR-007 | Business rule | Set an End Date 30 days out. | Does **not** appear on `/follow-up`. | — | — |
| RNT-BR-008 | Negative | View-only user attempts add/edit/delete. | All refused. | — | — |
| RNT-BR-009 | Negative | User with no `rentals` permission row opens the module. | Access denied; nav entry hidden. | — | — |
| RNT-BR-010 | Negative | ADMIN_B attempts to view/edit/delete a TENANT_A contract id. | 403/404; record unchanged. | — | — |
| RNT-BR-011 | Positive | Delete a contract. | Removed from the list; hard-deleted from the DB (no `deleted_at` column). | — | — |
| RNT-BR-012 | Positive | Create/edit/delete and check `/audit-logs`. | One entry per mutation; **the account number must not appear in the details text**. | — | — |
| RNT-BR-013 | Business rule | Delete the holder user, then view the contract. | `holder_id` becomes NULL; the record survives as global. | — | — |
| RNT-BR-014 | Security | Run an AI feature with rental contracts present. | Account numbers are masked before any model call. | — | — |
| RNT-BR-015 | Business rule | Include rentals in the Backup export. | Present under `contractAgreements`. | — | — |
| RNT-BR-016 | Negative | Subscription expired → open `/rentals`. | Access blocked. | — | — |

## B4. Database Validation

| TC ID | Validation Point | SQL Query | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| RNT-DB-001 | Tenant stamping (P1) | `SELECT tenant_id, type, name, provider FROM contract_agreements WHERE id = ':record_id';` | `tenant_id = :tenant_a`; values as entered | — | — |
| RNT-DB-002 | Account number encrypted (P5) | `SELECT account_number ~ '^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$' AS is_ciphertext FROM contract_agreements WHERE id = ':record_id';` | `t` | — | — |
| RNT-DB-003 | Plaintext never stored | `SELECT count(*) FROM contract_agreements WHERE account_number = 'Consumer ID 12345';` | `0` | — | — |
| RNT-DB-004 | Blank account number is NULL | `SELECT account_number FROM contract_agreements WHERE id = ':record_no_account';` | `NULL` | — | — |
| RNT-DB-005 | `is_global` defaults to true | Create without a holder, then: `SELECT is_global, holder_id FROM contract_agreements WHERE id = ':record_id';` | `t`, `NULL` | — | — |
| RNT-DB-006 | End date mandatory and non-null | `SELECT count(*) FROM contract_agreements WHERE tenant_id = ':tenant_a' AND end_date IS NULL;` | `0` | — | — |
| RNT-DB-007 | Amount precision preserved | `SELECT amount FROM contract_agreements WHERE id = ':record_id';` | Exactly the value entered, 2 decimals | — | — |
| RNT-DB-008 | **Non-numeric amount silently nulled** | After RNT-FLD-011: `SELECT amount FROM contract_agreements WHERE id = ':record_bad_amount';` | `NULL` — confirms the silent `parseFloat` fallback. Log as **S3** | — | — |
| RNT-DB-009 | No negative amounts | `SELECT count(*) FROM contract_agreements WHERE tenant_id = ':tenant_a' AND amount < 0;` | `0` — a non-zero result confirms RNT-FLD-012 | — | — |
| RNT-DB-010 | Types constrained | `SELECT DISTINCT type FROM contract_agreements WHERE tenant_id = ':tenant_a';` | Only `RENTAL`, `SUBSCRIPTION`, `UTILITY`, `MAINTENANCE` | — | — |
| RNT-DB-011 | Billing cycles constrained | `SELECT DISTINCT billing_cycle FROM contract_agreements WHERE tenant_id = ':tenant_a';` | Only `monthly`, `quarterly`, `half-yearly`, `yearly`, `one-time` (or NULL) | — | — |
| RNT-DB-012 | Audit timestamps (P2) | `SELECT created_at IS NOT NULL, updated_at IS NOT NULL, updated_at >= created_at FROM contract_agreements WHERE id = ':record_id';` | `t, t, t` | — | — |
| RNT-DB-013 | Hard delete (no soft-delete column) | Delete via the UI, then: `SELECT count(*) FROM contract_agreements WHERE id = ':record_id';` | `0` | — | — |
| RNT-DB-014 | Cross-tenant isolation (P7) | `SELECT count(*) FROM contract_agreements WHERE id = ':record_id' AND tenant_id = ':tenant_b';` | `0` | — | — |
| RNT-DB-015 | Holder is same-tenant | `SELECT count(*) FROM contract_agreements c JOIN users u ON u.id = c.holder_id WHERE c.tenant_id <> u.tenant_id;` | `0` | — | — |
| RNT-DB-016 | Follow-up threshold matches the DB | `SELECT count(*) FROM contract_agreements WHERE tenant_id = ':tenant_a' AND end_date <= now() + interval '15 days';` | Matches the number of contract entries on `/follow-up` | — | — |
| RNT-DB-017 | Audit details leak check | `SELECT count(*) FROM audit_logs WHERE tenant_id = ':tenant_a' AND details LIKE '%Consumer ID 12345%';` | `0` | — | — |
| RNT-DB-018 | No row without a tenant | `SELECT count(*) FROM contract_agreements WHERE tenant_id IS NULL;` | `0` | — | — |

---

## Cross-Module End-to-End Workflows

| TC ID | Workflow | Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| UTL-E2E-001 | Household coverage setup | 1. Add an AC warranty (expiry 10 days out) as Global.<br>2. Add a laptop AMC assigned to QA Child.<br>3. Add a Netflix subscription (monthly, ends in 12 days).<br>4. Add an apartment lease (yearly, ends in 6 months). | All four created; dashboard counts increment; `/follow-up` lists the AC warranty and Netflix subscription only. | — | — |
| UTL-E2E-002 | Renewal cycle | 1. Note the two items on `/follow-up`.<br>2. Extend both expiry/end dates by one year.<br>3. Re-open `/follow-up`. | Both disappear from the alert list; the records reflect the new dates. | — | — |
| UTL-E2E-003 | Global vs. holder visibility | 1. Create one Global and one holder-specific record in each module.<br>2. Log in as a different member with `canView`. | Global records are visible; confirm holder-specific visibility matches the intended model and record actual. | — | — |
| UTL-E2E-004 | Hard-delete verification | 1. Create one record in each module.<br>2. Delete both.<br>3. Query both tables by id. | Both rows are gone entirely (no soft-delete row remains) and neither appears in the UI, search or follow-ups. | — | — |
| UTL-E2E-005 | Encryption & masking check | 1. Create a rental with a known account number.<br>2. Inspect the list payload, the edit dialog, the DB row and `audit_logs.details`. | Ciphertext at rest; correct on reveal; absent from the audit trail; record the list-view exposure per RNT-BR-003. | — | — |
| UTL-E2E-006 | Isolation sweep | 1. Create one record in each module in TENANT_A.<br>2. Log in as ADMIN_B.<br>3. Attempt view/edit/delete on both ids and run a global search. | All attempts fail with 403/404; nothing disclosed. | — | — |
| UTL-E2E-007 | Member removal | 1. Assign records in both modules to QA Child.<br>2. Delete QA Child.<br>3. Re-open both modules. | Both records survive with `holder_id = NULL` and render as Global; no crashes or broken rows. | — | — |
