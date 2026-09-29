# TC-04 — Profiles

**Prefix:** `PRF` · **Route:** `/profile` · **Table:** `profiles` (1:1 with `users`)
**Permission key:** `profiles`

## Module Reference

| Aspect | Detail |
|---|---|
| Tabs | **Personal** · **Education** · **Shopping** · **Legal / ID** |
| Personal fields | Date of Birth, Blood Group, Gender, Place of Birth → `personal_details` (jsonb) |
| Education fields | Highest Degree, College / University, Year of Passing → `education_details` (jsonb) |
| Shopping fields | Clothing Size (Shirt/Top), Shoe Size (UK/US/EU), Preferred Brands / Shopping Notes → `shopping_details` (jsonb) |
| Legal fields | PAN Card Number, Aadhaar Card Number, Passport Number → `legal_details` (jsonb) |
| Encryption | `panNumber`, `aadhaarNumber`, `passportNumber` are **encrypted at rest** inside the `legal_details` JSON |
| Auto-enrichment | `autoUpdateProfile()` populates profile fields from record uploads (e.g. document metadata) without overwriting a non-empty existing value with an empty one |
| Cardinality | Exactly one profile row per user, enforced by a unique constraint on `profiles.user_id` |

---

## 1. UI Validation Test Cases

| TC ID | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| PRF-UI-001 | Positive | Open `/profile`. | Four tabs render with icons: Personal, Education, Shopping, Legal / ID. "Personal" is active by default. | — | — |
| PRF-UI-002 | Positive | Click each tab in turn. | Only the selected tab's fields are shown; the active tab is visually highlighted; no page reload. | — | — |
| PRF-UI-003 | Positive | Open `/profile` on a brand-new user. | All fields render empty (not `null`, `undefined` or `[object Object]`). | — | — |
| PRF-UI-004 | Positive | Open `/profile` for a user with saved data. | Every field is pre-populated with the stored value on load. | — | — |
| PRF-UI-005 | Positive | Type into a field and click Save. | Button shows a loading state; a success toast appears; values persist after reload. | — | — |
| PRF-UI-006 | Positive | Edit a Personal field, switch to Education, then back to Personal without saving. | Unsaved edits are still present in the field (tab switching does not reset in-progress edits). | — | — |
| PRF-UI-007 | Positive | Edit fields on two different tabs, then Save once. | Both tabs' changes are persisted in a single save. | — | — |
| PRF-UI-008 | Positive | Open the Legal / ID tab. | PAN, Aadhaar and Passport fields render. Confirm whether values are masked or fully revealed and record the actual behaviour. | — | — |
| PRF-UI-009 | Positive | Inspect the Date of Birth control. | A date picker is presented; it does not accept free-form invalid text. | — | — |
| PRF-UI-010 | Positive | Inspect the Blood Group and Gender controls. | Rendered as selects with sensible option lists; no free-text typo risk (or, if free-text, record it). | — | — |
| PRF-UI-011 | Positive | Trigger a save failure (offline). | An error toast appears; entered values remain in the form (not wiped). | — | — |
| PRF-UI-012 | Positive | View `/profile` at 375px width. | Tabs remain usable (scrollable or stacked); fields are full-width; no horizontal page scroll. | — | — |
| PRF-UI-013 | Positive | Tab through the Personal form with the keyboard. | Logical focus order; visible focus rings; Save reachable via keyboard. | — | — |
| PRF-UI-014 | Positive | Observe the page while the profile loads. | A loading/skeleton state is shown rather than an empty form that later jumps to populated. | — | — |
| PRF-UI-015 | Negative | Log in as a user without `profiles` view permission and open `/profile`. | Access denied / nav entry hidden. | — | — |

---

## 2. Field Validation Test Cases

| TC ID | Field | Type | Input / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|---|
| PRF-FLD-001 | All | Positive | Save with every field blank. | Accepted — the profile is entirely optional; empty JSON objects are stored. | — | — |
| PRF-FLD-002 | Date of Birth | Positive | `1990-05-14`. | Saved and re-displayed in the same date. | — | — |
| PRF-FLD-003 | Date of Birth | Edge | A future date (e.g. `2099-01-01`). | Record actual. A future DOB should be rejected; silent acceptance ⇒ **S3**. | — | — |
| PRF-FLD-004 | Date of Birth | Boundary | `1900-01-01` and today's date. | Both accepted without error. | — | — |
| PRF-FLD-005 | Blood Group | Positive | Each of `A+ A- B+ B- AB+ AB- O+ O-`. | All accepted and re-displayed exactly. | — | — |
| PRF-FLD-006 | Blood Group | Negative | Free-text `XYZ` (if the field is not a select). | Record actual — an invalid blood group should be rejected. | — | — |
| PRF-FLD-007 | Gender | Positive | Each available option. | Saved and re-displayed. | — | — |
| PRF-FLD-008 | Place of Birth | Edge | 255-char and 256-char values. | 255 accepted; 256 handled gracefully (rejected or stored — record actual; JSONB has no fixed limit). | — | — |
| PRF-FLD-009 | Place of Birth | Edge | Unicode value `पुणे, महाराष्ट्र`. | Stored and re-displayed intact. | — | — |
| PRF-FLD-010 | Highest Degree | Positive | `B.Tech (Computer Science)`. | Saved; punctuation preserved. | — | — |
| PRF-FLD-011 | Year of Passing | Positive | `2012`. | Saved. | — | — |
| PRF-FLD-012 | Year of Passing | Negative | `abcd`. | Rejected or coerced — record actual; non-numeric years should not be persisted. | — | — |
| PRF-FLD-013 | Year of Passing | Boundary | `1900` and the current year. | Both accepted. | — | — |
| PRF-FLD-014 | Year of Passing | Edge | A future year (e.g. current year + 20). | Record actual — expected to be rejected or flagged. | — | — |
| PRF-FLD-015 | Year of Passing | Boundary | `0` and a negative number. | Rejected. | — | — |
| PRF-FLD-016 | Clothing Size | Positive | `M`, `42`, `XL`. | All accepted (free text by design). | — | — |
| PRF-FLD-017 | Shoe Size | Positive | `UK 9 / US 10 / EU 43`. | Accepted verbatim. | — | — |
| PRF-FLD-018 | Brand Preferences | Boundary | A 5 000-character note. | Accepted (text column) and fully re-displayed. Confirm no truncation. | — | — |
| PRF-FLD-019 | Brand Preferences | Edge | Multi-line text with newlines. | Line breaks preserved on re-display. | — | — |
| PRF-FLD-020 | PAN | Positive | `ABCDE1234F` (valid Indian PAN format). | Accepted and saved. | — | — |
| PRF-FLD-021 | PAN | Negative | `12345ABCDE` (wrong pattern), `ABCDE1234` (9 chars). | Record actual — a PAN-format check should reject both; absence of validation ⇒ **S3**. | — | — |
| PRF-FLD-022 | Aadhaar | Positive | A 12-digit number. | Accepted and saved. | — | — |
| PRF-FLD-023 | Aadhaar | Boundary | 11-digit and 13-digit values. | Record actual — both should be rejected. | — | — |
| PRF-FLD-024 | Aadhaar | Edge | Spaced form `1234 5678 9012`. | Accepted; confirm it is normalised consistently for storage/search. | — | — |
| PRF-FLD-025 | Passport | Positive | `Z1234567`. | Accepted and saved. | — | — |
| PRF-FLD-026 | Legal IDs | Edge | Save a legal ID, reload, and save again **without changing it**. | The value is not double-encrypted and still decrypts to the original plaintext on display. | — | — |
| PRF-FLD-027 | Legal IDs | Edge | Clear a previously saved PAN and save. | The field becomes empty/null — not left holding a stale ciphertext. | — | — |
| PRF-FLD-028 | All | Edge | Enter `<script>alert(1)</script>` in Place of Birth and Brand Preferences. | Rendered as literal text; no script execution on `/profile` or anywhere the profile is surfaced. | — | — |
| PRF-FLD-029 | All | Edge | Enter a JSON-looking string `{"a":1}` into a text field. | Stored as a plain string; the profile JSON remains valid and the field re-displays as typed. | — | — |
| PRF-FLD-030 | All | Edge | Double-click Save. | Only one write occurs; no duplicate profile row is created. | — | — |

---

## 3. Business Rule Test Cases

| TC ID | Type | Rule / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| PRF-BR-001 | Positive | Register a new tenant and immediately open `/profile`. | A profile row already exists (created during registration) with four empty JSON objects. | — | — |
| PRF-BR-002 | Positive | Add a member, then log in as that member and open `/profile`. | Their own profile exists and is separate from the admin's. | — | — |
| PRF-BR-003 | Business rule | A user edits their own profile. | Only their own `profiles` row changes — no other member's profile is touched. | — | — |
| PRF-BR-004 | Negative | As USER_A1, attempt to view/edit ADMIN_A's profile (via a manipulated id if the UI exposes one). | Refused; only the session user's profile is editable. | — | — |
| PRF-BR-005 | Business rule | Upload a Document with metadata containing a document number (e.g. PAN) for a given holder. | `autoUpdateProfile` writes the value into that holder's `legal_details`, encrypted. | — | — |
| PRF-BR-006 | Business rule | Upload a second document with an **empty** metadata value for a field already populated in the profile. | The existing profile value is preserved (empty values never overwrite). | — | — |
| PRF-BR-007 | Business rule | Upload a document whose metadata contains a **different** value for an already-populated profile field. | The profile value is updated to the new value; confirm this matches product intent and record actual. | — | — |
| PRF-BR-008 | Business rule | Auto-enrichment for a document assigned to another member (holder). | The **holder's** profile is enriched, not the uploader's. | — | — |
| PRF-BR-009 | Security | Save PAN/Aadhaar/Passport, then inspect the DB row directly. | All three values are ciphertext in `legal_details`, never plaintext. | — | — |
| PRF-BR-010 | Security | Save PAN, then trigger any AI feature that includes profile context. | The AI payload contains masked/stripped identifiers (never the raw PAN/Aadhaar) per the AI Privacy Shield. | — | — |
| PRF-BR-011 | Positive | Save the profile and check `updated_at`. | Advances on each successful save. | — | — |
| PRF-BR-012 | Business rule | Delete the user. | Their profile row is removed by cascade. | — | — |
| PRF-BR-013 | Negative | With the subscription expired, open and try to save `/profile`. | Blocked by the expired-subscription rule. | — | — |
| PRF-BR-014 | Positive | Save the profile and check the audit log. | Record actual. Per house rules every mutation must be audited — a missing entry is **S2**. | — | — |

---

## 4. End-to-End Workflow Test Cases

| TC ID | Workflow | Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| PRF-E2E-001 | Complete a profile | 1. Open `/profile`.<br>2. Fill all four tabs completely.<br>3. Save.<br>4. Log out, log back in, reopen `/profile`. | Every value persisted and re-displayed identically; legal IDs decrypt correctly. | — | — |
| PRF-E2E-002 | Auto-enrichment from a document | 1. Note that Legal / ID is empty.<br>2. Upload a Passport document with AI auto-fill or manual metadata including the passport number, holder = self.<br>3. Reopen `/profile` → Legal / ID. | Passport Number is now populated automatically and stored encrypted. | — | — |
| PRF-E2E-003 | Enrichment for a member | 1. Upload an Aadhaar document with holder = QA Child.<br>2. Log in as QA Child.<br>3. Open `/profile` → Legal / ID. | QA Child's Aadhaar is populated; the admin's own profile is unchanged. | — | — |
| PRF-E2E-004 | Profile in backup export | 1. Complete a profile.<br>2. Run the Backup export from `/backup`. | The export contains the profile nested under the user. Verify the treatment of encrypted legal IDs in the export and record whether they are ciphertext or plaintext (plaintext export of Aadhaar/PAN without an explicit warning ⇒ **S2**). | — | — |
| PRF-E2E-005 | Clear a profile | 1. Populate all fields, save.<br>2. Clear every field, save.<br>3. Reload. | All fields are empty; no stale ciphertext remains in `legal_details`. | — | — |

---

## 5. Database Validation Test Cases

| TC ID | Validation Point | SQL Query | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| PRF-DB-001 | Exactly one profile per user | `SELECT user_id, count(*) FROM profiles GROUP BY user_id HAVING count(*) > 1;` | 0 rows | — | — |
| PRF-DB-002 | Profile exists for every user | `SELECT count(*) FROM users u LEFT JOIN profiles p ON p.user_id = u.id WHERE p.id IS NULL;` | `0` | — | — |
| PRF-DB-003 | Personal details saved correctly | `SELECT personal_details->>'dob' AS dob, personal_details->>'bloodGroup' AS bg, personal_details->>'gender' AS gender, personal_details->>'birthPlace' AS bp FROM profiles WHERE user_id = ':user_a1';` | The four values entered in the Personal tab | — | — |
| PRF-DB-004 | Education details saved correctly | `SELECT education_details->>'degree' AS degree, education_details->>'college' AS college, education_details->>'yearOfPassing' AS yop FROM profiles WHERE user_id = ':user_a1';` | The three values entered | — | — |
| PRF-DB-005 | Shopping details saved correctly | `SELECT shopping_details->>'clothingSize' AS cs, shopping_details->>'shoeSize' AS ss, shopping_details->>'brandPreferences' AS bp FROM profiles WHERE user_id = ':user_a1';` | The three values entered | — | — |
| PRF-DB-006 | PAN encrypted at rest | `SELECT legal_details->>'panNumber' ~ '^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$' AS is_ciphertext FROM profiles WHERE user_id = ':user_a1';` | `t` | — | — |
| PRF-DB-007 | PAN plaintext never stored | `SELECT count(*) FROM profiles WHERE legal_details->>'panNumber' = 'ABCDE1234F';` | `0` | — | — |
| PRF-DB-008 | Aadhaar encrypted at rest | `SELECT legal_details->>'aadhaarNumber' ~ '^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$' AS is_ciphertext FROM profiles WHERE user_id = ':user_a1';` | `t` | — | — |
| PRF-DB-009 | Aadhaar plaintext never stored | `SELECT count(*) FROM profiles WHERE legal_details->>'aadhaarNumber' = '123456789012';` | `0` | — | — |
| PRF-DB-010 | Passport encrypted at rest | `SELECT legal_details->>'passportNumber' ~ '^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$' AS is_ciphertext FROM profiles WHERE user_id = ':user_a1';` | `t` | — | — |
| PRF-DB-011 | Non-sensitive fields are NOT encrypted (readability) | `SELECT personal_details->>'bloodGroup' FROM profiles WHERE user_id = ':user_a1';` | Plain value such as `O+` — not ciphertext | — | — |
| PRF-DB-012 | No double encryption after a re-save | Save twice without changing the PAN, then decrypt via the UI. | The Legal tab still shows the original PAN (single-layer ciphertext) | — | — |
| PRF-DB-013 | Cleared legal ID is nulled, not left as ciphertext | Clear PAN and save, then: `SELECT legal_details->>'panNumber' FROM profiles WHERE user_id = ':user_a1';` | `NULL` or absent key — not a leftover ciphertext string | — | — |
| PRF-DB-014 | JSON columns remain valid JSON objects | `SELECT jsonb_typeof(personal_details), jsonb_typeof(education_details), jsonb_typeof(shopping_details), jsonb_typeof(legal_details) FROM profiles WHERE user_id = ':user_a1';` | `object` for all four | — | — |
| PRF-DB-015 | Audit timestamps present and ordered | `SELECT created_at IS NOT NULL, updated_at IS NOT NULL, updated_at >= created_at FROM profiles WHERE user_id = ':user_a1';` | `t, t, t` | — | — |
| PRF-DB-016 | `updated_at` advances on save | Capture, save from the UI, re-query `updated_at`. | Strictly greater than the captured value | — | — |
| PRF-DB-017 | Auto-enrichment writes to the holder's profile | After PRF-E2E-003: `SELECT legal_details->>'aadhaarNumber' IS NOT NULL AS child_has, (SELECT legal_details->>'aadhaarNumber' IS NOT NULL FROM profiles WHERE user_id = ':admin_a') AS admin_has FROM profiles WHERE user_id = ':child_id';` | `t`, `f` | — | — |
| PRF-DB-018 | Profile cascades on user delete | `SELECT count(*) FROM profiles WHERE user_id = ':deleted_user_id';` | `0` | — | — |
| PRF-DB-019 | No cross-tenant profile access | `SELECT count(*) FROM profiles p JOIN users u ON u.id = p.user_id WHERE u.tenant_id = ':tenant_b' AND p.updated_at > now() - interval '5 minutes';` after editing only TENANT_A profiles | `0` | — | — |
