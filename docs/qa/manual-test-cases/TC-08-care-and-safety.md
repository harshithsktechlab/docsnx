# TC-08 — Care & Safety: Medical Records · LIC & Mediclaim · Important Contacts

**Prefixes:** `MED`, `LIC`, `EMC`
**Routes:** `/medical`, `/lic-mediclaim`, `/important-contacts`
**Tables:** `medical_records`, `lic_mediclaims`, `emergency_contacts`

---

# PART A — Medical Records (`MED`)

## Module Reference

| Aspect | Detail |
|---|---|
| Route / table / key | `/medical` · `medical_records` · `medical` |
| Fields | Patient Name*, Record Type*, Date*, Doctor Name, Hospital Name, Details, File, Custom Fields[], Assigned Member/Holder |
| Record types | `prescription` (Prescriptions), `lab_report` (Lab Reports), `bill` (Bills), `other` |
| Client validation | "Patient Name and Date are required" |
| AI | AI Auto-fill from an uploaded report/prescription |
| Soft delete | Yes (`deleted_at`) |

## A1. UI Validation

| TC ID | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| MED-UI-001 | Positive | Open `/medical` on an empty tenant. | Empty state with an "Add Record" CTA. | — | — |
| MED-UI-002 | Positive | Open `/medical` with records. | Cards show patient name, record-type badge, date, doctor, hospital and a file indicator. | — | — |
| MED-UI-003 | Positive | Inspect the record-type badges. | Prescription = sky, Lab Report = emerald, Bill = amber, Other = violet — colour-coded and consistent. | — | — |
| MED-UI-004 | Positive | Use the record-type filter tabs (All / Prescriptions / Lab Reports / Bills / Other). | Filters correctly; the active tab is highlighted. | — | — |
| MED-UI-005 | Positive | Search "by patient, doctor, description". | Filters live across patient name, doctor and details. | — | — |
| MED-UI-006 | Positive | Open the Add dialog. | Fields: Patient Name, Record Type select, Date, Doctor Name, Hospital Name, Details textarea, file picker, AI Auto-fill, Custom Fields. | — | — |
| MED-UI-007 | Negative | Click AI Auto-fill without selecting a file. | Toast "Please select or upload a document file first to use AI Auto-fill." | — | — |
| MED-UI-008 | Positive | Run AI Auto-fill on a scanned prescription. | Fields populate from the extracted data; all remain editable before save. | — | — |
| MED-UI-009 | Negative | Force an AI failure. | Toast "Network error calling AI Scan endpoint"; nothing is saved. | — | — |
| MED-UI-010 | Positive | Save the form. | Spinner on the button; success toast; dialog closes; list refreshes. | — | — |
| MED-UI-011 | Positive | Click Edit. | Dialog pre-filled with every stored value including custom fields. | — | — |
| MED-UI-012 | Positive | Click Delete. | Confirmation dialog naming the record; on failure a toast "Network error deleting record" and the row stays. | — | — |
| MED-UI-013 | Positive | Preview an attached report (PDF/image). | Inline preview renders; a Download action is available. | — | — |
| MED-UI-014 | Positive | Share / Print a medical record. | Output includes patient, type, date, doctor, hospital, details and custom fields. | — | — |
| MED-UI-015 | Positive | View at 375px. | Cards stack; no horizontal page scroll; buttons remain tappable. | — | — |
| MED-UI-016 | Positive | As a view-only user, open `/medical`. | Add/Edit/Delete hidden or disabled. | — | — |

## A2. Field Validation

| TC ID | Field | Type | Input / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|---|
| MED-FLD-001 | Patient Name + Date | Negative | Submit both blank. | "Please fill in required fields (Patient Name and Date)". | — | — |
| MED-FLD-002 | Patient Name | Negative | Blank with a date filled. | Rejected. | — | — |
| MED-FLD-003 | Patient Name | Boundary | 255 / 256 characters. | 255 accepted; 256 rejected. | — | — |
| MED-FLD-004 | Patient Name | Edge | Unicode `सुनील (स्वतः)`. | Stored and rendered correctly; searchable. | — | — |
| MED-FLD-005 | Patient Name | Edge | `<script>alert(1)</script>`. | Rendered as literal text everywhere. | — | — |
| MED-FLD-006 | Record Type | Positive | Each of prescription / lab_report / bill / other. | Saved; badge colour matches. | — | — |
| MED-FLD-007 | Record Type | Edge | Save with no type chosen. | Defaults to a valid type (record actual); the record still filters correctly. | — | — |
| MED-FLD-008 | Date | Negative | Blank date. | Rejected — date is mandatory. | — | — |
| MED-FLD-009 | Date | Edge | A future date. | Record actual — a future consultation date should be rejected or flagged. | — | — |
| MED-FLD-010 | Date | Boundary | `1900-01-01` and today. | Both accepted and rendered without `Invalid Date`. | — | — |
| MED-FLD-011 | Date | Edge | Change the browser timezone and re-open the record. | The displayed date matches what was entered — no ±1-day drift. | — | — |
| MED-FLD-012 | Doctor / Hospital | Boundary | 255 / 256 characters each. | 255 accepted; 256 rejected. | — | — |
| MED-FLD-013 | Doctor / Hospital | Edge | Leave both blank. | Accepted (both nullable). | — | — |
| MED-FLD-014 | Details | Boundary | 10 000-character description. | Accepted (text) and fully retrievable. | — | — |
| MED-FLD-015 | Details | Edge | Multi-line text. | Line breaks preserved. | — | — |
| MED-FLD-016 | File | Positive | Attach a PDF and a JPG. | Both stored; `file_size` recorded; both previewable/downloadable. | — | — |
| MED-FLD-017 | File | Edge | Save with no file. | Accepted (`file_path` nullable, `file_size = 0`). | — | — |
| MED-FLD-018 | File | Boundary | Attach a file exceeding the remaining storage quota. | Rejected with the quota message; no record created. | — | — |
| MED-FLD-019 | Custom Fields | Positive | Add pairs like "Blood Sugar" / "110 mg/dL". | Saved and shown on the record and in Print. | — | — |
| MED-FLD-020 | Holder | Negative | Assign to a user id from another tenant (manipulated). | Rejected; no cross-tenant holder. | — | — |
| MED-FLD-021 | All | Edge | Double-click Save. | Exactly one record created. | — | — |

## A3. Business Rules

| TC ID | Type | Rule / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| MED-BR-001 | Positive | Create a record. | `tenant_id` from the session; `user_id` = creator; `holder_id` as selected. | — | — |
| MED-BR-002 | Negative | View-only user attempts add/edit/delete. | All refused. | — | — |
| MED-BR-003 | Negative | ADMIN_B attempts to open/edit/delete a TENANT_A medical record id. | 403/404; record unchanged. | — | — |
| MED-BR-004 | Positive | Delete a record. | Soft-deleted (`deleted_at` set); removed from lists, search and dashboard counts. | — | — |
| MED-BR-005 | Positive | Create/edit/delete, then check `/audit-logs`. | One entry per mutation naming the record. | — | — |
| MED-BR-006 | Security | Run AI Auto-fill on a report containing an Aadhaar/phone/email. | The AI payload is masked — no raw identifiers leave the platform. | — | — |
| MED-BR-007 | Business rule | AI Auto-fill with zero credits and no tenant key. | Blocked with an insufficient-credits message; no partial record; no credits deducted. | — | — |
| MED-BR-008 | Business rule | AI Auto-fill succeeds. | `ai_credits_balance` drops by the record-analysis cost; a `tenant_ai_usages` row is written. | — | — |
| MED-BR-009 | Business rule | Attach a file to a record on a Drive-enabled tenant. | File is stored on Drive; the quota check is bypassed. | — | — |
| MED-BR-010 | Negative | Subscription expired → open `/medical`. | Blocked; user directed to billing. | — | — |

## A4. Database Validation

| TC ID | Validation Point | SQL Query | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| MED-DB-001 | Tenant stamping (P1) | `SELECT tenant_id, user_id, patient_name, record_type FROM medical_records WHERE id = ':record_id';` | `tenant_id = :tenant_a`; values as entered | — | — |
| MED-DB-002 | Date persisted correctly | `SELECT date FROM medical_records WHERE id = ':record_id';` | Matches the date chosen in the UI | — | — |
| MED-DB-003 | Record type constrained | `SELECT DISTINCT record_type FROM medical_records WHERE tenant_id = ':tenant_a';` | Only `prescription`, `lab_report`, `bill`, `other` | — | — |
| MED-DB-004 | File metadata recorded | `SELECT file_path IS NOT NULL AS has_file, file_size FROM medical_records WHERE id = ':record_id';` | `t` and a byte count > 0 when a file was attached | — | — |
| MED-DB-005 | Custom fields as JSON array | `SELECT jsonb_typeof(custom_fields), jsonb_array_length(custom_fields) FROM medical_records WHERE id = ':record_id';` | `array`, count matching the pairs entered | — | — |
| MED-DB-006 | Audit timestamps (P2) | `SELECT created_at IS NOT NULL, updated_at IS NOT NULL, updated_at >= created_at FROM medical_records WHERE id = ':record_id';` | `t, t, t` | — | — |
| MED-DB-007 | Soft delete (P3) | `SELECT deleted_at FROM medical_records WHERE id = ':record_id';` | Non-null timestamp; row still present | — | — |
| MED-DB-008 | Deleted rows excluded from list counts | `SELECT count(*) FROM medical_records WHERE tenant_id = ':tenant_a' AND deleted_at IS NULL;` | Matches the UI count | — | — |
| MED-DB-009 | Holder is same-tenant | `SELECT count(*) FROM medical_records m JOIN users u ON u.id = m.holder_id WHERE m.tenant_id <> u.tenant_id;` | `0` | — | — |
| MED-DB-010 | Cross-tenant isolation (P7) | `SELECT count(*) FROM medical_records WHERE id = ':record_id' AND tenant_id = ':tenant_b';` | `0` | — | — |
| MED-DB-011 | Audit log per mutation (P4) | `SELECT action, details FROM audit_logs WHERE tenant_id = ':tenant_a' ORDER BY created_at DESC LIMIT 3;` | Entries for the create/update/delete just performed | — | — |
| MED-DB-012 | Long details untruncated | `SELECT length(details) FROM medical_records WHERE id = ':record_id';` | `10000` for the boundary case | — | — |
| MED-DB-013 | No row without a tenant | `SELECT count(*) FROM medical_records WHERE tenant_id IS NULL;` | `0` | — | — |

---

# PART B — LIC & Mediclaim (`LIC`)

## Module Reference

| Aspect | Detail |
|---|---|
| Route / table / key | `/lic-mediclaim` · `lic_mediclaims` · `lic_mediclaim` |
| Required fields (server) | Policy Type*, Company Name*, Policy Name*, **Policy Number***, Insured Person*, Sum Assured*, Premium Amount*, Premium Due Date* — missing any ⇒ "Missing required policy fields" |
| Optional | Expiry Date, File, Custom Fields[], Holder |
| Policy types | `lic` (LIC / Life Insurance), `mediclaim` (Health Insurance / Mediclaim) |
| Encryption | `policy_number` is **encrypted at rest**; `policy_number_hash` is a deterministic blind index; the list view returns the number **masked** (`••••1234`) |
| AI | An AI analysis of the policy is generated and stored in `ai_analysis` on create |
| Numeric precision | `sum_assured` decimal(15,2); `premium_amount` decimal(12,2) |

## B1. UI Validation

| TC ID | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| LIC-UI-001 | Positive | Open `/lic-mediclaim` empty and populated. | Empty state with CTA; populated view shows company, policy name, insured person, masked policy number, sum assured, premium and due date. | — | — |
| LIC-UI-002 | Positive | Inspect the policy number in the list. | Masked (e.g. `••••6789`), never the full number. | — | — |
| LIC-UI-003 | Positive | Open the record detail/edit view. | Full policy number is shown (single-record reveal). | — | — |
| LIC-UI-004 | Positive | Use the policy-type filter. | Filters to LIC or Mediclaim correctly. | — | — |
| LIC-UI-005 | Positive | Search "company, policy name, insured". | Live filtering across those fields. | — | — |
| LIC-UI-006 | Edge | Search using the **full policy number**. | Returns the matching record via the blind index (exact match). A partial/substring policy-number search is expected NOT to match — record actual. | — | — |
| LIC-UI-007 | Positive | Open the Add dialog. | Policy Type select (placeholder "Select Policy Type"), Company, Policy Name, Policy Number, Insured Person, Sum Assured, Premium Amount, Premium Due Date, Expiry Date, file, Custom Fields, Holder. | — | — |
| LIC-UI-008 | Positive | Save a valid policy. | Spinner; success toast; list refreshes; an AI analysis section appears on the record. | — | — |
| LIC-UI-009 | Positive | View the AI analysis on a saved policy. | Renders readable insight text; no raw JSON dump; no policy number in clear text if masking applies. | — | — |
| LIC-UI-010 | Positive | View a policy whose premium is due within 15 days. | Highlighted as due; also appears on `/follow-up`. | — | — |
| LIC-UI-011 | Positive | Edit / Delete a policy. | Edit pre-fills all fields; Delete asks for confirmation. | — | — |
| LIC-UI-012 | Positive | View at 375px. | Cards stack; long numbers wrap; no horizontal page scroll. | — | — |

## B2. Field Validation

| TC ID | Field | Type | Input / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|---|
| LIC-FLD-001 | All required | Negative | Submit with all fields blank. | "Missing required policy fields"; no row created. | — | — |
| LIC-FLD-002 | Each required field | Negative | Omit exactly one required field at a time (8 runs). | Each run is rejected with the same message; no partial rows. | — | — |
| LIC-FLD-003 | Policy Type | Positive | `lic` then `mediclaim`. | Both saved and filterable. | — | — |
| LIC-FLD-004 | Company Name | Boundary | 255 / 256 characters. | 255 accepted; 256 rejected. | — | — |
| LIC-FLD-005 | Policy Number | Positive | `123456789`. | Saved encrypted; masked in the list; full value on reveal. | — | — |
| LIC-FLD-006 | Policy Number | Edge | Number with spaces `1234 5678 9012`. | Accepted; the blind index normalises whitespace so an exact search with or without spaces finds it. | — | — |
| LIC-FLD-007 | Policy Number | Edge | Two policies with the **same** number. | Both stored; both produce the identical `policy_number_hash` (deterministic index) — confirm no unique-constraint crash. | — | — |
| LIC-FLD-008 | Policy Number | Boundary | 1-character and 500-character values. | Both handled without a crash; reveal returns the exact value. | — | — |
| LIC-FLD-009 | Insured Person | Boundary | 255 / 256 characters. | 255 accepted; 256 rejected. | — | — |
| LIC-FLD-010 | Sum Assured | Positive | `500000`. | Stored as `500000.00`; displayed formatted. | — | — |
| LIC-FLD-011 | Sum Assured | Boundary | `0`, `0.01`, `9999999999999.99` (13 int + 2 dec = precision 15). | All accepted and stored exactly. | — | — |
| LIC-FLD-012 | Sum Assured | Boundary | `99999999999999.99` (exceeds precision 15,2). | Rejected with a clear message — not a 500 error or a silently truncated value. | — | — |
| LIC-FLD-013 | Sum Assured | Negative | `-1000`. | Rejected — a negative sum assured is invalid. Record actual; silent acceptance ⇒ **S2**. | — | — |
| LIC-FLD-014 | Sum Assured | Negative | `abc` / `12,00,000` (with separators). | Rejected or normalised; must not persist as `NaN` or `0`. | — | — |
| LIC-FLD-015 | Sum Assured | Edge | `1000.555` (3 decimals). | Rounded to 2 decimals per the column scale; record the rounding behaviour. | — | — |
| LIC-FLD-016 | Premium Amount | Boundary | `0`, `0.01`, `9999999999.99` (precision 12,2). | Accepted; one order of magnitude above is rejected cleanly. | — | — |
| LIC-FLD-017 | Premium Amount | Negative | Negative value. | Rejected. | — | — |
| LIC-FLD-018 | Premium Due Date | Positive | A future date. | Saved; drives the follow-up alert. | — | — |
| LIC-FLD-019 | Premium Due Date | Edge | A past date. | Accepted; shown as overdue in follow-ups. | — | — |
| LIC-FLD-020 | Expiry Date | Edge | Expiry **earlier** than the premium due date. | Record actual — an inconsistent pair should be flagged. | — | — |
| LIC-FLD-021 | Expiry Date | Edge | Blank. | Accepted (nullable). | — | — |
| LIC-FLD-022 | File | Boundary | Attach a file that breaches the storage quota. | Rejected with the quota message; no row created. | — | — |
| LIC-FLD-023 | Custom Fields | Positive | Add "Agent Name" / value pairs. | Saved and displayed. | — | — |
| LIC-FLD-024 | All | Edge | Double-click Save. | Exactly one policy created and only one AI analysis charged. | — | — |

## B3. Business Rules

| TC ID | Type | Rule / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| LIC-BR-001 | Security | Save a policy, then inspect the DB row. | `policy_number` is ciphertext; the plaintext number appears nowhere in the row. | — | — |
| LIC-BR-002 | Security | Inspect the list network payload. | The policy number is masked and `policy_number_hash` is stripped from the response. | — | — |
| LIC-BR-003 | Positive | Reveal the record and compare with the value entered. | Byte-for-byte identical. | — | — |
| LIC-BR-004 | Business rule | Create a policy and check `ai_analysis`. | Populated with the generated analysis; the record still saves if AI is unavailable (degrades gracefully rather than blocking the save). | — | — |
| LIC-BR-005 | Security | Create a policy with a full policy number and verify the AI request payload. | The number is stripped/masked before being sent to the model. | — | — |
| LIC-BR-006 | Business rule | Create a policy with AI credits at zero. | Record actual: either the save succeeds without analysis, or it is blocked with a credit message — it must not fail with a 500. | — | — |
| LIC-BR-007 | Business rule | Set a premium due date 10 days out and open `/follow-up`. | The policy appears under renewals with the correct days-remaining count. | — | — |
| LIC-BR-008 | Business rule | Set a premium due date 30 days out. | It does **not** appear in follow-ups (outside the 15-day threshold). | — | — |
| LIC-BR-009 | Business rule | Set a premium due date in the past. | Shown as overdue with the correct "overdue by N days" wording. | — | — |
| LIC-BR-010 | Negative | ADMIN_B attempts to view/edit/delete a TENANT_A policy id. | 403/404; the record is unchanged. | — | — |
| LIC-BR-011 | Positive | Delete a policy. | Soft-deleted; removed from lists, search, follow-ups and dashboard counts. | — | — |
| LIC-BR-012 | Positive | Create/edit/delete and check `/audit-logs`. | One entry per mutation. **Verify the audit `details` text does not embed the full policy number** — if it does, raise **S2**. | — | — |
| LIC-BR-013 | Negative | View-only user attempts add/edit/delete. | All refused. | — | — |

## B4. Database Validation

| TC ID | Validation Point | SQL Query | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| LIC-DB-001 | Tenant stamping (P1) | `SELECT tenant_id, policy_type, company_name, policy_name, insured_person FROM lic_mediclaims WHERE id = ':record_id';` | `tenant_id = :tenant_a`; values as entered | — | — |
| LIC-DB-002 | Policy number encrypted (P5) | `SELECT policy_number ~ '^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$' AS is_ciphertext FROM lic_mediclaims WHERE id = ':record_id';` | `t` | — | — |
| LIC-DB-003 | Policy number plaintext never stored | `SELECT count(*) FROM lic_mediclaims WHERE policy_number = '123456789';` | `0` | — | — |
| LIC-DB-004 | Blind index populated and not plaintext (P6) | `SELECT policy_number_hash IS NOT NULL AS has_index, policy_number_hash <> '123456789' AS not_plain FROM lic_mediclaims WHERE id = ':record_id';` | `t`, `t` | — | — |
| LIC-DB-005 | Blind index is deterministic | Create two policies with the same number, then: `SELECT count(DISTINCT policy_number_hash) FROM lic_mediclaims WHERE tenant_id = ':tenant_a' AND policy_name IN ('DupA','DupB');` | `1` | — | — |
| LIC-DB-006 | Ciphertext is non-deterministic | Same two records: `SELECT count(DISTINCT policy_number) FROM lic_mediclaims WHERE tenant_id = ':tenant_a' AND policy_name IN ('DupA','DupB');` | `2` | — | — |
| LIC-DB-007 | Whitespace-normalised index | Save `1234 5678` and `12345678` as two policies, then compare their `policy_number_hash`. | Identical hashes | — | — |
| LIC-DB-008 | Monetary precision preserved | `SELECT sum_assured, premium_amount FROM lic_mediclaims WHERE id = ':record_id';` | Exactly the values entered, to 2 decimal places, no rounding drift | — | — |
| LIC-DB-009 | No negative monetary values | `SELECT count(*) FROM lic_mediclaims WHERE tenant_id = ':tenant_a' AND (sum_assured < 0 OR premium_amount < 0);` | `0` | — | — |
| LIC-DB-010 | AI analysis stored as JSON | `SELECT jsonb_typeof(ai_analysis) FROM lic_mediclaims WHERE id = ':record_id';` | `object` (or `null` if AI was unavailable) | — | — |
| LIC-DB-011 | AI analysis contains no raw policy number | `SELECT count(*) FROM lic_mediclaims WHERE ai_analysis::text LIKE '%123456789%';` | `0` | — | — |
| LIC-DB-012 | Dates stored correctly | `SELECT premium_due_date, expiry_date FROM lic_mediclaims WHERE id = ':record_id';` | Match the dates entered | — | — |
| LIC-DB-013 | Audit timestamps (P2) | `SELECT created_at IS NOT NULL, updated_at IS NOT NULL, updated_at >= created_at FROM lic_mediclaims WHERE id = ':record_id';` | `t, t, t` | — | — |
| LIC-DB-014 | Soft delete (P3) | `SELECT deleted_at FROM lic_mediclaims WHERE id = ':record_id';` | Non-null after a UI delete | — | — |
| LIC-DB-015 | Cross-tenant isolation (P7) | `SELECT count(*) FROM lic_mediclaims WHERE id = ':record_id' AND tenant_id = ':tenant_b';` | `0` | — | — |
| LIC-DB-016 | Follow-up threshold matches the DB | `SELECT count(*) FROM lic_mediclaims WHERE tenant_id = ':tenant_a' AND deleted_at IS NULL AND premium_due_date <= now() + interval '15 days';` | Equals the number of policy renewals shown on `/follow-up` | — | — |
| LIC-DB-017 | Audit details do not leak the number | `SELECT count(*) FROM audit_logs WHERE tenant_id = ':tenant_a' AND details LIKE '%123456789%';` | `0` — a non-zero result is a **S2** secret-leak defect | — | — |
| LIC-DB-018 | No row without a tenant | `SELECT count(*) FROM lic_mediclaims WHERE tenant_id IS NULL;` | `0` | — | — |

---

# PART C — Important Contacts (`EMC`)

## Module Reference

| Aspect | Detail |
|---|---|
| Route / table / key | `/important-contacts` · `emergency_contacts` · `emergency_contacts` |
| Required fields (server) | Name*, Role*, Phone Number* — otherwise "Missing required fields: name, role, or phoneNumber" |
| Optional | Email, Address, Notes |
| Scope | Tenant-wide (no `user_id`/`holder_id`, no `is_global` flag) — visible to the all members |
| Soft delete | **No** `deleted_at` column — deletion is a hard delete |

## C1. UI Validation

| TC ID | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| EMC-UI-001 | Positive | Open `/important-contacts` empty and populated. | Empty state with CTA; populated view shows name, role badge, phone (click-to-call), email, address and notes. | — | — |
| EMC-UI-002 | Positive | Click the phone number on a mobile viewport. | Initiates a `tel:` dial action. | — | — |
| EMC-UI-003 | Positive | Click the email address. | Opens a `mailto:` compose action. | — | — |
| EMC-UI-004 | Positive | Search "by name, role, phone, details". | Live filtering across all four. | — | — |
| EMC-UI-005 | Positive | Open the Add dialog. | Name, Role, Phone Number, Email, Address, Notes fields with the documented placeholders. | — | — |
| EMC-UI-006 | Positive | Save a valid contact. | Success toast; list refreshes; the contact appears. | — | — |
| EMC-UI-007 | Positive | Edit / Delete a contact. | Edit pre-fills all fields; Delete asks for confirmation first. | — | — |
| EMC-UI-008 | Positive | View at 375px. | Cards stack; phone/email remain tappable; no horizontal page scroll. | — | — |
| EMC-UI-009 | Positive | As a view-only user, open the module. | Add/Edit/Delete hidden or disabled; contacts still readable (important in an emergency). | — | — |

## C2. Field Validation

| TC ID | Field | Type | Input / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|---|
| EMC-FLD-001 | All required | Negative | Submit with Name, Role and Phone all blank. | "Missing required fields: name, role, or phoneNumber". | — | — |
| EMC-FLD-002 | Name | Negative | Blank name, role and phone filled. | Rejected. | — | — |
| EMC-FLD-003 | Role | Negative | Blank role. | Rejected. | — | — |
| EMC-FLD-004 | Phone | Negative | Blank phone. | Rejected. | — | — |
| EMC-FLD-005 | Name | Boundary | 255 / 256 characters. | 255 accepted; 256 rejected. | — | — |
| EMC-FLD-006 | Role | Boundary | 100 / 101 characters. | 100 accepted; 101 rejected (column limit 100). | — | — |
| EMC-FLD-007 | Phone | Positive | `+91 98765 43210`. | Accepted with spaces and country code preserved. | — | — |
| EMC-FLD-008 | Phone | Boundary | 50 / 51 characters. | 50 accepted; 51 rejected. | — | — |
| EMC-FLD-009 | Phone | Negative | Alphabetic `not-a-number`. | Record actual — a non-numeric phone should be rejected; acceptance ⇒ **S3**. | — | — |
| EMC-FLD-010 | Email | Positive | `doctor@hospital.com`. | Accepted; renders as a mailto link. | — | — |
| EMC-FLD-011 | Email | Negative | `notanemail`. | Record actual — an invalid email should be rejected. | — | — |
| EMC-FLD-012 | Email | Edge | Blank. | Accepted (nullable). | — | — |
| EMC-FLD-013 | Address / Notes | Boundary | 5 000-character values. | Accepted (text columns) and fully retrievable. | — | — |
| EMC-FLD-014 | Notes | Edge | Multi-line notes. | Line breaks preserved. | — | — |
| EMC-FLD-015 | All | Edge | `<script>alert(1)</script>` in Name and Notes. | Rendered as literal text. | — | — |
| EMC-FLD-016 | All | Edge | Create two contacts with identical details. | Both created (duplicates allowed) and independently editable. | — | — |
| EMC-FLD-017 | All | Edge | Double-click Save. | Exactly one contact created. | — | — |

## C3. Business Rules

| TC ID | Type | Rule / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| EMC-BR-001 | Positive | ADMIN_A creates a contact; QA Child (with `canView`) logs in. | The contact is visible to QA Child — important contacts are tenant-wide. | — | — |
| EMC-BR-002 | Negative | User with no `emergency_contacts` permission row opens the module. | Access denied; nav entry hidden. | — | — |
| EMC-BR-003 | Negative | ADMIN_B attempts to view/edit/delete a TENANT_A contact id. | 403/404; contact unchanged. | — | — |
| EMC-BR-004 | Positive | Delete a contact. | Removed from the list; because the table has no `deleted_at`, the row is hard-deleted. | — | — |
| EMC-BR-005 | Positive | Create/edit/delete and check `/audit-logs`. | One entry per mutation. | — | — |
| EMC-BR-006 | Business rule | Include an important contact in the Backup export. | Present under `emergencyContacts` in the exported JSON. | — | — |
| EMC-BR-007 | Security | Trigger an AI feature with contacts present. | Phone numbers and emails are masked in the AI payload. | — | — |
| EMC-BR-008 | Negative | Subscription expired → open the module. | Access blocked. | — | — |

## C4. Database Validation

| TC ID | Validation Point | SQL Query | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| EMC-DB-001 | Tenant stamping (P1) | `SELECT tenant_id, name, role, phone_number FROM emergency_contacts WHERE id = ':record_id';` | `tenant_id = :tenant_a`; values as entered | — | — |
| EMC-DB-002 | Optional fields nullable | `SELECT email, address, notes FROM emergency_contacts WHERE id = ':record_id';` | `NULL` where left blank — never the string `"null"` or `""` masquerading as data | — | — |
| EMC-DB-003 | Audit timestamps (P2) | `SELECT created_at IS NOT NULL, updated_at IS NOT NULL, updated_at >= created_at FROM emergency_contacts WHERE id = ':record_id';` | `t, t, t` | — | — |
| EMC-DB-004 | Hard delete (no soft-delete column) | Delete via the UI, then: `SELECT count(*) FROM emergency_contacts WHERE id = ':record_id';` | `0` | — | — |
| EMC-DB-005 | Cross-tenant isolation (P7) | `SELECT count(*) FROM emergency_contacts WHERE id = ':record_id' AND tenant_id = ':tenant_b';` | `0` | — | — |
| EMC-DB-006 | Tenant-wide scope (no per-user column) | `SELECT column_name FROM information_schema.columns WHERE table_name = 'emergency_contacts';` | No `user_id`, `holder_id` or `is_global` column — confirms the tenant-wide design | — | — |
| EMC-DB-007 | Field lengths enforced | `SELECT max(length(name)) AS n, max(length(role)) AS r, max(length(phone_number)) AS p FROM emergency_contacts WHERE tenant_id = ':tenant_a';` | `n ≤ 255`, `r ≤ 100`, `p ≤ 50` | — | — |
| EMC-DB-008 | UI count matches the DB | `SELECT count(*) FROM emergency_contacts WHERE tenant_id = ':tenant_a';` | Equals the number of cards shown | — | — |
| EMC-DB-009 | Tenant delete cascades contacts | Delete a throwaway tenant, then: `SELECT count(*) FROM emergency_contacts WHERE tenant_id = ':tenant_x';` | `0` | — | — |
| EMC-DB-010 | Audit log per mutation (P4) | `SELECT action, details FROM audit_logs WHERE tenant_id = ':tenant_a' ORDER BY created_at DESC LIMIT 3;` | Entries matching the create/update/delete performed | — | — |

---

## Cross-Module End-to-End Workflows (Care & Safety)

| TC ID | Workflow | Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| CS-E2E-001 | Member health file | 1. Add QA Child as a member.<br>2. Create a Medical Record for QA Child (lab report + PDF).<br>3. Create a Mediclaim policy insuring QA Child.<br>4. Add the treating doctor as an Emergency Contact.<br>5. Open `/dashboard`. | All three modules show the new records; dashboard counters increment for medical, LIC and important contacts. | — | — |
| CS-E2E-002 | Renewal alert chain | 1. Create a policy with a premium due in 7 days.<br>2. Open `/follow-up`.<br>3. Pay/extend the premium date to 90 days out.<br>4. Re-open `/follow-up`. | The policy appears in step 2 with "due in 7 days" and disappears after step 3. | — | — |
| CS-E2E-003 | Care record + AI | 1. Upload a lab report PDF with AI Auto-fill.<br>2. Verify the extracted fields.<br>3. Save.<br>4. Check `/ai-costs`. | Fields populate; the record saves; credits deducted once; usage visible in AI Costs. | — | — |
| CS-E2E-004 | Emergency readiness | 1. Populate 5 important contacts.<br>2. Log in as a view-only STANDARD user.<br>3. Open the module on a phone-sized viewport. | All contacts are readable and dial-able; no edit controls exposed. | — | — |
| CS-E2E-005 | Isolation sweep | 1. Create one record in each of the three modules in TENANT_A.<br>2. Log in as ADMIN_B.<br>3. Attempt to reach all three by record id and via global search. | All attempts fail; no data or masked fragment is disclosed. | — | — |
