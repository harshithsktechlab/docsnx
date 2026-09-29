# TC-14 — AI: Analysis · Bulk Scan · AI Settings · AI Costs & Privacy Shield

**Prefixes:** `AIA`, `BLK`, `AIS`
**Routes:** `/analysis`, `/dashboard/bulk-scan`, `/dashboard/context`, `/ai-settings`, `/ai-costs`
**Tables:** `ai_analysis_cache`, `tenant_ai_usages`, `api_keys`, `ai_api_keys`, `tenants`, `system_configs`

---

## 0. Shared AI Reference

| Aspect | Detail |
|---|---|
| Key resolution order | 1) the tenant's own API key (`tenants.api_key`, unlimited, no credit deduction) → 2) the platform key-rotation pool, gated by `tenants.ai_credits_balance` |
| Credit gate | If `ai_credits_balance < requiredCredits` and no tenant key exists → `INSUFFICIENT_CREDITS` error before any model call |
| Credit deduction | Only on **success** of a platform-pool call: `ai_credits_balance -= ceil(requiredCredits)` |
| Usage recording | Every call with token counts writes a `tenant_ai_usages` row (model, prompt tokens, completion tokens, cost) |
| Cost model | `system_configs` base costs — record analysis `1.00`, category analysis `2.00`, portfolio analysis `5.00`, bulk scan `10.00`. **Effective cost = base × multiplier**, where multiplier = `tenants.max_members + tenants.extra_members` |
| Providers | Gemini (default `gemini-2.5-flash`) and OpenAI |
| **Privacy Shield** | `prepareAiPayload()` strips forbidden keys — `password`, `passwordEncrypted`, `passwordHash`, `netBankingUsername`, `cards`, `cvv`, `pin`, `secretKey`, `apiKey`, `loginUsername`, `clientSecret`, `token`, `authCode`, `secret`, `privateKey`, `passphrase` |
| PII masking regexes | Aadhaar (12 digits) → `[AADHAAR-MASKED]` · PAN (`AAAAA9999A`) → `[PAN-MASKED]` · 9–18-digit numbers → `[ACCOUNT-NUM-MASKED]` · emails → `[EMAIL-MASKED]` · Indian phone numbers → `[PHONE-MASKED]` |
| Compression | Free-text strings **> 300 characters** are truncated to 300 chars plus `... [truncated for token optimization]`, then masked |
| Analysis cache | `ai_analysis_cache` keyed on `(tenant_id, user_id, category)`; `?refresh=true` bypasses it |
| Disclaimer | Every analysis response carries the AI profile's mandatory disclaimer |

---

# PART A — AI Analysis (`AIA`)

**Route:** `/analysis` · **Table:** `ai_analysis_cache`

## A1. UI Validation

| TC ID | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| AIA-UI-001 | Positive | Open `/analysis` on a tenant with no records. | A clear "not enough data" or empty state — no crash, no empty AI panel. | — | — |
| AIA-UI-002 | Positive | Open `/analysis` with records and select a category. | Loading state while generating; then structured, readable insight sections. | — | — |
| AIA-UI-003 | Positive | Inspect the bottom of any generated analysis. | The mandatory disclaimer is present and legible. | — | — |
| AIA-UI-004 | Positive | Re-open the same category immediately. | Served from cache — noticeably faster; a "cached"/"last updated" indicator with a timestamp is shown. | — | — |
| AIA-UI-005 | Positive | Click Refresh on a cached analysis. | Regenerates fresh content; the "last updated" timestamp advances. | — | — |
| AIA-UI-006 | Negative | Trigger an analysis with zero AI credits and no tenant key. | A clear insufficient-credits message with a route to buy credits — not a generic 500. | — | — |
| AIA-UI-007 | Negative | Trigger an analysis with an invalid tenant API key. | A clear provider/key error; the page remains usable. | — | — |
| AIA-UI-008 | Positive | Observe the button state during generation. | Disabled with a spinner and progress text; double-clicking cannot fire two generations. | — | — |
| AIA-UI-009 | Positive | View `/analysis` at 375px. | Sections stack; long insight text wraps; no horizontal page scroll. | — | — |
| AIA-UI-010 | Positive | Open `/dashboard/context`. | The context summary renders without error and reflects the tenant's actual data. | — | — |
| AIA-UI-011 | Negative | Log in as SUPER_ADMIN and attempt `/analysis`. | Forbidden — SUPER_ADMIN must not read tenant data. | — | — |

## A2. Business Rules

| TC ID | Type | Rule / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| AIA-BR-001 | Negative | Request an analysis with no category selected. | Rejected with "Category is required". | — | — |
| AIA-BR-002 | Positive | Generate an analysis for the first time. | A `ai_analysis_cache` row is created for `(tenant, user, category)`. | — | — |
| AIA-BR-003 | Positive | Request the same category again without refresh. | Served from cache; **no** new credit deduction and **no** new `tenant_ai_usages` row. | — | — |
| AIA-BR-004 | Positive | Request with refresh. | A fresh model call: credits deducted again and a new usage row written; the cache row is updated in place (not duplicated). | — | — |
| AIA-BR-005 | Business rule | Two different users in the same tenant generate the same category. | Two cache rows (cache is per user), each independently refreshable. | — | — |
| AIA-BR-006 | Business rule | Generate an analysis on a tenant with its own API key configured. | The tenant key is used; **no credits are deducted**; a usage row is still written for visibility. | — | — |
| AIA-BR-007 | Business rule | Generate on a tenant with no key and sufficient credits. | The platform pool is used; credits decrease by `ceil(category cost × multiplier)`. | — | — |
| AIA-BR-008 | Boundary | Set `ai_credits_balance` to exactly the required amount, then generate. | Succeeds; balance lands on 0. | — | — |
| AIA-BR-009 | Boundary | Set the balance one credit below the requirement. | Blocked with `INSUFFICIENT_CREDITS`; **no** deduction and **no** partial cache row. | — | — |
| AIA-BR-010 | Edge | Force the model call to fail (invalid platform key) mid-generation. | No credits deducted (deduction happens only on success); no cache row written; a clear error surfaces. | — | — |
| AIA-BR-011 | **Security** | Generate an analysis on a tenant holding passwords, bank accounts, cards and trading accounts, capturing the outbound AI payload (proxy or debug log). | The payload contains **none** of: `password`, `passwordEncrypted`, `cards`, `cvv`, `netBankingUsername`, `loginUsername`, `clientSecret`, `token`, `secret`, `privateKey`, `passphrase`, `apiKey`. Any leak ⇒ **S1**. | — | — |
| AIA-BR-012 | Security | Include an Aadhaar (`1234 5678 9012`), a PAN (`ABCDE1234F`), a 14-digit account number, an email and a `+91` phone number in record free-text, then generate. | All five appear masked in the payload as `[AADHAAR-MASKED]`, `[PAN-MASKED]`, `[ACCOUNT-NUM-MASKED]`, `[EMAIL-MASKED]`, `[PHONE-MASKED]`. | — | — |
| AIA-BR-013 | Boundary | Put a 299-character note and a 301-character note into two records, then generate. | The 299-char string passes through whole; the 301-char string is truncated at 300 with the `... [truncated for token optimization]` suffix. | — | — |
| AIA-BR-014 | Edge | Put a PAN inside a 500-character note. | The note is truncated **and** the surviving text is masked — masking must be applied after truncation. | — | — |
| AIA-BR-015 | Edge | Store an 8-digit and a 19-digit number in a note. | Neither matches the 9–18-digit account regex, so both pass through unmasked. Record actual and judge whether that gap matters for this data. | — | — |
| AIA-BR-016 | Security | Generate an analysis in TENANT_A, then check TENANT_B's `/analysis`. | TENANT_B's analysis contains no TENANT_A data; cache rows never cross tenants. | — | — |
| AIA-BR-017 | Negative | Subscription expired → open `/analysis`. | Access blocked. | — | — |
| AIA-BR-018 | Business rule | Delete records, then refresh the analysis. | The regenerated content reflects the reduced dataset. | — | — |

## A3. Database Validation

| TC ID | Validation Point | SQL Query | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| AIA-DB-001 | Cache row created with correct scope | `SELECT tenant_id, user_id, category FROM ai_analysis_cache WHERE tenant_id = ':tenant_a' ORDER BY created_at DESC LIMIT 1;` | `:tenant_a`, the generating user, the requested category | — | — |
| AIA-DB-002 | Cache is unique per (tenant, user, category) | `SELECT tenant_id, user_id, category, count(*) FROM ai_analysis_cache GROUP BY 1,2,3 HAVING count(*) > 1;` | 0 rows | — | — |
| AIA-DB-003 | Refresh updates in place | Capture `updated_at`, refresh, re-query. | Same row id; `updated_at` advanced | — | — |
| AIA-DB-004 | Analysis data is valid JSON | `SELECT jsonb_typeof(analysis_data) FROM ai_analysis_cache WHERE id = ':cache_id';` | `object` | — | — |
| AIA-DB-005 | **No secret leaked into the cache** | `SELECT count(*) FROM ai_analysis_cache WHERE tenant_id = ':tenant_a' AND (analysis_data::text ILIKE '%SecretPassword123%' OR analysis_data::text ILIKE '%cvv%' OR analysis_data::text LIKE '%50100234567890%');` | `0` | — | — |
| AIA-DB-006 | Credit deduction on a platform-pool call | Capture `ai_credits_balance`, generate, re-query: `SELECT ai_credits_balance FROM tenants WHERE id = ':tenant_a';` | Decreased by `ceil(base × multiplier)` for the category | — | — |
| AIA-DB-007 | No deduction on a cached read | Capture the balance, read the cached analysis, re-query. | Unchanged | — | — |
| AIA-DB-008 | No deduction when a tenant key is used | Configure a tenant key, generate, compare the balance. | Unchanged | — | — |
| AIA-DB-009 | Usage row written | `SELECT model_name, prompt_tokens, completion_tokens, cost FROM tenant_ai_usages WHERE tenant_id = ':tenant_a' ORDER BY created_at DESC LIMIT 1;` | Row present with non-zero token counts and a cost value | — | — |
| AIA-DB-010 | Failed call writes no usage and no deduction | Force a failure, then compare the balance and the latest usage row. | Both unchanged | — | — |
| AIA-DB-011 | Cross-tenant isolation (P7) | `SELECT count(*) FROM ai_analysis_cache WHERE id = ':cache_id' AND tenant_id = ':tenant_b';` | `0` | — | — |
| AIA-DB-012 | Tenant delete cascades the cache | Delete a throwaway tenant, then: `SELECT count(*) FROM ai_analysis_cache WHERE tenant_id = ':tenant_x';` | `0` | — | — |

---

# PART B — Bulk Scan (`BLK`)

**Route:** `/dashboard/bulk-scan` · Multi-file upload → AI extraction → review/edit → save into modules

## B1. UI Validation

| TC ID | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| BLK-UI-001 | Positive | Open `/dashboard/bulk-scan`. | Drop zone plus a file picker; empty state explains the flow. | — | — |
| BLK-UI-002 | Positive | Drag and drop 3 files onto the drop zone. | All three are listed with name, type and size; the drop zone highlights on drag-over. | — | — |
| BLK-UI-003 | Positive | Add files via the file picker instead. | Same result as drag-and-drop; files from both paths accumulate rather than replacing each other. | — | — |
| BLK-UI-004 | Negative | Click Scan with no files selected. | Toast "Please upload at least one file."; no request. | — | — |
| BLK-UI-005 | Positive | Remove a file from the pending list. | Only that file is removed. | — | — |
| BLK-UI-006 | Positive | Start a scan and observe the progress text. | Staged messages ("Uploading files to server…", then extraction progress); the button is disabled throughout. | — | — |
| BLK-UI-007 | Positive | Complete a scan of 3 documents. | A reviewable list of proposed records appears, each mapped to a target module with the extracted fields editable. | — | — |
| BLK-UI-008 | Positive | Edit an extracted field before saving. | The edit is retained and is what gets saved. | — | — |
| BLK-UI-009 | Positive | Delete one proposed record from the review list. | It is removed; its source files are re-assigned to the first remaining record rather than being orphaned. | — | — |
| BLK-UI-010 | Edge | Delete **all** proposed records. | Handled gracefully — a clear empty state, no crash, no dangling file references. | — | — |
| BLK-UI-011 | Negative | Trigger a network failure during scan. | Toast "📡 Network error connecting to the server…"; the file list is preserved so the user can retry. | — | — |
| BLK-UI-012 | Negative | Trigger a server-side scan error (e.g. no credits). | The server's message is surfaced verbatim; no records saved. | — | — |
| BLK-UI-013 | Positive | Save the reviewed records. | Spinner; success summary naming how many records were created per module; navigation to the results/dashboard. | — | — |
| BLK-UI-014 | Positive | View at 375px. | The drop zone and review list remain usable; no horizontal page scroll. | — | — |
| BLK-UI-015 | Negative | Log in as SUPER_ADMIN and open `/dashboard/bulk-scan`. | Redirected to `/tenants` — this route is in the tenant-specific guard list. | — | — |

## B2. Field & Business Rules

| TC ID | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| BLK-FLD-001 | Boundary | Upload 1 file. | Scan succeeds. | — | — |
| BLK-FLD-002 | Boundary | Upload 20 files at once. | All processed, or a clear cap message — never a silent truncation of the list. | — | — |
| BLK-FLD-003 | Boundary | Upload a file at and above any per-file size limit. | The oversized file is rejected with a clear message; the others still process. | — | — |
| BLK-FLD-004 | Boundary | Upload files whose combined size exceeds the storage quota. | Rejected with the quota message; no partial records; no orphan files on disk. | — | — |
| BLK-FLD-005 | Edge | Upload a 0-byte file. | Rejected or skipped with a message; the scan does not fail wholesale. | — | — |
| BLK-FLD-006 | Edge | Upload a mix of PDF, JPG, PNG, DOCX and XLSX. | All supported types are processed; unsupported types are reported individually. | — | — |
| BLK-FLD-007 | Edge | Upload a corrupt/unreadable PDF. | That file is reported as unprocessable; the remaining files still yield records. | — | — |
| BLK-FLD-008 | Edge | Upload a file with a very long name and special characters. | Processed; the stored path is sanitised; the display name is preserved. | — | — |
| BLK-BR-001 | Business rule | Run a bulk scan with sufficient credits. | Credits decrease by `ceil(bulkScan base × multiplier)` **once** for the batch (not per file) — record actual. | — | — |
| BLK-BR-002 | Business rule | Run a bulk scan with zero credits and no tenant key. | Blocked before any upload/model call with an insufficient-credits message; no files stored; no credits deducted. | — | — |
| BLK-BR-003 | Business rule | Run a bulk scan on a tenant with its own API key. | Succeeds with no credit deduction. | — | — |
| BLK-BR-004 | Positive | Scan an Aadhaar, a bank statement and an insurance policy together. | Each is routed to the correct module (documents, bank info, LIC) with sensible extracted fields. | — | — |
| BLK-BR-005 | **Security** | Scan a document containing a password/CVV-like string and capture the outbound AI payload. | Forbidden keys stripped; Aadhaar/PAN/account/email/phone masked. Any leak ⇒ **S1**. | — | — |
| BLK-BR-006 | Business rule | Save the reviewed records. | All created rows carry `tenant_id` = the session tenant and appear in their modules; each write produces an audit entry. | — | — |
| BLK-BR-007 | Negative | Run a bulk scan as a user lacking `add` permission on a target module. | Records for that module are refused; the rest still save, with a clear per-module result. | — | — |
| BLK-BR-008 | Negative | Subscription expired → open bulk scan. | Access blocked. | — | — |
| BLK-BR-009 | Edge | Cancel/navigate away mid-scan. | No half-written records; any uploaded-but-unsaved files do not count against the storage quota permanently (or are cleaned up) — record actual. | — | — |
| BLK-BR-010 | Edge | Save the same reviewed batch twice (browser back then re-save). | Duplicate records are either prevented or clearly surfaced — silent duplication ⇒ **S3**. | — | — |
| BLK-BR-011 | Positive | Scan a document already on file, then on the results screen click **Compare** on the pending row. | The duplicate prompt opens with the stored record on the left and the scanned source file on the right, offering **Keep the existing one** / **Keep both** / **Keep the new one**. | — | — |
| BLK-BR-012 | Positive | From that prompt choose **Keep both**. | A second record is saved under a numbered name; the record already on file is untouched; the audit entry is a create that says the copy was kept alongside it. | — | — |
| BLK-BR-013 | Business rule | Do the same where the scan matched on a document number rather than a name. | **Keep both** is not offered — only update or leave it. | — | — |

## B3. Database Validation

| TC ID | Validation Point | SQL Query | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| BLK-DB-001 | Records land in the correct tenant | `SELECT tenant_id, name FROM documents WHERE tenant_id = ':tenant_a' ORDER BY created_at DESC LIMIT 5;` | All rows carry `:tenant_a` and match the reviewed batch | — | — |
| BLK-DB-002 | Records land in the correct modules | Run a `count(*)` per target table before and after the save. | Each table's count increases by exactly the number of records assigned to it in the review step | — | — |
| BLK-DB-003 | Credit deduction is charged once per batch | Capture `ai_credits_balance`, run a 5-file scan, re-query. | Decreased by `ceil(bulk-scan base × multiplier)` once — not five times | — | — |
| BLK-DB-004 | Usage rows written | `SELECT count(*), sum(prompt_tokens) FROM tenant_ai_usages WHERE tenant_id = ':tenant_a' AND created_at > now() - interval '5 minutes';` | At least one row with non-zero tokens | — | — |
| BLK-DB-005 | No deduction on a failed scan | Force a failure, then compare the balance. | Unchanged | — | — |
| BLK-DB-006 | Audit entries for each saved record | `SELECT action, details FROM audit_logs WHERE tenant_id = ':tenant_a' ORDER BY created_at DESC LIMIT 10;` | One entry per created record | — | — |
| BLK-DB-007 | File sizes counted toward storage | `SELECT sum(file_size) FROM documents WHERE tenant_id = ':tenant_a' AND deleted_at IS NULL;` | Increased by the sum of the saved files; matches the storage widget | — | — |
| BLK-DB-008 | Encrypted fields still encrypted on the bulk path | For any bank/policy record created via bulk scan: `SELECT account_number ~ '^[0-9a-f]+:' AS is_ciphertext FROM bank_infos WHERE id = ':bulk_record_id';` | `t` — the bulk path must not bypass field encryption | — | — |
| BLK-DB-009 | No cross-tenant writes | `SELECT count(*) FROM documents WHERE tenant_id = ':tenant_b' AND created_at > now() - interval '5 minutes';` | `0` | — | — |

---

# PART C — AI Settings & Costs (`AIS`)

**Routes:** `/ai-settings` (tenant BYO key), `/ai-costs` · **Tables:** `tenants`, `api_keys`, `ai_api_keys`, `system_configs`

## C1. UI Validation

| TC ID | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| AIS-UI-001 | Positive | Open `/ai-settings`. | Provider select (Gemini / OpenAI), model select, API-key input, and a list of configured keys with status. | — | — |
| AIS-UI-002 | Positive | Change the provider from Gemini to OpenAI. | The model list updates to that provider's models and a sensible default is selected. | — | — |
| AIS-UI-003 | Positive | Click Edit on an existing key. | The provider and model are pre-populated but the **API key field is deliberately blank** (never pre-filled for security). | — | — |
| AIS-UI-004 | Negative | Add a new key with the API-key field empty. | Rejected with a validation message; no key saved. | — | — |
| AIS-UI-005 | Positive | Edit an existing key **without** re-entering the API key. | Provider/model changes save; the stored key is retained unchanged. | — | — |
| AIS-UI-006 | Positive | Click "Test" on a configured key. | A spinner on that row only; the result (success/failure) is shown per key. | — | — |
| AIS-UI-007 | Negative | Test a deliberately invalid key. | A clear failure result with the provider's error; the key is not silently deleted. | — | — |
| AIS-UI-008 | Positive | Inspect a saved key in the list. | Only a masked/truncated form of the key is displayed — never the full secret. | — | — |
| AIS-UI-009 | Positive | Delete a configured key. | Confirmation dialog first; on delete the tenant falls back to the platform credit pool. | — | — |
| AIS-UI-010 | Positive | Open `/ai-costs`. | Shows the four action costs (record / category / portfolio / bulk scan), the base costs, the multiplier and the current credit balance. | — | — |
| AIS-UI-011 | Positive | View both pages at 375px. | Forms and cost tables reflow; no horizontal page scroll. | — | — |
| AIS-UI-012 | Negative | Open `/ai-settings` as a `STANDARD` user. | Access denied or read-only — a standard member must not be able to change the tenant's AI key. Record actual. | — | — |

## C2. Business Rules

| TC ID | Type | Rule / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| AIS-BR-001 | Security | Save a tenant API key, then inspect the DB. | `tenants.api_key` is stored encrypted at rest — never plaintext. | — | — |
| AIS-BR-002 | Security | Inspect every client-visible payload after saving a key (`/api/auth/me`, the settings list). | The full key never appears in any response, page source or DOM. | — | — |
| AIS-BR-003 | Positive | Configure a valid tenant key, then run an AI action. | The tenant key is used; no credits are deducted. | — | — |
| AIS-BR-004 | Positive | Delete the tenant key, then run an AI action. | The platform pool is used and credits are deducted. | — | — |
| AIS-BR-005 | Negative | Configure an invalid tenant key, then run an AI action. | A clear provider error; **no silent fallback** to the platform pool that spends credits without the user's knowledge. Record actual — a silent fallback that charges credits is **S3**. | — | — |
| AIS-BR-006 | Positive | Verify the effective cost calculation on `/ai-costs`. | `effective = base × (max_members + extra_members)` for all four actions. | — | — |
| AIS-BR-007 | Boundary | Set `max_members = 1`, `extra_members = 0`. | Multiplier is 1; effective costs equal the base costs. | — | — |
| AIS-BR-008 | Boundary | Purchase an add-on granting extra members. | The multiplier and all four effective costs increase accordingly on `/ai-costs`. | — | — |
| AIS-BR-009 | Edge | Set `max_members` to NULL/0 in the database. | The multiplier defaults to 1 — costs never become 0 or negative. | — | — |
| AIS-BR-010 | Positive | Super Admin changes the base costs under platform settings. | The tenant's `/ai-costs` reflects the new base costs after a reload. | — | — |
| AIS-BR-011 | Edge | Delete the `system_configs` row entirely, then open `/ai-costs`. | Falls back to the documented defaults (1.00 / 2.00 / 5.00 / 10.00) rather than erroring. | — | — |
| AIS-BR-012 | Positive | Run several AI actions, then reload `/ai-costs`. | The credit balance shown matches `tenants.ai_credits_balance` exactly. | — | — |
| AIS-BR-013 | Security | Configure a key in TENANT_A, then check TENANT_B's `/ai-settings`. | TENANT_B sees nothing of TENANT_A's key and cannot use it. | — | — |
| AIS-BR-014 | Business rule | Exhaust the credit balance to exactly 0, then attempt each of the four AI actions. | All four blocked with a consistent insufficient-credits message. | — | — |
| AIS-BR-015 | Edge | Set `ai_credits_balance` to a negative value in the database, then attempt an AI action. | Blocked cleanly; the balance is never driven further negative. | — | — |
| AIS-BR-016 | Business rule | Buy an AI-credit add-on. | The balance increases by the add-on's `ai_credits`; AI actions work again. | — | — |
| AIS-BR-017 | Business rule | Verify the platform key rotation (Super Admin view). | With multiple platform keys configured, usage rotates and a key that errors repeatedly is de-prioritised; `api_keys.daily_usage` / `error_count` update accordingly. | — | — |

## C3. Database Validation

| TC ID | Validation Point | SQL Query | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| AIS-DB-001 | Tenant API key encrypted at rest | `SELECT api_key ~ '^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$' AS is_ciphertext FROM tenants WHERE id = ':tenant_a';` | `t` | — | — |
| AIS-DB-002 | Tenant key plaintext never stored | `SELECT count(*) FROM tenants WHERE api_key LIKE 'AIza%' OR api_key LIKE 'sk-%';` | `0` — a provider-prefixed plaintext key ⇒ **S1** | — | — |
| AIS-DB-003 | Provider/model persisted | `SELECT ai_provider, ai_model FROM tenants WHERE id = ':tenant_a';` | Match the selections made in `/ai-settings` | — | — |
| AIS-DB-004 | Defaults on a new tenant | `SELECT ai_provider, ai_model, ai_credits_balance FROM tenants WHERE id = ':new_tenant';` | `gemini`, `gemini-2.5-flash`, `0` | — | — |
| AIS-DB-005 | Cost configuration values | `SELECT ai_cost_record_analysis, ai_cost_category_analysis, ai_cost_portfolio_analysis, ai_cost_bulk_scan FROM system_configs LIMIT 1;` | Match the base costs shown on `/ai-costs` | — | — |
| AIS-DB-006 | Effective-cost multiplier | `SELECT max_members, extra_members, (COALESCE(max_members,1) + COALESCE(extra_members,0)) AS multiplier FROM tenants WHERE id = ':tenant_a';` | The multiplier matches the value shown on `/ai-costs` | — | — |
| AIS-DB-007 | Credit balance matches the UI | `SELECT ai_credits_balance FROM tenants WHERE id = ':tenant_a';` | Equals the balance rendered on `/ai-costs` | — | — |
| AIS-DB-008 | Usage aggregation | `SELECT model_name, count(*) AS calls, sum(prompt_tokens) AS pt, sum(completion_tokens) AS ct, sum(cost) AS total FROM tenant_ai_usages WHERE tenant_id = ':tenant_a' GROUP BY model_name;` | Totals match the usage summary shown in the UI | — | — |
| AIS-DB-009 | Usage rows are tenant-scoped | `SELECT count(*) FROM tenant_ai_usages WHERE tenant_id = ':tenant_b' AND created_at > now() - interval '10 minutes';` | `0` after running AI actions only in TENANT_A | — | — |
| AIS-DB-010 | Platform keys encrypted | `SELECT api_key ~ '^[0-9a-f]+:' AS is_ciphertext FROM api_keys LIMIT 5;` and `SELECT key ~ '^[0-9a-f]+:' AS is_ciphertext FROM ai_api_keys LIMIT 5;` | `t` for every row | — | — |
| AIS-DB-011 | Platform key rotation counters | `SELECT label, daily_usage, daily_limit, error_count, last_used_at FROM api_keys ORDER BY priority;` | `daily_usage` and `last_used_at` advance as calls are made; `error_count` rises on failures | — | — |
| AIS-DB-012 | Daily limit respected | Drive one key to its `daily_limit`, then run another AI action. | The next key in the pool is used; no call exceeds a key's daily limit | — | — |
| AIS-DB-013 | Deleting the tenant key restores pool usage | Delete the key, run an action, then: `SELECT api_key FROM tenants WHERE id = ':tenant_a';` and check the balance. | `api_key` is NULL; the balance decreases on the next AI action | — | — |

---

## Cross-Module End-to-End Workflows

| TC ID | Workflow | Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| AI-E2E-001 | Credit lifecycle | 1. Note the credit balance on `/ai-costs`.<br>2. Run a record analysis, a category analysis and a bulk scan.<br>3. Re-check the balance and `tenant_ai_usages`. | The balance drops by exactly `ceil(base × multiplier)` for each action; one usage row per model call. | — | — |
| AI-E2E-002 | Credit exhaustion & top-up | 1. Drive the balance to 0.<br>2. Attempt each AI action → all blocked.<br>3. Buy an AI-credit add-on.<br>4. Retry. | Consistent block messages in step 2; all actions work after the top-up; the balance reflects the purchased credits. | — | — |
| AI-E2E-003 | BYO key switchover | 1. Confirm actions consume credits.<br>2. Configure a valid tenant Gemini key.<br>3. Re-run an action.<br>4. Delete the key and re-run. | Step 3 consumes no credits; step 4 resumes consuming credits. | — | — |
| AI-E2E-004 | Privacy Shield end-to-end | 1. Populate the tenant with passwords, cards, bank accounts, trading accounts and notes containing Aadhaar/PAN/email/phone.<br>2. Run a portfolio analysis with the outbound payload captured.<br>3. Inspect the payload and the resulting cached analysis. | No forbidden key and no unmasked PII in either the payload or the cache; long notes truncated at 300 chars. | — | — |
| AI-E2E-005 | Analysis cache behaviour | 1. Generate a category analysis.<br>2. Re-open it 3 times.<br>3. Refresh once.<br>4. Compare credits and usage rows. | Only 2 model calls occurred (initial + refresh); the 3 cached reads cost nothing. | — | — |
| AI-E2E-006 | Bulk scan into modules | 1. Upload 5 mixed documents.<br>2. Review, correct one field, delete one proposed record.<br>3. Save. | 4 records created across the correct modules with the corrections applied; one batch charge; audit entries for each; sensitive fields encrypted at rest. | — | — |
| AI-E2E-007 | Isolation | 1. Run AI actions in TENANT_A only.<br>2. Inspect TENANT_B's credit balance, usage rows and analysis cache. | All unchanged/empty for TENANT_B. | — | — |
| AI-E2E-008 | Cost configuration propagation | 1. As SUPER_ADMIN change the bulk-scan base cost.<br>2. As ADMIN_A reload `/ai-costs`.<br>3. Run a bulk scan. | The new base and effective cost are shown; the deduction matches the new figure. | — | — |
