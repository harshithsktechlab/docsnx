# TC-02 — Onboarding, App Shell, Navigation & Dashboard

**Prefix:** `SHL` · **Routes:** `/onboarding`, `/dashboard`, `/more`, all module routes (shell)
**Tables:** `tenants`, `users`, `notifications`, `user_devices`

## Module Reference

| Aspect | Detail |
|---|---|
| Onboarding wizard | 4 steps — **Welcome → Storage → Members → Finish**; progress bar = `step / 4 × 100%` |
| Onboarding gate | `TENANT_ADMIN` with `tenants.has_completed_onboarding = false` is force-redirected to `/onboarding` from every route except `/login`, `/register`, `/billing`, `/verify-email` |
| Shell redirect precedence | 1) no plan → `/billing` · 2) AMC locked → `/billing/amc-lock` · 3) subscription expired → `/billing` · 4) onboarding incomplete (TENANT_ADMIN) → `/onboarding` |
| SUPER_ADMIN guard | Any tenant-specific path (all 19 module routes + `/dashboard/bulk-scan`) redirects to `/tenants` |
| Nav groups | Workspace · Care & Safety · Wealth & Assets · Utilities |
| Polling | Notifications + follow-up count refresh every 60 s (skipped for `SUPER_ADMIN`) |
| Persisted UI state | `localStorage.sidebar_collapsed`, theme, font size; `sessionStorage.isEmbedded` when `?embedded=true` |
| Spotlight search | 250 ms debounce, calls global search, keyboard-navigable |

---

## 1. UI Validation Test Cases

### 1.1 Onboarding wizard

| TC ID | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| SHL-UI-001 | Positive | Log in as a freshly registered TENANT_ADMIN. | Automatically redirected to `/onboarding`; progress bar at 25%; step labels Welcome / Storage / Members / Finish with "Welcome" highlighted. | — | — |
| SHL-UI-002 | Positive | Click through steps 1 → 2 → 3 → 4. | Progress bar advances to 50%, 75%, 100%; the corresponding step label turns primary-coloured; each step's card content changes. | — | — |
| SHL-UI-003 | Boundary | On step 4, attempt to advance further. | Step index is clamped at 4 — no step 5, no error. | — | — |
| SHL-UI-004 | Positive | On step 2 (Storage), inspect the Google Drive card. | "Connect Google Drive" CTA shown with an explanation of zero-knowledge storage. | — | — |
| SHL-UI-005 | Positive | Return to `/onboarding` after Google Drive has been connected. | Drive shows as connected and the wizard fast-forwards to step 3 (Members). | — | — |
| SHL-UI-006 | Positive | On step 3, add a member with all fields filled. | Success toast "Member added successfully!"; member appears in the list below; the three inputs reset to empty. | — | — |
| SHL-UI-007 | Negative | On step 3, click "Add" with any of Name / Email / Password empty. | Toast "Please fill all fields for the member"; no member added. | — | — |
| SHL-UI-008 | Positive | Click "Add" and observe the button while the request is in flight. | Button disabled with a spinner; re-enables afterwards. | — | — |
| SHL-UI-009 | Positive | Click Finish on step 4. | Spinner on the button; redirect to `/dashboard`; toast "Welcome to DocsNX!". | — | — |
| SHL-UI-010 | Negative | Simulate a network failure while completing onboarding (offline mode). | Toast "Network error"; button re-enables; user stays on `/onboarding` (not stranded in a spinner). | — | — |
| SHL-UI-011 | Positive | Resize `/onboarding` to 375px width. | Card stays within the viewport, no horizontal scroll, buttons remain tappable. | — | — |

### 1.2 App shell / sidebar / header

| TC ID | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| SHL-UI-012 | Positive | Log in as TENANT_ADMIN and inspect the sidebar. | Four groups render with headers: Workspace, Care & Safety, Wealth & Assets, Utilities — with all their modules listed and an icon on each. | — | — |
| SHL-UI-013 | Positive | Navigate to `/documents`. | The Documents nav item is visually marked active; all other items are inactive. | — | — |
| SHL-UI-014 | Positive | Collapse the sidebar, then reload the page. | Collapsed state persists (`localStorage.sidebar_collapsed = "true"`); icons remain visible with tooltips/labels on hover. | — | — |
| SHL-UI-015 | Positive | Expand the sidebar and reload. | Expanded state persists. | — | — |
| SHL-UI-016 | Positive | Open the app at 375px width. | Sidebar collapses into a mobile drawer/bottom nav; opening it overlays the content and closes on selection or backdrop tap. | — | — |
| SHL-UI-017 | Positive | Click the notification bell with unread notifications present. | Badge shows the unread count; the dropdown lists notifications newest-first with title, message and relative time. | — | — |
| SHL-UI-018 | Positive | Click a notification in the dropdown. | Navigates to the notification's `link`; the item is marked read and the badge count decrements. | — | — |
| SHL-UI-019 | Positive | Observe the follow-up badge when items are due within 15 days. | Badge shows the count and links to `/follow-up`. | — | — |
| SHL-UI-020 | Positive | Leave the app idle for ~70 seconds with a notification created in the background. | Notification count and follow-up count auto-refresh (60-second poll) without a manual reload. | — | — |
| SHL-UI-021 | Positive | Open the spotlight search and type 3+ characters. | Search fires after a ~250 ms pause (not on every keystroke); a loading indicator shows; grouped results appear. | — | — |
| SHL-UI-022 | Positive | With results open, press ↓ / ↑ / Enter. | Active result highlight moves; Enter navigates to the highlighted record. | — | — |
| SHL-UI-023 | Edge | Clear the search box. | Results list clears immediately; no stale results retained. | — | — |
| SHL-UI-024 | Positive | Open the user menu in the header. | Shows the logged-in user's name, email, role, plan badge and storage usage; contains Profile / Billing / Logout actions. | — | — |
| SHL-UI-025 | Positive | Toggle dark ⇄ light theme, then reload. | Theme persists; all glassmorphism surfaces and text remain legible in both modes. | — | — |
| SHL-UI-026 | Positive | Use the font-size toggle across its options, then reload. | Base font size changes across the app and persists; layouts do not overflow at the largest setting. | — | — |
| SHL-UI-027 | Positive | Open `/more`. | Lists secondary destinations (Audit Logs, Backup, AI Costs, Analysis, Important Contacts, etc.) as tappable cards. | — | — |
| SHL-UI-028 | Positive | Open any app URL with `?embedded=true`. | Chrome (sidebar/header) is hidden for the embedded view and the flag persists in `sessionStorage` across in-app navigation. | — | — |
| SHL-UI-029 | Positive | Observe the shell while `clientGetMe()` is in flight. | A loading state is shown; protected children do not flash tenant data before auth resolves. | — | — |
| SHL-UI-030 | Positive | Trigger the PWA install banner (supported browser, not yet installed). | Banner renders with install/dismiss; dismissing hides it for the session. | — | — |

### 1.3 Dashboard

| TC ID | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| SHL-UI-031 | Positive | Open `/dashboard` on a brand-new tenant. | All module counters show `0`; empty-state copy/CTAs shown instead of broken widgets. | — | — |
| SHL-UI-032 | Positive | Create one record in three different modules, then reload `/dashboard`. | The three corresponding counters each increment to 1. | — | — |
| SHL-UI-033 | Positive | Observe the dashboard while data loads. | Skeleton placeholders are shown, then replaced by real cards — no layout jump that moves clickable elements. | — | — |
| SHL-UI-034 | Positive | Click a dashboard module tile. | Navigates to that module's list page. | — | — |
| SHL-UI-035 | Positive | Inspect the storage-usage widget. | Shows used vs. plan limit with a progress bar; percentage matches used/limit. | — | — |
| SHL-UI-036 | Edge | View the dashboard on a tenant with Google Drive enabled. | Storage displays as unlimited / Drive-backed rather than a bounded bar. | — | — |
| SHL-UI-037 | Positive | Open `/dashboard/context`. | Context page renders the AI/context summary without error. | — | — |
| SHL-UI-038 | Positive | View `/dashboard` at 375px, 768px and 1440px. | Grid reflows 1 → 2 → 3+ columns; no horizontal scroll at any width. | — | — |

---

## 2. Field Validation Test Cases (Onboarding — add member)

| TC ID | Field | Type | Input / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|---|
| SHL-FLD-001 | Name | Negative | Blank name, other fields valid. | Toast "Please fill all fields for the member". | — | — |
| SHL-FLD-002 | Email | Negative | `notanemail`. | Rejected with an invalid-email error; no user created. | — | — |
| SHL-FLD-003 | Email | Negative | Email already used by another user (any tenant). | Rejected — "Email already in use" (or equivalent); no duplicate row. | — | — |
| SHL-FLD-004 | Email | Edge | Mixed-case email. | Accepted and normalised to lowercase in `users.email`. | — | — |
| SHL-FLD-005 | Password | Boundary | 1-character password. | Record actual. Expected: rejected for being below the 8-character policy. Inconsistency with registration ⇒ **S3**. | — | — |
| SHL-FLD-006 | Password | Positive | 8+ char password. | Member created; the temporary password can be used to log in. | — | — |
| SHL-FLD-007 | All | Boundary | Add members until the plan's member limit is reached, then add one more. | The over-limit attempt is rejected with a limit message naming the allowed count. | — | — |
| SHL-FLD-008 | Name | Edge | Name containing `<img src=x onerror=alert(1)>`. | Stored and rendered as literal text — no script execution in the member list or elsewhere. | — | — |
| SHL-FLD-009 | All | Edge | Click "Add" twice quickly with the same details. | Exactly one user is created (button disables during the request). | — | — |

---

## 3. Business Rule Test Cases

| TC ID | Type | Rule / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| SHL-BR-001 | Positive | Log in as a TENANT_ADMIN whose `has_completed_onboarding = false` and try to open `/documents`. | Force-redirected to `/onboarding`. | — | — |
| SHL-BR-002 | Positive | With onboarding incomplete, open `/billing` and `/verify-email`. | Both are reachable — they are explicitly exempt from the onboarding gate. | — | — |
| SHL-BR-003 | Business rule | Log in as a `STANDARD` user in a tenant with `has_completed_onboarding = false`. | The onboarding gate does NOT apply (it targets TENANT_ADMIN only); user lands on `/dashboard`. | — | — |
| SHL-BR-004 | Positive | Complete onboarding, then navigate to `/onboarding` manually. | `has_completed_onboarding` is `true`, so the user is no longer force-redirected there from other routes. | — | — |
| SHL-BR-005 | Negative | Attempt `POST` of onboarding-complete as a `STANDARD` user (via the UI as far as it is reachable). | Rejected — only TENANT_ADMIN may complete onboarding. | — | — |
| SHL-BR-006 | Business rule | Log in as a tenant user whose tenant has NO `subscription_plan_id`. | Redirected to `/billing` from every route except `/billing`, `/login`, `/register`. | — | — |
| SHL-BR-007 | Business rule | Put the tenant into AMC-locked state (pending AMC invoice past due). | Redirected to `/billing/amc-lock` from all routes except `/login`; module navigation is blocked. | — | — |
| SHL-BR-008 | Business rule | Expire the tenant subscription and navigate the app. | Redirected to `/billing`; modules inaccessible. | — | — |
| SHL-BR-009 | Business rule | Verify redirect precedence with a tenant that is BOTH AMC-locked and onboarding-incomplete. | AMC lock wins — user lands on `/billing/amc-lock`, not `/onboarding`. | — | — |
| SHL-BR-010 | Positive | Log in as SUPER_ADMIN and inspect the sidebar. | Only platform modules are shown (Tenants, Users, Plans, Add-ons, Discounts, Payments, Settings, SMTP, AI Settings). No tenant record modules. | — | — |
| SHL-BR-011 | Negative | As SUPER_ADMIN, type `/documents`, `/passwords`, `/bank-info` and `/dashboard/bulk-scan` directly in the URL bar. | Each redirects to `/tenants`. No tenant data is rendered even momentarily. | — | — |
| SHL-BR-012 | Positive | As SUPER_ADMIN, confirm the notification/follow-up pollers. | No notification or follow-up polling occurs for SUPER_ADMIN (no tenant context). | — | — |
| SHL-BR-013 | Business rule | Log in as `USER_A3` (no permission on `passwords` / `bank_info`). | Those two nav entries are hidden or produce a Forbidden state when opened directly; all permitted modules remain visible. | — | — |
| SHL-BR-014 | Business rule | Log in as `USER_A2` (view-only everywhere). | Module lists render, but "Add", "Edit" and "Delete" affordances are hidden or disabled across every module. | — | — |
| SHL-BR-015 | Positive | Log in on a browser that supports push and accept the permission prompt. | The device is registered (a `user_devices` row appears for the user/tenant). | — | — |
| SHL-BR-016 | Edge | Decline the push permission prompt. | App continues to function normally; no repeated blocking prompts; no console error loop. | — | — |
| SHL-BR-017 | Negative | Open a protected route (`/dashboard`) with no session. | Redirected to `/login`; protected children never mount. | — | — |
| SHL-BR-018 | Positive | While authenticated, open `/login`, `/register` or `/`. | Redirected forward to `/dashboard` (or `/billing`/`/onboarding` per the precedence rules) — an authenticated user never sees the login form. | — | — |
| SHL-BR-019 | Edge | Open `/verify-email`, `/forgot-password`, `/reset-password` while unauthenticated. | All are reachable without a redirect to `/login`. | — | — |
| SHL-BR-020 | Positive | Verify the module list against `src/lib/moduleRegistry.js`. | The sidebar contains exactly the modules defined in `NAV_MODULES` — no extras, none missing, correct group placement. | — | — |

---

## 4. End-to-End Workflow Test Cases

| TC ID | Workflow | Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| SHL-E2E-001 | First-run onboarding | 1. Register + verify a new tenant.<br>2. Land on `/onboarding`.<br>3. Step through Welcome → Storage (skip Drive) → Members (add 1 member) → Finish.<br>4. Land on `/dashboard`. | `has_completed_onboarding` flips to `true`; the added member exists as a `STANDARD` user with default permissions; the user is never redirected back to `/onboarding`. | — | — |
| SHL-E2E-002 | Onboarding with Drive | 1. On step 2 click "Connect Google Drive".<br>2. Complete the Google OAuth consent.<br>3. Return to the app. | Returns to `/onboarding` at step 3 with Drive marked connected; `tenants.google_drive_enabled = true` and tokens stored. | — | — |
| SHL-E2E-003 | Abandon & resume onboarding | 1. Start onboarding, reach step 3, close the browser.<br>2. Log in again. | Redirected back to `/onboarding`; previously added members are still present. | — | — |
| SHL-E2E-004 | Navigation sweep | Visit all 19 module routes in one session via the sidebar. | Every route loads without a console error; the active nav highlight always matches the current page; page titles are correct. | — | — |
| SHL-E2E-005 | Role-based navigation | Log in in turn as SUPER_ADMIN, TENANT_ADMIN, USER_A2 (view-only), USER_A3 (restricted). | Each sees only the nav items and actions their role/permissions allow; no cross-role element leaks. | — | — |
| SHL-E2E-006 | Global search → record | 1. Create a document named "QA Passport".<br>2. Open spotlight, type "Passport".<br>3. Press Enter on the result. | Navigates to the Documents module with the record highlighted/visible. | — | — |
| SHL-E2E-007 | Notification round-trip | 1. Trigger an event that creates a notification (e.g. assign a To-Do to yourself).<br>2. Observe the bell badge.<br>3. Open and click the notification. | Badge increments within one poll cycle; clicking navigates to the linked page and marks the item read; badge decrements. | — | — |
| SHL-E2E-008 | Session expiry mid-session | 1. Log in.<br>2. Delete the `auth_token` cookie.<br>3. Click any sidebar link. | Redirected to `/login` cleanly — no partially rendered tenant page, no unhandled error. | — | — |

---

## 5. Database Validation Test Cases

| TC ID | Validation Point | SQL Query | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| SHL-DB-001 | New tenant starts with onboarding incomplete | `SELECT has_completed_onboarding FROM tenants WHERE id = ':tenant_a';` | `false` | — | — |
| SHL-DB-002 | Finishing the wizard flips the flag | Run after clicking Finish: `SELECT has_completed_onboarding FROM tenants WHERE id = ':tenant_a';` | `true` | — | — |
| SHL-DB-003 | Onboarding-added member is created in the right tenant with the right role | `SELECT name, email, role, tenant_id FROM users WHERE tenant_id = ':tenant_a' ORDER BY created_at DESC LIMIT 1;` | The member just added, `role = STANDARD`, `tenant_id = :tenant_a` | — | — |
| SHL-DB-004 | Member gets a profile row | `SELECT count(*) FROM profiles WHERE user_id = ':member_id';` | `1` | — | — |
| SHL-DB-005 | Member gets default permission rows | `SELECT count(*) FROM permissions WHERE user_id = ':member_id';` | Equal to the number of permission module keys (19 nav modules with keys + `audit_logs`) | — | — |
| SHL-DB-006 | Default permissions are view+add only | `SELECT DISTINCT can_view, can_add, can_edit, can_delete, can_share FROM permissions WHERE user_id = ':member_id';` | Single row: `t, t, f, f, f` | — | — |
| SHL-DB-007 | Permission uniqueness per user+module | `SELECT user_id, module, count(*) FROM permissions GROUP BY user_id, module HAVING count(*) > 1;` | 0 rows | — | — |
| SHL-DB-008 | Google Drive connection persisted | `SELECT google_drive_enabled, google_drive_tokens IS NOT NULL AS has_tokens FROM tenants WHERE id = ':tenant_a';` | `t`, `t` after connecting | — | — |
| SHL-DB-009 | Drive tokens are not exposed as plaintext in page source | Connect Drive, then view page source / network responses for `/api/auth/me`. | No refresh/access token string appears in any client-visible payload | — | — |
| SHL-DB-010 | Push device registration is tenant-scoped | `SELECT tenant_id, user_id, platform FROM user_devices WHERE user_id = ':user_a1';` | Row present with `tenant_id = :tenant_a` | — | — |
| SHL-DB-011 | FCM token uniqueness | `SELECT fcm_token, count(*) FROM user_devices GROUP BY fcm_token HAVING count(*) > 1;` | 0 rows | — | — |
| SHL-DB-012 | Dashboard counters match the database | For each module: `SELECT count(*) FROM documents WHERE tenant_id = ':tenant_a' AND deleted_at IS NULL;` (repeat per table) | Each count equals the number displayed on `/dashboard` | — | — |
| SHL-DB-013 | Dashboard excludes soft-deleted records | Soft-delete one document, reload the dashboard, then run: `SELECT count(*) FROM documents WHERE tenant_id = ':tenant_a' AND deleted_at IS NULL;` | Count decreases by 1 and matches the UI | — | — |
| SHL-DB-014 | Dashboard never counts another tenant's rows | `SELECT count(*) FROM documents WHERE tenant_id = ':tenant_b';` compared with the TENANT_A dashboard figure | TENANT_B rows are excluded from TENANT_A's totals | — | — |
| SHL-DB-015 | Storage widget matches summed file sizes | `SELECT sum(file_size) FROM (SELECT file_size FROM documents WHERE tenant_id = ':tenant_a' UNION ALL SELECT file_size FROM medical_records WHERE tenant_id = ':tenant_a' UNION ALL SELECT file_size FROM vehicles WHERE tenant_id = ':tenant_a') s;` | Sum (converted to MB/GB) matches the storage widget value | — | — |
| SHL-DB-016 | Onboarding does not create records in any vault table | After completing onboarding on a fresh tenant: `SELECT count(*) FROM documents WHERE tenant_id = ':tenant_a';` | `0` | — | — |
