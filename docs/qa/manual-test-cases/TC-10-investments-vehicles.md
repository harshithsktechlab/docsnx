# TC-10 — Investments & Vehicles

**Prefixes:** `INV`, `VEH` · **Routes:** `/investments`, `/vehicles`
**Tables:** `investments`, `vehicles` · **Permission keys:** `investments`, `vehicles`

---

# PART A — Investments (`INV`)

## Module Reference

| Aspect | Detail |
|---|---|
| Required fields | Category*, Title*, Purchase Date*, Purchase Value*, Current Value* — otherwise "Missing required investment fields" |
| Optional | Quantity, Details (jsonb), Custom Fields[], Assigned Member; property-specific: Property Tax Due Date, Property Tax Receipt Uploaded, 7/12 Extract, Namuna D, Map |
| Categories | `property` (Property), `shares` (Shares), `mutual_funds` (Mutual Funds), `gold_silver` (Gold / Silver) |
| Numeric precision | `purchase_value` / `current_value` decimal(15,2); `quantity` decimal(15,4) |
| Derived display | Gain/loss = `current_value − purchase_value`; percentage = gain / purchase_value × 100 |
| AI | An AI analysis is generated and stored in `ai_analysis` |
| Follow-up generation | `POST /investments/[id]/generate-followups` creates To-Dos; requires the **edit** permission |
| Soft delete | Yes (`deleted_at`) |

## A1. UI Validation

| TC ID | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| INV-UI-001 | Positive | Open `/investments` empty and populated. | Empty state with CTA; populated view shows title, category badge, purchase/current value and gain/loss. | — | — |
| INV-UI-002 | Positive | Inspect a record where current > purchase. | Gain is shown in a positive colour with a correct amount and percentage. | — | — |
| INV-UI-003 | Positive | Inspect a record where current < purchase. | Loss is shown in a negative colour with a correct amount and percentage. | — | — |
| INV-UI-004 | Edge | Inspect a record where current == purchase. | Renders as 0 / 0.00% — not as `NaN`, `Infinity` or a blank. | — | — |
| INV-UI-005 | Edge | Inspect a record with purchase value 0 and current value > 0. | Percentage calculation does not divide by zero (shows `—`, `N/A` or `∞` deliberately, never `NaN`). | — | — |
| INV-UI-006 | Positive | Use the category filter tabs (All Assets / Property / Shares / Mutual Funds / Gold / Silver). | Filters correctly; active tab highlighted. | — | — |
| INV-UI-007 | Positive | Search "by asset name". | Live filtering by title. | — | — |
| INV-UI-008 | Positive | Open the Add dialog. | Category select ("Select Asset Category"), Title, Purchase Date, Purchase Value, Current Value, Quantity, Details, Custom Fields, Assigned Member. | — | — |
| INV-UI-009 | Positive | Choose category = Property. | Property-specific fields appear: address, Property Tax Due Date, Property Tax Receipt, 7/12 Extract, Namuna D, Map toggles. | — | — |
| INV-UI-010 | Positive | Choose category = Shares, then Mutual Funds. | The form adapts (ticker vs. fund name placeholders); property-only fields are hidden. | — | — |
| INV-UI-011 | Positive | Save a valid investment. | Spinner; success toast; list refreshes; an AI analysis section appears on the record. | — | — |
| INV-UI-012 | Positive | Click "Generate Follow-ups" on a property with an upcoming tax due date. | To-Dos are created and a confirmation is shown with the number generated. | — | — |
| INV-UI-013 | Negative | Trigger a follow-up generation failure. | Toast with the server message; no partial tasks created. | — | — |
| INV-UI-014 | Positive | View the portfolio summary/total. | Total purchase value and total current value equal the sum of the visible records. | — | — |
| INV-UI-015 | Positive | Edit / Delete a record. | Edit pre-fills every field; Delete confirms first. | — | — |
| INV-UI-016 | Positive | View at 375px. | Cards stack; long currency figures do not overflow; no horizontal page scroll. | — | — |
| INV-UI-017 | Positive | As a view-only user, open `/investments`. | Add/Edit/Delete and Generate Follow-ups are hidden or disabled. | — | — |

## A2. Field Validation

| TC ID | Field | Type | Input / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|---|
| INV-FLD-001 | All required | Negative | Submit with all fields blank. | "Missing required investment fields"; no row created. | — | — |
| INV-FLD-002 | Each required field | Negative | Omit exactly one required field at a time (5 runs). | Each rejected with the same message. | — | — |
| INV-FLD-003 | Category | Positive | Each of property / shares / mutual_funds / gold_silver. | Saved; the record appears under the matching filter tab. | — | — |
| INV-FLD-004 | Title | Boundary | 255 / 256 characters. | 255 accepted; 256 rejected. | — | — |
| INV-FLD-005 | Title | Edge | Unicode/emoji `सोने 🪙`. | Stored and displayed correctly; searchable. | — | — |
| INV-FLD-006 | Purchase Value | Positive | `50000`. | Stored as `50000.00`. | — | — |
| INV-FLD-007 | Purchase Value | Boundary | `0`, `0.01`, `9999999999999.99` (precision 15,2). | All accepted exactly. | — | — |
| INV-FLD-008 | Purchase Value | Boundary | `99999999999999.99` (over precision). | Rejected with a clear message — never a 500 or a silently truncated value. | — | — |
| INV-FLD-009 | Purchase Value | Negative | `-5000`. | Rejected — a negative purchase value is invalid. Record actual; acceptance ⇒ **S2**. | — | — |
| INV-FLD-010 | Purchase Value | Negative | `abc` and `50,000` (with a separator). | Rejected or normalised; must never persist as `NaN`. | — | — |
| INV-FLD-011 | Purchase Value | Edge | `1000.555` (3 decimals). | Rounded to 2 decimals per the column scale; record the rounding direction. | — | — |
| INV-FLD-012 | Current Value | Boundary/Negative | Same set as Purchase Value. | Same expectations. | — | — |
| INV-FLD-013 | Current Value | Edge | `0` with a non-zero purchase value. | Accepted (a total write-off is valid); loss shows as −100%. | — | — |
| INV-FLD-014 | Quantity | Positive | `10.5`, `25.123`, `50`. | All accepted; 4-decimal precision preserved (`25.1230`). | — | — |
| INV-FLD-015 | Quantity | Boundary | `0.0001` and `0.00001` (5 decimals). | `0.0001` preserved; the 5-decimal value is rounded per scale 4 — record actual. | — | — |
| INV-FLD-016 | Quantity | Negative | Negative quantity. | Rejected. | — | — |
| INV-FLD-017 | Quantity | Edge | Blank. | Accepted (nullable). | — | — |
| INV-FLD-018 | Purchase Date | Positive | A past date. | Saved and displayed. | — | — |
| INV-FLD-019 | Purchase Date | Edge | A future date. | Record actual — a future purchase date should be rejected or flagged. | — | — |
| INV-FLD-020 | Purchase Date | Boundary | `1900-01-01` and today. | Both stored and rendered correctly. | — | — |
| INV-FLD-021 | Property Tax Due Date | Positive | A date 10 days out. | Saved; the record surfaces in follow-ups. | — | — |
| INV-FLD-022 | Property flags | Positive | Toggle 7/12 Extract, Namuna D, Map, Tax Receipt Uploaded. | Each toggle saves independently and re-displays correctly. | — | — |
| INV-FLD-023 | Property flags | Edge | Set the property flags on a non-property category. | Either hidden by the UI or stored harmlessly — they must not corrupt the record. Record actual. | — | — |
| INV-FLD-024 | Details | Positive | Fill category-specific details (address / ticker / fund name). | Stored in the `details` JSON and re-displayed. | — | — |
| INV-FLD-025 | Custom Fields | Positive | Add "Folio Number" label/value pairs. | Saved and displayed. | — | — |
| INV-FLD-026 | Assigned Member | Negative | Assign to another tenant's user id. | Rejected. | — | — |
| INV-FLD-027 | All | Edge | `<script>alert(1)</script>` in Title. | Rendered as literal text. | — | — |
| INV-FLD-028 | All | Edge | Double-click Save. | Exactly one record created; only one AI analysis charged. | — | — |

## A3. Business Rules

| TC ID | Type | Rule / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| INV-BR-001 | Positive | Create an investment. | `tenant_id` from the session; `user_id` = the assigned member (default: creator). | — | — |
| INV-BR-002 | Positive | Verify the gain/loss shown against the stored values. | `current_value − purchase_value` exactly; percentage matches to 2 decimals. | — | — |
| INV-BR-003 | Positive | Verify the portfolio total. | Equals the SUM of all non-deleted investments for the tenant. | — | — |
| INV-BR-004 | Business rule | Create an investment and inspect `ai_analysis`. | Populated; the record still saves if AI is unavailable (graceful degradation, not a 500). | — | — |
| INV-BR-005 | Security | Create an investment with an account/folio number in details, then check the AI payload. | Identifiers masked before the model call. | — | — |
| INV-BR-006 | Business rule | Click Generate Follow-ups on a property whose tax is due in 10 days. | A To-Do is created with the correct task text, due date and assignee (the investment's owner). | — | — |
| INV-BR-007 | Business rule | Click Generate Follow-ups when nothing is due within the threshold. | No tasks created; a clear "nothing due" message rather than a silent no-op or an error. | — | — |
| INV-BR-008 | Business rule | Click Generate Follow-ups **twice** for the same investment. | Record actual — duplicate To-Dos indicate a missing idempotency guard ⇒ **S3**. | — | — |
| INV-BR-009 | Negative | Generate Follow-ups as a user with `canView` but not `canEdit`. | Forbidden — the action requires the edit permission. | — | — |
| INV-BR-010 | Negative | Generate Follow-ups for a TENANT_B investment id. | 404 "not found"; no To-Do created in either tenant. | — | — |
| INV-BR-011 | Negative | ADMIN_B attempts to view/edit/delete a TENANT_A investment id. | 403/404; record unchanged. | — | — |
| INV-BR-012 | Positive | Delete an investment. | Soft-deleted; removed from list, portfolio totals, search and dashboard counts. | — | — |
| INV-BR-013 | Positive | Create/edit/delete and check `/audit-logs`. | One entry per mutation. | — | — |
| INV-BR-014 | Negative | Subscription expired → open `/investments`. | Access blocked. | — | — |
| INV-BR-015 | Edge | Create 200 investments and open the module. | The list paginates and remains responsive; totals stay correct. | — | — |

## A4. Database Validation

| TC ID | Validation Point | SQL Query | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| INV-DB-001 | Tenant stamping (P1) | `SELECT tenant_id, category, title FROM investments WHERE id = ':record_id';` | `tenant_id = :tenant_a`; values as entered | — | — |
| INV-DB-002 | Monetary precision preserved | `SELECT purchase_value, current_value, quantity FROM investments WHERE id = ':record_id';` | Exactly the values entered — 2 decimals for values, 4 for quantity | — | — |
| INV-DB-003 | No negative monetary values | `SELECT count(*) FROM investments WHERE tenant_id = ':tenant_a' AND (purchase_value < 0 OR current_value < 0 OR quantity < 0);` | `0` | — | — |
| INV-DB-004 | Category constrained | `SELECT DISTINCT category FROM investments WHERE tenant_id = ':tenant_a';` | Only `property`, `shares`, `mutual_funds`, `gold_silver` | — | — |
| INV-DB-005 | Portfolio total matches the UI | `SELECT sum(purchase_value) AS invested, sum(current_value) AS current FROM investments WHERE tenant_id = ':tenant_a' AND deleted_at IS NULL;` | Both figures match the portfolio summary shown | — | — |
| INV-DB-006 | Gain/loss matches the UI | `SELECT title, current_value - purchase_value AS gain, round((current_value - purchase_value) / NULLIF(purchase_value,0) * 100, 2) AS pct FROM investments WHERE id = ':record_id';` | Matches the amount and percentage rendered on the card | — | — |
| INV-DB-007 | Details stored as JSON | `SELECT jsonb_typeof(details) FROM investments WHERE id = ':record_id';` | `object` | — | — |
| INV-DB-008 | AI analysis stored as JSON | `SELECT jsonb_typeof(ai_analysis) FROM investments WHERE id = ':record_id';` | `object` (or `null` if AI was unavailable) | — | — |
| INV-DB-009 | Property flags default to false | Create a non-property investment, then: `SELECT has_712_extract, has_namuna_d, has_map, property_tax_receipt_uploaded FROM investments WHERE id = ':record_id';` | `f, f, f, f` | — | — |
| INV-DB-010 | Property tax due date persisted | `SELECT property_tax_due_date FROM investments WHERE id = ':property_id';` | Matches the date entered | — | — |
| INV-DB-011 | Follow-up generation creates To-Dos in the same tenant | After INV-BR-006: `SELECT tenant_id, task, due_date, assignee_id FROM todos WHERE tenant_id = ':tenant_a' ORDER BY created_at DESC LIMIT 1;` | `tenant_id = :tenant_a`; task text references the investment; due date matches the tax due date | — | — |
| INV-DB-012 | Duplicate follow-up check | Run Generate Follow-ups twice, then: `SELECT count(*) FROM todos WHERE tenant_id = ':tenant_a' AND task LIKE '%Property Tax%';` | Record actual — `2` indicates missing idempotency | — | — |
| INV-DB-013 | Audit timestamps (P2) | `SELECT created_at IS NOT NULL, updated_at IS NOT NULL, updated_at >= created_at FROM investments WHERE id = ':record_id';` | `t, t, t` | — | — |
| INV-DB-014 | Soft delete (P3) | `SELECT deleted_at FROM investments WHERE id = ':record_id';` | Non-null after a UI delete | — | — |
| INV-DB-015 | Deleted rows excluded from totals | Soft-delete one record, then re-run INV-DB-005. | Totals drop by exactly that record's values and match the UI | — | — |
| INV-DB-016 | Cross-tenant isolation (P7) | `SELECT count(*) FROM investments WHERE id = ':record_id' AND tenant_id = ':tenant_b';` | `0` | — | — |
| INV-DB-017 | Owner/holder are same-tenant | `SELECT count(*) FROM investments i JOIN users u ON u.id = i.user_id WHERE i.tenant_id <> u.tenant_id;` | `0` | — | — |
| INV-DB-018 | Audit log per mutation (P4) | `SELECT action, details FROM audit_logs WHERE tenant_id = ':tenant_a' ORDER BY created_at DESC LIMIT 3;` | Entries matching the create/update/delete performed | — | — |

---

# PART B — Vehicles (`VEH`)

## Module Reference

| Aspect | Detail |
|---|---|
| Required fields | Vehicle Name*, Vehicle Number*, Owner Name*, Registration Date*, Insurance Expiry*, PUC Expiry*, Fitness Expiry* — otherwise "Missing required vehicle fields" |
| Optional | Last Service Date, Next Service Date, Service Notes, File, Custom Fields[], Assigned Member |
| Column limits | `vehicle_name` 255 · `vehicle_number` 100 · `owner_name` 255 |
| Follow-up generation | `POST /vehicles/[id]/generate-followups` creates a To-Do for **each** of Insurance / PUC / Fitness expiring **within 30 days or already overdue**; requires the **edit** permission; assignee = the vehicle's owner |
| Follow-up page threshold | The `/follow-up` screen alerts on items within **15 days** (note: different from the 30-day generation window) |
| Storage quota | Attaching a file is subject to `checkStorageLimit` |
| Soft delete | Yes (`deleted_at`) |

## B1. UI Validation

| TC ID | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| VEH-UI-001 | Positive | Open `/vehicles` empty and populated. | Empty state with CTA; populated view shows vehicle name, number, owner and the three expiry dates. | — | — |
| VEH-UI-002 | Positive | View a vehicle with an expiry in the past. | That expiry is visibly flagged as overdue (colour/badge). | — | — |
| VEH-UI-003 | Positive | View a vehicle with an expiry 10 days out. | Flagged as expiring soon with the correct day count. | — | — |
| VEH-UI-004 | Positive | View a vehicle with all expiries far in the future. | No warning styling. | — | — |
| VEH-UI-005 | Positive | Search "by name, number, owner". | Live filtering across all three fields. | — | — |
| VEH-UI-006 | Positive | Open the Add dialog. | Vehicle Name, Vehicle Number (`MH-12-XX-1234`), Owner Name, Registration Date, Insurance Expiry, PUC Expiry, Fitness Expiry, Last/Next Service Date, Service Notes, file picker, AI Auto-fill, Custom Fields. | — | — |
| VEH-UI-007 | Negative | Click AI Auto-fill without selecting a file. | Toast "Please select or upload a document file first to use AI Auto-fill." | — | — |
| VEH-UI-008 | Positive | Run AI Auto-fill on an RC book scan. | Fields populate from the extracted data; all remain editable. | — | — |
| VEH-UI-009 | Negative | Force an AI failure. | Toast "Network error calling AI Scan endpoint"; nothing saved. | — | — |
| VEH-UI-010 | Positive | Click "Generate Follow-ups" on a vehicle with two expiries within 30 days. | Two To-Dos created; the confirmation states how many. | — | — |
| VEH-UI-011 | Negative | Trigger a follow-up generation failure. | Toast with the server message ("Failed to generate follow-ups" / "Network error. Please try again."); no partial tasks. | — | — |
| VEH-UI-012 | Positive | Edit / Delete a vehicle. | Edit pre-fills everything; Delete confirms first; on failure a toast "Network error deleting record" and the row stays. | — | — |
| VEH-UI-013 | Positive | View at 375px. | Cards stack; the three expiry chips wrap; no horizontal page scroll. | — | — |
| VEH-UI-014 | Positive | As a view-only user, open `/vehicles`. | Add/Edit/Delete and Generate Follow-ups are hidden or disabled. | — | — |

## B2. Field Validation

| TC ID | Field | Type | Input / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|---|
| VEH-FLD-001 | All required | Negative | Submit with all seven required fields blank. | "Missing required vehicle fields"; no row created. | — | — |
| VEH-FLD-002 | Each required field | Negative | Omit exactly one required field at a time (7 runs). | Each rejected with the same message. | — | — |
| VEH-FLD-003 | Vehicle Name | Boundary | 255 / 256 characters. | 255 accepted; 256 rejected. | — | — |
| VEH-FLD-004 | Vehicle Number | Positive | `MH-12-XX-1234`. | Accepted and displayed as typed. | — | — |
| VEH-FLD-005 | Vehicle Number | Boundary | 100 / 101 characters. | 100 accepted; 101 rejected. | — | — |
| VEH-FLD-006 | Vehicle Number | Edge | Lowercase `mh12ab1234` and spaced `MH 12 AB 1234`. | Accepted; record whether the value is normalised (uppercase / de-spaced) and whether search finds both forms. | — | — |
| VEH-FLD-007 | Vehicle Number | Edge | Two vehicles with the same number. | Record actual — a duplicate registration number should ideally be rejected or warned. | — | — |
| VEH-FLD-008 | Owner Name | Boundary | 255 / 256 characters. | 255 accepted; 256 rejected. | — | — |
| VEH-FLD-009 | Registration Date | Positive | A past date. | Accepted. | — | — |
| VEH-FLD-010 | Registration Date | Edge | A future date. | Record actual — a future registration date should be rejected. | — | — |
| VEH-FLD-011 | Insurance Expiry | Positive | A future date. | Accepted; drives follow-ups. | — | — |
| VEH-FLD-012 | Insurance Expiry | Edge | A past date. | Accepted; shown as overdue. | — | — |
| VEH-FLD-013 | Expiry dates | Edge | An expiry **earlier** than the registration date. | Record actual — an inconsistent pair should be flagged. | — | — |
| VEH-FLD-014 | Expiry dates | Boundary | Expiry exactly today. | Treated consistently by both the display badge and follow-up generation (0 days, not −1). | — | — |
| VEH-FLD-015 | Expiry dates | Boundary | Expiry exactly 30 days out, and 31 days out. | 30 days generates a follow-up; 31 days does not. | — | — |
| VEH-FLD-016 | Expiry dates | Boundary | Expiry exactly 15 days out, and 16 days out. | 15 days appears on `/follow-up`; 16 days does not. | — | — |
| VEH-FLD-017 | Service Dates | Edge | Next Service Date earlier than Last Service Date. | Record actual — should be flagged. | — | — |
| VEH-FLD-018 | Service Notes | Boundary | 10 000-character note. | Accepted (text column) and fully retrievable. | — | — |
| VEH-FLD-019 | File | Boundary | Attach a file that breaches the storage quota. | Rejected with the quota message; no row created. | — | — |
| VEH-FLD-020 | File | Edge | Save with no file. | Accepted (`file_path` nullable, `file_size = 0`). | — | — |
| VEH-FLD-021 | Custom Fields | Positive | Add "Engine Number" label/value pairs. | Saved and displayed. | — | — |
| VEH-FLD-022 | Assigned Member | Negative | Assign to another tenant's user id. | Rejected. | — | — |
| VEH-FLD-023 | All | Edge | `<script>alert(1)</script>` in Vehicle Name and Service Notes. | Rendered as literal text. | — | — |
| VEH-FLD-024 | All | Edge | Double-click Save. | Exactly one vehicle created. | — | — |

## B3. Business Rules

| TC ID | Type | Rule / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| VEH-BR-001 | Positive | Create a vehicle. | `tenant_id` from the session; `user_id` = the assigned member. | — | — |
| VEH-BR-002 | Business rule | Generate Follow-ups on a vehicle with Insurance in 10 days, PUC in 20 days, Fitness in 200 days. | Exactly **two** To-Dos are created (Insurance, PUC); Fitness is skipped. | — | — |
| VEH-BR-003 | Business rule | Generate Follow-ups on a vehicle with an overdue insurance expiry. | A To-Do is still created (overdue items match the ≤30-day window). | — | — |
| VEH-BR-004 | Business rule | Verify a generated To-Do's contents. | Task text names the vehicle and its number; `due_date` = the expiry date; `assignee_id` = the vehicle's owner; `status = PENDING`; same tenant. | — | — |
| VEH-BR-005 | Business rule | Generate Follow-ups with nothing due inside 30 days. | Zero tasks created and a clear message — not a silent success. | — | — |
| VEH-BR-006 | Business rule | Generate Follow-ups **twice** for the same vehicle. | Record actual — duplicate To-Dos indicate a missing idempotency guard ⇒ **S3**. | — | — |
| VEH-BR-007 | Negative | Generate Follow-ups as a `canView`-only user. | Forbidden — the action requires the edit permission. | — | — |
| VEH-BR-008 | Negative | Generate Follow-ups for a TENANT_B vehicle id. | 404 "Vehicle not found"; no To-Do created in either tenant. | — | — |
| VEH-BR-009 | Business rule | Set Insurance Expiry 10 days out and open `/follow-up`. | The vehicle appears with "Vehicle Insurance Expiring … due in 10 days". | — | — |
| VEH-BR-010 | Business rule | Set Insurance Expiry 5 days in the past and open `/follow-up`. | Shows "Vehicle Insurance Overdue … overdue by 5 days". | — | — |
| VEH-BR-011 | Business rule | Set all three expiries within 15 days on one vehicle. | Three separate follow-up entries appear (insurance, PUC, fitness), each linking to `/vehicles`. | — | — |
| VEH-BR-012 | Negative | ADMIN_B attempts to view/edit/delete a TENANT_A vehicle id. | 403/404; record unchanged. | — | — |
| VEH-BR-013 | Positive | Delete a vehicle. | Soft-deleted; removed from list, follow-ups, search and dashboard counts. | — | — |
| VEH-BR-014 | Business rule | Delete a vehicle that had generated To-Dos. | Record actual — confirm whether the orphaned To-Dos remain and whether that is intended. | — | — |
| VEH-BR-015 | Positive | Create/edit/delete and check `/audit-logs`. | One entry per mutation, plus an entry for the follow-up generation. | — | — |
| VEH-BR-016 | Security | Run AI Auto-fill on an RC book containing a chassis/engine number. | Identifiers masked before the model call. | — | — |
| VEH-BR-017 | Business rule | AI Auto-fill with zero credits and no tenant key. | Blocked with an insufficient-credits message; no partial record; no credits deducted. | — | — |
| VEH-BR-018 | Negative | Subscription expired → open `/vehicles`. | Access blocked. | — | — |

## B4. Database Validation

| TC ID | Validation Point | SQL Query | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| VEH-DB-001 | Tenant stamping (P1) | `SELECT tenant_id, vehicle_name, vehicle_number, owner_name FROM vehicles WHERE id = ':record_id';` | `tenant_id = :tenant_a`; values as entered | — | — |
| VEH-DB-002 | All four mandatory dates persisted | `SELECT registration_date, insurance_expiry, puc_expiry, fitness_expiry FROM vehicles WHERE id = ':record_id';` | All four non-null and matching the dates entered | — | — |
| VEH-DB-003 | Optional service dates nullable | `SELECT last_service_date, next_service_date FROM vehicles WHERE id = ':record_no_service';` | `NULL, NULL` | — | — |
| VEH-DB-004 | File metadata | `SELECT file_path IS NOT NULL AS has_file, file_size FROM vehicles WHERE id = ':record_id';` | `t` and a byte count > 0 when a file was attached; `f`/`0` otherwise | — | — |
| VEH-DB-005 | Follow-up generation window (30 days) | `SELECT vehicle_name, insurance_expiry, puc_expiry, fitness_expiry, (insurance_expiry <= now() + interval '30 days') AS ins_due, (puc_expiry <= now() + interval '30 days') AS puc_due, (fitness_expiry <= now() + interval '30 days') AS fit_due FROM vehicles WHERE id = ':record_id';` | The `*_due` flags equal `true` for exactly the To-Dos that were generated | — | — |
| VEH-DB-006 | Generated To-Dos land in the same tenant | `SELECT tenant_id, task, due_date, assignee_id, status FROM todos WHERE tenant_id = ':tenant_a' AND task ILIKE '%' \|\| ':vehicle_number' \|\| '%';` | Rows present with `status = PENDING`, `due_date` = the corresponding expiry, `assignee_id` = the vehicle owner | — | — |
| VEH-DB-007 | No To-Do generated for items beyond 30 days | `SELECT count(*) FROM todos WHERE tenant_id = ':tenant_a' AND task ILIKE '%Fitness%' AND task ILIKE '%' \|\| ':vehicle_number' \|\| '%';` | `0` when fitness was 200 days out | — | — |
| VEH-DB-008 | Follow-up page threshold (15 days) | `SELECT count(*) FROM vehicles WHERE tenant_id = ':tenant_a' AND deleted_at IS NULL AND (insurance_expiry <= now() + interval '15 days' OR puc_expiry <= now() + interval '15 days' OR fitness_expiry <= now() + interval '15 days');` | Consistent with the number of vehicle renewal entries on `/follow-up` | — | — |
| VEH-DB-009 | Audit timestamps (P2) | `SELECT created_at IS NOT NULL, updated_at IS NOT NULL, updated_at >= created_at FROM vehicles WHERE id = ':record_id';` | `t, t, t` | — | — |
| VEH-DB-010 | Soft delete (P3) | `SELECT deleted_at FROM vehicles WHERE id = ':record_id';` | Non-null after a UI delete | — | — |
| VEH-DB-011 | Cross-tenant isolation (P7) | `SELECT count(*) FROM vehicles WHERE id = ':record_id' AND tenant_id = ':tenant_b';` | `0` | — | — |
| VEH-DB-012 | Owner/holder are same-tenant | `SELECT count(*) FROM vehicles v JOIN users u ON u.id = v.user_id WHERE v.tenant_id <> u.tenant_id;` | `0` | — | — |
| VEH-DB-013 | Storage accounting includes vehicle files | `SELECT sum(file_size) FROM vehicles WHERE tenant_id = ':tenant_a' AND deleted_at IS NULL;` | Contributes correctly to the storage widget total | — | — |
| VEH-DB-014 | Audit log per mutation (P4) | `SELECT action, details FROM audit_logs WHERE tenant_id = ':tenant_a' ORDER BY created_at DESC LIMIT 4;` | Entries for create, update, follow-up generation and delete | — | — |
| VEH-DB-015 | Field lengths enforced | `SELECT max(length(vehicle_name)) AS n, max(length(vehicle_number)) AS num, max(length(owner_name)) AS o FROM vehicles WHERE tenant_id = ':tenant_a';` | `n ≤ 255`, `num ≤ 100`, `o ≤ 255` | — | — |
| VEH-DB-016 | No row without a tenant | `SELECT count(*) FROM vehicles WHERE tenant_id IS NULL;` | `0` | — | — |

---

## Cross-Module End-to-End Workflows

| TC ID | Workflow | Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| IVH-E2E-001 | Portfolio build & valuation | 1. Add one investment per category with known values.<br>2. Read the portfolio summary.<br>3. Edit one record's current value.<br>4. Re-read the summary. | Totals and gain/loss recalculate correctly after the edit; percentages are accurate to 2 decimals. | — | — |
| IVH-E2E-002 | Property compliance chain | 1. Add a Property investment with a tax due date 10 days out and all document flags off.<br>2. Generate Follow-ups.<br>3. Open `/todos` and `/follow-up`.<br>4. Complete the generated task. | A property-tax To-Do exists with the right due date and assignee; completing it removes it from pending views. | — | — |
| IVH-E2E-003 | Vehicle renewal chain | 1. Add a vehicle with insurance in 10 days, PUC in 25 days, fitness in 1 year.<br>2. Generate Follow-ups.<br>3. Check `/todos` and `/follow-up`.<br>4. Renew the insurance (push the date out a year).<br>5. Re-check `/follow-up`. | Two To-Dos generated (insurance, PUC); follow-up page shows only the insurance item (15-day window); after renewal the insurance alert disappears. | — | — |
| IVH-E2E-004 | AI-assisted vehicle entry | 1. Upload an RC book scan and run AI Auto-fill.<br>2. Correct one extracted field.<br>3. Save.<br>4. Check `/ai-costs`. | Fields populate; the manual correction is what is saved; credits deducted once; usage recorded. | — | — |
| IVH-E2E-005 | Isolation sweep | 1. Create one investment and one vehicle in TENANT_A.<br>2. Log in as ADMIN_B.<br>3. Attempt view/edit/delete/generate-followups on both ids and run a global search. | All attempts fail with 403/404 and no disclosure; no To-Dos are created in TENANT_B. | — | — |
| IVH-E2E-006 | Delete cascade sanity | 1. Create a vehicle, generate follow-ups, then delete the vehicle.<br>2. Inspect `/todos` and the dashboard. | The vehicle is soft-deleted and gone from all views; note the fate of the generated To-Dos and confirm it matches intent. | — | — |
