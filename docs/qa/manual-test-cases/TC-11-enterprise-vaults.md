# TC-11 — Enterprise Vaults: Tax · Loans · Wills · Utility Bills · Corporate · Employment

**Prefixes:** `TAX`, `LON`, `WIL`, `UTL`, `CRP`, `EMP`
**Routes:** `/tax-compliance`, `/loans-debt`, `/wills-estate`, `/utility-bills`,
`/corporate-compliance`, `/employment-payroll`

These six modules share one CRUD contract. **Section 0 defines the shared behaviour and the
shared test cases** — run every case in Section 0 against **each** of the six modules,
substituting the module prefix. Sections 1–6 then add the module-specific field, business-rule
and DB cases.

---

## Section 0 — Shared Contract & Common Test Cases

### 0.1 Shared behaviour

| Aspect | Detail |
|---|---|
| Common columns | `id`, `tenant_id`, `user_id`, `holder_id`, `is_global`, `title`, `file_path`, `file_size`, `ai_analysis`, `custom_fields`, `created_at`, `updated_at`, `deleted_at` |
| Auth pipeline | `getUserFromRequest` → `hasPermission(user, <key>, <action>)` → validate → tenant-scoped write → audit log |
| Missing-field error | `"Missing required fields"` (HTTP 400) for any absent mandatory field |
| **Duplicate guard** | Each module checks for an existing record on a natural key before insert. On a hit it returns **HTTP 409** with `requiresConfirmation: true`. Re-submitting with **`forceSave`** bypasses the guard and creates the record anyway |
| Storage quota | Attaching a file goes through `checkStorageLimit` |
| Soft delete | All six tables have `deleted_at` |
| Search & filter | Free-text search plus a document/form-type filter tab with an "All" option |

### 0.2 Per-module summary

| Module | Prefix | Table | Permission key | Mandatory fields | Duplicate key | Encrypted column | Blind index |
|---|---|---|---|---|---|---|---|
| Tax & Compliance | `TAX` | `tax_compliances` | `tax_compliance` | Title, Form Type, Assessment Year | form type + assessment year | `acknowledgement_number` | — |
| Loans & Debts | `LON` | `loans_debts` | `loans_debt` | Title, Lender Name, Loan Type, Account Number | account-number hash + lender | `account_number` | `account_number_hash` |
| Wills & Estate | `WIL` | `wills_estates` | `wills_estate` | Title, Document Type, Testator Name | testator + document type | — | — |
| Utility Bills | `UTL` | `utility_bills` | `utility_bills` | Title, Provider Name, Service Type, Consumer Number | consumer-number hash + provider | `consumer_number` | `consumer_number_hash` |
| Corporate Compliance | `CRP` | `corporate_compliances` | `corporate_compliance` | Title, Entity Name, Document Type | entity + document type | `registration_number` | — |
| Employment & Payroll | `EMP` | `employment_payrolls` | `employment_payroll` | Title, Employer Name, Employee Name, Document Type | employee + document type | — | — |

### 0.3 Shared UI validation (run per module — 6 executions each)

| TC ID | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| `<MOD>`-UI-001 | Positive | Open the module on an empty tenant. | Empty state with an "Add Record" CTA; no console error. | — | — |
| `<MOD>`-UI-002 | Positive | Open the module with records present. | List/cards render every mandatory field plus the type badge and date. | — | — |
| `<MOD>`-UI-003 | Positive | Observe the loading state. | Skeletons, then content — no flash of the empty state. | — | — |
| `<MOD>`-UI-004 | Positive | Use the type filter tabs (including "All"). | Filters correctly; the active tab is highlighted. | — | — |
| `<MOD>`-UI-005 | Positive | Type in the module search box. | Live filtering across the searchable fields named in the placeholder. | — | — |
| `<MOD>`-UI-006 | Negative | Search for a nonsense string. | Friendly empty state, not a blank page. | — | — |
| `<MOD>`-UI-007 | Positive | Open the Add dialog. | All mandatory fields are marked required; optional fields present; file picker available. | — | — |
| `<MOD>`-UI-008 | Positive | Save a valid record. | Spinner on the button; success toast; dialog closes; list refreshes. | — | — |
| `<MOD>`-UI-009 | Positive | Trigger the duplicate guard (save the same natural key twice). | A confirmation prompt appears explaining the duplicate, offering Cancel and "Save anyway". | — | — |
| `<MOD>`-UI-010 | Positive | Choose "Save anyway" on the duplicate prompt. | The record is created (forceSave path); both records now appear. | — | — |
| `<MOD>`-UI-011 | Positive | Choose Cancel on the duplicate prompt. | No record created; the form stays open with the entered values intact. | — | — |
| `<MOD>`-UI-012 | Positive | Click Edit. | Dialog pre-populated with every stored value, including any encrypted field revealed. | — | — |
| `<MOD>`-UI-013 | Positive | Click Delete. | Confirmation dialog naming the record before deletion. | — | — |
| `<MOD>`-UI-014 | Negative | Trigger a save/delete failure (offline). | Error toast; the list is unchanged; entered values retained. | — | — |
| `<MOD>`-UI-015 | Positive | Attach and then preview/download a file. | Inline preview for PDF/image; Download returns the original file. | — | — |
| `<MOD>`-UI-016 | Positive | View at 375px, 768px and 1440px. | Layout reflows; tables scroll inside their own container; no horizontal page scroll. | — | — |
| `<MOD>`-UI-017 | Positive | As a view-only user, open the module. | Add/Edit/Delete hidden or disabled; records still readable. | — | — |
| `<MOD>`-UI-018 | Positive | Inspect the AI analysis panel on a saved record. | Renders readable insight text (or a clean "not available" state) — never a raw JSON dump or an error stack. | — | — |

### 0.4 Shared field validation (run per module)

| TC ID | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| `<MOD>`-FLD-001 | Negative | Submit with all mandatory fields blank. | `"Missing required fields"`; no row created. | — | — |
| `<MOD>`-FLD-002 | Negative | Omit exactly one mandatory field at a time (one run per mandatory field). | Each rejected with the same message; no partial rows. | — | — |
| `<MOD>`-FLD-003 | Negative | Submit a mandatory field containing only spaces. | Rejected as empty. Record actual — whitespace-only acceptance ⇒ **S3**. | — | — |
| `<MOD>`-FLD-004 | Boundary | Title at 255 and 256 characters. | 255 accepted; 256 rejected. | — | — |
| `<MOD>`-FLD-005 | Boundary | Every `varchar(255)` field at 255 / 256 characters. | 255 accepted; 256 rejected on each. | — | — |
| `<MOD>`-FLD-006 | Boundary | Every `varchar(100)` field (type/category columns) at 100 / 101 characters. | 100 accepted; 101 rejected. | — | — |
| `<MOD>`-FLD-007 | Edge | Unicode and emoji in the Title. | Stored and rendered correctly; searchable by the unicode substring. | — | — |
| `<MOD>`-FLD-008 | Edge | `<script>alert(1)</script>` in every free-text field. | Rendered as literal text everywhere including print/share views. | — | — |
| `<MOD>`-FLD-009 | Edge | Leading/trailing whitespace on a text field. | Stored consistently (record whether trimmed). | — | — |
| `<MOD>`-FLD-010 | Positive | Add 3 custom Label/Value pairs. | Saved and displayed on the record. | — | — |
| `<MOD>`-FLD-011 | Boundary | Add 50 custom fields. | All persist; the form remains usable. | — | — |
| `<MOD>`-FLD-012 | Boundary | Attach a file that breaches the remaining storage quota. | Rejected with the quota message; no row created; no orphan file on disk. | — | — |
| `<MOD>`-FLD-013 | Edge | Save with no file attached. | Accepted (`file_path` nullable, `file_size = 0`). | — | — |
| `<MOD>`-FLD-014 | Negative | Assign the holder to a user id from another tenant (manipulated). | Rejected; no cross-tenant holder is stored. | — | — |
| `<MOD>`-FLD-015 | Edge | Double-click Save. | Exactly one record created. | — | — |
| `<MOD>`-FLD-016 | Edge | Any date field: past date, today, future date, `1900-01-01`, `2999-12-31`. | All stored and rendered without `Invalid Date`; no ±1-day timezone drift. | — | — |

### 0.5 Shared business rules (run per module)

| TC ID | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| `<MOD>`-BR-001 | Positive | Create a record as TENANT_ADMIN. | `tenant_id` = session tenant; `user_id` = creator; `holder_id` as selected. | — | — |
| `<MOD>`-BR-002 | Negative | View-only user attempts add/edit/delete. | All three refused with Forbidden; controls not rendered. | — | — |
| `<MOD>`-BR-003 | Negative | User with no permission row for the module key opens the module. | Access denied; nav entry hidden. | — | — |
| `<MOD>`-BR-004 | Negative | ADMIN_B attempts to view/edit/delete a TENANT_A record id. | 403/404; TENANT_A record unchanged (`updated_at` does not move). | — | — |
| `<MOD>`-BR-005 | Positive | Delete a record. | Soft-deleted; removed from list, search and dashboard counts. | — | — |
| `<MOD>`-BR-006 | Positive | Create/edit/delete and check `/audit-logs`. | One entry per mutation naming the record. | — | — |
| `<MOD>`-BR-007 | Business rule | Trigger the duplicate guard, then confirm with "Save anyway". | The 409 path returns `requiresConfirmation`; the forceSave path creates the record. | — | — |
| `<MOD>`-BR-008 | Edge | Trigger the duplicate guard against a **soft-deleted** record with the same natural key. | Record actual — if the guard matches deleted rows, the user is blocked from re-creating a record they already deleted ⇒ **S3**. | — | — |
| `<MOD>`-BR-009 | Edge | Create a record whose natural key matches a record in **TENANT_B**. | Allowed — the duplicate guard must be tenant-scoped. A cross-tenant 409 leaks the existence of another tenant's data ⇒ **S1**. | — | — |
| `<MOD>`-BR-010 | Security | Trigger AI features with records present. | Encrypted identifiers and PII patterns are stripped/masked before any model call. | — | — |
| `<MOD>`-BR-011 | Negative | Subscription expired → open the module. | Access blocked; user directed to billing. | — | — |
| `<MOD>`-BR-012 | Business rule | Attach a file on a Drive-enabled tenant. | Stored on Drive; the quota check is bypassed. | — | — |

### 0.6 Shared database validation (run per module — substitute `<table>`)

| TC ID | Validation Point | SQL Query | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| `<MOD>`-DB-001 | Tenant stamping (P1) | `SELECT tenant_id, user_id, title FROM <table> WHERE id = ':record_id';` | `tenant_id = :tenant_a`; title as entered | — | — |
| `<MOD>`-DB-002 | Audit timestamps (P2) | `SELECT created_at IS NOT NULL, updated_at IS NOT NULL, updated_at >= created_at FROM <table> WHERE id = ':record_id';` | `t, t, t` | — | — |
| `<MOD>`-DB-003 | `updated_at` advances on edit | Capture, edit in the UI, re-query. | Strictly greater | — | — |
| `<MOD>`-DB-004 | Soft delete (P3) | `SELECT deleted_at FROM <table> WHERE id = ':record_id';` | Non-null after a UI delete; the row still exists | — | — |
| `<MOD>`-DB-005 | Deleted rows excluded from list counts | `SELECT count(*) FROM <table> WHERE tenant_id = ':tenant_a' AND deleted_at IS NULL;` | Matches the UI count | — | — |
| `<MOD>`-DB-006 | Cross-tenant isolation (P7) | `SELECT count(*) FROM <table> WHERE id = ':record_id' AND tenant_id = ':tenant_b';` | `0` | — | — |
| `<MOD>`-DB-007 | Owner is same-tenant | `SELECT count(*) FROM <table> t JOIN users u ON u.id = t.user_id WHERE t.tenant_id <> u.tenant_id;` | `0` | — | — |
| `<MOD>`-DB-008 | Holder is same-tenant | `SELECT count(*) FROM <table> t JOIN users u ON u.id = t.holder_id WHERE t.tenant_id <> u.tenant_id;` | `0` | — | — |
| `<MOD>`-DB-009 | No row without a tenant | `SELECT count(*) FROM <table> WHERE tenant_id IS NULL;` | `0` | — | — |
| `<MOD>`-DB-010 | Custom fields stored as JSON | `SELECT jsonb_typeof(custom_fields) FROM <table> WHERE id = ':record_id';` | `array` or `object` (consistent within the module) | — | — |
| `<MOD>`-DB-011 | File metadata | `SELECT file_path IS NOT NULL AS has_file, file_size FROM <table> WHERE id = ':record_id';` | `t` and bytes > 0 when a file was attached; `f`/`0` otherwise | — | — |
| `<MOD>`-DB-012 | AI analysis stored as JSON | `SELECT jsonb_typeof(ai_analysis) FROM <table> WHERE id = ':record_id';` | `object` or `null` | — | — |
| `<MOD>`-DB-013 | Audit log per mutation (P4) | `SELECT action, details FROM audit_logs WHERE tenant_id = ':tenant_a' ORDER BY created_at DESC LIMIT 3;` | Entries matching the create/update/delete performed | — | — |
| `<MOD>`-DB-014 | Duplicate guard is tenant-scoped | `SELECT tenant_id, count(*) FROM <table> WHERE <natural key predicate> GROUP BY tenant_id;` | Both tenants may hold a record with the same natural key — one row per tenant | — | — |
| `<MOD>`-DB-015 | Tenant delete cascades | Delete a throwaway tenant, then: `SELECT count(*) FROM <table> WHERE tenant_id = ':tenant_x';` | `0` | — | — |

---

## Section 1 — Tax & Compliance (`TAX`)

**Route:** `/tax-compliance` · **Table:** `tax_compliances` · **Key:** `tax_compliance`
**Mandatory:** Title, Form Type, Assessment Year · **Duplicate key:** form type + assessment year
**Form types:** `ITR` (ITR Filing), `FORM_16` (Form 16/16A), `GST_RETURN` (GST Return), `ADVANCE_TAX` (Advance Tax), `OTHER` (Other Compliance)
**Encrypted:** `acknowledgement_number` · **Money:** `taxable_amount`, `tax_paid` — decimal(15,2)

| TC ID | Category | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|---|
| TAX-FLD-101 | Field | Positive | Save one record for each of the 5 form types. | All saved; each appears under its filter tab. | — | — |
| TAX-FLD-102 | Field | Positive | Assessment Year `2024-25`. | Accepted and displayed as typed. | — | — |
| TAX-FLD-103 | Field | Negative | Assessment Year `abcd` / `2024` / `2024-2025-26`. | Record actual — a malformed AY should be rejected. Absence of validation ⇒ **S3**. | — | — |
| TAX-FLD-104 | Field | Boundary | Assessment Year at 50 / 51 characters. | 50 accepted; 51 rejected. | — | — |
| TAX-FLD-105 | Field | Positive | Acknowledgement Number `123456789012345`. | Saved encrypted; masked in the list; full value on reveal. | — | — |
| TAX-FLD-106 | Field | Edge | Blank Acknowledgement Number. | Stored as NULL, not an empty ciphertext. | — | — |
| TAX-FLD-107 | Field | Boundary | Taxable Amount / Tax Paid: `0`, `0.01`, `9999999999999.99`, and one over precision. | First three accepted exactly; the over-precision value rejected cleanly. | — | — |
| TAX-FLD-108 | Field | Negative | Negative Taxable Amount or Tax Paid. | Rejected. Record actual. | — | — |
| TAX-FLD-109 | Field | Edge | Tax Paid greater than Taxable Amount. | Accepted (legitimate for refunds) — confirm no false validation error. | — | — |
| TAX-FLD-110 | Field | Edge | Filing Date after the Due Date. | Accepted; ideally flagged as a late filing. Record actual. | — | — |
| TAX-BR-101 | Business | Business rule | Create a record with a Due Date 10 days out and open `/follow-up`. | Record actual — confirm whether tax deadlines feed the follow-up screen. | — | — |
| TAX-BR-102 | Business | Business rule | Save the same Form Type + Assessment Year twice. | Second attempt returns the duplicate confirmation; forceSave creates it. | — | — |
| TAX-DB-101 | DB | Encryption (P5) | `SELECT acknowledgement_number ~ '^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$' AS is_ciphertext FROM tax_compliances WHERE id = ':record_id';` | `t` | — | — |
| TAX-DB-102 | DB | Plaintext never stored | `SELECT count(*) FROM tax_compliances WHERE acknowledgement_number = '123456789012345';` | `0` | — | — |
| TAX-DB-103 | DB | Money precision | `SELECT taxable_amount, tax_paid FROM tax_compliances WHERE id = ':record_id';` | Exactly the values entered, 2 decimals | — | — |
| TAX-DB-104 | DB | Form types constrained | `SELECT DISTINCT form_type FROM tax_compliances WHERE tenant_id = ':tenant_a';` | Only `ITR`, `FORM_16`, `GST_RETURN`, `ADVANCE_TAX`, `OTHER` | — | — |
| TAX-DB-105 | DB | Duplicate guard key | `SELECT form_type, assessment_year, count(*) FROM tax_compliances WHERE tenant_id = ':tenant_a' AND deleted_at IS NULL GROUP BY 1,2 HAVING count(*) > 1;` | Only rows deliberately created via forceSave | — | — |
| TAX-DB-106 | DB | Audit details leak check | `SELECT count(*) FROM audit_logs WHERE tenant_id = ':tenant_a' AND details LIKE '%123456789012345%';` | `0` | — | — |

---

## Section 2 — Loans & Debts (`LON`)

**Route:** `/loans-debt` · **Table:** `loans_debts` · **Key:** `loans_debt`
**Mandatory:** Title, Lender Name, Loan Type, Account Number
**Duplicate key:** `account_number_hash` + lender name
**Loan types:** `HOME_LOAN`, `PERSONAL_LOAN`, `VEHICLE_LOAN`, `EDUCATION_LOAN`, `BUSINESS_LOAN`, `CREDIT_CARD_EMI`, `OTHER`
**Status values:** `ACTIVE`, `CLOSED` (Closed/Paid Off), `DEFAULTED`
**Encrypted:** `account_number` · **Blind index:** `account_number_hash`
**Money:** `principal_amount` decimal(15,2), `emi_amount` decimal(12,2), `interest_rate` decimal(6,2)

| TC ID | Category | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|---|
| LON-FLD-101 | Field | Positive | Save one record for each of the 7 loan types. | All saved and filterable. | — | — |
| LON-FLD-102 | Field | Positive | Account Number `12345678901234`. | Saved encrypted; masked in the list; revealed in detail. | — | — |
| LON-FLD-103 | Field | Edge | Account Number with spaces `1234 5678 9012`. | Blind index normalises whitespace — an exact search with either form matches. | — | — |
| LON-FLD-104 | Field | Boundary | Principal Amount `0`, `0.01`, `9999999999999.99`, one over precision. | First three accepted; over-precision rejected cleanly. | — | — |
| LON-FLD-105 | Field | Boundary | EMI Amount `0.01` and `9999999999.99` (precision 12,2). | Both accepted exactly. | — | — |
| LON-FLD-106 | Field | Boundary | Interest Rate `0.00`, `9.75`, `9999.99` (precision 6,2), `10000.00`. | First three accepted; `10000.00` rejected cleanly. | — | — |
| LON-FLD-107 | Field | Negative | Negative principal, EMI or interest rate. | Rejected. Record actual. | — | — |
| LON-FLD-108 | Field | Edge | Interest Rate `7.555` (3 decimals). | Rounded to 2 decimals per scale; record the rounding. | — | — |
| LON-FLD-109 | Field | Edge | Maturity Date earlier than Start Date. | Record actual — should be flagged. | — | — |
| LON-FLD-110 | Field | Positive | Toggle "Has NOC". | Saves independently and re-displays correctly; defaults to `false`. | — | — |
| LON-BR-101 | Business | Business rule | Save the same account number + lender twice. | Duplicate confirmation on the second attempt; forceSave creates it. | — | — |
| LON-BR-102 | Business | Business rule | Save the same account number with a **different** lender. | Allowed without a duplicate prompt (the key is number + lender). | — | — |
| LON-BR-103 | Business | Business rule | Mark a loan `CLOSED` with `has_noc = true`. | Status and NOC flag persist; the loan is visually distinguished from active loans. | — | — |
| LON-BR-104 | Business | Business rule | Set a Maturity Date 10 days out and open `/follow-up`. | Record actual — confirm whether loan maturity feeds the follow-up screen. | — | — |
| LON-DB-101 | DB | Encryption (P5) | `SELECT account_number ~ '^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$' AS is_ciphertext FROM loans_debts WHERE id = ':record_id';` | `t` | — | — |
| LON-DB-102 | DB | Plaintext never stored | `SELECT count(*) FROM loans_debts WHERE account_number = '12345678901234';` | `0` | — | — |
| LON-DB-103 | DB | Blind index (P6) | `SELECT account_number_hash IS NOT NULL AS has_index, account_number_hash <> '12345678901234' AS not_plain FROM loans_debts WHERE id = ':record_id';` | `t`, `t` | — | — |
| LON-DB-104 | DB | Money precision | `SELECT principal_amount, emi_amount, interest_rate FROM loans_debts WHERE id = ':record_id';` | Exactly the values entered at the correct scales | — | — |
| LON-DB-105 | DB | No negative money | `SELECT count(*) FROM loans_debts WHERE tenant_id = ':tenant_a' AND (principal_amount < 0 OR emi_amount < 0 OR interest_rate < 0);` | `0` | — | — |
| LON-DB-106 | DB | Loan types constrained | `SELECT DISTINCT loan_type FROM loans_debts WHERE tenant_id = ':tenant_a';` | Only the 7 documented values | — | — |
| LON-DB-107 | DB | NOC default | Create without touching the toggle, then: `SELECT has_noc FROM loans_debts WHERE id = ':record_id';` | `false` | — | — |
| LON-DB-108 | DB | Duplicate guard is tenant-scoped | Create the same account number + lender in TENANT_B: `SELECT tenant_id, count(*) FROM loans_debts WHERE account_number_hash = ':hash' GROUP BY tenant_id;` | One row per tenant — no cross-tenant 409 | — | — |
| LON-DB-109 | DB | Audit details leak check | `SELECT count(*) FROM audit_logs WHERE tenant_id = ':tenant_a' AND details LIKE '%12345678901234%';` | `0` | — | — |

---

## Section 3 — Wills & Estate (`WIL`)

**Route:** `/wills-estate` · **Table:** `wills_estates` · **Key:** `wills_estate`
**Mandatory:** Title, Document Type, Testator Name · **Duplicate key:** testator + document type
**Document types:** `WILL`, `TRUST_DEED`, `GIFT_DEED`, `POWER_OF_ATTORNEY`, `SUCCESSION_CERT`, `OTHER`
**Registration status:** `REGISTERED`, `UNREGISTERED` (default), `NOTARIZED`, `PENDING`
**Nominees:** stored as jsonb

| TC ID | Category | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|---|
| WIL-FLD-101 | Field | Positive | Save one record for each of the 6 document types. | All saved and filterable. | — | — |
| WIL-FLD-102 | Field | Positive | Set each of the 4 registration statuses. | All saved and displayed with distinct badges. | — | — |
| WIL-FLD-103 | Field | Edge | Save without choosing a registration status. | Defaults to `UNREGISTERED`. | — | — |
| WIL-FLD-104 | Field | Boundary | Testator Name and Executor Name at 255 / 256 characters. | 255 accepted; 256 rejected on each. | — | — |
| WIL-FLD-105 | Field | Positive | Add 3 nominees with names and shares. | All persist in the `nominees` JSON and re-display. | — | — |
| WIL-FLD-106 | Field | Boundary | Add 20 nominees. | All persist; the form remains usable. | — | — |
| WIL-FLD-107 | Field | Edge | Add a nominee with an empty name. | Handled consistently; no `undefined` rendered. | — | — |
| WIL-FLD-108 | Field | Edge | Nominee shares summing to more than 100%. | Record actual — an over-100% allocation should be flagged. | — | — |
| WIL-FLD-109 | Field | Edge | Execution Date in the future. | Record actual — a future execution date should be flagged. | — | — |
| WIL-FLD-110 | Field | Edge | Leave Execution Date and Executor Name blank. | Accepted (both nullable). | — | — |
| WIL-BR-101 | Business | Business rule | Save the same testator + document type twice. | Duplicate confirmation on the second attempt; forceSave creates it. | — | — |
| WIL-BR-102 | Business | Security | Include nominee names and a will document, then run an AI feature. | Nominee PII is masked before any model call. | — | — |
| WIL-DB-101 | DB | Registration status default | Create without a status, then: `SELECT registration_status FROM wills_estates WHERE id = ':record_id';` | `UNREGISTERED` | — | — |
| WIL-DB-102 | DB | Document types constrained | `SELECT DISTINCT document_type FROM wills_estates WHERE tenant_id = ':tenant_a';` | Only the 6 documented values | — | — |
| WIL-DB-103 | DB | Nominees stored as JSON array | `SELECT jsonb_typeof(nominees), jsonb_array_length(nominees) FROM wills_estates WHERE id = ':record_id';` | `array`, count matching the nominees added | — | — |
| WIL-DB-104 | DB | Duplicate guard key | `SELECT testator_name, document_type, count(*) FROM wills_estates WHERE tenant_id = ':tenant_a' AND deleted_at IS NULL GROUP BY 1,2 HAVING count(*) > 1;` | Only rows deliberately created via forceSave | — | — |

---

## Section 4 — Utility Bills (`UTL`)

**Route:** `/utility-bills` · **Table:** `utility_bills` · **Key:** `utility_bills`
**Mandatory:** Title, Provider Name, Service Type, Consumer Number
**Duplicate key:** `consumer_number_hash` + provider name
**Service types:** `ELECTRICITY`, `WATER`, `GAS` (Gas/PNG), `INTERNET` (Internet/Broadband), `MOBILE` (Mobile/Postpaid), `DTH` (DTH/Cable), `MAINTENANCE` (Society Maintenance), `OTHER`
**Encrypted:** `consumer_number` · **Blind index:** `consumer_number_hash`
**Money:** `bill_amount` decimal(12,2) · **Flag:** `is_paid` (default `false`)

| TC ID | Category | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|---|
| UTL-FLD-101 | Field | Positive | Save one record for each of the 8 service types. | All saved and filterable. | — | — |
| UTL-FLD-102 | Field | Positive | Consumer Number `987654321`. | Saved encrypted; masked in the list; revealed in detail. | — | — |
| UTL-FLD-103 | Field | Edge | Consumer Number with spaces. | Blind index normalises whitespace; exact search matches either form. | — | — |
| UTL-FLD-104 | Field | Boundary | Bill Amount `0`, `0.01`, `9999999999.99`, one over precision. | First three accepted exactly; over-precision rejected cleanly. | — | — |
| UTL-FLD-105 | Field | Negative | Negative bill amount. | Rejected. Record actual. | — | — |
| UTL-FLD-106 | Field | Positive | Billing Period `May 2024`. | Accepted and displayed as typed. | — | — |
| UTL-FLD-107 | Field | Boundary | Billing Period at 100 / 101 characters. | 100 accepted; 101 rejected. | — | — |
| UTL-FLD-108 | Field | Positive | Toggle "Paid" on and off. | Persists both ways; the card styling reflects paid vs. unpaid. | — | — |
| UTL-FLD-109 | Field | Edge | Create without touching the Paid toggle. | Defaults to `false` (unpaid). | — | — |
| UTL-FLD-110 | Field | Edge | Due Date in the past with `is_paid = false`. | Displayed as overdue. | — | — |
| UTL-BR-101 | Business | Business rule | Create a bill with a Due Date 10 days out, unpaid, then open `/follow-up`. | Record actual — confirm whether unpaid bills feed the follow-up screen. | — | — |
| UTL-BR-102 | Business | Business rule | Mark that bill as paid and re-check `/follow-up`. | It should no longer be listed as pending. | — | — |
| UTL-BR-103 | Business | Business rule | Save the same consumer number + provider twice. | Duplicate confirmation; forceSave creates it. | — | — |
| UTL-BR-104 | Business | Business rule | Save the same consumer number with a different provider. | Allowed without a prompt. | — | — |
| UTL-DB-101 | DB | Encryption (P5) | `SELECT consumer_number ~ '^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$' AS is_ciphertext FROM utility_bills WHERE id = ':record_id';` | `t` | — | — |
| UTL-DB-102 | DB | Plaintext never stored | `SELECT count(*) FROM utility_bills WHERE consumer_number = '987654321';` | `0` | — | — |
| UTL-DB-103 | DB | Blind index (P6) | `SELECT consumer_number_hash IS NOT NULL AS has_index, consumer_number_hash <> '987654321' AS not_plain FROM utility_bills WHERE id = ':record_id';` | `t`, `t` | — | — |
| UTL-DB-104 | DB | Paid flag default | `SELECT is_paid FROM utility_bills WHERE id = ':record_id';` | `false` when the toggle was untouched | — | — |
| UTL-DB-105 | DB | Money precision | `SELECT bill_amount FROM utility_bills WHERE id = ':record_id';` | Exactly the value entered, 2 decimals | — | — |
| UTL-DB-106 | DB | Service types constrained | `SELECT DISTINCT service_type FROM utility_bills WHERE tenant_id = ':tenant_a';` | Only the 8 documented values | — | — |
| UTL-DB-107 | DB | Overdue-unpaid query matches the UI | `SELECT count(*) FROM utility_bills WHERE tenant_id = ':tenant_a' AND deleted_at IS NULL AND is_paid = false AND due_date < now();` | Matches the number of bills flagged overdue in the UI | — | — |
| UTL-DB-108 | DB | Audit details leak check | `SELECT count(*) FROM audit_logs WHERE tenant_id = ':tenant_a' AND details LIKE '%987654321%';` | `0` | — | — |

---

## Section 5 — Corporate Compliance (`CRP`)

**Route:** `/corporate-compliance` · **Table:** `corporate_compliances` · **Key:** `corporate_compliance`
**Mandatory:** Title, Entity Name, Document Type · **Duplicate key:** entity + document type
**Document types:** `INCORPORATION_CERTIFICATE` (Incorporation), `MOA_AOA` (MOA/AOA), `BOARD_RESOLUTION`, `ANNUAL_RETURN`, `TRADE_LICENSE`, `OTHER`
**Encrypted:** `registration_number`

| TC ID | Category | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|---|
| CRP-FLD-101 | Field | Positive | Save one record for each of the 6 document types. | All saved and filterable. | — | — |
| CRP-FLD-102 | Field | Boundary | Entity Name at 255 / 256 characters. | 255 accepted; 256 rejected. | — | — |
| CRP-FLD-103 | Field | Positive | Registration Number `U72900MH2020PTC123456` (CIN format). | Saved encrypted; masked in the list; revealed in detail. | — | — |
| CRP-FLD-104 | Field | Edge | Blank Registration Number. | Stored as NULL, not an empty ciphertext. | — | — |
| CRP-FLD-105 | Field | Edge | Expiry Date earlier than Filing Date. | Record actual — should be flagged. | — | — |
| CRP-FLD-106 | Field | Edge | Both dates blank. | Accepted (both nullable). | — | — |
| CRP-BR-101 | Business | Business rule | Set an Expiry Date 10 days out (e.g. a trade licence) and open `/follow-up`. | Record actual — confirm whether corporate expiries feed the follow-up screen. | — | — |
| CRP-BR-102 | Business | Business rule | Save the same entity + document type twice. | Duplicate confirmation; forceSave creates it. | — | — |
| CRP-DB-101 | DB | Encryption (P5) | `SELECT registration_number ~ '^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$' AS is_ciphertext FROM corporate_compliances WHERE id = ':record_id';` | `t` | — | — |
| CRP-DB-102 | DB | Plaintext never stored | `SELECT count(*) FROM corporate_compliances WHERE registration_number = 'U72900MH2020PTC123456';` | `0` | — | — |
| CRP-DB-103 | DB | Document types constrained | `SELECT DISTINCT document_type FROM corporate_compliances WHERE tenant_id = ':tenant_a';` | Only the 6 documented values | — | — |
| CRP-DB-104 | DB | Duplicate guard key | `SELECT entity_name, document_type, count(*) FROM corporate_compliances WHERE tenant_id = ':tenant_a' AND deleted_at IS NULL GROUP BY 1,2 HAVING count(*) > 1;` | Only rows deliberately created via forceSave | — | — |
| CRP-DB-105 | DB | Audit details leak check | `SELECT count(*) FROM audit_logs WHERE tenant_id = ':tenant_a' AND details LIKE '%U72900MH2020PTC123456%';` | `0` | — | — |

---

## Section 6 — Employment & Payroll (`EMP`)

**Route:** `/employment-payroll` · **Table:** `employment_payrolls` · **Key:** `employment_payroll`
**Mandatory:** Title, Employer Name, Employee Name, Document Type
**Duplicate key:** employee name + document type — the 409 message is
*"An employment record for this employee and document type already exists."*
**Document types:** `OFFER_LETTER`, `CONTRACT` (Employment Contract), `PAYSLIP`, `EXPERIENCE_LETTER`, `RELIEVING_LETTER`, `OTHER`
**No encrypted column** in this table

| TC ID | Category | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|---|
| EMP-FLD-101 | Field | Positive | Save one record for each of the 6 document types. | All saved and filterable. | — | — |
| EMP-FLD-102 | Field | Boundary | Employer Name, Employee Name and Designation at 255 / 256 characters. | 255 accepted; 256 rejected on each. | — | — |
| EMP-FLD-103 | Field | Edge | Leave Designation and Issue Date blank. | Accepted (both nullable). | — | — |
| EMP-FLD-104 | Field | Edge | Issue Date in the future. | Record actual — a future issue date should be flagged. | — | — |
| EMP-FLD-105 | Field | Edge | Employee Name differing only in case from an existing record (`Ravi` vs `ravi`) with the same document type. | Record actual — a case-sensitive duplicate check lets near-duplicates through ⇒ **S3**. | — | — |
| EMP-FLD-106 | Field | Edge | Employee Name with trailing whitespace vs. the same name without. | Record actual — same near-duplicate concern. | — | — |
| EMP-BR-101 | Business | Business rule | Save the same employee + document type twice. | Second attempt returns *"An employment record for this employee and document type already exists."* with a confirmation prompt. | — | — |
| EMP-BR-102 | Business | Business rule | Confirm "Save anyway" on that prompt. | Both records exist — legitimate for e.g. 12 monthly payslips. | — | — |
| EMP-BR-103 | Business | Business rule | Save 12 payslips for the same employee (one per month, distinct titles). | Each requires the duplicate confirmation. Record whether this is acceptable UX for a monthly document ⇒ potential **S3** usability defect. | — | — |
| EMP-BR-104 | Business | Security | Attach a payslip PDF containing salary and PAN, then run an AI feature. | PAN and salary identifiers are masked before any model call. | — | — |
| EMP-DB-101 | DB | Fields persisted | `SELECT employer_name, employee_name, document_type, designation, issue_date FROM employment_payrolls WHERE id = ':record_id';` | Exactly the values entered | — | — |
| EMP-DB-102 | DB | Document types constrained | `SELECT DISTINCT document_type FROM employment_payrolls WHERE tenant_id = ':tenant_a';` | Only the 6 documented values | — | — |
| EMP-DB-103 | DB | Duplicate guard key | `SELECT employee_name, document_type, count(*) FROM employment_payrolls WHERE tenant_id = ':tenant_a' AND deleted_at IS NULL GROUP BY 1,2 HAVING count(*) > 1;` | Only rows deliberately created via forceSave | — | — |
| EMP-DB-104 | DB | Duplicate guard is tenant-scoped | Create the same employee + type in TENANT_B: `SELECT tenant_id, count(*) FROM employment_payrolls WHERE employee_name = 'Ravi Sharma' AND document_type = 'PAYSLIP' GROUP BY tenant_id;` | One row per tenant — no cross-tenant 409 | — | — |
| EMP-DB-105 | DB | Audit action recorded | `SELECT action FROM audit_logs WHERE tenant_id = ':tenant_a' AND action = 'EMPLOYMENT_PAYROLL_CREATED' ORDER BY created_at DESC LIMIT 1;` | Row present | — | — |
| EMP-DB-106 | DB | Custom fields shape | `SELECT jsonb_typeof(custom_fields) FROM employment_payrolls WHERE id = ':record_id';` | `object` (this module defaults `custom_fields` to `{}`) — note the difference from modules that default to `[]` | — | — |

---

## Section 7 — Cross-Module End-to-End Workflows

| TC ID | Workflow | Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| ENT-E2E-001 | Full enterprise sweep | Create one record in each of the six modules with all mandatory fields and a file attachment. | All six succeed; the dashboard counters for all six increment; storage usage grows by the sum of the six file sizes. | — | — |
| ENT-E2E-002 | Duplicate-guard sweep | For each module, save the same natural key twice, cancel once and force-save once. | All six modules return a 409 confirmation prompt; cancel creates nothing; force-save creates the record. | — | — |
| ENT-E2E-003 | Encryption sweep | For the four modules with an encrypted identifier (Tax, Loans, Utility, Corporate), enter a known identifier, then inspect list masking, detail reveal and the raw DB row. | Masked in list, correct on reveal, ciphertext at rest, and absent from `audit_logs.details` in all four. | — | — |
| ENT-E2E-004 | Blind-index search sweep | For Loans and Utility Bills, search by the full encrypted identifier and by a substring. | Full value matches exactly; substring returns nothing. | — | — |
| ENT-E2E-005 | Isolation sweep | Create one record per module in TENANT_A, capture all six ids, then attempt view/edit/delete on each as ADMIN_B and run a global search. | All 18 attempts fail with 403/404; nothing disclosed. | — | — |
| ENT-E2E-006 | Soft-delete sweep | Delete one record from each module, then check lists, search, dashboard counts and the DB. | Each row carries a `deleted_at`; none appear anywhere in the UI. | — | — |
| ENT-E2E-007 | Permission sweep | Give USER_A2 `canView` only on all six keys, then attempt every mutation. | All mutations refused across all six modules. | — | — |
| ENT-E2E-008 | Backup completeness | Populate all six modules, then run the Backup export. | The export JSON contains keys for `taxCompliances`, `willsEstates`, `loansDebts`, `utilityBills`, `corporateCompliances` and `employmentPayrolls`, each with the expected row count. | — | — |
| ENT-E2E-009 | Quota interaction | Fill the tenant's storage quota, then attempt a file attachment in each module. | All six reject with the same quota message; no partial rows; no orphan files. | — | — |
