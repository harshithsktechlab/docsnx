# TC-13 — Follow-Ups · Notifications · Global Search

**Prefixes:** `FUP`, `NTF`, `SRC` · **Routes:** `/follow-up`, notification bell (shell), spotlight search
**Tables:** `notifications` (+ read-only aggregation across the record tables)

---

# PART A — Follow-Up / Renewal Alerts (`FUP`)

## Module Reference

The `/follow-up` screen aggregates four categories from across the tenant's records.
The alert threshold is **15 days** (`daysLeft <= 15`, which also matches all overdue items).
`SUPER_ADMIN` always receives four empty lists.

| Category | Source | Rule |
|---|---|---|
| **Renewals** | `vehicles` (insurance / PUC / fitness expiry), `lic_mediclaims` (premium due), `warranty_amcs` (expiry), `contract_agreements` (end date) | Item appears when `daysLeft <= 15` (including negative = overdue). Title switches between "… Expiring" and "… Overdue"; message reads "due in N days" or "overdue by N days" |
| **Insurance Gaps** | `users` × `lic_mediclaims` | For each member: if no policy with `policyType = lic` is linked (by `holderId` **or** by `insuredPerson` containing the member's name, case-insensitive) → "Missing Life Insurance". Same rule for `mediclaim` → "Missing Health Insurance" |
| **Documents Pending** | `users` × `documents` | For each member, checks their documents (matched by `holderId` **or** `userId`) for a **name or file name containing** `pan` / `aadhaar`\|`adhar` / `passport`. Any missing type produces a pending entry |
| **To-Dos Pending** | `todos` | All todos in the tenant with `status = PENDING` |

Renewals are sorted ascending by `daysLeft` (most urgent first).
The shell polls `/follow-up/count` every 60 seconds for the badge total.

## A1. UI Validation

| TC ID | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| FUP-UI-001 | Positive | Open `/follow-up` on a tenant with nothing due. | Insurance-gap and document-pending sections still populate (a new tenant has no policies/documents); renewals and pending to-dos show friendly empty states. | — | — |
| FUP-UI-002 | Positive | Open `/follow-up` with items in all four categories. | Four clearly separated sections: Renewals, Insurance Gaps, Documents Pending, To-Dos Pending — each with a count. | — | — |
| FUP-UI-003 | Positive | Inspect a renewal due in 7 days. | Title reads "… Expiring"; message reads "due in 7 days". | — | — |
| FUP-UI-004 | Positive | Inspect a renewal 5 days overdue. | Title reads "… Overdue"; message reads "overdue by 5 days"; styled more urgently than an upcoming item. | — | — |
| FUP-UI-005 | Positive | With several renewals at different distances, inspect the ordering. | Sorted ascending by days left — overdue items first, then nearest-due. | — | — |
| FUP-UI-006 | Positive | Click a renewal entry. | Navigates to the linked module (`/vehicles`, `/lic-mediclaim`, `/warranty`, `/rentals`). | — | — |
| FUP-UI-007 | Positive | Click an insurance-gap entry. | Navigates to `/lic-mediclaim`. | — | — |
| FUP-UI-008 | Positive | Click a documents-pending entry. | Navigates to `/documents`. | — | — |
| FUP-UI-009 | Positive | Observe the page while loading. | Skeletons then content; no flash of "nothing pending" before the real data arrives. | — | — |
| FUP-UI-010 | Negative | Trigger a fetch failure (offline). | Error state or toast; the page does not hang on a spinner. | — | — |
| FUP-UI-011 | Positive | Observe the sidebar follow-up badge. | Shows the aggregate count and matches the number of items rendered on `/follow-up`. | — | — |
| FUP-UI-012 | Positive | Complete a pending item (e.g. mark a To-Do done) and wait ~60 s. | The badge and page auto-refresh; the item disappears without a manual reload. | — | — |
| FUP-UI-013 | Positive | View `/follow-up` at 375px, 768px and 1440px. | Sections stack; long messages wrap; no horizontal page scroll. | — | — |
| FUP-UI-014 | Positive | Log in as SUPER_ADMIN and attempt to reach `/follow-up`. | Redirected away from tenant routes; no tenant data rendered. | — | — |

## A2. Business Rule Test Cases

| TC ID | Type | Rule / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| FUP-BR-001 | Boundary | Set a vehicle's insurance expiry to exactly **15 days** from today. | Appears under Renewals. | — | — |
| FUP-BR-002 | Boundary | Set it to exactly **16 days**. | Does **not** appear. | — | — |
| FUP-BR-003 | Boundary | Set it to **today**. | Appears with "due in 0 days" (or equivalent) — never "overdue by 0 days" or a blank. | — | — |
| FUP-BR-004 | Boundary | Set it to **yesterday**. | Appears as "overdue by 1 day". | — | — |
| FUP-BR-005 | Positive | Set all three vehicle dates (insurance, PUC, fitness) inside the window. | **Three separate** renewal entries appear for the one vehicle, each with the correct label. | — | — |
| FUP-BR-006 | Positive | Set an LIC premium due date inside the window. | Appears as a policy renewal with the company/policy name. | — | — |
| FUP-BR-007 | Positive | Set a warranty expiry inside the window. | Appears with the appliance name. | — | — |
| FUP-BR-008 | Positive | Set a rental end date inside the window. | Appears with the contract name and provider. | — | — |
| FUP-BR-009 | Business rule | Create a member with **no** LIC policy. | An insurance gap "Missing Life Insurance" appears naming that member. | — | — |
| FUP-BR-010 | Business rule | Add an LIC policy with `holderId` = that member. | The Life Insurance gap disappears for them. | — | — |
| FUP-BR-011 | Business rule | Add an LIC policy with a **blank holder** but `insuredPerson` containing the member's name. | The gap also disappears (name-matching path). | — | — |
| FUP-BR-012 | Edge | Add an LIC policy whose `insuredPerson` is the member's name in a **different case** (`ravi sharma` vs `Ravi Sharma`). | The gap still disappears (matching is case-insensitive). | — | — |
| FUP-BR-013 | **Edge** | Add an LIC policy whose `insuredPerson` is a *substring supersets* case — e.g. member "Ravi" and a policy insuring "Ravikant". | **The substring match will incorrectly clear Ravi's gap.** Record actual; a false-negative gap detection is a **S3** correctness defect. | — | — |
| FUP-BR-014 | Business rule | Add a Mediclaim policy for a member. | The Health Insurance gap disappears for them only — other members still show theirs. | — | — |
| FUP-BR-015 | Business rule | Verify gap detection against every member in the tenant. | Each member produces up to 2 gap entries; the total equals `(members × 2) − (covered combinations)`. | — | — |
| FUP-BR-016 | Business rule | Upload a document named "PAN Card - Ravi" with holder = Ravi. | Ravi's "Missing PAN Card" entry disappears. | — | — |
| FUP-BR-017 | Business rule | Upload a document named "Untitled" whose **file name** is `pan_scan.pdf`, holder = Ravi. | The gap also clears (the check inspects the file name as well as the display name). | — | — |
| FUP-BR-018 | Edge | Upload a document named "Company Panel Layout" for Ravi. | **The substring `pan` will match and wrongly clear the PAN gap.** Record actual — this is a **S3** false-negative. | — | — |
| FUP-BR-019 | Edge | Upload an Aadhaar document spelled "Adhar Card". | The Aadhaar gap clears (both spellings are matched). | — | — |
| FUP-BR-020 | Business rule | Upload a PAN document assigned via `userId` rather than `holderId`. | The gap clears (either linkage counts). | — | — |
| FUP-BR-021 | Business rule | Create a PENDING To-Do. | It appears under To-Dos Pending with its assignee name. | — | — |
| FUP-BR-022 | Business rule | Mark that To-Do COMPLETED. | It disappears from To-Dos Pending. | — | — |
| FUP-BR-023 | Edge | Create a PENDING To-Do with **no due date**. | Record actual — the pending-todos section lists all PENDING todos regardless of due date, so it should still appear. | — | — |
| FUP-BR-024 | Business rule | **Soft-delete** a vehicle whose insurance is due in 5 days, then reload `/follow-up`. | The renewal must disappear. Record actual — the follow-up aggregation does not filter on `deleted_at`, so a deleted record still raising an alert is a **S2** defect. | — | — |
| FUP-BR-025 | Business rule | Soft-delete an LIC policy that was covering a member's gap. | The insurance gap should re-appear. Record actual against the same `deleted_at` concern. | — | — |
| FUP-BR-026 | Security | Create records in TENANT_B with imminent expiries, then open TENANT_A's `/follow-up`. | None of TENANT_B's items appear; the badge count excludes them. | — | — |
| FUP-BR-027 | Positive | Log in as a `STANDARD` user with limited permissions and open `/follow-up`. | Record actual — confirm whether items from modules the user cannot view are filtered out. Leaking a module the user has no `canView` on is **S3**. | — | — |
| FUP-BR-028 | Positive | Compare the badge count with the on-page item total. | They match exactly. | — | — |

## A3. Database Validation

| TC ID | Validation Point | SQL Query | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| FUP-DB-001 | Vehicle renewals match the DB | `SELECT count(*) FROM vehicles WHERE tenant_id = ':tenant_a' AND (insurance_expiry <= now() + interval '15 days') ;` plus the same for `puc_expiry` and `fitness_expiry` | The sum of the three equals the number of vehicle renewal entries shown | — | — |
| FUP-DB-002 | Policy renewals match the DB | `SELECT count(*) FROM lic_mediclaims WHERE tenant_id = ':tenant_a' AND premium_due_date <= now() + interval '15 days';` | Equals the number of policy renewal entries shown | — | — |
| FUP-DB-003 | Warranty renewals match the DB | `SELECT count(*) FROM warranty_amcs WHERE tenant_id = ':tenant_a' AND expiry_date <= now() + interval '15 days';` | Equals the number of warranty entries shown | — | — |
| FUP-DB-004 | Contract renewals match the DB | `SELECT count(*) FROM contract_agreements WHERE tenant_id = ':tenant_a' AND end_date <= now() + interval '15 days';` | Equals the number of contract entries shown | — | — |
| FUP-DB-005 | Pending to-dos match the DB | `SELECT count(*) FROM todos WHERE tenant_id = ':tenant_a' AND status = 'PENDING';` | Equals the To-Dos Pending count | — | — |
| FUP-DB-006 | Insurance gaps — member count basis | `SELECT count(*) FROM users WHERE tenant_id = ':tenant_a' AND deleted_at IS NULL;` | Confirms the denominator for the gap calculation; note whether soft-deleted users are still counted | — | — |
| FUP-DB-007 | LIC coverage per member | `SELECT u.name, EXISTS (SELECT 1 FROM lic_mediclaims p WHERE p.tenant_id = u.tenant_id AND p.policy_type = 'lic' AND (p.holder_id = u.id OR lower(p.insured_person) LIKE '%' \|\| lower(u.name) \|\| '%')) AS has_lic FROM users u WHERE u.tenant_id = ':tenant_a';` | `has_lic = f` for exactly the members shown with a Life Insurance gap | — | — |
| FUP-DB-008 | Mediclaim coverage per member | Same query with `policy_type = 'mediclaim'` | `has_mediclaim = f` for exactly the members shown with a Health Insurance gap | — | — |
| FUP-DB-009 | Document coverage per member | `SELECT u.name, EXISTS (SELECT 1 FROM documents d WHERE d.tenant_id = u.tenant_id AND (d.holder_id = u.id OR d.user_id = u.id) AND (lower(d.name) LIKE '%pan%' OR lower(d.file_name) LIKE '%pan%')) AS has_pan FROM users u WHERE u.tenant_id = ':tenant_a';` | `has_pan = f` for exactly the members shown with a Missing PAN entry | — | — |
| FUP-DB-010 | **Soft-deleted records still counted** | Soft-delete a vehicle due in 5 days, then re-run FUP-DB-001 with and without `AND deleted_at IS NULL`. | The two counts differ; whichever the UI matches tells you whether FUP-BR-024 is a defect | — | — |
| FUP-DB-011 | Cross-tenant exclusion | `SELECT count(*) FROM vehicles WHERE tenant_id = ':tenant_b' AND insurance_expiry <= now() + interval '15 days';` | Whatever this returns, **none** of it appears on TENANT_A's `/follow-up` | — | — |
| FUP-DB-012 | Badge total matches the aggregate | Sum FUP-DB-001 … FUP-DB-005 plus the gap and document counts. | Equals the sidebar badge number | — | — |

---

# PART B — Notifications (`NTF`)

## Module Reference

| Aspect | Detail |
|---|---|
| Table | `notifications` — `tenant_id`, `user_id`, `title`, `message`, `link`, `is_read` (default `false`), `created_at` |
| Delivery | Bell dropdown in the shell; polled every 60 s (skipped for `SUPER_ADMIN`) |
| Push | Optional device push via `user_devices` (FCM), e.g. from To-Do assignment |
| Scope | Per-user within a tenant (`user_id` is NOT NULL) |

## B1. Test Cases

| TC ID | Category | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|---|
| NTF-UI-001 | UI | Positive | Open the bell with no notifications. | Empty state ("You're all caught up") — not a blank dropdown. | — | — |
| NTF-UI-002 | UI | Positive | Open the bell with unread notifications. | Badge shows the unread count; items listed newest-first with title, message and relative time; unread items visually distinct from read ones. | — | — |
| NTF-UI-003 | UI | Positive | Click a notification. | Navigates to its `link`; the item is marked read; the badge decrements by one. | — | — |
| NTF-UI-004 | UI | Positive | Use "Mark all as read" (if present). | All items become read; the badge clears. | — | — |
| NTF-UI-005 | UI | Positive | Generate a notification in another tab and wait ~60 s. | The badge updates on the poll without a manual reload. | — | — |
| NTF-UI-006 | UI | Boundary | Generate 50+ notifications. | The dropdown scrolls or paginates; it does not grow beyond the viewport or freeze the page. | — | — |
| NTF-UI-007 | UI | Edge | A notification with a very long title/message. | Truncated with an ellipsis in the dropdown; full text available on the target page. | — | — |
| NTF-UI-008 | UI | Edge | A notification whose title contains `<script>alert(1)</script>`. | Rendered as literal text. | — | — |
| NTF-UI-009 | UI | Positive | Open the bell at 375px width. | The dropdown fits the viewport; items remain tappable; no horizontal page scroll. | — | — |
| NTF-BR-001 | Business | Positive | Trigger an event that notifies a specific user (e.g. To-Do assignment). | Only that user sees it — other members of the same tenant do not. | — | — |
| NTF-BR-002 | Business | Security | Create a notification in TENANT_B, then check TENANT_A's bell. | Not visible. | — | — |
| NTF-BR-003 | Business | Negative | Attempt to mark another user's notification read (manipulated id). | 403/404; the other user's notification stays unread. | — | — |
| NTF-BR-004 | Business | Positive | Read a notification, then reload the page. | It stays read (persisted, not just client state). | — | — |
| NTF-BR-005 | Business | Positive | Delete the notification's target record, then click the notification. | The target page loads gracefully with a "record not found" state — not a crash or an infinite spinner. | — | — |
| NTF-BR-006 | Business | Positive | Log in as SUPER_ADMIN. | No notification polling occurs and no tenant notifications are shown. | — | — |
| NTF-BR-007 | Business | Security | Inspect a push notification's payload on a device. | Contains no password, account number, card number or other tenant's data. | — | — |
| NTF-DB-001 | DB | Tenant & user scoping | `SELECT tenant_id, user_id, title, is_read FROM notifications WHERE id = ':notification_id';` | `tenant_id = :tenant_a`; `user_id` = the intended recipient; `is_read = false` initially | — | — |
| NTF-DB-002 | DB | Unread count matches the badge | `SELECT count(*) FROM notifications WHERE tenant_id = ':tenant_a' AND user_id = ':user_a1' AND is_read = false;` | Equals the badge number shown to that user | — | — |
| NTF-DB-003 | DB | Read flag persists | Click a notification, then: `SELECT is_read FROM notifications WHERE id = ':notification_id';` | `true` | — | — |
| NTF-DB-004 | DB | Link is a valid in-app path | `SELECT link FROM notifications WHERE id = ':notification_id';` | A relative in-app path (e.g. `/todos`) — never an external URL | — | — |
| NTF-DB-005 | DB | Recipient is same-tenant | `SELECT count(*) FROM notifications n JOIN users u ON u.id = n.user_id WHERE n.tenant_id <> u.tenant_id;` | `0` | — | — |
| NTF-DB-006 | DB | Cross-tenant isolation (P7) | `SELECT count(*) FROM notifications WHERE id = ':notification_id' AND tenant_id = ':tenant_b';` | `0` | — | — |
| NTF-DB-007 | DB | Tenant delete cascades | Delete a throwaway tenant, then: `SELECT count(*) FROM notifications WHERE tenant_id = ':tenant_x';` | `0` | — | — |
| NTF-DB-008 | DB | No orphan notifications | `SELECT count(*) FROM notifications n LEFT JOIN users u ON u.id = n.user_id WHERE u.id IS NULL;` | `0` | — | — |

---

# PART C — Global Search (`SRC`)

## Module Reference

| Aspect | Detail |
|---|---|
| Entry point | Spotlight search in the shell; 250 ms debounce; keyboard-navigable (↑/↓/Enter) |
| Modules searched | documents, medical records, passwords, bank infos, trading demats, vehicles, LIC policies, investments |
| Matching | Substring (`ILIKE %q%`) on plaintext columns |
| Encrypted columns | **Cannot** be substring-searched. The query is converted to a **blind index** and matched exactly against `*_hash` columns (account number, client ID, demat number, policy number) |
| Masking | Results derived from encrypted fields are returned masked (`maskTail`) |
| Scope | Every query is filtered by the session tenant; `SUPER_ADMIN` always receives an empty result set |
| Empty query | Returns an empty result list without hitting the database |

## C1. Test Cases

| TC ID | Category | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|---|
| SRC-UI-001 | UI | Positive | Open spotlight and type 3+ characters. | Debounced request (~250 ms after typing stops); loading indicator; results grouped by module with an icon/label per group. | — | — |
| SRC-UI-002 | UI | Positive | Type quickly across 10 characters. | Only one request fires after the pause — not one per keystroke. | — | — |
| SRC-UI-003 | UI | Positive | Press ↓ / ↑ / Enter with results showing. | Highlight moves; Enter opens the highlighted record's module. | — | — |
| SRC-UI-004 | UI | Positive | Press Escape. | The spotlight closes and the query is cleared. | — | — |
| SRC-UI-005 | UI | Edge | Clear the input. | Results clear immediately; no stale results retained. | — | — |
| SRC-UI-006 | UI | Negative | Search a string matching nothing. | Friendly "no results" state, not a blank panel. | — | — |
| SRC-UI-007 | UI | Boundary | Search a single character. | Either results or a "type more" hint — no crash and no unbounded result set. | — | — |
| SRC-UI-008 | UI | Boundary | Search a 500-character string. | Handled gracefully; no 500 error. | — | — |
| SRC-UI-009 | UI | Edge | Search with only spaces. | Treated as empty; returns nothing without an error. | — | — |
| SRC-UI-010 | UI | Positive | Search a term that hits 5 different modules. | Results grouped under each module heading; each group is capped (10 per module) rather than flooding the panel. | — | — |
| SRC-UI-011 | UI | Positive | View spotlight at 375px. | Panel fits the viewport; results scroll within the panel. | — | — |
| SRC-FLD-001 | Field | Edge | Search with SQL metacharacters `' OR 1=1 --`. | Treated as a literal string; no error; no extra rows returned. | — | — |
| SRC-FLD-002 | Field | Edge | Search with `%` and `_` (SQL LIKE wildcards). | Treated literally or escaped — must not return the entire dataset. Record actual; a wildcard that dumps all records is **S3**. | — | — |
| SRC-FLD-003 | Field | Edge | Search a unicode/emoji substring present in a record title. | Returns the matching record. | — | — |
| SRC-FLD-004 | Field | Edge | Search in a different case than stored. | Matches (search is case-insensitive via `ILIKE`). | — | — |
| SRC-FLD-005 | Field | Edge | Search `<script>alert(1)</script>`. | Rendered as literal text in the results panel; no script execution. | — | — |
| SRC-BR-001 | Business | Positive | Create a document, medical record, password, bank account, trading account, vehicle, policy and investment all sharing the token "QAFIND". Search "QAFIND". | All eight modules return their record, correctly grouped. | — | — |
| SRC-BR-002 | Business | Positive | Search the **full** bank account number. | The bank record is returned via the blind index, with the number masked in the result. | — | — |
| SRC-BR-003 | Business | Negative | Search a **partial** bank account number (middle 4 digits). | No match — encrypted columns cannot be substring-searched. | — | — |
| SRC-BR-004 | Business | Positive | Search the full trading client ID and the full policy number. | Each returns its record via the blind index. | — | — |
| SRC-BR-005 | Business | Edge | Search the full account number with different spacing/case. | Still matches (the blind index normalises trim/whitespace/case). | — | — |
| SRC-BR-006 | Business | Security | Search a term matching a **password** record and inspect the result payload. | Title/username/URL may be returned; the password itself must **never** be present. | — | — |
| SRC-BR-007 | Business | Security | Search a term matching a bank record and inspect the payload. | Account number is masked; `account_number_hash` is not returned. | — | — |
| SRC-BR-008 | Business | Security | Create "TenantBSecret" in TENANT_B, then search it from TENANT_A. | Zero results; no partial or masked disclosure. | — | — |
| SRC-BR-009 | Business | Security | Log in as SUPER_ADMIN and search anything. | Always zero results — SUPER_ADMIN must never read tenant data. | — | — |
| SRC-BR-010 | Business | Business rule | Soft-delete a document, then search its name. | It must not appear. Record actual — the search does not filter on `deleted_at` for every table, so a deleted record surfacing is **S2**. | — | — |
| SRC-BR-011 | Business | Business rule | Log in as USER_A3 (no `passwords` / `bank_info` permission) and search a term matching those records. | Record actual — search results should honour per-module permissions. Returning records from a module the user cannot view is **S2**. | — | — |
| SRC-BR-012 | Business | Boundary | Create 50 documents all matching one term, then search it. | Only the first 10 per module are returned (the documented cap); the panel stays responsive. | — | — |
| SRC-BR-013 | Business | Edge | Search while the subscription is expired. | Access blocked consistently with the rest of the app. | — | — |
| SRC-DB-001 | DB | Result count matches the DB | `SELECT count(*) FROM documents WHERE tenant_id = ':tenant_a' AND (name ILIKE '%QAFIND%' OR category ILIKE '%QAFIND%');` | Equals the number of Documents results shown (capped at 10) | — | — |
| SRC-DB-002 | DB | Blind-index lookup works | `SELECT count(*) FROM bank_infos WHERE tenant_id = ':tenant_a' AND account_number_hash = ':blind_index_of_query';` | `1` for an exact-match search that returned a hit | — | — |
| SRC-DB-003 | DB | No cross-tenant rows are reachable | `SELECT count(*) FROM documents WHERE tenant_id = ':tenant_b' AND name ILIKE '%QAFIND%';` | Whatever this returns, none of it appears in TENANT_A's search | — | — |
| SRC-DB-004 | DB | Soft-deleted rows excluded | Soft-delete a matching document, then: `SELECT count(*) FROM documents WHERE tenant_id = ':tenant_a' AND name ILIKE '%QAFIND%' AND deleted_at IS NULL;` | Matches the number of results shown — a mismatch confirms SRC-BR-010 | — | — |
| SRC-DB-005 | DB | Per-module cap | `SELECT count(*) FROM documents WHERE tenant_id = ':tenant_a' AND name ILIKE '%QAFIND%';` after creating 50 matches | DB returns 50; the UI shows at most 10 | — | — |

---

## Cross-Module End-to-End Workflows

| TC ID | Workflow | Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| FNS-E2E-001 | Full follow-up lifecycle | 1. Create a vehicle (insurance 7 days), a policy (premium 12 days), a warranty (expiry 3 days) and a PENDING To-Do.<br>2. Open `/follow-up`.<br>3. Note the badge count.<br>4. Resolve each item (renew dates, complete the To-Do).<br>5. Re-open `/follow-up`. | All four appear correctly ordered by urgency; the badge matches; after resolution all four disappear and the badge drops to the remaining gap/document entries. | — | — |
| FNS-E2E-002 | Gap closure | 1. Add 3 members with no policies or documents.<br>2. Open `/follow-up` and count gaps and pending documents.<br>3. Add an LIC policy, a Mediclaim policy, a PAN, an Aadhaar and a Passport for one member.<br>4. Re-open `/follow-up`. | Initially 6 insurance gaps and 9 pending documents (3 members × 2 and × 3); after step 3 that member's 5 entries clear and the others remain. | — | — |
| FNS-E2E-003 | Notification → record | 1. Assign a To-Do to yourself with push enabled.<br>2. Observe the bell within one poll cycle.<br>3. Click the notification.<br>4. Complete the task. | Badge increments; clicking navigates to `/todos` and marks the notification read; completing removes it from follow-ups. | — | — |
| FNS-E2E-004 | Search across a populated tenant | 1. Populate all 8 searchable modules with records sharing a token.<br>2. Search the token.<br>3. Search a full encrypted identifier.<br>4. Search a partial encrypted identifier. | Step 2 returns grouped hits from all 8; step 3 returns the exact record masked; step 4 returns nothing. | — | — |
| FNS-E2E-005 | Isolation sweep | 1. Populate TENANT_B with imminent expiries, notifications and searchable records.<br>2. Log in to TENANT_A.<br>3. Check `/follow-up`, the bell and spotlight search. | TENANT_A sees none of TENANT_B's data in any of the three surfaces. | — | — |
| FNS-E2E-006 | Deleted-record hygiene | 1. Create a vehicle due in 5 days and a document named "QAFIND Passport".<br>2. Confirm both appear in follow-ups/search.<br>3. Soft-delete both.<br>4. Re-check follow-ups and search. | Both must disappear from both surfaces. Any survivor is **S2** (deleted data resurfacing). | — | — |
