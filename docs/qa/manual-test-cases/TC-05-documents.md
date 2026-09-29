# TC-05 — Document Vault

**Prefix:** `DOC` · **Route:** `/documents` · **Table:** `documents`
**Permission key:** `documents` · **Storage:** Google Drive → Azure Blob → local `/uploads` fallback

## Module Reference

| Aspect | Detail |
|---|---|
| Core fields | Document Name*, Category*, File*, Assigned Member (`userId`) |
| Metadata (jsonb) | `documentNumber`, `idHolderName`, `dob`, `fatherName`, `expiryDate`, `customFields[]` |
| Built-in categories | `legal` (Legal / ID), `education`, `business`, `other` — plus **custom categories** typed by the user |
| Auto-grouping | Documents are grouped by keywords in the **name**: Aadhaar Cards, PAN Cards, Passports, Voter ID Cards, Driving Licenses, Educational Certificates, Insurance Documents, Bills & Receipts, Tax & GST Records, Financial & Banking, General / Miscellaneous |
| Encryption | `metadata.documentNumber` is **encrypted at rest**; list views return it **masked**, the single-record view returns full plaintext |
| Replace | Uploading with `replaceId` overwrites an existing document, deletes the previous file from disk and requires **edit** permission (plain add requires **add**) |
| Storage quota | `checkStorageLimit` blocks the upload when the tenant's plan+add-on GB limit is exceeded; tenants with Google Drive enabled are unlimited |
| Actions | Preview, Download, Share, Print, Edit, Replace, Delete, AI Auto-fill |
| Server required fields | `name` and `file` — otherwise "Missing name or file" |

---

## 1. UI Validation Test Cases

| TC ID | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| DOC-UI-001 | Positive | Open `/documents` on an empty tenant. | Empty state with an "Upload"/"Add Document" CTA; no broken grid, no console error. | — | — |
| DOC-UI-002 | Positive | Open `/documents` with records present. | Cards/rows show name, category badge, holder, file type icon, size and date; auto-group headings appear. | — | — |
| DOC-UI-003 | Positive | Observe the page while loading. | Skeleton placeholders, then content — no flash of the empty state. | — | — |
| DOC-UI-004 | Positive | Click the category filter tabs (All Folders / Legal / Education / Business / Other). | The list filters to the selected category; the active tab is highlighted; counts update. | — | — |
| DOC-UI-005 | Positive | Create a document with a custom category `Insurance`, then reload the page. | A new "Insurance" tab is appended to the filter tabs automatically. | — | — |
| DOC-UI-006 | Positive | Type in the search box. | List filters by name, file name, category and document number as you type; clearing restores everything. | — | — |
| DOC-UI-007 | Negative | Search for a nonsense string. | Friendly "no results" state. | — | — |
| DOC-UI-008 | Positive | Upload documents named "Aadhaar - Ravi", "PAN Card - Ravi", "Passport - Ravi". | They are grouped under **Aadhaar Cards**, **PAN Cards** and **Passports** respectively. | — | — |
| DOC-UI-009 | Edge | Upload a document named "Random Notes". | Grouped under **General / Miscellaneous Documents**. | — | — |
| DOC-UI-010 | Edge | Upload a document named "aadhaar card" (all lowercase). | Still grouped under Aadhaar Cards (grouping is case-insensitive). | — | — |
| DOC-UI-011 | Positive | Open the upload dialog. | Fields: Document Name, Category (select + custom option), Assigned Member, Document Number, ID Holder Name, DOB, Father/Spouse, Expiry Date, Custom Fields, file picker, AI Auto-fill button. | — | — |
| DOC-UI-012 | Positive | Choose "Custom" in the Category select. | A free-text "Enter custom category" input appears. | — | — |
| DOC-UI-013 | Positive | Click "+ Add Custom Field" repeatedly. | A new Label/Value pair is appended each time; each pair has a remove control that removes only that row. | — | — |
| DOC-UI-014 | Positive | Select a file and observe the picker. | Selected file name and size are displayed; the picker can be cleared/replaced. | — | — |
| DOC-UI-015 | Negative | Click "AI Auto-fill" with no file selected. | Toast "Please select or upload a document file first to use AI Auto-fill." — no request fired. | — | — |
| DOC-UI-016 | Positive | Select a scanned ID and click "AI Auto-fill". | A loading state shows; on success the metadata fields are populated from the extracted data; the user can still edit them before saving. | — | — |
| DOC-UI-017 | Negative | Trigger an AI Auto-fill failure (invalid key / network down). | Toast "Network error calling AI Scan endpoint" (or the server message); the form remains editable and nothing is saved. | — | — |
| DOC-UI-018 | Positive | Submit the upload form. | Button disables with a spinner; on success the dialog closes, the list refreshes and the new document is visible. | — | — |
| DOC-UI-019 | Positive | Click a document to preview it. | Preview modal opens with an inline viewer for images/PDFs and a Download link for other types. | — | — |
| DOC-UI-020 | Edge | Preview a `.docx` or `.xlsx` file. | A graceful fallback ("preview not available") plus a working Download link — no blank modal or crash. | — | — |
| DOC-UI-021 | Positive | Click Share on a document. | Share sheet/copy action produces text containing the document name, holder and document number. | — | — |
| DOC-UI-022 | Positive | Click Print on a document. | A print-friendly view opens listing Document Number, Holder, DOB, Father/Spouse, Expiry Date and all custom fields. | — | — |
| DOC-UI-023 | Positive | Click Download. | The original file downloads with a sensible file name. | — | — |
| DOC-UI-024 | Positive | Click Edit on a document. | Dialog pre-populated with all current values including metadata and custom fields. | — | — |
| DOC-UI-025 | Positive | Click Delete. | A confirmation dialog naming the document appears before deletion. | — | — |
| DOC-UI-026 | Positive | Trigger a delete failure (offline). | Toast "Network error deleting document"; the row stays in the list. | — | — |
| DOC-UI-027 | Positive | Inspect a document number in the list vs. the detail/edit view. | List shows a masked value (e.g. `••••1234`); the edit/detail view shows the full number. | — | — |
| DOC-UI-028 | Positive | Paginate a list of >1 page of documents. | Pagination controls work; page/limit are respected; totals are correct. | — | — |
| DOC-UI-029 | Positive | View `/documents` at 375px, 768px and 1440px. | Grid reflows; the table (if any) scrolls inside its own container; no horizontal page scroll. | — | — |
| DOC-UI-030 | Positive | As a view-only user, open `/documents`. | Upload / Edit / Delete controls are hidden or disabled; preview and download remain available. | — | — |

---

## 2. Field Validation Test Cases

| TC ID | Field | Type | Input / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|---|
| DOC-FLD-001 | Name + File | Negative | Submit with both empty. | Rejected — "Missing name or file"; nothing uploaded. | — | — |
| DOC-FLD-002 | Name | Negative | File selected, name blank. | Rejected — "Missing name or file". | — | — |
| DOC-FLD-003 | File | Negative | Name entered, no file selected. | Rejected — "Missing name or file". | — | — |
| DOC-FLD-004 | Name | Boundary | 255-character name. | Accepted; stored untruncated. | — | — |
| DOC-FLD-005 | Name | Boundary | 256-character name. | Rejected/truncated cleanly with a clear message — no 500 error. | — | — |
| DOC-FLD-006 | Name | Boundary | 1-character name `A`. | Accepted. | — | — |
| DOC-FLD-007 | Name | Edge | Name with unicode/emoji `पासपोर्ट 🛂`. | Accepted, stored and displayed correctly. | — | — |
| DOC-FLD-008 | Name | Edge | `<script>alert(1)</script>`. | Rendered as literal text in the list, preview and print view. | — | — |
| DOC-FLD-009 | Category | Positive | Each of legal / education / business / other. | Saved and reflected in the filter tabs. | — | — |
| DOC-FLD-010 | Category | Edge | No category chosen. | Defaults to `other` server-side. | — | — |
| DOC-FLD-011 | Category | Positive | Custom category `Property Papers`. | Accepted; a matching filter tab appears with title-cased label. | — | — |
| DOC-FLD-012 | Category | Boundary | 100-char and 101-char custom categories. | 100 accepted; 101 rejected/handled cleanly (column limit is 100). | — | — |
| DOC-FLD-013 | Category | Edge | Custom category containing only spaces. | Rejected or normalised — an empty-looking tab must not appear. | — | — |
| DOC-FLD-014 | File | Positive | Upload PDF, JPG, PNG, DOCX and XLSX. | All accepted; correct `mime_type` and `file_size` recorded. | — | — |
| DOC-FLD-015 | File | Boundary | Upload a 0-byte file. | Record actual — should be rejected as invalid rather than stored as a 0-byte record. | — | — |
| DOC-FLD-016 | File | Boundary | Upload a file just under the storage quota remainder. | Accepted. | — | — |
| DOC-FLD-017 | File | Boundary | Upload a file that exceeds the remaining quota. | Rejected with the storage-limit message; nothing written to `documents` and no file left on disk. | — | — |
| DOC-FLD-018 | File | Edge | Upload a file with a very long name (>200 chars) and special characters/spaces. | Accepted; the stored path is sanitised (non-alphanumerics replaced) and the original `file_name` is preserved for display. | — | — |
| DOC-FLD-019 | File | Edge | Upload two files with identical names. | Both stored without collision (timestamp+random prefix); both downloadable and distinct. | — | — |
| DOC-FLD-020 | File | Negative | Upload an executable (`.exe`, `.sh`) or a file with a double extension (`invoice.pdf.exe`). | Record actual. Expected: rejected or stored inert (never served with an executable content type). A file served back as executable ⇒ **S1**. | — | — |
| DOC-FLD-021 | File | Edge | Upload a file whose extension does not match its content (a `.pdf` that is really a PNG). | Stored; the preview degrades gracefully; no crash. | — | — |
| DOC-FLD-022 | Document Number | Positive | `ABCDE1234F`. | Saved; masked in the list; full value in the edit view. | — | — |
| DOC-FLD-023 | Document Number | Edge | Leave blank. | Accepted; no encryption artefact stored; list shows an empty/`N/A` value. | — | — |
| DOC-FLD-024 | Document Number | Boundary | 500-character value. | Accepted or rejected cleanly — no truncation that silently corrupts the ciphertext. | — | — |
| DOC-FLD-025 | DOB | Positive | Valid past date. | Saved and displayed formatted. | — | — |
| DOC-FLD-026 | DOB | Edge | Future date. | Record actual — a future DOB should be rejected. | — | — |
| DOC-FLD-027 | Expiry Date | Positive | Future date. | Saved; the document surfaces in follow-up alerts as expiry nears. | — | — |
| DOC-FLD-028 | Expiry Date | Edge | Past date. | Accepted (historical records are valid); shown as expired. | — | — |
| DOC-FLD-029 | Expiry Date | Edge | Expiry earlier than DOB. | Record actual — an inconsistent pair should be flagged. | — | — |
| DOC-FLD-030 | ID Holder Name / Father Name | Boundary | 255 and 256 characters. | 255 accepted; 256 handled cleanly. | — | — |
| DOC-FLD-031 | Custom Fields | Positive | Add 3 label/value pairs. | All three saved and shown in the detail/print view. | — | — |
| DOC-FLD-032 | Custom Fields | Edge | Add a pair with a label but no value (and vice versa). | Saved or skipped consistently; no `undefined`/`null` text rendered in the UI. | — | — |
| DOC-FLD-033 | Custom Fields | Boundary | Add 50 custom fields. | All persist; the form and print view remain usable (scroll, no overflow). | — | — |
| DOC-FLD-034 | Custom Fields | Edge | Two pairs with the same label. | Both retained (no silent de-duplication that loses data). | — | — |
| DOC-FLD-035 | Assigned Member | Positive | Assign to another member. | Saved; the list shows that member as the holder. | — | — |
| DOC-FLD-036 | Assigned Member | Negative | Assign to a user id belonging to another tenant (manipulated). | Rejected — "Invalid user ID"; no record created. | — | — |
| DOC-FLD-037 | All | Edge | Double-click Upload. | Exactly one document row is created and one file stored. | — | — |

---

## 3. Business Rule Test Cases

| TC ID | Type | Rule / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| DOC-BR-001 | Positive | Upload a document as TENANT_ADMIN. | Row created with `tenant_id` = session tenant and `user_id` = the assigned member (defaults to the uploader). | — | — |
| DOC-BR-002 | Negative | As a user with only `canView` on documents, attempt to upload. | Blocked with Forbidden; controls hidden in the UI. | — | — |
| DOC-BR-003 | Negative | As a user with `canAdd` but not `canEdit`, attempt a **replace** (re-upload over an existing document). | Blocked — replace requires the `edit` permission. | — | — |
| DOC-BR-004 | Positive | As a user with `canEdit`, replace an existing document. | The record is updated in place (same id), the new file is stored and the **old file is removed from disk**. | — | — |
| DOC-BR-005 | Negative | Attempt to replace a document id belonging to TENANT_B. | "Document to replace not found" (404); TENANT_B's record untouched. | — | — |
| DOC-BR-006 | Business rule | Upload files until the plan's storage quota is exhausted. | The upload that would breach the quota is rejected with the storage message; earlier uploads are unaffected. | — | — |
| DOC-BR-007 | Business rule | Enable Google Drive for the tenant, then upload beyond the previous plan limit. | Allowed — Drive-enabled tenants bypass the quota. | — | — |
| DOC-BR-008 | Business rule | Upload a document with metadata containing a document number for holder = QA Child. | QA Child's profile is auto-enriched with that identifier (encrypted). | — | — |
| DOC-BR-009 | Security | Upload with a document number, then inspect the list view payload/DOM. | The number is **masked**; the raw plaintext is not present in the list response. | — | — |
| DOC-BR-010 | Security | Open the edit dialog for the same document. | The full plaintext number is shown (single-record reveal). | — | — |
| DOC-BR-011 | Security | Copy the file URL of a TENANT_A document and open it while logged in as ADMIN_B. | Access denied — uploaded files are authorised against the requester's tenant. | — | — |
| DOC-BR-012 | Security | Open a TENANT_A file URL with no session at all. | Access denied / redirected to login. | — | — |
| DOC-BR-013 | Negative | As ADMIN_B, attempt to open/edit/delete a TENANT_A document by its id. | 403/404; nothing changes in TENANT_A. | — | — |
| DOC-BR-014 | Positive | Delete a document. | It disappears from the list; check the DB for the delete semantics used (soft `deleted_at` vs. hard delete) and record actual. | — | — |
| DOC-BR-015 | Business rule | After deleting, check whether the stored file is removed from disk/Drive. | Record actual — an orphaned file that remains publicly fetchable ⇒ **S2**. | — | — |
| DOC-BR-016 | Positive | Perform create, replace and delete, then open `/audit-logs`. | Three entries exist: `CREATE_DOCUMENT`, `UPDATE_DOCUMENT` and the delete action, each naming the document. | — | — |
| DOC-BR-017 | Business rule | Use AI Auto-fill on a document containing a PAN and an Aadhaar. | The AI request payload is masked/stripped of the raw identifiers per the AI Privacy Shield; the extracted values still populate the form. | — | — |
| DOC-BR-018 | Business rule | Use AI Auto-fill with zero AI credits and no tenant key configured. | Blocked with an insufficient-credits message; no partial record created; no credits deducted. | — | — |
| DOC-BR-019 | Business rule | Use AI Auto-fill successfully on a credit-consuming action. | `tenants.ai_credits_balance` decreases by the configured record-analysis cost. | — | — |
| DOC-BR-020 | Negative | With the subscription expired, attempt to upload. | Blocked; the user is directed to billing. | — | — |
| DOC-BR-021 | Positive | Upload a *different* file under a document name already used in that category. | The duplicate prompt opens showing **both** documents side by side — "Already on file" (the stored record, decrypted for preview) and "Uploading now" (the file just picked) — with three answers: **Keep the existing one**, **Keep both**, **Keep the new one**. | — | — |
| DOC-BR-021a | Positive | On that prompt, choose **Keep the existing one** (or close it). | Nothing is written: the record on file is unchanged, no second row appears, no audit entry. | — | — |
| DOC-BR-021b | Positive | Repeat and choose **Keep the new one**. | One record still, with the new file; audit says the document was overwritten. Requires **edit** permission on that sub-category. | — | — |
| DOC-BR-021c | Positive | Repeat and choose **Keep both**. | Two records: the original, and a new one named exactly as the prompt said it would be (`<name> (2)`). Both open. Audit says the copy was kept alongside the existing record, as a create — so it works with **add** permission alone. | — | — |
| DOC-BR-021d | Business rule | Upload a record whose **document number** matches one already on file, under a different title. | The prompt shows both documents but offers only two answers — **Keep both** is absent, with a line saying both records would claim the same number. | — | — |
| DOC-BR-021e | Edge | Trigger the prompt where one side is a `.docx`/`.xlsx`, or where the record on file has no attachment. | That pane shows a card naming the file instead of a viewer — no stuck spinner, no console error. | — | — |
| DOC-BR-021f | Security | As a member with **add** but not **view** on that sub-category, trigger the prompt. | The record is named, but the "Already on file" pane shows no preview — the file is withheld from someone who may not read that category. | — | — |
| DOC-BR-022 | Positive | Assign a document to another member, then delete that member. | The document is not orphaned into another tenant; `holder_id` behaviour matches the schema's `set null` rule. | — | — |

---

## 4. End-to-End Workflow Test Cases

| TC ID | Workflow | Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| DOC-E2E-001 | Upload → view → download | 1. Upload "Passport - Ravi" (PDF, category legal, doc number, expiry).<br>2. Confirm it appears under **Passports**.<br>3. Preview it.<br>4. Download it. | Record created with all metadata; preview renders the PDF; downloaded file is byte-identical to the source. | — | — |
| DOC-E2E-002 | AI-assisted upload | 1. Choose a scanned Aadhaar image.<br>2. Click AI Auto-fill.<br>3. Review the populated fields, correct one value.<br>4. Save. | Extracted values pre-fill the form; the manual correction is what gets saved; credits deducted once; audit entry written. | — | — |
| DOC-E2E-003 | Edit & replace | 1. Open an existing document → Edit.<br>2. Change the name and category.<br>3. Upload a revised file.<br>4. Save. | Same record id retained; new file served; old file removed from storage; `UPDATE_DOCUMENT` audit entry written; `updated_at` advances. | — | — |
| DOC-E2E-004 | Delete lifecycle | 1. Note the document count on `/dashboard`.<br>2. Delete a document.<br>3. Return to `/dashboard` and `/documents`. | The document is gone from the list, the dashboard count decrements, and an audit entry exists. | — | — |
| DOC-E2E-005 | Quota exhaustion | 1. Set the tenant to a small-storage plan.<br>2. Upload files until the quota is reached.<br>3. Attempt one more upload.<br>4. Enable Google Drive.<br>5. Retry. | Step 3 is blocked with a clear quota message; step 5 succeeds. | — | — |
| DOC-E2E-006 | Profile enrichment chain | 1. Confirm QA Child's Legal / ID profile tab is empty.<br>2. Upload a PAN document with holder = QA Child and the PAN in metadata.<br>3. Open QA Child's profile. | PAN appears in QA Child's `legal_details`, encrypted at rest. | — | — |
| DOC-E2E-007 | Cross-tenant isolation | 1. Upload "Secret A" in TENANT_A and capture its id and file URL.<br>2. Log in as ADMIN_B.<br>3. Search "Secret A"; open the record id; open the file URL. | No search hit; record access 403/404; file URL denied. | — | — |
| DOC-E2E-008 | Permission downgrade mid-flight | 1. As ADMIN_A, revoke QA Child's `canDelete` on documents.<br>2. As QA Child (already logged in), attempt a delete. | Delete is refused after the change takes effect; record how long the old permission remains usable. | — | — |
| DOC-E2E-009 | Search & filter combination | 1. Upload 5 documents across 3 categories.<br>2. Filter to one category and search a term matching documents in two categories. | Only records matching **both** the filter and the search term are shown. | — | — |
| DOC-E2E-010 | Share & print | 1. Open a document with full metadata.<br>2. Share.<br>3. Print. | Share text and print view both contain the document name, holder, number and custom fields, with the document number presented per the masking policy in force for that view. | — | — |

---

## 5. Database Validation Test Cases

| TC ID | Validation Point | SQL Query | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| DOC-DB-001 | Row created with correct tenant (P1) | `SELECT tenant_id, user_id, name, category FROM documents WHERE id = ':record_id';` | `tenant_id = :tenant_a`; name/category as entered | — | — |
| DOC-DB-002 | File attributes recorded | `SELECT file_name, mime_type, file_size, file_path FROM documents WHERE id = ':record_id';` | Original file name, correct MIME type, byte size > 0, non-empty path | — | — |
| DOC-DB-003 | Document number encrypted at rest (P5) | `SELECT metadata->>'documentNumber' ~ '^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$' AS is_ciphertext FROM documents WHERE id = ':record_id';` | `t` | — | — |
| DOC-DB-004 | Document number plaintext never stored | `SELECT count(*) FROM documents WHERE metadata->>'documentNumber' = 'ABCDE1234F';` | `0` | — | — |
| DOC-DB-005 | Non-sensitive metadata stored in the clear | `SELECT metadata->>'idHolderName' AS holder, metadata->>'fatherName' AS father, metadata->>'expiryDate' AS expiry FROM documents WHERE id = ':record_id';` | Readable plaintext values matching the form | — | — |
| DOC-DB-006 | Custom fields stored as an array | `SELECT jsonb_typeof(metadata->'customFields') AS t, jsonb_array_length(metadata->'customFields') AS n FROM documents WHERE id = ':record_id';` | `array`, `n` = number of pairs entered | — | — |
| DOC-DB-007 | Audit timestamps (P2) | `SELECT created_at IS NOT NULL, updated_at IS NOT NULL, updated_at >= created_at FROM documents WHERE id = ':record_id';` | `t, t, t` | — | — |
| DOC-DB-008 | `updated_at` advances on edit | Capture, edit in the UI, re-query `updated_at`. | Strictly greater | — | — |
| DOC-DB-009 | Replace keeps the same row id | Before/after a replace: `SELECT id, file_path, file_name FROM documents WHERE id = ':record_id';` | Same `id`; `file_path`/`file_name` changed to the new file | — | — |
| DOC-DB-010 | Replace does not create a second row | `SELECT count(*) FROM documents WHERE tenant_id = ':tenant_a' AND name = 'Passport - Ravi';` | `1` after a replace | — | — |
| DOC-DB-011 | Delete semantics (P3) | `SELECT id, deleted_at FROM documents WHERE id = ':record_id';` | Row present with a non-null `deleted_at` (soft delete). If the row is gone entirely, record it — hard delete contradicts the documented soft-delete policy ⇒ **S3** | — | — |
| DOC-DB-012 | Deleted rows excluded from list views | `SELECT count(*) FROM documents WHERE tenant_id = ':tenant_a' AND deleted_at IS NULL;` | Matches the number of rows shown in the UI | — | — |
| DOC-DB-013 | Audit log for create (P4) | `SELECT action, details FROM audit_logs WHERE tenant_id = ':tenant_a' AND action = 'CREATE_DOCUMENT' ORDER BY created_at DESC LIMIT 1;` | Row present; details name the document and category | — | — |
| DOC-DB-014 | Audit log for update/replace | `SELECT action, details FROM audit_logs WHERE tenant_id = ':tenant_a' AND action = 'UPDATE_DOCUMENT' ORDER BY created_at DESC LIMIT 1;` | Row present mentioning the revised document | — | — |
| DOC-DB-015 | Audit log for delete | `SELECT action, details FROM audit_logs WHERE tenant_id = ':tenant_a' ORDER BY created_at DESC LIMIT 1;` immediately after deleting | Top row is the delete action for that document | — | — |
| DOC-DB-016 | Storage accounting matches uploads | `SELECT count(*) AS n, sum(file_size) AS bytes FROM documents WHERE tenant_id = ':tenant_a' AND deleted_at IS NULL;` | `n` and `bytes` match what the storage widget reports | — | — |
| DOC-DB-017 | Quota rejection leaves no row | After a quota-blocked upload: `SELECT count(*) FROM documents WHERE tenant_id = ':tenant_a' AND name = 'QuotaBuster';` | `0` | — | — |
| DOC-DB-018 | Assigned member belongs to the same tenant | `SELECT count(*) FROM documents d JOIN users u ON u.id = d.user_id WHERE d.tenant_id = ':tenant_a' AND u.tenant_id <> ':tenant_a';` | `0` | — | — |
| DOC-DB-019 | Holder reference is same-tenant | `SELECT count(*) FROM documents d JOIN users u ON u.id = d.holder_id WHERE d.tenant_id <> u.tenant_id;` | `0` | — | — |
| DOC-DB-020 | Cross-tenant isolation (P7) | `SELECT count(*) FROM documents WHERE id = ':record_id' AND tenant_id = ':tenant_b';` | `0` | — | — |
| DOC-DB-021 | No document row is missing a tenant | `SELECT count(*) FROM documents WHERE tenant_id IS NULL;` | `0` | — | — |
| DOC-DB-022 | File paths are unique per upload | `SELECT file_path, count(*) FROM documents WHERE tenant_id = ':tenant_a' GROUP BY file_path HAVING count(*) > 1;` | 0 rows | — | — |
| DOC-DB-023 | Custom category persisted verbatim | `SELECT DISTINCT category FROM documents WHERE tenant_id = ':tenant_a';` | Includes the custom category exactly as typed | — | — |
| DOC-DB-024 | Default category applied when omitted | Upload without choosing a category, then: `SELECT category FROM documents WHERE id = ':record_id';` | `other` | — | — |
| DOC-DB-025 | AI credit deduction on auto-fill | Capture `ai_credits_balance`, run AI Auto-fill, re-query: `SELECT ai_credits_balance FROM tenants WHERE id = ':tenant_a';` | Decreased by the configured record-analysis cost (`system_configs.ai_cost_record_analysis`) | — | — |
| DOC-DB-026 | AI usage recorded | `SELECT model_name, prompt_tokens, completion_tokens, cost FROM tenant_ai_usages WHERE tenant_id = ':tenant_a' ORDER BY created_at DESC LIMIT 1;` | A row for the auto-fill call with non-zero token counts | — | — |
