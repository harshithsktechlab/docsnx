# TC-03 — Members (Users) & Permission Matrix

**Prefix:** `MEM` · **Route:** `/users` · **Tables:** `users`, `permissions`, `profiles`,
`tenants`, `subscription_plans`, `tenant_addons`, `addons`, `audit_logs`

## Module Reference

| Aspect | Detail |
|---|---|
| Access | `TENANT_ADMIN` only (no per-user permission key — the module is admin-managed) |
| Add-member fields | Name*, Email, Phone Number, Password*, Role, DOB, Anniversary Date, per-module permissions |
| Server rules | Name and Password required; contact validation via `validateUserContacts` (role-dependent email/phone requirement); email must be globally unique; TENANT_ADMIN may not create a `SUPER_ADMIN` |
| Member limit | `plan.maxMembers` + Σ `addon.extraMembers` (active add-ons). Blocked at ≥ limit with an explanatory message |
| Roles assignable | `TENANT_ADMIN`, `STANDARD` |
| Permission actions | `canView`, `canAdd`, `canEdit`, `canDelete`, `canShare` per module |
| Default new-member permissions | `canView = true`, `canAdd = true`, others `false`, for all 20 permission keys |
| Effective permission logic | `SUPER_ADMIN` → only `tenants`, `ai-keys`, `audit_logs`, `dashboard`; `TENANT_ADMIN` → everything in-tenant; `STANDARD` → per-module row; **any expired subscription → all permissions denied** |
| Self-delete | Blocked in the UI ("Cannot delete yourself!") |

---

## 1. UI Validation Test Cases

| TC ID | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| MEM-UI-001 | Positive | Log in as TENANT_ADMIN and open `/users`. | Member list renders with name, email, phone, role badge and action buttons; the current admin is included and clearly identified. | — | — |
| MEM-UI-002 | Positive | Observe `/users` while data loads. | Skeleton rows shown, replaced by real rows; no flash of "no members". | — | — |
| MEM-UI-003 | Positive | Open `/users` on a tenant with only the admin. | Exactly one row (the admin) plus an "Add Member" CTA. | — | — |
| MEM-UI-004 | Positive | Click "Add Member". | Modal/drawer opens with Name, Email, Phone, Password, Role, DOB, Anniversary and a permissions grid; all fields empty. | — | — |
| MEM-UI-005 | Positive | Inspect the permissions grid in the add form. | One row per module (all 20 permission keys) with 5 checkboxes each (View/Add/Edit/Delete/Share); View and Add pre-ticked by default. | — | — |
| MEM-UI-006 | Positive | Tick/untick a permission checkbox. | Only that checkbox changes state; other modules are unaffected. | — | — |
| MEM-UI-007 | Positive | Submit the add form. | Button disables with a spinner; on success a toast appears, the modal closes and the list refreshes with the new member. | — | — |
| MEM-UI-008 | Positive | Observe the screen after creating a member. | The generated/entered temporary password is surfaced with the note that the member will be required to change it at first login. | — | — |
| MEM-UI-009 | Positive | Cancel the add form after typing values. | Modal closes; re-opening it shows a cleared form (no stale values). | — | — |
| MEM-UI-010 | Positive | Click Edit on an existing member. | Modal pre-populated with that member's current name, email, phone, role, DOB and anniversary. | — | — |
| MEM-UI-011 | Positive | Click "Manage Permissions" for a `STANDARD` member. | Permission grid opens reflecting that member's current stored permissions exactly. | — | — |
| MEM-UI-012 | Positive | Change several permissions and save. | Success toast; re-opening the grid shows the saved state. | — | — |
| MEM-UI-013 | Positive | Click Delete on another member. | A confirmation dialog naming the member is shown before anything is deleted. | — | — |
| MEM-UI-014 | Negative | Click Delete on your own row. | Toast "Cannot delete yourself!"; no confirmation dialog; no deletion. | — | — |
| MEM-UI-015 | Positive | Use the search box on `/users`. | List filters by name/email as you type; clearing restores the full list. | — | — |
| MEM-UI-016 | Negative | Search for a string that matches nothing. | Friendly empty state ("No members found"), not a blank page or spinner. | — | — |
| MEM-UI-017 | Positive | Simulate a fetch failure (offline) then open `/users`. | Toast "Network error fetching users"; the page shows an error/empty state rather than hanging. | — | — |
| MEM-UI-018 | Positive | View `/users` at 375px width. | Rows reflow to stacked cards; the permission grid scrolls horizontally within its own container (page body does not scroll sideways). | — | — |
| MEM-UI-019 | Positive | Inspect role badges. | `TENANT_ADMIN` and `STANDARD` render with visually distinct badges. | — | — |
| MEM-UI-020 | Negative | Log in as a `STANDARD` user and open `/users` directly. | Access is denied / the nav item is hidden — a standard user cannot manage members. | — | — |

---

## 2. Field Validation Test Cases

| TC ID | Field | Type | Input / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|---|
| MEM-FLD-001 | All | Negative | Submit the add form empty. | Toast "Please fill in Name, Email and Password."; no request sent. | — | — |
| MEM-FLD-002 | Name | Negative | Blank name with everything else valid. | Rejected — "Name and Password are required". | — | — |
| MEM-FLD-003 | Name | Boundary | 255-character name. | Accepted, stored untruncated. | — | — |
| MEM-FLD-004 | Name | Boundary | 256-character name. | Rejected with a length error (column limit is 255). | — | — |
| MEM-FLD-005 | Name | Edge | Name with unicode/diacritics: `Ravi Śarmā`. | Accepted and rendered correctly. | — | — |
| MEM-FLD-006 | Name | Edge | `<script>alert(1)</script>`. | Stored/rendered as literal text; no script executes on `/users` or in any dropdown that lists members. | — | — |
| MEM-FLD-007 | Email | Negative | `bademail`. | Rejected with an invalid-contact error. | — | — |
| MEM-FLD-008 | Email | Negative | Email already used by a user in **the same** tenant. | Rejected — "Email already in use". | — | — |
| MEM-FLD-009 | Email | Negative | Email already used by a user in **another** tenant. | Also rejected (email is globally unique). | — | — |
| MEM-FLD-010 | Email | Edge | Mixed-case email. | Accepted; stored lowercase. | — | — |
| MEM-FLD-011 | Email/Phone | Negative | Omit both email and phone. | Rejected by contact validation with a message naming the missing contact. | — | — |
| MEM-FLD-012 | Phone | Boundary | 9-digit and 10-digit phone numbers. | 9 digits rejected; 10 digits accepted. | — | — |
| MEM-FLD-013 | Phone | Negative | Phone number already used by another user. | Record actual: attempt login with that phone afterwards and confirm it resolves to a single, deterministic account. Ambiguity ⇒ **S2**. | — | — |
| MEM-FLD-014 | Password | Negative | Blank password. | Rejected — "Name and Password are required". | — | — |
| MEM-FLD-015 | Password | Boundary | 1-character password. | Record actual. Expected: rejected under the 8-character policy; if accepted, raise **S3** for inconsistency with registration. | — | — |
| MEM-FLD-016 | Password | Positive | 8+ character password. | Member created; that password works at `/login`. | — | — |
| MEM-FLD-017 | Role | Negative | Select `SUPER_ADMIN` (if exposed) as a TENANT_ADMIN. | Rejected — "Tenant Admins cannot create Super Admin users." | — | — |
| MEM-FLD-018 | Role | Positive | Create a second `TENANT_ADMIN`. | Created successfully; the new admin has full in-tenant access. | — | — |
| MEM-FLD-019 | Role | Positive | Create a `STANDARD` member with no role explicitly chosen. | Defaults to `STANDARD`. | — | — |
| MEM-FLD-020 | DOB | Positive | Enter a valid past date. | Saved into the member's profile `personalDetails.dob`. | — | — |
| MEM-FLD-021 | DOB | Edge | Enter a future date. | Record actual — a future date of birth should be rejected or flagged; if silently accepted, raise **S3**. | — | — |
| MEM-FLD-022 | DOB | Edge | Leave DOB blank. | Accepted; stored as `null` in the profile JSON. | — | — |
| MEM-FLD-023 | Anniversary | Positive | Enter a valid date. | Saved into `personalDetails.anniversaryDate`. | — | — |
| MEM-FLD-024 | Permissions | Edge | Untick every permission for every module and save. | Member is created with zero access — after logging in they see no record modules. | — | — |
| MEM-FLD-025 | Permissions | Edge | Grant `canEdit` but not `canView` on a module. | Record actual: the module list may be inaccessible while edits remain permitted at the record level. Any resulting inconsistency ⇒ **S3**. | — | — |
| MEM-FLD-026 | All | Edge | Double-click Save on the add form. | Exactly one member created. | — | — |

---

## 3. Business Rule Test Cases

| TC ID | Type | Rule / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| MEM-BR-001 | Boundary | On a plan with `maxMembers = N`, add members until the tenant has exactly N users. | All N creations succeed. | — | — |
| MEM-BR-002 | Negative | Attempt to add member N+1. | Blocked with "User limit reached. Your plan allows N member(s). Please purchase an add-on to add more." | — | — |
| MEM-BR-003 | Positive | Purchase an add-on granting `extraMembers = M`, then retry. | Limit becomes N+M; the previously blocked creation now succeeds. | — | — |
| MEM-BR-004 | Edge | Deactivate the add-on (`tenant_addons.is_active = false`) while the tenant is already over the base limit. | New additions are blocked; existing members are NOT deleted. Record whether they remain able to log in. | — | — |
| MEM-BR-005 | Business rule | Count check — verify the limit counts ALL rows in `users` for the tenant, including the admin. | The admin occupies one of the allowed slots. | — | — |
| MEM-BR-006 | Negative | Expire the tenant subscription, then try to add a member. | Blocked with "Subscription expired. Please renew." | — | — |
| MEM-BR-007 | Positive | Create a member without supplying an explicit permission set. | Default permissions are created for all 20 keys with View+Add only. | — | — |
| MEM-BR-008 | Positive | Create a member with an explicit permission set. | Exactly the supplied permissions are stored — no defaults are merged in. | — | — |
| MEM-BR-009 | Positive | New member logs in for the first time. | `requires_password_change` is `true`; the member is prompted to change the temporary password. | — | — |
| MEM-BR-010 | Positive | Delete a member as TENANT_ADMIN. | Member is removed from the list and can no longer log in. | — | — |
| MEM-BR-011 | Business rule | After deleting a member, check their records (documents, passwords, etc.). | Confirm the intended behaviour: `documents.user_id` cascades on user delete, while `holder_id` is set to NULL. No orphaned rows and no cross-tenant reassignment. | — | — |
| MEM-BR-012 | Negative | Attempt to delete the last remaining `TENANT_ADMIN`. | Record actual. A tenant left with no admin is a lockout ⇒ raise **S2** if permitted. | — | — |
| MEM-BR-013 | Negative | As TENANT_ADMIN of TENANT_A, attempt to edit or delete a user belonging to TENANT_B (direct URL/ID manipulation). | Rejected with 403/404; TENANT_B's user is unchanged. | — | — |
| MEM-BR-014 | Positive | Revoke `canDelete` on Documents for USER_A1, then log in as USER_A1. | Delete controls are hidden/disabled in Documents; a forced delete attempt is refused. | — | — |
| MEM-BR-015 | Positive | Grant only `canView` on Passwords for USER_A2. | USER_A2 can open the Passwords list but cannot add, edit, delete or reveal-and-modify entries. | — | — |
| MEM-BR-016 | Negative | Remove the `passwords` permission row entirely for USER_A3, then open `/passwords`. | Access denied — a missing row means no access at all (not a default-allow). | — | — |
| MEM-BR-017 | Positive | Promote a `STANDARD` user to `TENANT_ADMIN`. | After re-login they have full in-tenant access regardless of their per-module permission rows. | — | — |
| MEM-BR-018 | Positive | Demote a `TENANT_ADMIN` to `STANDARD`. | Their access is now governed by their permission rows only. | — | — |
| MEM-BR-019 | Business rule | Verify the permission change takes effect on the member's next request/session. | Record how quickly a permission change propagates (immediate vs. requires re-login). Stale elevated access ⇒ **S2**. | — | — |
| MEM-BR-020 | Security | Inspect the `/users` list response as rendered in the page. | No `passwordHash` value for any user appears anywhere in the DOM, page source or network payload. | — | — |
| MEM-BR-021 | Business rule | As SUPER_ADMIN, open `/users`. | SUPER_ADMIN is redirected away from tenant routes — this module is not accessible to them. | — | — |

---

## 4. Permission Matrix (execute per module — one row per module × role)

Run each cell as: log in as the role, open the module, attempt the action.
Legend: **✓** = allowed, **✗** = blocked (403 / control hidden), **n/a** = not applicable.

| TC ID | Module | Role / permission set | View | Add | Edit | Delete | Actual (V/A/E/D) | Status |
|---|---|---|---|---|---|---|---|---|
| MEM-MTX-001 | Documents | TENANT_ADMIN | ✓ | ✓ | ✓ | ✓ | — | — |
| MEM-MTX-002 | Documents | STANDARD, view-only | ✓ | ✗ | ✗ | ✗ | — | — |
| MEM-MTX-003 | Documents | STANDARD, no permission row | ✗ | ✗ | ✗ | ✗ | — | — |
| MEM-MTX-004 | Documents | SUPER_ADMIN | ✗ | ✗ | ✗ | ✗ | — | — |
| MEM-MTX-005 | Documents | Any role, subscription expired | ✗ | ✗ | ✗ | ✗ | — | — |
| MEM-MTX-006 | Passwords | (repeat the five rows above) | | | | | — | — |
| MEM-MTX-007 | To-Dos | (repeat) | | | | | — | — |
| MEM-MTX-008 | Medical Records | (repeat) | | | | | — | — |
| MEM-MTX-009 | LIC & Mediclaim | (repeat) | | | | | — | — |
| MEM-MTX-010 | Important Contacts | (repeat) | | | | | — | — |
| MEM-MTX-011 | Bank & Cards | (repeat) | | | | | — | — |
| MEM-MTX-012 | Trading | (repeat) | | | | | — | — |
| MEM-MTX-013 | Investments | (repeat) | | | | | — | — |
| MEM-MTX-014 | Vehicles | (repeat) | | | | | — | — |
| MEM-MTX-015 | Tax & Compliance | (repeat) | | | | | — | — |
| MEM-MTX-016 | Loans & Debts | (repeat) | | | | | — | — |
| MEM-MTX-017 | Wills & Estate | (repeat) | | | | | — | — |
| MEM-MTX-018 | Warranty & AMC | (repeat) | | | | | — | — |
| MEM-MTX-019 | Rentals & Subscriptions | (repeat) | | | | | — | — |
| MEM-MTX-020 | Utility Bills | (repeat) | | | | | — | — |
| MEM-MTX-021 | Corporate Compliance | (repeat) | | | | | — | — |
| MEM-MTX-022 | Employment & Payroll | (repeat) | | | | | — | — |
| MEM-MTX-023 | Profiles | (repeat) | | | | | — | — |
| MEM-MTX-024 | Audit Logs | (repeat; SUPER_ADMIN is **✓ View**) | | | | | — | — |

---

## 5. End-to-End Workflow Test Cases

| TC ID | Workflow | Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| MEM-E2E-001 | Add & onboard a member | 1. As ADMIN_A, add member "QA Child" with a temp password.<br>2. Log out.<br>3. Log in as QA Child.<br>4. Change the password when prompted.<br>5. Open a permitted module. | Login works with the temp password; the change-password prompt appears; after the change `requires_password_change = false`; the permitted module is accessible. | — | — |
| MEM-E2E-002 | Tighten permissions | 1. As ADMIN_A, revoke Add+Edit+Delete on Documents for QA Child.<br>2. Log in as QA Child.<br>3. Open Documents. | Documents list is readable; Upload/Edit/Delete controls are absent; a direct attempt to add is refused. | — | — |
| MEM-E2E-003 | Hit and lift the member cap | 1. Fill the tenant to the plan's member limit.<br>2. Attempt one more member → blocked.<br>3. Purchase an extra-members add-on.<br>4. Retry. | Blocked at the cap with the correct allowed count; succeeds after the add-on. | — | — |
| MEM-E2E-004 | Promote to admin | 1. Promote QA Child to `TENANT_ADMIN`.<br>2. Re-login as QA Child.<br>3. Open `/users`. | Member management is now accessible; all modules are fully usable. | — | — |
| MEM-E2E-005 | Remove a member | 1. Delete QA Child.<br>2. Attempt to log in as QA Child.<br>3. Check records they had created. | Login fails; their records follow the defined cascade/nullify rules; an audit entry exists for the deletion. | — | — |
| MEM-E2E-006 | Expired-subscription lockdown | 1. Expire TENANT_A's subscription.<br>2. Log in as USER_A1.<br>3. Attempt to view any module. | All modules are denied regardless of granted permissions; the user is directed to billing. | — | — |
| MEM-E2E-007 | Cross-tenant admin probe | 1. As ADMIN_A, capture a TENANT_B user id from the DB.<br>2. Attempt to edit/delete that user via the UI's edit URL. | 403/404; TENANT_B's user row is byte-for-byte unchanged. | — | — |

---

## 6. Database Validation Test Cases

| TC ID | Validation Point | SQL Query | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| MEM-DB-001 | Member is created in the acting admin's tenant | `SELECT tenant_id, role FROM users WHERE email = 'qa.child@example.com';` | `:tenant_a`, `STANDARD` | — | — |
| MEM-DB-002 | Password stored as bcrypt only | `SELECT password_hash LIKE '$2%' AS is_bcrypt, password_hash = 'TempPass123' AS is_plain FROM users WHERE email = 'qa.child@example.com';` | `t`, `f` | — | — |
| MEM-DB-003 | New member must change password | `SELECT requires_password_change FROM users WHERE email = 'qa.child@example.com';` | `true` | — | — |
| MEM-DB-004 | Profile row auto-created with DOB/anniversary | `SELECT personal_details FROM profiles WHERE user_id = ':member_id';` | JSON containing the `dob` and `anniversaryDate` entered (or nulls if blank) | — | — |
| MEM-DB-005 | Full default permission set written | `SELECT count(*) FROM permissions WHERE user_id = ':member_id';` | `20` (19 keyed nav modules + `audit_logs`) | — | — |
| MEM-DB-006 | Default flags are view+add | `SELECT module, can_view, can_add, can_edit, can_delete, can_share FROM permissions WHERE user_id = ':member_id' ORDER BY module;` | Every row `t, t, f, f, f` | — | — |
| MEM-DB-007 | Custom permission set stored verbatim | After saving a custom grid: `SELECT module, can_view, can_edit FROM permissions WHERE user_id = ':member_id' AND module = 'documents';` | Matches exactly what was ticked in the UI | — | — |
| MEM-DB-008 | Permission update does not duplicate rows | `SELECT module, count(*) FROM permissions WHERE user_id = ':member_id' GROUP BY module HAVING count(*) > 1;` | 0 rows | — | — |
| MEM-DB-009 | Permission module keys are valid | `SELECT DISTINCT module FROM permissions WHERE user_id = ':member_id';` | Every value appears in `PERMISSION_MODULE_KEYS` (`src/lib/moduleRegistry.js`) — no typos, no unknown keys | — | — |
| MEM-DB-010 | Member limit enforced against real row count | `SELECT count(*) FROM users WHERE tenant_id = ':tenant_a';` vs. `SELECT p.max_members + COALESCE(sum(a.extra_members),0) FROM tenants t JOIN subscription_plans p ON p.id = t.subscription_plan_id LEFT JOIN tenant_addons ta ON ta.tenant_id = t.id AND ta.is_active LEFT JOIN addons a ON a.id = ta.addon_id WHERE t.id = ':tenant_a' GROUP BY p.max_members;` | User count never exceeds the computed allowance | — | — |
| MEM-DB-011 | Email uniqueness is global, not per-tenant | `SELECT email, count(*) FROM users GROUP BY email HAVING count(*) > 1;` | 0 rows | — | — |
| MEM-DB-012 | Email normalised to lowercase | `SELECT count(*) FROM users WHERE email <> lower(email);` | `0` | — | — |
| MEM-DB-013 | Role values are constrained to the enum | `SELECT DISTINCT role FROM users;` | Only `SUPER_ADMIN`, `TENANT_ADMIN`, `STANDARD` | — | — |
| MEM-DB-014 | No TENANT_ADMIN-created SUPER_ADMIN | `SELECT count(*) FROM users WHERE role = 'SUPER_ADMIN' AND tenant_id = ':tenant_a';` | `0` | — | — |
| MEM-DB-015 | Audit log written for member creation | `SELECT action, details FROM audit_logs WHERE tenant_id = ':tenant_a' ORDER BY created_at DESC LIMIT 1;` | An entry describing the user creation with the member's name/email | — | — |
| MEM-DB-016 | Audit log written for permission change | Change permissions, then re-run the query above | An entry describing the permission update | — | — |
| MEM-DB-017 | Audit log written for member deletion | Delete a member, then re-run the query above | An entry describing the deletion | — | — |
| MEM-DB-018 | Deleting a member cascades their permissions | `SELECT count(*) FROM permissions WHERE user_id = ':deleted_member_id';` | `0` | — | — |
| MEM-DB-019 | Deleting a member cascades their profile | `SELECT count(*) FROM profiles WHERE user_id = ':deleted_member_id';` | `0` | — | — |
| MEM-DB-020 | Deleting a member nullifies holder references rather than deleting other tenants' data | `SELECT count(*) FROM documents WHERE holder_id = ':deleted_member_id';` | `0` (references set to NULL, records preserved where the schema says `set null`) | — | — |
| MEM-DB-021 | Audit timestamps present | `SELECT count(*) FROM users WHERE created_at IS NULL OR updated_at IS NULL;` | `0` | — | — |
| MEM-DB-022 | `updated_at` advances on edit | Capture `updated_at`, edit the member's name in the UI, re-query. | New value is strictly greater than the old one | — | — |
| MEM-DB-023 | Cross-tenant isolation of the member list | `SELECT count(*) FROM users WHERE tenant_id = ':tenant_b';` compared against the row count shown on TENANT_A's `/users` | TENANT_B users never appear in TENANT_A's list | — | — |
| MEM-DB-024 | Permission rows never point at another tenant's user | `SELECT count(*) FROM permissions p JOIN users u ON u.id = p.user_id WHERE u.tenant_id <> ':tenant_a' AND p.user_id IN (SELECT id FROM users WHERE tenant_id = ':tenant_a');` | `0` | — | — |
