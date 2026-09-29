# TC-09 — Wealth: Bank Accounts · Credit Cards · Trading & Demat

**Prefixes:** `BNK`, `CRD`, `TRD` · **Routes:** `/bank-info`, `/trading`
**Tables:** `bank_infos`, `credit_cards`, `trading_demats`
**Permission keys:** `bank_info` (covers both bank accounts and credit cards), `trading`

> ⚠️ These are the most security-sensitive record modules in the product. Every masking,
> encryption and isolation case below should be treated as **S1** if it fails.

---

# PART A — Bank Accounts (`BNK`)

## Module Reference

| Aspect | Detail |
|---|---|
| Required fields | Bank Name*, Account Number*, IFSC Code* (client message: "Bank Name, Account Number, and IFSC Code are required") |
| Optional | Account Type, Branch, Customer ID, Net Banking Username, Cards[], Custom Fields[], Assigned Member |
| Server validation | `bankName` 1–255 · `accountNumber` 1–100 · `ifscCode` 1–50 · `accountType` ≤100 · `branch` ≤255 · `customerId` ≤100 · `netBankingUsername` ≤255 · `userId` must be a UUID |
| Account types | `savings`, `current`, `nre`, `nro`, `other` |
| Encrypted at rest | `account_number`, `customer_id`, `net_banking_username`, `cards` (whole JSON blob) |
| Blind index | `account_number_hash` for exact-match lookup |
| List masking | Account number → `••••1234` (`maskTail`); Customer ID → `maskTail`; Net Banking Username → `ra••••` (`maskUsername`); card numbers → `•••• •••• •••• 1234`; `account_number_hash` is stripped from the response |
| Full reveal | Only from the single-record view (`/bank-info/[id]`) |

## A1. UI Validation

| TC ID | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| BNK-UI-001 | Positive | Open `/bank-info` empty and populated. | Empty state with CTA; populated view shows bank name, masked account number, account type, IFSC, branch. | — | — |
| BNK-UI-002 | Positive | Inspect the account number in the list. | Masked to the last 4 digits (`••••1234`) — the full number is never visible in the list. | — | — |
| BNK-UI-003 | Positive | Inspect the Customer ID and Net Banking Username in the list. | Customer ID masked to the last 4; username masked as first-2-then-dots (`us••••`). | — | — |
| BNK-UI-004 | Positive | Open a record's detail/edit view. | Full account number, customer ID and net-banking username are revealed. | — | — |
| BNK-UI-005 | Positive | Inspect a linked card in the list. | Card number shows as `•••• •••• •••• 1234`; CVV renders as fixed dots and is never a real value. | — | — |
| BNK-UI-006 | Positive | Open the Add dialog. | Bank Name, Account Number, Account Type select, IFSC, Branch, Customer ID, Net Banking Username, Cards sub-form, Custom Fields, Assigned Member. | — | — |
| BNK-UI-007 | Positive | Add a card in the sub-form (Card Number, Cardholder Name, Expiry MM/YY, CVV). | The card is appended to the record's card list; the form clears for the next card. | — | — |
| BNK-UI-008 | Negative | Click "Add Card" with any card field empty. | Toast "Please fill in all card details first."; no card appended. | — | — |
| BNK-UI-009 | Positive | Remove a card from the sub-form. | Only that card is removed; the others are untouched. | — | — |
| BNK-UI-010 | Positive | Search "by Bank Name or account". | Live filtering on bank name; an exact full account number also matches via the blind index. | — | — |
| BNK-UI-011 | Edge | Search a **partial** account number (e.g. the middle 4 digits). | No match expected — encrypted columns cannot be substring-searched. Record actual. | — | — |
| BNK-UI-012 | Positive | Use the account-type filter. | Filters to savings / current / NRE / NRO / other correctly. | — | — |
| BNK-UI-013 | Positive | Edit / Delete a record. | Edit pre-fills all fields with revealed plaintext; Delete confirms first; on failure a toast "Network error deleting record" and the row remains. | — | — |
| BNK-UI-014 | Positive | View at 375px. | Cards stack; long numbers wrap; the CVV/card row does not overflow the viewport. | — | — |
| BNK-UI-015 | Positive | As a view-only user, open `/bank-info`. | Add/Edit/Delete hidden; masked values still shown; confirm whether reveal is permitted and that it matches policy. | — | — |

## A2. Field Validation

| TC ID | Field | Type | Input / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|---|
| BNK-FLD-001 | Required trio | Negative | Submit with Bank Name, Account Number and IFSC all blank. | "Please fill in required fields (Bank Name, Account Number, and IFSC)". | — | — |
| BNK-FLD-002 | Bank Name | Negative | Blank with the others filled. | Rejected. | — | — |
| BNK-FLD-003 | Bank Name | Boundary | 255 / 256 characters. | 255 accepted; 256 rejected. | — | — |
| BNK-FLD-004 | Account Number | Negative | Blank. | Rejected. | — | — |
| BNK-FLD-005 | Account Number | Boundary | 1, 100 and 101 characters. | 1 and 100 accepted; 101 rejected (max 100). | — | — |
| BNK-FLD-006 | Account Number | Edge | Spaced form `5010 0234 5678`. | Accepted; the blind index normalises whitespace so a search with or without spaces matches. | — | — |
| BNK-FLD-007 | Account Number | Negative | Alphabetic value `ABCDEFGH`. | Record actual — a non-numeric account number should be rejected. | — | — |
| BNK-FLD-008 | Account Number | Edge | Leading zeros `000123456789`. | Preserved exactly on reveal (not coerced to a number and stripped). | — | — |
| BNK-FLD-009 | IFSC | Positive | `HDFC0000123` (valid 11-char format). | Accepted. | — | — |
| BNK-FLD-010 | IFSC | Negative | `HDFC123` / `1234567890X` / lowercase `hdfc0000123`. | Record actual — an IFSC-format check should reject the malformed values and normalise case. Absence of validation ⇒ **S3**. | — | — |
| BNK-FLD-011 | IFSC | Boundary | 50 / 51 characters. | 50 accepted; 51 rejected. | — | — |
| BNK-FLD-012 | Account Type | Positive | Each of savings / current / nre / nro / other. | Saved and filterable. | — | — |
| BNK-FLD-013 | Account Type | Edge | Blank. | Accepted (nullable). | — | — |
| BNK-FLD-014 | Branch | Boundary | 255 / 256 characters. | 255 accepted; 256 rejected. | — | — |
| BNK-FLD-015 | Customer ID | Boundary | 100 / 101 characters. | 100 accepted; 101 rejected. | — | — |
| BNK-FLD-016 | Customer ID | Edge | Blank. | Stored as NULL — not an empty-string ciphertext. | — | — |
| BNK-FLD-017 | Net Banking Username | Boundary | 255 / 256 characters. | 255 accepted; 256 rejected. | — | — |
| BNK-FLD-018 | Net Banking Username | Edge | 1- and 2-character usernames. | Masking must not leak the value — a 2-char username should mask to dots rather than showing both characters. | — | — |
| BNK-FLD-019 | Card Number | Positive | A 16-digit test number. | Accepted; `last_four` derived correctly. | — | — |
| BNK-FLD-020 | Card Number | Boundary | 15-digit (Amex) and 19-digit numbers. | Both accepted; last four correct in each case. | — | — |
| BNK-FLD-021 | Card Number | Edge | Spaced form `4111 1111 1111 1111`. | Accepted; masking still shows the correct last four. | — | — |
| BNK-FLD-022 | Card Expiry | Positive | `12/29`. | Accepted and stored. | — | — |
| BNK-FLD-023 | Card Expiry | Negative | `13/29` (invalid month) and `12/20` (past). | Record actual — an invalid or expired date should be rejected or flagged. | — | — |
| BNK-FLD-024 | CVV | Positive | `123` and `1234`. | Accepted at entry, **never persisted** (see BNK-BR-004). | — | — |
| BNK-FLD-025 | CVV | Negative | `12` (2 digits) or non-numeric. | Rejected. | — | — |
| BNK-FLD-026 | Cards | Boundary | Add 10 cards to one bank record. | All stored inside the encrypted `cards` blob; all render masked. | — | — |
| BNK-FLD-027 | Custom Fields | Positive | Add "UPI ID" label/value pairs. | Saved and displayed. | — | — |
| BNK-FLD-028 | Assigned Member | Negative | Assign to a user id from another tenant (manipulated). | Rejected as invalid; no record created. | — | — |
| BNK-FLD-029 | All | Edge | `<script>alert(1)</script>` in Bank Name and Branch. | Rendered as literal text. | — | — |
| BNK-FLD-030 | All | Edge | Double-click Save. | Exactly one record created. | — | — |

## A3. Business Rules

| TC ID | Type | Rule / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| BNK-BR-001 | Security | Save a bank record, then inspect the row directly. | `account_number`, `customer_id`, `net_banking_username` and `cards` are all ciphertext; no plaintext value is present. | — | — |
| BNK-BR-002 | Security | Inspect the `/bank-info` list network payload. | Account number, customer ID and username are masked; `account_number_hash` is absent; no card number or CVV is present in full. | — | — |
| BNK-BR-003 | Security | Open the single-record view and inspect the payload. | Full plaintext is returned only here, and only to a permitted user. | — | — |
| BNK-BR-004 | Security | Save a card with a CVV, then query the DB and re-open the record. | **The CVV is never stored** (PCI-DSS). The UI always renders it as fixed dots. Any persisted CVV ⇒ **S1**. | — | — |
| BNK-BR-005 | Positive | Reveal the record and compare against the values entered. | All encrypted fields round-trip byte-for-byte. | — | — |
| BNK-BR-006 | Positive | Edit the record without touching the account number. | The account number is preserved and not double-encrypted (reveal still returns the original). | — | — |
| BNK-BR-007 | Business rule | Save two records with the same account number. | Both stored; both produce identical `account_number_hash` but different ciphertexts. | — | — |
| BNK-BR-008 | Negative | User with only `canView` on `bank_info` attempts add/edit/delete. | All refused. | — | — |
| BNK-BR-009 | Negative | User with no `bank_info` permission row opens `/bank-info`. | Access denied; nav entry hidden. | — | — |
| BNK-BR-010 | Negative | ADMIN_B attempts to view/reveal/edit/delete a TENANT_A bank record id. | 403/404 on every attempt; TENANT_A's row unchanged (`updated_at` does not move). | — | — |
| BNK-BR-011 | Positive | Delete a record. | Soft-deleted; gone from list, search and dashboard counts. | — | — |
| BNK-BR-012 | Positive | Create/edit/delete and check `/audit-logs`. | One entry per mutation. **The audit `details` must not contain the full account number.** | — | — |
| BNK-BR-013 | Security | Run any AI feature with bank records present. | `cards`, `netBankingUsername` and account numbers are stripped/masked before the payload leaves the platform. | — | — |
| BNK-BR-014 | Security | Run the Backup export. | Record how bank fields appear (ciphertext vs. plaintext). Plaintext account numbers in an unencrypted export without a warning ⇒ **S2**. | — | — |
| BNK-BR-015 | Security | Run the Google Drive ZK sync for this module. | `/DocsNX_Data/bank_info.enc.json` contains only `ivHex:ciphertextHex` — nothing readable. | — | — |
| BNK-BR-016 | Negative | Subscription expired → open `/bank-info`. | Access blocked. | — | — |
| BNK-BR-017 | Edge | Change `ENCRYPTION_SECRET` (test env only) and re-open an existing record. | Decryption fails gracefully with an error — no crash, no garbage rendered as if it were the account number. Restore the secret afterwards. | — | — |

## A4. Database Validation

| TC ID | Validation Point | SQL Query | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| BNK-DB-001 | Tenant stamping (P1) | `SELECT tenant_id, bank_name, ifsc_code, account_type FROM bank_infos WHERE id = ':record_id';` | `tenant_id = :tenant_a`; values as entered | — | — |
| BNK-DB-002 | Account number encrypted (P5) | `SELECT account_number ~ '^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$' AS is_ciphertext FROM bank_infos WHERE id = ':record_id';` | `t` | — | — |
| BNK-DB-003 | Account number plaintext never stored | `SELECT count(*) FROM bank_infos WHERE account_number = '50100234567890';` | `0` | — | — |
| BNK-DB-004 | Blind index populated and not plaintext (P6) | `SELECT account_number_hash IS NOT NULL AS has_index, account_number_hash <> '50100234567890' AS not_plain FROM bank_infos WHERE id = ':record_id';` | `t`, `t` | — | — |
| BNK-DB-005 | Blind index deterministic, ciphertext non-deterministic | Two records with the same account number: `SELECT count(DISTINCT account_number_hash) AS h, count(DISTINCT account_number) AS c FROM bank_infos WHERE tenant_id = ':tenant_a' AND bank_name IN ('DupA','DupB');` | `h = 1`, `c = 2` | — | — |
| BNK-DB-006 | Customer ID encrypted | `SELECT customer_id ~ '^[0-9a-f]+:' AS is_ciphertext FROM bank_infos WHERE id = ':record_id';` | `t` (or NULL when blank) | — | — |
| BNK-DB-007 | Net banking username encrypted | `SELECT net_banking_username ~ '^[0-9a-f]+:' AS is_ciphertext FROM bank_infos WHERE id = ':record_id';` | `t` (or NULL when blank) | — | — |
| BNK-DB-008 | Cards blob encrypted | `SELECT cards->>'encryptedData' IS NOT NULL AS is_encrypted, cards::text LIKE '%4111%' AS leaks_pan FROM bank_infos WHERE id = ':record_id';` | `t`, `f` | — | — |
| BNK-DB-009 | **CVV never persisted** | `SELECT count(*) FROM bank_infos WHERE cards::text ILIKE '%cvv%';` and inspect the decrypted blob via the UI | `0` occurrences of a real CVV value anywhere. Any hit ⇒ **S1** | — | — |
| BNK-DB-010 | Blank optional fields are NULL, not empty ciphertext | `SELECT customer_id, net_banking_username FROM bank_infos WHERE id = ':record_no_optional';` | `NULL, NULL` | — | — |
| BNK-DB-011 | IFSC stored in the clear (searchable) | `SELECT ifsc_code FROM bank_infos WHERE id = ':record_id';` | Readable value such as `HDFC0000123` | — | — |
| BNK-DB-012 | Audit timestamps (P2) | `SELECT created_at IS NOT NULL, updated_at IS NOT NULL, updated_at >= created_at FROM bank_infos WHERE id = ':record_id';` | `t, t, t` | — | — |
| BNK-DB-013 | Soft delete (P3) | `SELECT deleted_at FROM bank_infos WHERE id = ':record_id';` | Non-null after a UI delete | — | — |
| BNK-DB-014 | Cross-tenant isolation (P7) | `SELECT count(*) FROM bank_infos WHERE id = ':record_id' AND tenant_id = ':tenant_b';` | `0` | — | — |
| BNK-DB-015 | Owner/holder are same-tenant | `SELECT count(*) FROM bank_infos b JOIN users u ON u.id = b.user_id WHERE b.tenant_id <> u.tenant_id;` | `0` | — | — |
| BNK-DB-016 | Audit details do not leak the account number | `SELECT count(*) FROM audit_logs WHERE tenant_id = ':tenant_a' AND details LIKE '%50100234567890%';` | `0` | — | — |
| BNK-DB-017 | No unencrypted legacy rows | `SELECT count(*) FROM bank_infos WHERE tenant_id = ':tenant_a' AND account_number !~ '^[0-9a-f]+:';` | `0` | — | — |
| BNK-DB-018 | No row without a tenant | `SELECT count(*) FROM bank_infos WHERE tenant_id IS NULL;` | `0` | — | — |

---

# PART B — Credit Cards (`CRD`)

## Module Reference

| Aspect | Detail |
|---|---|
| Table / permission key | `credit_cards` · gated by the **`bank_info`** permission key |
| Required fields | Card Name*, Card Number* — otherwise "Missing cardName or cardNumber" |
| Optional | Card Network (Visa/Mastercard/RuPay), Card Type (Credit/Forex), Cardholder, Expiry, CVV (entered but not stored), Custom Fields[], Assigned Member |
| Encryption | `card_details_encrypted` holds an encrypted JSON of `{cardHolder, cardNumber, cardExpiry}` — **CVV is deliberately excluded** |
| Derived column | `last_four` = last 4 digits of the card number |
| List masking | `•••• •••• •••• 1234` from `last_four`; CVV always renders as `•••`; `card_details_encrypted` is stripped from the response |

## B1–B3 Test Cases

| TC ID | Category | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|---|
| CRD-UI-001 | UI | Positive | Open the Credit Cards view/tab. | Cards show name, network, type and a masked number; CVV always dots. | — | — |
| CRD-UI-002 | UI | Positive | Inspect the list payload in DevTools. | No full card number, no CVV, no `cardDetailsEncrypted`. | — | — |
| CRD-UI-003 | UI | Positive | Open a card's detail/edit view. | The full card number, holder and expiry are revealed; the CVV field is empty (it was never stored). | — | — |
| CRD-UI-004 | UI | Positive | Add a card and observe the save. | Spinner; success toast; the card appears with the correct last four. | — | — |
| CRD-FLD-001 | Field | Negative | Submit with Card Name and Card Number blank. | "Missing cardName or cardNumber". | — | — |
| CRD-FLD-002 | Field | Negative | Card Number filled, Card Name blank. | Rejected. | — | — |
| CRD-FLD-003 | Field | Boundary | Card Name 255 / 256 characters. | 255 accepted; 256 rejected. | — | — |
| CRD-FLD-004 | Field | Boundary | 15-, 16- and 19-digit card numbers. | All accepted; `last_four` correct for each. | — | — |
| CRD-FLD-005 | Field | Edge | Card number shorter than 4 digits (`123`). | `last_four` derivation must not crash; masking must not expose the whole number. Record actual. | — | — |
| CRD-FLD-006 | Field | Negative | Non-numeric card number `abcd efgh`. | Record actual — should be rejected. | — | — |
| CRD-FLD-007 | Field | Edge | Card number with spaces/hyphens. | Accepted; `last_four` derived from the digits only. | — | — |
| CRD-FLD-008 | Field | Positive | Each Card Network (Visa, Mastercard, RuPay, Amex) and Card Type (Credit, Forex). | Saved and displayed correctly. | — | — |
| CRD-FLD-009 | Field | Edge | Omit network and type. | Accepted; stored as empty strings/nulls; UI renders cleanly (no `undefined`). | — | — |
| CRD-FLD-010 | Field | Negative | Expiry `13/29` or a past expiry. | Record actual — invalid/expired should be rejected or flagged. | — | — |
| CRD-FLD-011 | Field | Edge | Enter a CVV, save, re-open the card. | The CVV field is blank on re-open and the DB contains no CVV. | — | — |
| CRD-BR-001 | Business | Security | Save a card, then inspect the row. | `card_details_encrypted` is ciphertext; `last_four` is the only plaintext digits stored; **no CVV anywhere**. | — | — |
| CRD-BR-002 | Business | Security | Trigger AI features with cards present. | `cards`/`cvv` keys are stripped by the AI privacy masker before any model call. | — | — |
| CRD-BR-003 | Business | Negative | ADMIN_B attempts to reach a TENANT_A card by id. | 403/404; nothing revealed. | — | — |
| CRD-BR-004 | Business | Negative | A user with no `bank_info` permission attempts to view cards. | Denied — cards inherit the `bank_info` permission key. | — | — |
| CRD-BR-005 | Business | Positive | Delete a card. | Soft-deleted; removed from the UI and counts. | — | — |
| CRD-BR-006 | Business | Positive | Create/edit/delete and check `/audit-logs`. | One entry per mutation; **no full card number in the details text**. | — | — |

## B4. Database Validation

| TC ID | Validation Point | SQL Query | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| CRD-DB-001 | Tenant stamping (P1) | `SELECT tenant_id, card_name, card_network, card_type, last_four FROM credit_cards WHERE id = ':record_id';` | `tenant_id = :tenant_a`; `last_four` = last 4 digits entered | — | — |
| CRD-DB-002 | Card details encrypted (P5) | `SELECT card_details_encrypted ~ '^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$' AS is_ciphertext FROM credit_cards WHERE id = ':record_id';` | `t` | — | — |
| CRD-DB-003 | Full PAN never stored in the clear | `SELECT count(*) FROM credit_cards WHERE card_details_encrypted LIKE '%4111111111111111%' OR card_name LIKE '%4111111111111111%';` | `0` | — | — |
| CRD-DB-004 | **CVV never persisted** | `SELECT count(*) FROM credit_cards WHERE card_details_encrypted ILIKE '%cvv%';` plus a manual decrypt check via the UI | `0`; the decrypted JSON contains only `cardHolder`, `cardNumber`, `cardExpiry`. Any CVV ⇒ **S1** | — | — |
| CRD-DB-005 | `last_four` is exactly 4 characters | `SELECT count(*) FROM credit_cards WHERE length(last_four) <> 4;` | `0` (except for the deliberately short-number edge case) | — | — |
| CRD-DB-006 | `last_four` matches what the UI masks to | `SELECT last_four FROM credit_cards WHERE id = ':record_id';` | Equals the 4 digits displayed after the dots | — | — |
| CRD-DB-007 | Audit timestamps (P2) | `SELECT created_at IS NOT NULL, updated_at IS NOT NULL, updated_at >= created_at FROM credit_cards WHERE id = ':record_id';` | `t, t, t` | — | — |
| CRD-DB-008 | Soft delete (P3) | `SELECT deleted_at FROM credit_cards WHERE id = ':record_id';` | Non-null after a UI delete | — | — |
| CRD-DB-009 | Cross-tenant isolation (P7) | `SELECT count(*) FROM credit_cards WHERE id = ':record_id' AND tenant_id = ':tenant_b';` | `0` | — | — |
| CRD-DB-010 | Audit details do not leak the PAN | `SELECT count(*) FROM audit_logs WHERE tenant_id = ':tenant_a' AND details LIKE '%4111111111111111%';` | `0` | — | — |
| CRD-DB-011 | Owner is same-tenant | `SELECT count(*) FROM credit_cards c JOIN users u ON u.id = c.user_id WHERE c.tenant_id <> u.tenant_id;` | `0` | — | — |

---

# PART C — Trading & Demat (`TRD`)

## Module Reference

| Aspect | Detail |
|---|---|
| Route / table / key | `/trading` · `trading_demats` · `trading` |
| Required fields | Broker Name*, Client ID* — otherwise "Missing brokerName or clientId" |
| Optional | Demat Account Number, Login Username, Nominee Name, Details, Custom Fields[], Assigned Member |
| Encrypted at rest | `client_id`, `demat_account_number`, `login_username` |
| Blind indexes | `client_id_hash`, `demat_account_number_hash` |
| List masking | Client ID → `maskTail`; `client_id_hash` stripped from the response |

## C1–C3 Test Cases

| TC ID | Category | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|---|
| TRD-UI-001 | UI | Positive | Open `/trading` empty and populated. | Empty state with CTA; populated view shows broker, masked client ID, nominee and details. | — | — |
| TRD-UI-002 | UI | Positive | Inspect the client ID in the list. | Masked (`••••1234`); the full value only appears in the detail/edit view. | — | — |
| TRD-UI-003 | UI | Positive | Open the Add dialog. | Broker Name, Client ID, Demat Account Number, Login Username, Nominee Name, Details, Custom Fields, Assigned Member. | — | — |
| TRD-UI-004 | UI | Positive | Search "by Broker or Client ID". | Broker name matches by substring; the **full** client ID matches exactly via the blind index. | — | — |
| TRD-UI-005 | UI | Edge | Search a partial client ID. | No match expected (encrypted column). Record actual. | — | — |
| TRD-UI-006 | UI | Positive | Edit / Delete a record. | Edit pre-fills revealed plaintext; Delete confirms first. | — | — |
| TRD-UI-007 | UI | Positive | View at 375px. | Cards stack; long IDs wrap; no horizontal page scroll. | — | — |
| TRD-FLD-001 | Field | Negative | Submit with Broker Name and Client ID blank. | "Missing brokerName or clientId". | — | — |
| TRD-FLD-002 | Field | Negative | Broker filled, Client ID blank. | Rejected. | — | — |
| TRD-FLD-003 | Field | Boundary | Broker Name 255 / 256 characters. | 255 accepted; 256 rejected. | — | — |
| TRD-FLD-004 | Field | Positive | Client ID `AB1234`. | Saved encrypted; masked in list; revealed in detail. | — | — |
| TRD-FLD-005 | Field | Edge | Client ID with spaces / mixed case. | Blind index normalises (trim, collapse whitespace, uppercase) so an equivalent search matches. | — | — |
| TRD-FLD-006 | Field | Positive | Demat Account Number `1208160001234567` (16 digits). | Saved encrypted; a matching blind index is written. | — | — |
| TRD-FLD-007 | Field | Edge | Omit Demat Account Number. | Accepted; both the column and its `_hash` are NULL (not empty ciphertext). | — | — |
| TRD-FLD-008 | Field | Positive | Login Username `sunil_groww`. | Saved encrypted; masked where displayed in list views. | — | — |
| TRD-FLD-009 | Field | Boundary | Nominee Name 255 / 256 characters. | 255 accepted; 256 rejected. | — | — |
| TRD-FLD-010 | Field | Boundary | Details field with 10 000 characters. | Accepted and fully retrievable. | — | — |
| TRD-FLD-011 | Field | Edge | `<script>alert(1)</script>` in Broker Name and Details. | Rendered as literal text. | — | — |
| TRD-FLD-012 | Field | Negative | Assign to a user id from another tenant. | Rejected. | — | — |
| TRD-FLD-013 | Field | Edge | Double-click Save. | Exactly one record created. | — | — |
| TRD-BR-001 | Business | Security | Save a record, then inspect the row. | `client_id`, `demat_account_number` and `login_username` are all ciphertext. | — | — |
| TRD-BR-002 | Business | Security | Inspect the list payload. | Client ID masked; `client_id_hash` and `demat_account_number_hash` absent. | — | — |
| TRD-BR-003 | Business | Positive | Reveal and compare with the entered values. | Byte-for-byte identical. | — | — |
| TRD-BR-004 | Business | Security | **Check the audit log details for this module.** | The create action's details text is expected to reference the client ID — confirm whether the full client ID is written into `audit_logs.details`. If it is, raise **S2** (secret in an audit trail). | — | — |
| TRD-BR-005 | Business | Security | Trigger AI features with trading records present. | `loginUsername` and the client/demat identifiers are stripped/masked before any model call. | — | — |
| TRD-BR-006 | Business | Negative | ADMIN_B attempts to view/reveal/edit/delete a TENANT_A trading record id. | 403/404; row unchanged. | — | — |
| TRD-BR-007 | Business | Negative | A user with only `canView` on `trading` attempts add/edit/delete. | All refused. | — | — |
| TRD-BR-008 | Business | Positive | Delete a record. | Soft-deleted; removed from list, search and counts. | — | — |
| TRD-BR-009 | Business | Negative | Subscription expired → open `/trading`. | Access blocked. | — | — |

## C4. Database Validation

| TC ID | Validation Point | SQL Query | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| TRD-DB-001 | Tenant stamping (P1) | `SELECT tenant_id, broker_name, nominee_name FROM trading_demats WHERE id = ':record_id';` | `tenant_id = :tenant_a`; values as entered | — | — |
| TRD-DB-002 | Client ID encrypted (P5) | `SELECT client_id ~ '^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$' AS is_ciphertext FROM trading_demats WHERE id = ':record_id';` | `t` | — | — |
| TRD-DB-003 | Client ID plaintext never stored | `SELECT count(*) FROM trading_demats WHERE client_id = 'AB1234';` | `0` | — | — |
| TRD-DB-004 | Demat number encrypted | `SELECT demat_account_number ~ '^[0-9a-f]+:' AS is_ciphertext FROM trading_demats WHERE id = ':record_id';` | `t` (or NULL when blank) | — | — |
| TRD-DB-005 | Login username encrypted | `SELECT login_username ~ '^[0-9a-f]+:' AS is_ciphertext FROM trading_demats WHERE id = ':record_id';` | `t` (or NULL when blank) | — | — |
| TRD-DB-006 | Blind indexes populated (P6) | `SELECT client_id_hash IS NOT NULL AS h1, demat_account_number_hash IS NOT NULL AS h2 FROM trading_demats WHERE id = ':record_id';` | `t`, `t` (h2 NULL when no demat number was entered) | — | — |
| TRD-DB-007 | Blind index is not the plaintext | `SELECT client_id_hash <> 'AB1234' AS not_plain FROM trading_demats WHERE id = ':record_id';` | `t` | — | — |
| TRD-DB-008 | Blind index normalisation | Save `ab 1234` and `AB1234` as two records, then compare their `client_id_hash`. | Identical | — | — |
| TRD-DB-009 | Blank demat leaves both columns NULL | `SELECT demat_account_number, demat_account_number_hash FROM trading_demats WHERE id = ':record_no_demat';` | `NULL, NULL` | — | — |
| TRD-DB-010 | Audit timestamps (P2) | `SELECT created_at IS NOT NULL, updated_at IS NOT NULL, updated_at >= created_at FROM trading_demats WHERE id = ':record_id';` | `t, t, t` | — | — |
| TRD-DB-011 | Soft delete (P3) | `SELECT deleted_at FROM trading_demats WHERE id = ':record_id';` | Non-null after a UI delete | — | — |
| TRD-DB-012 | Cross-tenant isolation (P7) | `SELECT count(*) FROM trading_demats WHERE id = ':record_id' AND tenant_id = ':tenant_b';` | `0` | — | — |
| TRD-DB-013 | Audit details leak check | `SELECT count(*) FROM audit_logs WHERE tenant_id = ':tenant_a' AND details LIKE '%AB1234%';` | Ideally `0`. A hit confirms TRD-BR-004 — log as **S2** | — | — |
| TRD-DB-014 | No unencrypted legacy rows | `SELECT count(*) FROM trading_demats WHERE tenant_id = ':tenant_a' AND client_id !~ '^[0-9a-f]+:';` | `0` | — | — |
| TRD-DB-015 | Owner is same-tenant | `SELECT count(*) FROM trading_demats t JOIN users u ON u.id = t.user_id WHERE t.tenant_id <> u.tenant_id;` | `0` | — | — |

---

## Cross-Module End-to-End Workflows (Wealth)

| TC ID | Workflow | Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| WLT-E2E-001 | Full banking setup | 1. Add a bank account (HDFC, account no., IFSC, customer ID, net-banking username).<br>2. Attach two cards to it.<br>3. Add a standalone credit card.<br>4. Add a Zerodha trading account with client ID and demat number.<br>5. Review every list view. | All records created; **every** sensitive value is masked in list views; the dashboard counts update. | — | — |
| WLT-E2E-002 | Reveal & round-trip audit | Open each of the four records' detail views and compare all revealed values against what was entered. | 100% match, no truncation, no encoding damage. | — | — |
| WLT-E2E-003 | Masking sweep | With DevTools open, load `/bank-info` and `/trading` and inspect every network response and the rendered DOM. | No full account number, card number, CVV, client ID, demat number or net-banking username appears anywhere before an explicit single-record reveal. | — | — |
| WLT-E2E-004 | Exact-match search | 1. Note a full account number and a full client ID.<br>2. Search each in the module search and in global spotlight search. | Each returns its record via the blind index; partial substrings return nothing. | — | — |
| WLT-E2E-005 | Cross-tenant assault | 1. Capture the ids of all four TENANT_A records.<br>2. Log in as ADMIN_B.<br>3. Attempt list, detail-reveal, edit and delete on each id; run global search for the bank name and broker. | All 16 attempts fail with 403/404 and no partial disclosure; TENANT_A `updated_at` values are unchanged. | — | — |
| WLT-E2E-006 | AI privacy shield | 1. With all wealth records present, run an AI portfolio analysis.<br>2. Capture the outbound payload (proxy or debug log). | No password, CVV, card number, account number, client ID or login username is present; PAN/Aadhaar/phone/email patterns are masked. | — | — |
| WLT-E2E-007 | Zero-Knowledge Drive sync | 1. Enable Drive sync.<br>2. Sync `bank_info` and `trading`.<br>3. Download both `.enc.json` files and open them. | Both files are opaque `ivHex:ciphertextHex` payloads — nothing readable without the passphrase. | — | — |
| WLT-E2E-008 | Permission lockdown | 1. Revoke `bank_info` entirely for USER_A3.<br>2. Log in as USER_A3.<br>3. Attempt to open `/bank-info` and to reach credit cards. | Both denied — cards share the `bank_info` key. | — | — |
