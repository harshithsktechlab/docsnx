# TC-07 — To-Dos

**Prefix:** `TDO` · **Route:** `/todos` · **Table:** `todos` · **Permission key:** `todos`

## Module Reference

| Aspect | Detail |
|---|---|
| Fields | Task* (text), Due Date, Status, Assignee (member or Unassigned), Push Notification (bool) |
| Status values | `PENDING` (default), `COMPLETED` |
| Server rules | `task` required — "Missing required field: task"; `status` defaults to `PENDING`; `assigneeId` defaults to `null`; `pushNotification` defaults to `false`; `creatorId` = session user |
| Filters | Status (Pending / Completed / All), Member (Unassigned / All / specific), free-text search on task description |
| Member filter semantics | Selecting a member returns todos where they are **assignee OR creator** |
| Soft delete | This table has **no** `deleted_at` column — deletion is a hard delete |
| AI assist | A scan/auto-fill path can propose structured task values |

---

## 1. UI Validation Test Cases

| TC ID | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| TDO-UI-001 | Positive | Open `/todos` on an empty tenant. | Empty state with an "Add Task" CTA; no error. | — | — |
| TDO-UI-002 | Positive | Open `/todos` with tasks present. | Each row/card shows the task text, assignee name, due date and a status control. | — | — |
| TDO-UI-003 | Positive | Observe the loading state. | Skeletons render, then the list; no flash of the empty state. | — | — |
| TDO-UI-004 | Positive | Trigger a fetch failure (offline) and open `/todos`. | Toast "Network error fetching to-dos"; an error/empty state is shown rather than a hang. | — | — |
| TDO-UI-005 | Positive | Open the Add Task dialog. | Fields: task description (textarea), Due Date, Status select, Member select, Push Notification toggle. | — | — |
| TDO-UI-006 | Positive | Inspect the Status select. | Options: Pending, Completed. | — | — |
| TDO-UI-007 | Positive | Inspect the Member select. | Options: "Unassigned / All" plus every member in the tenant — and **no** members from other tenants. | — | — |
| TDO-UI-008 | Positive | Submit the Add form. | Button disables with a spinner; on success a toast appears, the dialog closes and the list refreshes with the new task at the expected position. | — | — |
| TDO-UI-009 | Positive | Toggle a task's status directly from the list. | The status updates optimistically, a success toast appears and the change survives a reload. | — | — |
| TDO-UI-010 | Negative | Trigger a status-update failure (offline). | Toast "Network error updating status"; the status reverts to its previous value (no false "completed"). | — | — |
| TDO-UI-011 | Positive | Filter by Status = Pending, then Completed, then All. | The list shows only matching tasks in each case; the active filter is visually indicated. | — | — |
| TDO-UI-012 | Positive | Filter by a specific member. | Only tasks where that member is assignee **or** creator are shown. | — | — |
| TDO-UI-013 | Positive | Type into the search box ("Search by task description, assignee…"). | The list filters as you type; clearing restores everything. | — | — |
| TDO-UI-014 | Positive | Combine a status filter, a member filter and a search term. | Only tasks matching all three are listed. | — | — |
| TDO-UI-015 | Negative | Apply filters that match nothing. | Friendly empty state, not a blank page. | — | — |
| TDO-UI-016 | Positive | Click Edit on a task. | Dialog pre-populated with the current task text, due date, status, assignee and push flag. | — | — |
| TDO-UI-017 | Positive | Click Delete. | A confirmation dialog is shown before deletion. | — | — |
| TDO-UI-018 | Negative | Trigger a delete failure (offline). | Toast "Network error deleting task"; the row remains. | — | — |
| TDO-UI-019 | Positive | View a task whose due date is in the past and still `PENDING`. | It is visually flagged as overdue (colour/badge). | — | — |
| TDO-UI-020 | Positive | View a task due today. | Rendered as due today (not misreported as overdue). | — | — |
| TDO-UI-021 | Positive | View a task with no due date. | Renders cleanly (e.g. "No due date") — never `Invalid Date` or `null`. | — | — |
| TDO-UI-022 | Positive | Use the AI scan/auto-fill action on a task source. | On success the task fields populate; on failure a toast "AI could not detect structured values. Try filling manually." appears and the form stays editable. | — | — |
| TDO-UI-023 | Positive | View `/todos` at 375px. | Rows stack; the status toggle and action buttons remain tappable; no horizontal page scroll. | — | — |
| TDO-UI-024 | Positive | As a view-only user, open `/todos`. | Add/Edit/Delete and the status toggle are hidden or disabled. | — | — |
| TDO-UI-025 | Positive | Inspect the Push Notification toggle. | Off by default in the Add form; state is reflected correctly when re-opening an existing task. | — | — |

---

## 2. Field Validation Test Cases

| TC ID | Field | Type | Input / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|---|
| TDO-FLD-001 | Task | Negative | Submit with the task blank. | Toast "Task description is required"; no record created. | — | — |
| TDO-FLD-002 | Task | Negative | Submit a task of only spaces `"   "`. | Rejected as empty (whitespace-only must not create a task). Record actual — silent acceptance ⇒ **S3**. | — | — |
| TDO-FLD-003 | Task | Boundary | 1-character task `X`. | Accepted. | — | — |
| TDO-FLD-004 | Task | Boundary | 10 000-character task. | Accepted (text column) and fully retrievable; the list truncates the display gracefully. | — | — |
| TDO-FLD-005 | Task | Edge | Task with newlines and bullet characters. | Line breaks preserved on display/edit. | — | — |
| TDO-FLD-006 | Task | Edge | Unicode/emoji task `किराणा खरेदी 🛒`. | Stored and displayed correctly; searchable by the unicode substring. | — | — |
| TDO-FLD-007 | Task | Edge | `<script>alert(1)</script>`. | Rendered as literal text in the list, edit dialog and any notification generated from it. | — | — |
| TDO-FLD-008 | Due Date | Positive | A future date. | Saved and displayed; the task appears in follow-up alerts as it nears. | — | — |
| TDO-FLD-009 | Due Date | Edge | A past date. | Accepted; flagged as overdue. | — | — |
| TDO-FLD-010 | Due Date | Edge | Today's date. | Accepted; shown as due today. | — | — |
| TDO-FLD-011 | Due Date | Edge | Leave blank. | Accepted; stored as NULL; displayed as "no due date". | — | — |
| TDO-FLD-012 | Due Date | Boundary | `1900-01-01` and `2999-12-31`. | Both stored and rendered without overflow or `Invalid Date`. | — | — |
| TDO-FLD-013 | Due Date | Edge | Change the browser timezone, then create and view a task due "today". | The displayed date matches the date chosen — no off-by-one day shift. | — | — |
| TDO-FLD-014 | Status | Positive | Create with `PENDING`, then with `COMPLETED`. | Both saved correctly. | — | — |
| TDO-FLD-015 | Status | Edge | Create without choosing a status. | Defaults to `PENDING`. | — | — |
| TDO-FLD-016 | Status | Negative | Force an unknown status value (e.g. via a manipulated select). | Rejected, or normalised to a known value — an arbitrary string must not be persisted. Record actual. | — | — |
| TDO-FLD-017 | Assignee | Positive | Assign to a member. | Saved; the member's name displays on the task. | — | — |
| TDO-FLD-018 | Assignee | Edge | Leave unassigned. | Saved with `assignee_id = NULL`; displays as Unassigned. | — | — |
| TDO-FLD-019 | Assignee | Negative | Assign to a user id from another tenant (manipulated). | Rejected; no cross-tenant assignee is stored. | — | — |
| TDO-FLD-020 | Push Notification | Positive | Enable it and save. | Stored as `true`; a push is dispatched to the assignee's registered devices (if any). | — | — |
| TDO-FLD-021 | Push Notification | Edge | Enable it on a task with no assignee. | Handled gracefully — no crash, no push to the whole tenant unless that is the intended design (record actual). | — | — |
| TDO-FLD-022 | Push Notification | Edge | Enable it for an assignee with no registered device. | No error surfaced to the user; the task still saves. | — | — |
| TDO-FLD-023 | All | Edge | Double-click Save. | Exactly one task created. | — | — |
| TDO-FLD-024 | All | Edge | Create two identical tasks. | Both created (duplicates allowed); each is independently editable and deletable. | — | — |

---

## 3. Business Rule Test Cases

| TC ID | Type | Rule / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| TDO-BR-001 | Positive | Create a task as USER_A1. | `creator_id` = USER_A1, `tenant_id` = TENANT_A, regardless of the assignee. | — | — |
| TDO-BR-002 | Positive | ADMIN_A assigns a task to QA Child; QA Child logs in. | The task is visible to QA Child (assignee) and to ADMIN_A (creator). | — | — |
| TDO-BR-003 | Business rule | Filter `/todos` by QA Child. | Returns tasks where QA Child is assignee **or** creator — verify both cases with dedicated fixtures. | — | — |
| TDO-BR-004 | Positive | QA Child marks an assigned task complete. | Status changes to `COMPLETED`; ADMIN_A sees the change on refresh. | — | — |
| TDO-BR-005 | Negative | As a user with only `canView` on todos, attempt to create/edit/delete a task, and to toggle the status of a task that is **neither assigned to nor created by** you. | All refused with Forbidden; the tick-circle on that task is disabled with the title "Only the assignee or the creator can complete this task". | — | — |
| TDO-BR-006 | Negative | As a user with no `todos` permission row, open `/todos`. | Access denied; nav entry hidden. | — | — |
| TDO-BR-007 | Business rule | As a `STANDARD` user with `canEdit`/`canDelete` on todos, edit and delete a task created by someone else. | Allowed — the module permission governs other people's tasks; ownership only widens access (see TDO-BR-020..022), never narrows it. | — | — |
| TDO-BR-008 | Negative | As ADMIN_B, attempt to open/edit/delete a TENANT_A task id. | 403/404; the TENANT_A task is unchanged. | — | — |
| TDO-BR-009 | Positive | Delete a task. | It is removed from the list and, because this table has no `deleted_at`, the row is hard-deleted from the database. | — | — |
| TDO-BR-010 | Business rule | Delete the assignee user, then view their tasks. | `assignee_id` becomes NULL (`set null`); the tasks survive and display as Unassigned. | — | — |
| TDO-BR-011 | Business rule | Delete the creator user, then view their tasks. | Tasks are removed by cascade (`creator_id` cascades). Confirm no orphaned rows remain. | — | — |
| TDO-BR-012 | Positive | Create a task with a due date 5 days out and open `/follow-up`. | The task appears in the pending-todos section of the follow-up view. | — | — |
| TDO-BR-013 | Business rule | Create a task with a due date 30 days out and open `/follow-up`. | It does **not** appear (outside the 15-day alert threshold). | — | — |
| TDO-BR-014 | Business rule | Mark an overdue task complete, then open `/follow-up`. | It is no longer listed as pending. | — | — |
| TDO-BR-015 | Positive | Create/edit/delete tasks and open `/audit-logs`. | An audit entry exists for each mutation. Record actual — a missing entry is **S2** under the house audit rule. | — | — |
| TDO-BR-016 | Negative | With the subscription expired, open `/todos`. | Access blocked; user directed to billing. | — | — |
| TDO-BR-017 | Positive | Create a task with push enabled, assigned to a member with a registered device. | The device receives a push notification whose content matches the task; no secret or other tenant's data appears in it. | — | — |
| TDO-BR-018 | Edge | Create 300 tasks and open the list. | The list remains responsive; filters and search still return correct results. | — | — |
| TDO-BR-019 | Business rule | Trigger any AI feature with tasks present. | Task text is passed through the AI privacy masker — any PII inside a task (phone, email, account number) is masked before leaving the platform. | — | — |
| TDO-BR-020 | Positive | As a **Contributor** member (view + add, no edit — the default for a new member), create a task, assign it to yourself, and click the tick-circle. | Status becomes `COMPLETED` and the row strikes through; clicking again returns it to `PENDING`. No "Forbidden". | — | — |
| TDO-BR-021 | Positive | As the same Contributor, with a task you created but assigned to another member, click the tick-circle. | Allowed — the creator may complete their own task even after assigning it away. | — | — |
| TDO-BR-022 | Negative | As the same Contributor, open Edit on your own task and change its text, date, assignee or push flag. | Refused with Forbidden — the concession is the tick only; every other change still needs `canEdit`. The tick-circle on a task you neither created nor are assigned is disabled. | — | — |

---

## 4. End-to-End Workflow Test Cases

| TC ID | Workflow | Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| TDO-E2E-001 | Assign → complete | 1. As ADMIN_A create "Pay electricity bill", due in 3 days, assigned to QA Child, push on.<br>2. Log in as QA Child.<br>3. Open `/todos` and mark it Completed.<br>4. Log back in as ADMIN_A. | QA Child sees and completes the task; ADMIN_A sees status `COMPLETED`; the follow-up count drops by one. | — | — |
| TDO-E2E-002 | Overdue lifecycle | 1. Create a task with yesterday's due date.<br>2. Observe `/todos` and `/follow-up`.<br>3. Complete it.<br>4. Re-check both screens. | It is flagged overdue and listed in follow-ups until completed, then disappears from pending views. | — | — |
| TDO-E2E-003 | Full CRUD | 1. Create a task.<br>2. Edit its text, due date and assignee.<br>3. Toggle status twice.<br>4. Delete it. | Every step persists across reload; the final delete removes it everywhere including the dashboard count. | — | — |
| TDO-E2E-004 | Filter workflow | 1. Create 6 tasks: 3 pending / 3 completed, split across 2 members.<br>2. Exercise every combination of status × member × search. | Result sets always match the applied criteria exactly. | — | — |
| TDO-E2E-005 | Push notification round-trip | 1. Register a device (accept push permission).<br>2. Create a task assigned to that user with push enabled.<br>3. Observe the device. | A push arrives referencing the task; tapping it opens the To-Dos module. | — | — |
| TDO-E2E-006 | Cross-tenant isolation | 1. Create "Tenant A secret task" in TENANT_A; note its id.<br>2. Log in as ADMIN_B.<br>3. Attempt to view/edit/delete that id; search for the text. | All attempts fail; no text disclosure in search or the member dropdown. | — | — |
| TDO-E2E-007 | Member deletion impact | 1. Create tasks assigned to QA Child and created by QA Child.<br>2. Delete QA Child.<br>3. Re-open `/todos`. | Assigned tasks survive as Unassigned; tasks created by QA Child are removed by cascade; no broken rows or crashes. | — | — |

---

## 5. Database Validation Test Cases

| TC ID | Validation Point | SQL Query | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| TDO-DB-001 | Row created with correct tenant & creator (P1) | `SELECT tenant_id, creator_id, task, status FROM todos WHERE id = ':record_id';` | `tenant_id = :tenant_a`, `creator_id` = session user, task as typed, `status = PENDING` | — | — |
| TDO-DB-002 | Status default applied | Create without selecting a status, then: `SELECT status FROM todos WHERE id = ':record_id';` | `PENDING` | — | — |
| TDO-DB-003 | Assignee default | Create unassigned, then: `SELECT assignee_id FROM todos WHERE id = ':record_id';` | `NULL` | — | — |
| TDO-DB-004 | Push flag default | `SELECT push_notification FROM todos WHERE id = ':record_id';` | `false` when the toggle was left off | — | — |
| TDO-DB-005 | Due date stored as entered | `SELECT due_date FROM todos WHERE id = ':record_id';` | Matches the date picked (allowing for the stored timezone) | — | — |
| TDO-DB-006 | Null due date allowed | Create without a due date, then: `SELECT due_date IS NULL FROM todos WHERE id = ':record_id';` | `t` | — | — |
| TDO-DB-007 | Status values constrained to the known set | `SELECT DISTINCT status FROM todos WHERE tenant_id = ':tenant_a';` | Only `PENDING` and `COMPLETED` | — | — |
| TDO-DB-008 | Status change persisted | Toggle in the UI, then: `SELECT status, updated_at FROM todos WHERE id = ':record_id';` | `COMPLETED`; `updated_at` advanced | — | — |
| TDO-DB-009 | Audit timestamps (P2) | `SELECT created_at IS NOT NULL, updated_at IS NOT NULL, updated_at >= created_at FROM todos WHERE id = ':record_id';` | `t, t, t` | — | — |
| TDO-DB-010 | Hard delete (no soft-delete column) | Delete in the UI, then: `SELECT count(*) FROM todos WHERE id = ':record_id';` | `0` — note this table has no `deleted_at` | — | — |
| TDO-DB-011 | Assignee is same-tenant | `SELECT count(*) FROM todos t JOIN users u ON u.id = t.assignee_id WHERE t.tenant_id <> u.tenant_id;` | `0` | — | — |
| TDO-DB-012 | Creator is same-tenant | `SELECT count(*) FROM todos t JOIN users u ON u.id = t.creator_id WHERE t.tenant_id <> u.tenant_id;` | `0` | — | — |
| TDO-DB-013 | Cross-tenant isolation (P7) | `SELECT count(*) FROM todos WHERE id = ':record_id' AND tenant_id = ':tenant_b';` | `0` | — | — |
| TDO-DB-014 | Assignee delete nullifies, does not cascade | Delete the assignee user, then: `SELECT assignee_id FROM todos WHERE id = ':record_id';` | `NULL`; the row still exists | — | — |
| TDO-DB-015 | Creator delete cascades | Delete the creator user, then: `SELECT count(*) FROM todos WHERE creator_id = ':deleted_user_id';` | `0` | — | — |
| TDO-DB-016 | Member filter matches assignee OR creator | `SELECT count(*) FROM todos WHERE tenant_id = ':tenant_a' AND (assignee_id = ':user_a1' OR creator_id = ':user_a1');` | Equals the row count shown when filtering the UI by that member | — | — |
| TDO-DB-017 | Search matches the DB predicate | `SELECT count(*) FROM todos WHERE tenant_id = ':tenant_a' AND task ILIKE '%electricity%';` | Equals the number of rows shown for that search term | — | — |
| TDO-DB-018 | Follow-up threshold matches the DB | `SELECT count(*) FROM todos WHERE tenant_id = ':tenant_a' AND status = 'PENDING' AND due_date IS NOT NULL AND due_date <= now() + interval '15 days';` | Equals the pending-todo count shown on `/follow-up` | — | — |
| TDO-DB-019 | Long task text stored untruncated | Save a 10 000-char task, then: `SELECT length(task) FROM todos WHERE id = ':record_id';` | `10000` | — | — |
| TDO-DB-020 | No row without a tenant | `SELECT count(*) FROM todos WHERE tenant_id IS NULL;` | `0` | — | — |
| TDO-DB-021 | Audit log entry per mutation (P4) | `SELECT action, details FROM audit_logs WHERE tenant_id = ':tenant_a' ORDER BY created_at DESC LIMIT 3;` right after create/update/delete | Three entries corresponding to those actions | — | — |
