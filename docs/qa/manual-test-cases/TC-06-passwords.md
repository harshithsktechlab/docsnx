# TC-06 — Password Manager (Credential Vault)

**Prefix:** `PWD` · **Route:** `/passwords` · **Table:** `passwords`
**Permission key:** `passwords` · **Sensitive column:** `password_encrypted` (AES-256-GCM)

## Module Reference

| Aspect | Detail |
|---|---|
| Fields | Title*, Category, URL, Username*, Password*, Notes, Custom Fields[], Assigned Member |
| Categories | `personal` (Personal), `social` (Social Media), `bank` (Bank / Finance), `business` (Work / Business), `other` |
| Server validation | `title` 1–255 required · `username` 1–255 required · `password` min 1 required · `category` ≤100 · `url` ≤1000 · `customFields` array · `userId` must be a UUID |
| Client validation | "Title, Username, and Password are required" (edit) / "Please fill in required fields (Title, Username, and Password)" (add) |
| Security model | The **list view never returns the password** — `password_encrypted` is stripped from every list response. Plaintext is returned only by the single-record reveal, which is permission-gated |
| Tenant scoping | List runs inside `withTenant` with an explicit `tenant_id` predicate **and** `deleted_at IS NULL` |
| Actions | Reveal/hide, Copy username, Copy password, Edit, Delete, Search, Category filter |

---

## 1. UI Validation Test Cases

| TC ID | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| PWD-UI-001 | Positive | Open `/passwords` on an empty tenant. | Empty state with an "Add Credential" CTA; no error. | — | — |
| PWD-UI-002 | Positive | Open `/passwords` with saved credentials. | Cards show title, category badge, username, URL and a masked password placeholder; owner/holder shown. | — | — |
| PWD-UI-003 | Positive | Inspect the password field of a list card **before** clicking reveal. | Only dots/asterisks are shown. Open DevTools → Network and inspect the list response: it contains **no** password field at all. | — | — |
| PWD-UI-004 | Positive | Click the reveal (eye) icon on a credential. | Plaintext password appears for that credential only; the icon switches to eye-off. | — | — |
| PWD-UI-005 | Positive | Click reveal on a second credential while the first is revealed. | Each card's visibility is tracked independently (revealing one does not hide or reveal another). | — | — |
| PWD-UI-006 | Positive | Click reveal again on a revealed credential. | It re-masks. | — | — |
| PWD-UI-007 | Positive | Reload the page while a password is revealed. | All passwords return to masked state (visibility is not persisted). | — | — |
| PWD-UI-008 | Positive | Click "Copy" next to the username. | Username is copied to the clipboard; the icon briefly changes to a check mark. | — | — |
| PWD-UI-009 | Positive | Click "Copy" next to the password. | Password is copied; the check-mark confirmation shows and then reverts. | — | — |
| PWD-UI-010 | Edge | Click Copy in a browser context where the Clipboard API is unavailable (e.g. insecure origin). | A graceful fallback or an error toast — no unhandled exception. | — | — |
| PWD-UI-011 | Positive | Open the Add Credential dialog. | Fields: Title, Category (select), URL, Username, Password (with show/hide), Notes, Custom Fields, Assigned Member. | — | — |
| PWD-UI-012 | Positive | Toggle show/hide inside the password input while typing. | Value toggles between masked and visible; typed value is preserved. | — | — |
| PWD-UI-013 | Positive | Add and remove custom Label/Value pairs. | Each "+" appends a row; each remove deletes only its own row. | — | — |
| PWD-UI-014 | Positive | Submit the add form. | Button disables with a spinner; on success the dialog closes, a toast appears and the list refreshes. | — | — |
| PWD-UI-015 | Positive | Click the category filter tabs. | The list filters to that category; the active tab is highlighted. | — | — |
| PWD-UI-016 | Positive | Type into the search box ("Search logins, titles…"). | Filters by title, username, URL and category; clearing restores the full list. | — | — |
| PWD-UI-017 | Negative | Search for a nonsense string. | Friendly empty state. | — | — |
| PWD-UI-018 | Positive | Click Edit on a credential. | Dialog pre-populated with title, category, URL, username, notes and custom fields. Record whether the password field is pre-filled with the real password or left blank. | — | — |
| PWD-UI-019 | Positive | Click Delete. | A confirmation dialog naming the credential is shown first. | — | — |
| PWD-UI-020 | Negative | Trigger a delete failure (offline). | Toast "Network error deleting credential"; the card remains. | — | — |
| PWD-UI-021 | Positive | Trigger a save failure. | Inline form error is displayed; the entered values are retained so nothing is retyped. | — | — |
| PWD-UI-022 | Positive | View `/passwords` at 375px width. | Cards stack; reveal/copy buttons remain tappable (≥44px targets); no horizontal page scroll. | — | — |
| PWD-UI-023 | Positive | As a view-only user, open `/passwords`. | Add/Edit/Delete are hidden or disabled. Record whether reveal is still permitted for a view-only user and confirm that matches the intended policy. | — | — |
| PWD-UI-024 | Positive | Paginate through more than one page of credentials. | Pagination works; totals correct; passwords remain masked on every page. | — | — |
| PWD-UI-025 | Edge | With a credential revealed, use the browser's "Save page"/View-Source. | Confirm the plaintext only exists in the live DOM after an explicit reveal, not in the server-rendered source. | — | — |

---

## 2. Field Validation Test Cases

| TC ID | Field | Type | Input / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|---|
| PWD-FLD-001 | All | Negative | Submit the add form empty. | "Please fill in required fields (Title, Username, and Password)". No record created. | — | — |
| PWD-FLD-002 | Title | Negative | Blank title, username and password filled. | Rejected — "Title is required". | — | — |
| PWD-FLD-003 | Title | Boundary | 1-character title. | Accepted. | — | — |
| PWD-FLD-004 | Title | Boundary | 255-character title. | Accepted; stored untruncated. | — | — |
| PWD-FLD-005 | Title | Boundary | 256-character title. | Rejected with a max-length message; no row created. | — | — |
| PWD-FLD-006 | Title | Edge | Unicode/emoji title `Gmail 📧 खाता`. | Accepted and displayed correctly. | — | — |
| PWD-FLD-007 | Title | Edge | `<script>alert(1)</script>`. | Rendered as literal text everywhere the title appears. | — | — |
| PWD-FLD-008 | Username | Negative | Blank username. | Rejected — "Username is required". | — | — |
| PWD-FLD-009 | Username | Boundary | 255 and 256 characters. | 255 accepted; 256 rejected. | — | — |
| PWD-FLD-010 | Username | Edge | Username that is an email, a phone number, and one containing spaces. | All accepted verbatim (no format restriction). | — | — |
| PWD-FLD-011 | Password | Negative | Blank password. | Rejected — "Password is required". | — | — |
| PWD-FLD-012 | Password | Boundary | 1-character password. | Accepted (the vault stores arbitrary secrets; no strength minimum is enforced here). | — | — |
| PWD-FLD-013 | Password | Boundary | 1 000-character password. | Accepted; reveal returns the full value byte-for-byte. | — | — |
| PWD-FLD-014 | Password | Edge | Password containing `: ; " ' \ / < > & %` and a colon (`abc:def:ghi`). | Stored and revealed intact — the colon must not corrupt the `iv:salt:tag:ct` ciphertext parsing. | — | — |
| PWD-FLD-015 | Password | Edge | Password with leading/trailing spaces `"  secret  "`. | Reveal returns the exact string including the spaces (no silent trim). | — | — |
| PWD-FLD-016 | Password | Edge | Password containing newlines/tabs. | Stored and revealed intact. | — | — |
| PWD-FLD-017 | Password | Edge | Unicode/emoji password `pä55w🔑rd`. | Stored and revealed intact. | — | — |
| PWD-FLD-018 | Password | Edge | A password that itself looks like ciphertext (`aa:bb:cc:dd` in hex). | Record actual — idempotent-encryption logic must not pass it through unencrypted. If it is stored as-is, that is a **S1** plaintext-at-rest defect. | — | — |
| PWD-FLD-019 | Category | Positive | Each of personal / social / bank / business / other. | Saved; the record appears under the matching filter tab. | — | — |
| PWD-FLD-020 | Category | Edge | Leave category unset. | Accepted (nullable); the record still appears in "All". | — | — |
| PWD-FLD-021 | Category | Boundary | 100 and 101 characters. | 100 accepted; 101 rejected. | — | — |
| PWD-FLD-022 | URL | Positive | `https://accounts.google.com`. | Saved and rendered as a link. | — | — |
| PWD-FLD-023 | URL | Edge | Value without a scheme (`accounts.google.com`). | Accepted; confirm the rendered link is not broken/relative. | — | — |
| PWD-FLD-024 | URL | Boundary | 1 000 and 1 001 characters. | 1 000 accepted; 1 001 rejected. | — | — |
| PWD-FLD-025 | URL | Negative | `javascript:alert(1)`. | Must NOT be rendered as a clickable link that executes script — sanitised or rendered as plain text. Execution ⇒ **S1**. | — | — |
| PWD-FLD-026 | Notes | Boundary | 10 000-character note. | Accepted (text column) and fully retrievable. | — | — |
| PWD-FLD-027 | Notes | Edge | Multi-line note with recovery codes. | Line breaks preserved on display. | — | — |
| PWD-FLD-028 | Notes | Edge | Note containing a password-like string. | Record actual — notes are stored unencrypted; confirm this is the accepted design and that no secret is expected there. | — | — |
| PWD-FLD-029 | Custom Fields | Positive | Add 3 label/value pairs (e.g. "Pin Number"). | Saved and displayed on the record. | — | — |
| PWD-FLD-030 | Custom Fields | Edge | Add a pair with an empty label. | Handled consistently; no `undefined` label rendered. | — | — |
| PWD-FLD-031 | Custom Fields | Boundary | Add 50 pairs. | All persist; the form stays usable. | — | — |
| PWD-FLD-032 | Assigned Member | Positive | Assign the credential to another member. | Saved; the list shows that member as the owner. | — | — |
| PWD-FLD-033 | Assigned Member | Negative | Supply a non-UUID / another tenant's user id (manipulated). | Rejected as invalid; no record created. | — | — |
| PWD-FLD-034 | All | Edge | Create two credentials with the identical title, username and password. | Both are created (duplicates are allowed) and both reveal correctly and independently. | — | — |
| PWD-FLD-035 | All | Edge | Double-click Save. | Exactly one record created. | — | — |

---

## 3. Business Rule Test Cases

| TC ID | Type | Rule / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| PWD-BR-001 | Security | Create a credential, then inspect the row in the database. | `password_encrypted` is ciphertext of the form `iv:salt:tag:ct`; the plaintext string appears nowhere in the table. | — | — |
| PWD-BR-002 | Security | Open `/passwords` and inspect the list network response. | No `passwordEncrypted` and no plaintext password field is present for any record. | — | — |
| PWD-BR-003 | Security | Click reveal on one credential and inspect that request's response. | Only that single record's plaintext is returned — not the whole collection. | — | — |
| PWD-BR-004 | Positive | Reveal a credential and compare against the value entered at creation. | Byte-for-byte identical (encryption round-trip is lossless). | — | — |
| PWD-BR-005 | Positive | Edit a credential **without** touching the password field, then reveal. | The original password is preserved (an untouched field must not blank or re-encrypt to a different value). | — | — |
| PWD-BR-006 | Positive | Edit a credential and change the password, then reveal. | The new password is returned; the old one no longer works anywhere in the UI. | — | — |
| PWD-BR-007 | Negative | As a user with only `canView`, attempt to add/edit/delete. | All three blocked with Forbidden. | — | — |
| PWD-BR-008 | Negative | As a user with **no** `passwords` permission row, open `/passwords`. | Access denied; the nav entry is hidden. | — | — |
| PWD-BR-009 | Negative | As ADMIN_B, attempt to open a TENANT_A credential by its record id. | 403/404; nothing revealed. | — | — |
| PWD-BR-010 | Negative | As ADMIN_B, attempt to edit or delete a TENANT_A credential id. | 403/404; TENANT_A's row is unchanged (verify `updated_at` did not move). | — | — |
| PWD-BR-011 | Positive | Delete a credential. | It disappears from the list and `deleted_at` is set (soft delete); it never reappears after a refresh. | — | — |
| PWD-BR-012 | Business rule | After a soft delete, search for the credential's title. | No hit in the module list or in global search. | — | — |
| PWD-BR-013 | Positive | Create, edit and delete a credential, then open `/audit-logs`. | Three audit entries exist. Verify the details text does **not** contain the password itself. | — | — |
| PWD-BR-014 | Security | Trigger any AI feature while credentials exist (analysis, bulk scan, context). | No password, `passwordEncrypted`, username-as-credential or notes secret is sent to the AI provider (AI Privacy Shield strips these keys). | — | — |
| PWD-BR-015 | Security | Run the Backup export with credentials present. | Confirm how passwords appear in the export (ciphertext vs. plaintext) and that the behaviour is documented. Plaintext export without an explicit user warning ⇒ **S2**. | — | — |
| PWD-BR-016 | Security | Run the Google Drive Zero-Knowledge sync with credentials present. | The Drive file `/DocsNX_Data/passwords.enc.json` contains only client-side-encrypted `ivHex:ciphertextHex` content — no readable password. | — | — |
| PWD-BR-017 | Negative | With the subscription expired, open `/passwords`. | Access blocked; user directed to billing. | — | — |
| PWD-BR-018 | Business rule | Create a credential assigned to QA Child, then log in as QA Child with `canView` on passwords. | Behaviour matches the intended sharing model (record actual: whether tenant-wide visibility or holder-only visibility applies). | — | — |
| PWD-BR-019 | Edge | Change the `ENCRYPTION_SECRET` (test environment only) and reload a previously saved credential. | Reveal fails gracefully with an error — the app must not crash or return garbage as if it were the password. Restore the original secret afterwards. | — | — |
| PWD-BR-020 | Edge | Create 200 credentials and open the list. | Pagination keeps the page responsive; no timeout; masked values still enforced on every page. | — | — |

---

## 4. End-to-End Workflow Test Cases

| TC ID | Workflow | Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| PWD-E2E-001 | Create → reveal → copy | 1. Add "Google Main Account" (category personal, URL, username, password `SecretPassword123`).<br>2. Reveal it.<br>3. Copy it and paste into a text field. | Record created; revealed value equals `SecretPassword123`; clipboard content matches exactly. | — | — |
| PWD-E2E-002 | Rotate a password | 1. Open an existing credential → Edit.<br>2. Change only the password.<br>3. Save, reload, reveal. | The new password is shown; DB ciphertext changed; `updated_at` advanced; an audit entry exists. | — | — |
| PWD-E2E-003 | Metadata-only edit | 1. Edit a credential changing only the title and URL.<br>2. Save and reveal. | Password unchanged; title/URL updated. | — | — |
| PWD-E2E-004 | Category workflow | 1. Create one credential in each of the five categories.<br>2. Use each filter tab.<br>3. Combine a filter with a search term. | Each tab shows only its own category; the combined filter+search returns only records matching both. | — | — |
| PWD-E2E-005 | Permission restriction | 1. Give USER_A2 `canView` only on passwords.<br>2. Log in as USER_A2.<br>3. Attempt add/edit/delete. | List is readable; every mutation is refused; no controls rendered. | — | — |
| PWD-E2E-006 | Cross-tenant probe | 1. Create "Bank Login A" in TENANT_A; capture its id from the DB.<br>2. Log in as ADMIN_B.<br>3. Attempt to open/reveal/edit/delete that id.<br>4. Search "Bank Login A" globally. | All four attempts fail with 403/404 and no data disclosure. | — | — |
| PWD-E2E-007 | Soft-delete lifecycle | 1. Create a credential.<br>2. Delete it.<br>3. Verify it is gone from the list, search and dashboard counts.<br>4. Inspect the DB. | Row still exists with `deleted_at` set; invisible everywhere in the UI. | — | — |
| PWD-E2E-008 | Encryption round-trip under stress | 1. Create credentials whose passwords contain colons, unicode, emoji, newlines and 1 000 characters.<br>2. Reveal each. | Every value round-trips exactly; no parse errors in the console or server logs. | — | — |
| PWD-E2E-009 | Vault in Zero-Knowledge sync | 1. Enable Google Drive sync.<br>2. Sync the passwords module.<br>3. Download `/DocsNX_Data/passwords.enc.json` from Drive and open it. | The file contains only `ivHex:ciphertextHex` payloads; no title/username/password is readable without the passphrase. | — | — |

---

## 5. Database Validation Test Cases

| TC ID | Validation Point | SQL Query | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| PWD-DB-001 | Row created with correct tenant & owner (P1) | `SELECT tenant_id, user_id, title, category, username FROM passwords WHERE id = ':record_id';` | `tenant_id = :tenant_a`; the values entered | — | — |
| PWD-DB-002 | Password stored as ciphertext (P5) | `SELECT password_encrypted ~ '^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$' AS is_ciphertext FROM passwords WHERE id = ':record_id';` | `t` | — | — |
| PWD-DB-003 | Plaintext password never stored | `SELECT count(*) FROM passwords WHERE password_encrypted = 'SecretPassword123';` | `0` | — | — |
| PWD-DB-004 | No plaintext password leaks into other columns | `SELECT count(*) FROM passwords WHERE notes LIKE '%SecretPassword123%' OR title LIKE '%SecretPassword123%' OR username LIKE '%SecretPassword123%';` | `0` (unless deliberately typed there by the tester) | — | — |
| PWD-DB-005 | Two identical passwords produce different ciphertexts | Create two credentials with the same password, then: `SELECT count(DISTINCT password_encrypted) FROM passwords WHERE tenant_id = ':tenant_a' AND title IN ('Dup1','Dup2');` | `2` — random IV/salt per encryption | — | — |
| PWD-DB-006 | Ciphertext changes when the password is rotated | Capture `password_encrypted`, rotate via the UI, re-query. | The two values differ | — | — |
| PWD-DB-007 | Ciphertext is stable when only metadata is edited | Capture `password_encrypted`, edit only the title, re-query. | Confirm reveal still returns the original password; note whether the ciphertext string itself was rewritten | — | — |
| PWD-DB-008 | Audit timestamps (P2) | `SELECT created_at IS NOT NULL, updated_at IS NOT NULL, updated_at >= created_at FROM passwords WHERE id = ':record_id';` | `t, t, t` | — | — |
| PWD-DB-009 | Soft delete (P3) | `SELECT id, deleted_at FROM passwords WHERE id = ':record_id';` | Row present with a non-null `deleted_at` | — | — |
| PWD-DB-010 | Soft-deleted rows excluded from the UI count | `SELECT count(*) FROM passwords WHERE tenant_id = ':tenant_a' AND deleted_at IS NULL;` | Matches the number of cards shown in `/passwords` | — | — |
| PWD-DB-011 | Audit log written for each mutation (P4) | `SELECT action, details FROM audit_logs WHERE tenant_id = ':tenant_a' AND action ILIKE '%PASSWORD%' ORDER BY created_at DESC LIMIT 3;` | Three rows (create/update/delete) | — | — |
| PWD-DB-012 | Audit details contain no secret | `SELECT count(*) FROM audit_logs WHERE tenant_id = ':tenant_a' AND details LIKE '%SecretPassword123%';` | `0` | — | — |
| PWD-DB-013 | Owner belongs to the same tenant | `SELECT count(*) FROM passwords p JOIN users u ON u.id = p.user_id WHERE p.tenant_id <> u.tenant_id;` | `0` | — | — |
| PWD-DB-014 | Holder belongs to the same tenant | `SELECT count(*) FROM passwords p JOIN users u ON u.id = p.holder_id WHERE p.tenant_id <> u.tenant_id;` | `0` | — | — |
| PWD-DB-015 | Cross-tenant isolation (P7) | `SELECT count(*) FROM passwords WHERE id = ':record_id' AND tenant_id = ':tenant_b';` | `0` | — | — |
| PWD-DB-016 | No row without a tenant | `SELECT count(*) FROM passwords WHERE tenant_id IS NULL;` | `0` | — | — |
| PWD-DB-017 | Every password row has ciphertext (no empty/legacy plaintext) | `SELECT count(*) FROM passwords WHERE password_encrypted IS NULL OR password_encrypted = '' OR password_encrypted !~ '^[0-9a-f]+:';` | `0` | — | — |
| PWD-DB-018 | Custom fields stored as an array | `SELECT jsonb_typeof(custom_fields), jsonb_array_length(custom_fields) FROM passwords WHERE id = ':record_id';` | `array`, count matching the pairs entered | — | — |
| PWD-DB-019 | Long password stored without truncation | Save a 1 000-char password, then: `SELECT length(password_encrypted) FROM passwords WHERE id = ':record_id';` | Ciphertext length grows proportionally; reveal returns all 1 000 characters | — | — |
| PWD-DB-020 | Category values constrained to the known set | `SELECT DISTINCT category FROM passwords WHERE tenant_id = ':tenant_a';` | Only `personal`, `social`, `bank`, `business`, `other` (or NULL) | — | — |
| PWD-DB-021 | Cross-tenant edit attempt did not mutate the row | Capture `updated_at` before the PWD-BR-010 probe and re-query afterwards. | Unchanged | — | — |
