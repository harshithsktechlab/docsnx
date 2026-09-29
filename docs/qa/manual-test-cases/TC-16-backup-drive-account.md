# TC-16 — Backup & Export · Google Drive Zero-Knowledge Sync · Account Data & Deletion

**Prefixes:** `BKP`, `ZKD`, `ACC` · **Routes:** `/backup`, `/profile` (danger zone), onboarding step 2
**Tables:** every tenant-scoped table (read), `tenants` (Drive tokens), `audit_logs`

---

# PART A — Backup & Export (`BKP`)

## Module Reference

| Aspect | Detail |
|---|---|
| Route | `/backup` |
| Export contents | `version: "2.0"`, `tenantId`, `exportDate`, and a `data` object keyed by module: `users` (with nested profiles), `documents`, `medicalRecords`, `passwords`, `bankInfos`, `tradingDemats`, `vehicles`, `licMediclaims`, `investments`, `emergencyContacts`, `warrantyAmcs`, `contractAgreements`, `todos`, `taxCompliances`, `willsEstates`, `loansDebts`, `utilityBills`, `corporateCompliances`, `employmentPayrolls` — **19 module keys** |
| Access | Tenant users only. `SUPER_ADMIN` is refused with *"Super Admin cannot export tenant data"* |
| Scope | Every query is filtered by the session tenant |
| Client crypto | The page imports `deriveZeroKnowledgeKey` / `encryptZeroKnowledge` — an optional passphrase-encrypted export |
| Restore | A restore/import path exists ("Database restored successfully! All records have been synchronized.") |

## A1. UI Validation

| TC ID | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| BKP-UI-001 | Positive | Open `/backup`. | Export and restore cards render with clear explanations of what each does. | — | — |
| BKP-UI-002 | Positive | Click Export. | Button shows a loading state; a `.json` file downloads with a sensible default name. | — | — |
| BKP-UI-003 | Negative | Trigger an export failure (offline). | Error message "Failed to export data. Please try again."; the button re-enables. | — | — |
| BKP-UI-004 | Positive | Export on an empty tenant. | A valid JSON file downloads with all 19 module keys present as empty arrays — not a truncated or malformed file. | — | — |
| BKP-UI-005 | Positive | Inspect the passphrase option (if offered). | A passphrase field is shown with an explanation that the export cannot be recovered without it. | — | — |
| BKP-UI-006 | Positive | Export **with** a passphrase. | The downloaded file is opaque ciphertext; opening it in a text editor reveals no record data. | — | — |
| BKP-UI-007 | Positive | Import/restore a previously exported file. | Progress feedback; success message "Database restored successfully! All records have been synchronized." | — | — |
| BKP-UI-008 | Negative | Import a malformed/truncated JSON file. | A clear validation error; **no partial restore**; existing data untouched. | — | — |
| BKP-UI-009 | Negative | Import a file from **another tenant** (change `tenantId` inside the file). | Rejected, or imported strictly under the current tenant. Data landing under the foreign `tenantId` ⇒ **S1**. | — | — |
| BKP-UI-010 | Negative | Import an encrypted export with the wrong passphrase. | A clear decryption-failed message; nothing is written. | — | — |
| BKP-UI-011 | Positive | View `/backup` at 375px. | Cards stack; buttons remain reachable; no horizontal page scroll. | — | — |
| BKP-UI-012 | Negative | Log in as SUPER_ADMIN and attempt an export. | Refused with *"Super Admin cannot export tenant data"*. | — | — |

## A2. Business Rules

| TC ID | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| BKP-BR-001 | Positive | Populate all 19 modules, then export. | The file contains all 19 keys, each with the correct row count. | — | — |
| BKP-BR-002 | **Security** | Search the exported file for `passwordHash`. | **Absent for every user.** A `passwordHash` in an export is **S1**. | — | — |
| BKP-BR-003 | Security | Search the exported file for a known plaintext vault password. | Absent. Record whether `passwordEncrypted` is exported as ciphertext (acceptable) or decrypted (⇒ **S2** unless the export is itself passphrase-encrypted and clearly labelled). | — | — |
| BKP-BR-004 | Security | Search the exported file for a known bank account number, card number, CVV, client ID and PAN. | Account/card/client values appear only as ciphertext or masked; **no CVV** anywhere. | — | — |
| BKP-BR-005 | **Security** | Populate TENANT_B, then export from TENANT_A. | The file contains **zero** TENANT_B rows; every `tenantId` inside equals TENANT_A. | — | — |
| BKP-BR-006 | Business rule | Soft-delete some records, then export. | Record actual — the export does not filter on `deleted_at`, so deleted rows are likely included. Confirm whether that is intended (an archive) and that the UI says so. | — | — |
| BKP-BR-007 | Business rule | Export, then delete a record, then restore the export. | The deleted record returns. Confirm restore semantics (merge vs. replace) are documented and match the UI copy. | — | — |
| BKP-BR-008 | Edge | Restore the same file twice. | No duplicate rows (idempotent restore), or a clear warning. Silent duplication ⇒ **S3**. | — | — |
| BKP-BR-009 | Edge | Export a tenant with ~5 000 records across modules. | The export completes without timeout; the file is complete and valid JSON. | — | — |
| BKP-BR-010 | Negative | Export as a `STANDARD` user. | Record actual — confirm whether a standard member can export the all members vault. If so, verify it is intended; unrestricted export by a low-privilege member ⇒ **S2**. | — | — |
| BKP-BR-011 | Positive | Export and check `/audit-logs`. | An audit entry records the export (who and when) — a data-export event should always be auditable. Missing entry ⇒ **S2**. | — | — |
| BKP-BR-012 | Negative | Subscription expired → attempt an export. | Record actual — confirm the intended behaviour (users should generally retain the ability to take their data out). | — | — |

## A3. Database Validation

| TC ID | Validation Point | SQL Query | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| BKP-DB-001 | Export row counts match the DB — documents | `SELECT count(*) FROM documents WHERE tenant_id = ':tenant_a';` | Equals the length of `data.documents` in the export | — | — |
| BKP-DB-002 | …passwords | `SELECT count(*) FROM passwords WHERE tenant_id = ':tenant_a';` | Equals `data.passwords.length` | — | — |
| BKP-DB-003 | …bank infos | `SELECT count(*) FROM bank_infos WHERE tenant_id = ':tenant_a';` | Equals `data.bankInfos.length` | — | — |
| BKP-DB-004 | …all remaining 16 modules | Repeat the pattern for `medical_records`, `trading_demats`, `vehicles`, `lic_mediclaims`, `investments`, `emergency_contacts`, `warranty_amcs`, `contract_agreements`, `todos`, `tax_compliances`, `wills_estates`, `loans_debts`, `utility_bills`, `corporate_compliances`, `employment_payrolls`, `users` | Each count equals the matching array length | — | — |
| BKP-DB-005 | Users exported with nested profiles | `SELECT count(*) FROM users u JOIN profiles p ON p.user_id = u.id WHERE u.tenant_id = ':tenant_a';` | Every exported user object carries its `profile` | — | — |
| BKP-DB-006 | No cross-tenant rows in the export | `SELECT count(*) FROM documents WHERE tenant_id = ':tenant_b';` | Whatever this returns, none of those ids appear in TENANT_A's export | — | — |
| BKP-DB-007 | Restore writes under the session tenant only | After restoring a file whose `tenantId` was edited to TENANT_B: `SELECT DISTINCT tenant_id FROM documents WHERE created_at > now() - interval '5 minutes';` | Only `:tenant_a` | — | — |
| BKP-DB-008 | Restore does not duplicate rows | Restore twice, then: `SELECT name, count(*) FROM documents WHERE tenant_id = ':tenant_a' GROUP BY name HAVING count(*) > 1;` | 0 rows (or a documented, intentional result) | — | — |
| BKP-DB-009 | Encrypted columns stay encrypted after restore | `SELECT account_number ~ '^[0-9a-f]+:' AS is_ciphertext FROM bank_infos WHERE tenant_id = ':tenant_a' ORDER BY created_at DESC LIMIT 1;` | `t` — restore must not write plaintext into an encrypted column | — | — |
| BKP-DB-010 | Export audit entry | `SELECT action, details FROM audit_logs WHERE tenant_id = ':tenant_a' ORDER BY created_at DESC LIMIT 1;` | An entry describing the export | — | — |

---

# PART B — Google Drive Zero-Knowledge Sync (`ZKD`)

## Module Reference

| Aspect | Detail |
|---|---|
| Contract | The **browser** encrypts each module with `clientCrypto` (PBKDF2, 100 000 iterations, SHA-256 → AES-256-GCM) and sends `{ moduleName: "ivHex:ciphertextHex" }`. The server relays ciphertext only — it never reads or writes plaintext |
| Payload validation | Each value must match `^[0-9a-fA-F]+:[0-9a-fA-F]+$`; anything else is rejected |
| Destination | `/DocsNX_Data/<module>.enc.json` on the **tenant's own** Google Drive (BYOD) |
| Module files | `manifest`, `passwords`, `medical`, `lic_mediclaim`, `bank_info`, `investments`, `documents`, `trading_demats`, `vehicles`, `warranty_amcs`, `contract_agreements`, `emergency_contacts`, `todos`, `tax_compliance`, `wills_estate`, `loans_debt`, `utility_bills`, `corporate_compliance`, `employment_payroll` — **18 modules + manifest** |
| Preconditions | `tenants.google_drive_enabled = true` **and** readable `google_drive_tokens`; otherwise `DRIVE_NOT_CONNECTED` (HTTP 400) |
| Quota | A Drive quota error (message contains "quota", or HTTP 403/507) returns `QUOTA_EXCEEDED` and prompts the user |
| Side effect | Drive-enabled tenants get **unlimited** platform storage (the plan quota check is bypassed) |

## B1. UI Validation

| TC ID | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| ZKD-UI-001 | Positive | Open the Drive connection UI (onboarding step 2 or settings). | "Connect Google Drive" CTA with an explanation of zero-knowledge storage. | — | — |
| ZKD-UI-002 | Positive | Click Connect and complete the Google OAuth consent. | Redirected back to the app; Drive shows as connected. | — | — |
| ZKD-UI-003 | Negative | Cancel/deny the Google consent screen. | Returns to the app with a clear "not connected" state; no tokens stored; no error page. | — | — |
| ZKD-UI-004 | Positive | Trigger a sync with Drive connected. | Progress feedback per module; a summary of which modules synced. | — | — |
| ZKD-UI-005 | Negative | Trigger a sync **without** Drive connected. | Message: *"Tenant has not connected their personal Google Drive for BYOD storage."* | — | — |
| ZKD-UI-006 | Negative | Trigger a sync with corrupted/expired Drive tokens. | *"Google Drive credentials could not be read. Please reconnect Google Drive."* with a reconnect CTA. | — | — |
| ZKD-UI-007 | Negative | Trigger a sync against a Drive account that is out of space. | A `QUOTA_EXCEEDED` message with guidance (free space or fall back to platform storage) — not a generic 500. | — | — |
| ZKD-UI-008 | Positive | Ask the user for the Zero-View passphrase before sync. | The passphrase is requested, never pre-filled, and never sent to the server. | — | — |
| ZKD-UI-009 | Positive | Disconnect Drive. | Confirmation dialog explaining that new uploads revert to platform storage and the plan quota applies again. | — | — |
| ZKD-UI-010 | Positive | View the sync UI at 375px. | Fully usable; module list scrolls in its own container. | — | — |

## B2. Business Rules

| TC ID | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| ZKD-BR-001 | **Security** | Complete a sync, then open one of the `.enc.json` files directly in Google Drive. | The content is a single `ivHex:ciphertextHex` string. **No record title, name, number or note is readable.** Any readable field ⇒ **S1**. | — | — |
| ZKD-BR-002 | **Security** | Capture the sync request payload in DevTools. | Every module value matches `^[0-9a-fA-F]+:[0-9a-fA-F]+$`. No plaintext record JSON is sent to the server. | — | — |
| ZKD-BR-003 | Negative | Send a sync payload with a plaintext (non-hex) value (manipulated in DevTools). | Rejected by the server's `ZK_CIPHERTEXT` check; nothing is written to Drive. | — | — |
| ZKD-BR-004 | Negative | Send a payload with a malformed ciphertext (missing the colon, or non-hex characters). | Rejected; no Drive write. | — | — |
| ZKD-BR-005 | Positive | Sync all 18 modules. | 18 `.enc.json` files plus `manifest.enc.json` appear under `/DocsNX_Data/`. | — | — |
| ZKD-BR-006 | Positive | Sync a subset of modules. | Only those files are written/updated; other module files are left untouched. | — | — |
| ZKD-BR-007 | Positive | Sync twice. | Files are **overwritten in place**, not duplicated as `passwords (1).enc.json`. | — | — |
| ZKD-BR-008 | Positive | Sync an empty module. | A valid encrypted file representing an empty set is written — no error, no zero-byte file. | — | — |
| ZKD-BR-009 | Business rule | Enable Drive, then upload a file that exceeds the plan storage quota. | Allowed — Drive-enabled tenants bypass the quota check. | — | — |
| ZKD-BR-010 | Business rule | Disable Drive, then retry the same oversized upload. | Blocked by the plan quota again. | — | — |
| ZKD-BR-011 | Security | Verify that TENANT_A's sync writes only to TENANT_A's Drive account. | TENANT_B's Drive is untouched; a sync from TENANT_A cannot target TENANT_B's tokens. | — | — |
| ZKD-BR-012 | Security | Inspect `/api/auth/me` and every page payload after connecting Drive. | Drive access/refresh tokens never appear client-side. | — | — |
| ZKD-BR-013 | Positive | Sync and check `/audit-logs`. | An audit entry records the sync (modules and outcome). | — | — |
| ZKD-BR-014 | Edge | Revoke the app's access from the Google account, then sync. | A clear reconnect message; no crash; the stored token state reflects the failure. | — | — |
| ZKD-BR-015 | Edge | Sync a very large module (thousands of records). | Completes or fails cleanly with a size/quota message — never a silent partial write. | — | — |
| ZKD-BR-016 | Security | Restore from a Drive file using the **wrong** passphrase. | Decryption fails in the browser with a clear message; nothing is written to the database. | — | — |
| ZKD-BR-017 | Positive | Restore from a Drive file using the **correct** passphrase. | Records decrypt in the browser and match the originals byte-for-byte. | — | — |

## B3. Database Validation

| TC ID | Validation Point | SQL Query | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| ZKD-DB-001 | Drive connection persisted | `SELECT google_drive_enabled, google_drive_tokens IS NOT NULL AS has_tokens FROM tenants WHERE id = ':tenant_a';` | `t`, `t` after connecting | — | — |
| ZKD-DB-002 | Disconnect clears the state | After disconnecting: same query. | `f` and/or tokens cleared | — | — |
| ZKD-DB-003 | Tokens are not stored as readable plaintext in any client-visible place | Inspect `/api/auth/me` and the page source. | No `access_token` / `refresh_token` string present | — | — |
| ZKD-DB-004 | Sync writes nothing plaintext to the database | `SELECT count(*) FROM audit_logs WHERE tenant_id = ':tenant_a' AND details LIKE '%SecretPassword123%';` | `0` | — | — |
| ZKD-DB-005 | Storage bypass for Drive tenants | `SELECT google_drive_enabled FROM tenants WHERE id = ':tenant_a';` while uploading past the plan quota | `t` — and the upload succeeds | — | — |
| ZKD-DB-006 | Sync audit entry | `SELECT action, details FROM audit_logs WHERE tenant_id = ':tenant_a' ORDER BY created_at DESC LIMIT 1;` | An entry describing the Drive sync | — | — |
| ZKD-DB-007 | Cross-tenant Drive isolation | `SELECT id, google_drive_enabled FROM tenants WHERE id IN (':tenant_a', ':tenant_b');` | Each tenant's Drive state is independent; TENANT_A's sync never mutates TENANT_B's row | — | — |
| ZKD-DB-008 | Restore writes under the session tenant only | After a Drive restore: `SELECT DISTINCT tenant_id FROM passwords WHERE created_at > now() - interval '5 minutes';` | Only `:tenant_a` | — | — |

---

# PART C — Account Data Export & Deletion (`ACC`)

## Module Reference

| Aspect | Detail |
|---|---|
| Data export | A DPDPA "right to access" export of the account's data |
| **Account deletion** | `TENANT_ADMIN` only, from **Settings → Account → Danger zone**. Requires the workspace name to be typed back exactly; the API rejects a mismatch with 400. Performs a **hard delete of the tenant row**, which cascades to users, profiles, permissions and every tenant-scoped table (DPDPA Right to Erasure). Non-admins are refused with *"Only Tenant Admins can delete the account."* |
| **Beyond Postgres** | The `/DocsNX_Data` folder in the tenant's Google Drive is deleted **permanently** (not trashed), legacy root `DocsNX_Data_*.enc.json` files are deleted, legacy `/uploads` files are unlinked and the Drive OAuth grant is revoked. Failures here are logged with an `[erasure]` prefix and do **not** abort the deletion. |
| **Retention** | One `deleted_accounts` row per member — name (encrypted), phone number (encrypted), email (cleartext), tenant id/name, `erased_at`. Nothing else survives. No backup of documents is taken or kept. |
| Irreversibility | There is no soft-delete, no recovery window and no backup — the data is permanently erased, including Drive's 30-day bin |

## C1. Test Cases

| TC ID | Category | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|---|
| ACC-UI-001 | UI | Positive | Open the account danger zone. | Deletion is visually separated (danger styling) with an unambiguous warning that the erasure is permanent and covers all members data. | — | — |
| ACC-UI-002 | UI | Positive | Click Delete Account. | A dialog opens; the confirm button stays **disabled** until the workspace name is typed back exactly. Not a single click. | — | — |
| ACC-UI-002b | UI | Negative | Type a near-miss of the workspace name (wrong case / trailing word) and confirm. | The button stays disabled. If the request is forced via the API, it is refused with 400 *"The workspace name does not match…"* and nothing is deleted. | — | — |
| ACC-UI-002c | UI | Positive | Read the danger-zone copy before confirming. | It states plainly that Drive files are deleted permanently, that **no backup is kept**, and that only name, phone number and email are retained. | — | — |
| ACC-UI-003 | UI | Positive | Cancel the confirmation. | Nothing is deleted; the user stays on the page. | — | — |
| ACC-UI-004 | UI | Positive | Confirm deletion. | Success message *"Account and all associated data have been permanently erased."*; the session ends; the user is returned to a public page. | — | — |
| ACC-UI-005 | UI | Negative | Attempt deletion as a `STANDARD` user. | Refused — *"Only Tenant Admins can delete the account."*; the control is hidden or disabled for non-admins. | — | — |
| ACC-UI-006 | UI | Positive | Trigger the account data export. | A complete data file downloads; the export is offered **before** deletion in the UI flow. | — | — |
| ACC-UI-007 | UI | Positive | View the danger zone at 375px. | Warning text is fully legible; the confirm control is reachable. | — | — |
| ACC-BR-001 | Business | Positive | Delete the account, then attempt to log in with the admin credentials. | Login fails — the user row is gone. | — | — |
| ACC-BR-002 | Business | Positive | Delete the account, then attempt to log in as a member of that tenant. | Login fails — all users cascaded. | — | — |
| ACC-BR-003 | Business | **Security** | As ADMIN_A, delete the account and immediately verify TENANT_B. | TENANT_B is completely unaffected — every row intact and login working. Any collateral deletion ⇒ **S1**. | — | — |
| ACC-BR-004 | Business | Business rule | Delete an account holding records across all 19 modules. | Every row for that tenant is gone; no orphan rows remain in any table. | — | — |
| ACC-BR-005 | Business | **Security** | Delete an account with uploaded files. | The `/DocsNX_Data` folder is gone from the Google account **and absent from its bin** (permanent delete); legacy `/uploads` files are unlinked from disk. Files left behind and still fetchable ⇒ **S1**. | — | — |
| ACC-BR-005b | Business | **Security** | After deletion, check the Google account's third-party access list. | DocsNX no longer appears / the grant is revoked. A live token to an ex-customer's Drive ⇒ **S1**. | — | — |
| ACC-BR-005c | Business | Edge | Revoke the Drive grant from Google **first**, then delete the account. | Deletion still completes (no 500). The orphaned Drive files are logged with an `[erasure]` prefix; only the user can remove them now. | — | — |
| ACC-BR-005d | Business | Edge | Disconnect Google Drive in Settings, then delete the account. | Deletion completes with no Drive work attempted and no error. | — | — |
| ACC-BR-006 | Business | Business rule | Delete an account with an active paid subscription. | Deletion proceeds; confirm the intended handling of the outstanding subscription/invoices and that the user is warned. | — | — |
| ACC-BR-007 | Business | Business rule | Delete an account, then re-register with the same email. | Blocked or allowed per the trial rule — the email remains in `trial_used_emails`, so no fresh trial is granted. | — | — |
| ACC-BR-008 | Business | Edge | Delete the account while a second admin is logged in on another browser. | The second session becomes invalid on its next request; no partial access to deleted data. | — | — |
| ACC-BR-009 | Business | Positive | Check the audit trail after deletion. | `audit_logs` cascades with the tenant, so the tenant's own log is gone by design. The platform-level record is the `deleted_accounts` rows — one per member. None at all ⇒ **S2** (unauditable erasure). | — | — |
| ACC-BR-010 | Business | **Privacy** | Inspect a `deleted_accounts` row. | Exactly one row per member holding tenant id/name, name, phone, email, role, `erased_at`. `name` and `phone_number` are ciphertext (`iv:salt:tag:ct`), never plaintext. No document, record or password data anywhere in the table ⇒ any ⇒ **S1**. | — | — |
| ACC-DB-001 | DB | Tenant row removed | `SELECT count(*) FROM tenants WHERE id = ':tenant_a';` | `0` | — | — |
| ACC-DB-002 | DB | Users cascaded | `SELECT count(*) FROM users WHERE tenant_id = ':tenant_a';` | `0` | — | — |
| ACC-DB-003 | DB | Profiles cascaded | `SELECT count(*) FROM profiles p LEFT JOIN users u ON u.id = p.user_id WHERE u.id IS NULL;` | `0` — no orphan profiles | — | — |
| ACC-DB-004 | DB | Permissions cascaded | `SELECT count(*) FROM permissions p LEFT JOIN users u ON u.id = p.user_id WHERE u.id IS NULL;` | `0` | — | — |
| ACC-DB-005 | DB | All 19 vault tables cleared | For each table: `SELECT count(*) FROM <table> WHERE tenant_id = ':tenant_a';` | `0` for every one | — | — |
| ACC-DB-006 | DB | Billing rows cascaded | `SELECT count(*) FROM payments WHERE tenant_id = ':tenant_a';` and the same for `invoices`, `tenant_addons`, `discount_usages`, `tenant_ai_usages`, `ai_analysis_cache`, `user_devices`, `notifications` | `0` for all | — | — |
| ACC-DB-007 | DB | Audit logs cascaded | `SELECT count(*) FROM audit_logs WHERE tenant_id = ':tenant_a';` | `0` | — | — |
| ACC-DB-008 | DB | **Other tenants untouched** | `SELECT count(*) FROM users WHERE tenant_id = ':tenant_b';` and `SELECT count(*) FROM documents WHERE tenant_id = ':tenant_b';` | Both equal their pre-deletion values | — | — |
| ACC-DB-009 | DB | No orphan rows platform-wide | `SELECT count(*) FROM documents d LEFT JOIN tenants t ON t.id = d.tenant_id WHERE t.id IS NULL;` (repeat for other tenant tables) | `0` for every table | — | — |
| ACC-DB-010 | DB | Trial email retained | `SELECT count(*) FROM trial_used_emails WHERE email = ':email_a';` | `1` — the trial record intentionally survives tenant deletion | — | — |
| ACC-DB-011 | DB | Deletion is a hard delete, not a soft delete | `SELECT count(*) FROM tenants WHERE id = ':tenant_a' AND deleted_at IS NOT NULL;` | `0` — the row does not exist at all | — | — |
| ACC-DB-012 | DB | Retention row written | `SELECT count(*) FROM deleted_accounts WHERE tenant_id = ':tenant_a';` | Equals the number of members the workspace had | — | — |
| ACC-DB-013 | DB | Retention row survives the cascade | Run ACC-DB-012 **after** confirming ACC-DB-001 returns `0`. | Still non-zero — the table has no FK to `tenants` on purpose | — | — |
| ACC-DB-014 | DB | Retained PII is encrypted | `SELECT name, phone_number, email FROM deleted_accounts WHERE tenant_id = ':tenant_a';` | `name`/`phone_number` are ciphertext; `email` is cleartext by design (matches `trial_used_emails`) | — | — |
| ACC-DB-015 | DB | Re-registration is not blocked | Delete the account, then register again with the same email. | Succeeds — but on **no** plan with `subscription_expiry = now()`, because `trial_used_emails` survived (ACC-DB-010) | — | — |

---

## End-to-End Workflows

| TC ID | Workflow | Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| BDA-E2E-001 | Full backup round-trip | 1. Populate all 19 modules in TENANT_A.<br>2. Export the backup and note the row counts.<br>3. Delete 5 records across 3 modules.<br>4. Restore the export.<br>5. Compare each module's counts with step 2. | Counts return to the pre-deletion values; no duplicates; encrypted columns remain encrypted. | — | — |
| BDA-E2E-002 | Zero-knowledge Drive round-trip | 1. Connect Google Drive.<br>2. Sync all 18 modules with a passphrase.<br>3. Open three `.enc.json` files directly in Drive.<br>4. Restore one module with the correct passphrase.<br>5. Attempt a restore with the wrong passphrase. | Files are unreadable in Drive; the correct-passphrase restore reproduces the records exactly; the wrong passphrase fails cleanly with nothing written. | — | — |
| BDA-E2E-003 | Storage-quota interaction | 1. On a small-storage plan, fill the quota and confirm uploads are blocked.<br>2. Connect Google Drive.<br>3. Retry the upload.<br>4. Disconnect Drive and retry again. | Blocked → allowed → blocked, matching the documented bypass rule. | — | — |
| BDA-E2E-004 | Export-before-delete (DPDPA) | 1. Export the account data.<br>2. Verify the export is complete and readable.<br>3. Delete the account.<br>4. Attempt to log in.<br>5. Verify TENANT_B is untouched. | The user leaves with a complete copy of their data; the account and all its rows are permanently erased; the other tenant is unaffected. | — | — |
| BDA-E2E-005 | Cross-tenant export isolation | 1. Populate both TENANT_A and TENANT_B with similarly named records.<br>2. Export from each.<br>3. Diff the two files. | Neither export contains a single row belonging to the other tenant. | — | — |
| BDA-E2E-006 | Secret-leak sweep on export | 1. Create a vault password, a bank account, a credit card, a trading account and a profile PAN.<br>2. Export.<br>3. Grep the file for the known plaintext values and for `passwordHash`. | No `passwordHash`; no CVV; sensitive identifiers appear only as ciphertext or masked. | — | — |
