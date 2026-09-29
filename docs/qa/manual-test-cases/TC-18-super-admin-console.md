# TC-18 — Super Admin Console

**Prefix:** `SAD` · **Routes:** `/admin`, `/tenants`, `/admin/tenants`, `/admin/users`,
`/admin/plans`, `/admin/addons`, `/admin/discounts`, `/admin/payments`, `/admin/settings`,
`/admin/smtp`, `/admin/ai-settings`
**Tables:** `tenants`, `users`, `subscription_plans`, `addons`, `tenant_addons`,
`discount_codes`, `payments`, `invoices`, `system_configs`, `api_keys`, `ai_api_keys`

## Module Reference

| Aspect | Detail |
|---|---|
| Role gate | Every admin route requires `role === 'SUPER_ADMIN'` and returns *"Access denied. Super Admin only."* (403) otherwise. SMTP returns 401 with *"Unauthorized"* |
| Permission scope | `hasPermission` limits `SUPER_ADMIN` to `tenants`, `ai-keys`, `audit_logs`, `dashboard` — **a Super Admin must never read tenant vault data** |
| Route guard | The shell redirects `SUPER_ADMIN` away from every tenant-specific path (all 19 module routes + `/dashboard/bulk-scan`) to `/tenants` |
| Public exception | The plans list is readable without auth (used by the registration/checkout pages); the admin view additionally exposes inactive plans |
| Manual upgrade | `POST /admin/tenants/[id]/upgrade` requires **both** `planId` and `reason`; recomputes expiry from `duration_days` (or sets no expiry for a lifetime plan) and writes an audit action `tenant.manual_upgrade` |
| Manual payment | Only a Super Admin may record a payment manually (`isManualPayment`) |
| Platform telemetry | `/admin` summary aggregates tenant counts, plan distribution, revenue and per-module record counts **across all tenants** |

---

## 1. UI Validation Test Cases

### 1.1 Console shell & dashboard

| TC ID | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| SAD-UI-001 | Positive | Log in as SUPER_ADMIN. | Lands on the admin console (`/tenants` or `/admin`); the sidebar shows only platform modules. | — | — |
| SAD-UI-002 | Positive | Inspect the SUPER_ADMIN sidebar. | Tenants, Users, Plans, Add-ons, Discounts, Payments, Settings, SMTP, AI Settings — **and no** tenant record modules. | — | — |
| SAD-UI-003 | Positive | Open `/admin`. | Platform summary renders: total/active/inactive tenants, plan distribution, revenue, aggregate AI credit balance and per-module record counts. | — | — |
| SAD-UI-004 | Positive | Observe `/admin` while loading. | Skeletons then content; no flash of zeroed metrics. | — | — |
| SAD-UI-005 | Positive | View `/admin` at 375px, 768px and 1440px. | Metric cards reflow; charts/tables scroll inside their own containers; no horizontal page scroll. | — | — |
| SAD-UI-006 | Negative | Trigger a fetch failure on `/admin`. | Error state rather than an indefinite spinner. | — | — |

### 1.2 Tenants

| TC ID | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| SAD-UI-010 | Positive | Open `/tenants` (or `/admin/tenants`). | Table lists every tenant with name, plan, expiry, active flag, user count, AI credits and created date. | — | — |
| SAD-UI-011 | Positive | Search/filter the tenant list. | Filters by name/email; clearing restores the full list. | — | — |
| SAD-UI-012 | Positive | Open a tenant's detail view. | Shows the plan, add-ons, member count, storage usage and payment history for that tenant only. | — | — |
| SAD-UI-013 | Positive | Open the Create Tenant dialog. | Fields for workspace name, admin name, admin email, password and plan. | — | — |
| SAD-UI-014 | Positive | Toggle a tenant's active flag. | Confirmation prompt; the badge updates; the change persists after reload. | — | — |
| SAD-UI-015 | Positive | Open the manual-upgrade dialog. | Plan select **and a mandatory reason field**; the Save action is blocked until both are supplied. | — | — |
| SAD-UI-016 | Positive | Open the grant-add-on dialog for a tenant. | Add-on select with the effect (credits / members / storage) described. | — | — |
| SAD-UI-017 | **Security** | On any tenant detail screen, look for the tenant's records. | No document, password, bank or other vault content is displayed anywhere — only counts and billing metadata. | — | — |
| SAD-UI-018 | Positive | Delete a tenant from the console. | A confirmation naming the tenant and warning that all data is erased permanently. | — | — |

### 1.3 Plans, add-ons, discounts

| TC ID | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| SAD-UI-020 | Positive | Open `/admin/plans`. | Lists all plans including inactive ones, with prices (INR/USD, all three cycles), AI credits, member limit, storage limit, badge colour, duration and the default/lifetime flags. | — | — |
| SAD-UI-021 | Positive | Create a plan. | Success toast; the plan appears in the list and, if active, on the tenant `/billing` page. | — | — |
| SAD-UI-022 | Positive | Deactivate a plan. | It disappears from tenant-facing plan cards but remains visible in the admin list. | — | — |
| SAD-UI-023 | Positive | Open `/admin/addons`. | Lists add-ons with prices, billing cycle, AI credits, extra members and storage GB. | — | — |
| SAD-UI-024 | Positive | Open `/admin/discounts`. | Lists codes with type, value, max uses, per-tenant limit, expiry, plan/add-on scope and active flag; shows redemption counts. | — | — |
| SAD-UI-025 | Positive | Create a discount code. | Success toast; the code becomes usable at tenant checkout immediately. | — | — |
| SAD-UI-026 | Positive | Edit / deactivate a discount code. | Changes take effect for new checkouts; existing `discount_usages` rows are untouched. | — | — |
| SAD-UI-027 | Positive | View all three pages at 375px. | Tables scroll inside their own container; no horizontal page scroll. | — | — |

### 1.4 Payments, settings, SMTP, AI keys

| TC ID | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| SAD-UI-030 | Positive | Open `/admin/payments`. | All tenants' payments listed with tenant, amount, currency, status, method and date; filterable. | — | — |
| SAD-UI-031 | Positive | Download an invoice from `/admin/payments`. | The correct tenant's invoice PDF is produced. | — | — |
| SAD-UI-032 | Positive | Record a manual payment. | Available to Super Admin only; the payment is captured directly with no Razorpay round-trip. | — | — |
| SAD-UI-033 | Positive | Open `/admin/settings`. | Platform name, GSTIN, address, state code, logo, email, phone and the four AI base costs. | — | — |
| SAD-UI-034 | Positive | Open `/admin/smtp`. | Host, port, user, password, secure toggle and from-address; the stored password is masked, never pre-filled in the clear. | — | — |
| SAD-UI-035 | Positive | Use the SMTP test action (if present). | Sends a test email and reports success/failure clearly. | — | — |
| SAD-UI-036 | Positive | Open `/admin/ai-settings`. | Platform key pool listed with label, provider, model, priority, daily usage/limit, error count and last used. | — | — |
| SAD-UI-037 | Positive | Inspect a stored platform AI key in the list. | Only a masked/truncated form is shown — never the full secret. | — | — |
| SAD-UI-038 | Positive | Use the per-key Test action. | Spinner on that row only; the result is reported per key. | — | — |

---

## 2. Field Validation Test Cases

| TC ID | Screen / Field | Type | Input / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|---|
| SAD-FLD-001 | Create Tenant / Name | Negative | Submit with the name blank. | *"Name is required."* | — | — |
| SAD-FLD-002 | Create Tenant / Admin Email | Negative | Use an email already registered anywhere. | *"Admin Email already registered."* | — | — |
| SAD-FLD-003 | Create Tenant / Admin Email | Negative | Malformed email. | Rejected with a format error. | — | — |
| SAD-FLD-004 | Create Tenant / Name | Boundary | 255 / 256 characters. | 255 accepted; 256 rejected. | — | — |
| SAD-FLD-005 | Plan / name + price | Negative | Submit with either blank. | *"name and price are required."* | — | — |
| SAD-FLD-006 | Plan / price | Boundary | `0`, `0.01`, `9999999999.99` (precision 12,2), one over precision. | First three accepted exactly; over-precision rejected cleanly. | — | — |
| SAD-FLD-007 | Plan / price | Negative | Negative price. | Rejected. Record actual — a negative plan price would break checkout arithmetic ⇒ **S2**. | — | — |
| SAD-FLD-008 | Plan / aiCredits, maxMembers, storageLimitGB | Boundary | `0` and a large value; then `-1`. | Zero and large values accepted; negatives rejected. | — | — |
| SAD-FLD-009 | Plan / durationDays | Boundary | `1`, `365`, `0`, blank. | `1` and `365` accepted; confirm the meaning of `0`/blank (treated as lifetime or invalid) and that it is consistent with `is_lifetime`. | — | — |
| SAD-FLD-010 | Plan / isDefault | Edge | Mark a **second** plan as default. | Only one plan may be the default — the previous default is cleared, or the save is rejected. Two simultaneous defaults ⇒ **S2** (registration picks one nondeterministically). | — | — |
| SAD-FLD-011 | Plan / isLifetime + durationDays | Edge | Set `isLifetime = true` **and** a duration of 30 days. | The conflict is resolved deterministically (lifetime wins) or rejected. Record actual. | — | — |
| SAD-FLD-012 | Plan / USD prices | Edge | Fill INR prices but leave USD blank, then view `/billing` in USD. | The USD toggle hides the plan or falls back cleanly — never shows `NaN`/`$null`. | — | — |
| SAD-FLD-013 | Add-on / price fields | Boundary | Same boundary set as plans. | Same expectations. | — | — |
| SAD-FLD-014 | Add-on / extraMembers, storageLimitGB, aiCredits | Boundary | `0` and large values; then negatives. | Zero/large accepted; negatives rejected. | — | — |
| SAD-FLD-015 | Discount / code + amount | Negative | Submit with either blank. | *"code and discountAmount are required."* | — | — |
| SAD-FLD-016 | Discount / code | Negative | Re-use an existing code string. | *"Discount code already exists."* | — | — |
| SAD-FLD-017 | Discount / code | Boundary | 100 / 101 characters. | 100 accepted; 101 rejected. | — | — |
| SAD-FLD-018 | Discount / discountPct | Boundary | `0`, `1`, `100`, `101`, `-5`. | `1`–`100` accepted; `0`, `101` and negatives rejected or clamped. Record actual. | — | — |
| SAD-FLD-019 | Discount / maxUses, maxUsesPerTenant | Boundary | `1`, blank (unlimited), `0`, `-1`. | `1` and blank behave as documented; `0`/negative rejected. | — | — |
| SAD-FLD-020 | Discount / expiresAt | Edge | A past date. | Accepted but immediately unusable at checkout (expired) — or rejected at creation. Record actual. | — | — |
| SAD-FLD-021 | Manual upgrade / planId + reason | Negative | Submit with either missing. | Rejected — both are mandatory. | — | — |
| SAD-FLD-022 | Manual upgrade / planId | Negative | Supply an unknown plan id. | *"Invalid subscription plan"*. | — | — |
| SAD-FLD-023 | Manual upgrade / reason | Boundary | 1-character and 1 000-character reasons. | Both stored; the reason is retrievable in the audit trail. | — | — |
| SAD-FLD-024 | AI key / label + key | Negative | Submit with either blank. | *"Label and API Key are required."* | — | — |
| SAD-FLD-025 | AI key / dailyLimit, priority | Boundary | `0`, large values, negatives. | Zero/large accepted per design; negatives rejected. | — | — |
| SAD-FLD-026 | SMTP / host, port, user, password, from | Negative | Submit with any of the mandatory fields blank. | Rejected with a clear message; the previous working config is retained. | — | — |
| SAD-FLD-027 | SMTP / port | Boundary | `1`, `465`, `587`, `65535`, `0`, `65536`. | Valid ports accepted; out-of-range rejected. | — | — |
| SAD-FLD-028 | SMTP / from | Negative | Malformed from-address. | Rejected. | — | — |
| SAD-FLD-029 | Settings / platformGstin | Edge | A malformed GSTIN. | Record actual — a format check should reject it, since the value is printed on invoices. | — | — |
| SAD-FLD-030 | Settings / AI base costs | Boundary | `0`, `0.01`, `99999999.99`, negatives. | Positive values accepted; negatives rejected (a negative cost would credit tenants) ⇒ **S2** if accepted. | — | — |
| SAD-FLD-031 | All admin forms | Edge | `<script>alert(1)</script>` in every free-text field (plan name, add-on name, platform name, discount code). | Rendered as literal text everywhere, including on generated invoices. | — | — |
| SAD-FLD-032 | All admin forms | Edge | Double-click Save. | Exactly one record created in each case. | — | — |

---

## 3. Business Rule Test Cases

### 3.1 Access control (the critical set)

| TC ID | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| SAD-BR-001 | **Security** | As `TENANT_ADMIN`, open each of `/tenants`, `/admin`, `/admin/plans`, `/admin/addons`, `/admin/discounts`, `/admin/payments`, `/admin/settings`, `/admin/smtp`, `/admin/ai-settings`. | All nine refused (*"Access denied. Super Admin only."* / *"Unauthorized"* for SMTP); no admin data rendered even briefly. | — | — |
| SAD-BR-002 | **Security** | Repeat SAD-BR-001 as a `STANDARD` user. | All nine refused. | — | — |
| SAD-BR-003 | Security | Repeat SAD-BR-001 with no session. | Redirected to `/login`. | — | — |
| SAD-BR-004 | **Security** | As SUPER_ADMIN, navigate directly to `/documents`, `/passwords`, `/bank-info`, `/medical`, `/investments` and `/dashboard/bulk-scan`. | Each redirects to `/tenants`; **no tenant record is rendered at any point**. Any leak ⇒ **S1**. | — | — |
| SAD-BR-005 | **Security** | As SUPER_ADMIN, attempt the global search and `/follow-up`. | Both return empty — SUPER_ADMIN has no tenant context. | — | — |
| SAD-BR-006 | **Security** | As SUPER_ADMIN, attempt a backup export. | Refused — *"Super Admin cannot export tenant data"*. | — | — |
| SAD-BR-007 | Security | As SUPER_ADMIN, open `/analysis` or any AI analysis surface. | Forbidden. | — | — |
| SAD-BR-008 | Business rule | As SUPER_ADMIN, open `/audit-logs`. | `audit_logs` is in the allow-list but the query filters by the session tenant — record actual; a SUPER_ADMIN must never see another tenant's log entries. | — | — |
| SAD-BR-009 | Security | Inspect the platform telemetry on `/admin`. | Only **counts and aggregates** are exposed — no record titles, names, numbers or file contents from any tenant. | — | — |

### 3.2 Tenant management

| TC ID | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| SAD-BR-020 | Positive | Create a tenant from the console. | Tenant + admin user + profile created; the admin can log in with the supplied password. | — | — |
| SAD-BR-021 | Positive | Suspend a tenant (`is_active = false`). | That tenant's users are blocked at login with *"Account inactive or suspended"*; other tenants are unaffected. | — | — |
| SAD-BR-022 | Positive | Re-activate the tenant. | Login works again; no data was lost during suspension. | — | — |
| SAD-BR-023 | Positive | Manually upgrade a tenant to a 30-day plan. | `subscription_plan_id` updates; `subscription_expiry` = base date + 30 days; an audit entry `tenant.manual_upgrade` records the reason and the old/new plan. | — | — |
| SAD-BR-024 | Positive | Manually upgrade to a lifetime/no-duration plan. | `subscription_expiry` becomes NULL (no expiry). | — | — |
| SAD-BR-025 | Edge | Manually upgrade a tenant whose subscription is **already expired**. | The new expiry is computed from *now*, not from the stale past expiry — the tenant regains a full term. Record actual. | — | — |
| SAD-BR-026 | Positive | Grant an add-on to a tenant. | A `tenant_addons` row is created and active; the tenant's member/storage/credit allowances rise immediately. | — | — |
| SAD-BR-027 | Positive | Revoke a granted add-on. | The allowance drops; existing members/records are not deleted. | — | — |
| SAD-BR-028 | Positive | Record a manual payment for a tenant. | Payment captured directly with `status = captured` and no Razorpay ids; the plan activates and credits are granted. | — | — |
| SAD-BR-029 | Negative | Attempt a manual payment as a TENANT_ADMIN. | *"Only Super Admins can manually record payments."* | — | — |
| SAD-BR-030 | **Security** | Delete a tenant from the console. | That tenant's data cascades away entirely; **every other tenant is untouched**. | — | — |
| SAD-BR-031 | Positive | Change a tenant's AI credit balance from the console (if supported). | The tenant's `/ai-costs` reflects the new balance; an audit entry exists. | — | — |

### 3.3 Catalogue & configuration

| TC ID | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| SAD-BR-040 | Positive | Create a plan and mark it active. | It appears on the public `/register` plan picker and on tenant `/billing`. | — | — |
| SAD-BR-041 | Positive | Deactivate a plan that tenants are currently on. | Existing subscribers keep their plan and access; the plan disappears from new-purchase options. | — | — |
| SAD-BR-042 | Business rule | Set a plan as `isDefault`, then register a brand-new tenant. | The new tenant is assigned that plan with the matching trial length. | — | — |
| SAD-BR-043 | **Business rule** | Deactivate/remove every default plan, then attempt a registration. | Blocked — *"Registration disabled: No default subscription plan configured in the system."* Confirm the console warns before allowing this state. | — | — |
| SAD-BR-044 | Positive | Change a plan's `maxMembers`, then check an existing tenant on that plan. | The member allowance updates immediately for that tenant. | — | — |
| SAD-BR-045 | Positive | Change a plan's `storageLimitGB`. | The tenant's storage widget and quota enforcement reflect the new limit. | — | — |
| SAD-BR-046 | Positive | Change a plan's `aiCredits`. | Only **future** purchases grant the new amount; already-granted balances are unchanged. | — | — |
| SAD-BR-047 | Positive | Create a discount code, redeem it as a tenant, then view the admin discount list. | The redemption count increments and the tenant is attributable via `discount_usages`. | — | — |
| SAD-BR-048 | Positive | Deactivate a code that has been redeemed. | New checkouts reject it; historical usages remain intact. | — | — |
| SAD-BR-049 | Positive | Update platform settings (name, GSTIN, address, logo), then generate a tenant invoice. | The new invoice header reflects the updated platform details; historical invoices are unchanged. | — | — |
| SAD-BR-050 | Positive | Update the four AI base costs, then check a tenant's `/ai-costs`. | The new base and effective costs are shown; the next AI action deducts at the new rate. | — | — |
| SAD-BR-051 | Positive | Configure SMTP correctly, then trigger a registration OTP. | The email is delivered. | — | — |
| SAD-BR-052 | Negative | Configure SMTP with an invalid host/credential, then trigger a registration. | The failure is surfaced/logged; the registration transaction still commits or fails cleanly — the user is never left with an account they cannot verify and no way to resend. Record actual. | — | — |
| SAD-BR-053 | **Security** | Save an SMTP password, then re-open `/admin/smtp` and inspect the payload. | The password is never returned to the client in the clear. | — | — |
| SAD-BR-054 | **Security** | Save a platform AI key, then inspect the `/admin/ai-settings` payload. | Only a masked form is returned; the full key never reaches the browser. | — | — |
| SAD-BR-055 | Positive | Add three platform AI keys with different priorities and drive traffic through them. | Usage rotates by priority; `daily_usage`, `last_used_at` and `error_count` update; a key at its `daily_limit` is skipped. | — | — |
| SAD-BR-056 | Positive | Deactivate a platform AI key. | It is excluded from rotation; tenant AI actions continue on the remaining keys. | — | — |
| SAD-BR-057 | Edge | Deactivate **all** platform AI keys, then run a tenant AI action with credits available. | A clear "no AI capacity" error; credits are **not** deducted. | — | — |

---

## 4. Database Validation Test Cases

| TC ID | Validation Point | SQL Query | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| SAD-DB-001 | Console-created tenant is complete | `SELECT t.id, t.name, t.is_active, u.email, u.role FROM tenants t JOIN users u ON u.tenant_id = t.id WHERE t.name = 'QA Console Tenant';` | One tenant with exactly one `TENANT_ADMIN` user | — | — |
| SAD-DB-002 | Admin email uniqueness enforced | `SELECT email, count(*) FROM users GROUP BY email HAVING count(*) > 1;` | 0 rows | — | — |
| SAD-DB-003 | Suspension persists | `SELECT is_active FROM tenants WHERE id = ':tenant_a';` | `false` after suspending | — | — |
| SAD-DB-004 | Manual upgrade recomputes expiry | `SELECT subscription_plan_id, subscription_expiry, subscription_expiry::date - now()::date AS days FROM tenants WHERE id = ':tenant_a';` | New plan id; `days` ≈ the plan's `duration_days` | — | — |
| SAD-DB-005 | Lifetime upgrade nulls the expiry | Same query after upgrading to a lifetime plan. | `subscription_expiry` = `NULL` | — | — |
| SAD-DB-006 | Manual upgrade is audited with a reason | `SELECT action, details FROM audit_logs WHERE tenant_id = ':tenant_a' AND action = 'tenant.manual_upgrade' ORDER BY created_at DESC LIMIT 1;` | Row present containing the supplied reason and the old/new plan names | — | — |
| SAD-DB-007 | Add-on grant creates an active row | `SELECT ta.is_active, a.name, a.extra_members, a.storage_limit_gb, a.ai_credits FROM tenant_addons ta JOIN addons a ON a.id = ta.addon_id WHERE ta.tenant_id = ':tenant_a';` | Active row with the expected entitlements | — | — |
| SAD-DB-008 | Manual payment recorded correctly | `SELECT amount, status, payment_method, razorpay_order_id, initiated_by FROM payments WHERE tenant_id = ':tenant_a' ORDER BY created_at DESC LIMIT 1;` | `status = captured`; `razorpay_order_id IS NULL`; `initiated_by` identifies the Super Admin path | — | — |
| SAD-DB-009 | **Exactly one default plan** | `SELECT count(*) FROM subscription_plans WHERE is_default = true;` | `1` — `0` breaks registration, `>1` makes plan assignment nondeterministic (**S2**) | — | — |
| SAD-DB-010 | Plan prices are non-negative | `SELECT count(*) FROM subscription_plans WHERE price < 0 OR COALESCE(price_yearly,0) < 0 OR COALESCE(price_one_time,0) < 0 OR amc_amount < 0;` | `0` | — | — |
| SAD-DB-011 | Plan entitlements are non-negative | `SELECT count(*) FROM subscription_plans WHERE ai_credits < 0 OR max_members < 0 OR storage_limit_gb < 0;` | `0` | — | — |
| SAD-DB-012 | Add-on entitlements are non-negative | `SELECT count(*) FROM addons WHERE ai_credits < 0 OR extra_members < 0 OR storage_limit_gb < 0 OR COALESCE(price,0) < 0;` | `0` | — | — |
| SAD-DB-013 | Discount codes are globally unique | `SELECT code, count(*) FROM discount_codes GROUP BY code HAVING count(*) > 1;` | 0 rows | — | — |
| SAD-DB-014 | Discount percentages are sane | `SELECT count(*) FROM discount_codes WHERE discount_pct < 0 OR discount_pct > 100;` | `0` | — | — |
| SAD-DB-015 | Discount usage never exceeds `max_uses` | `SELECT dc.code, dc.max_uses, count(du.id) AS used FROM discount_codes dc LEFT JOIN discount_usages du ON du.discount_code_id = dc.id GROUP BY 1,2 HAVING dc.max_uses IS NOT NULL AND count(du.id) > dc.max_uses;` | 0 rows | — | — |
| SAD-DB-016 | Platform settings persisted | `SELECT platform_name, platform_gstin, platform_state_code, platform_email FROM system_configs LIMIT 1;` | Match the values entered in `/admin/settings` | — | — |
| SAD-DB-017 | AI base costs persisted and positive | `SELECT ai_cost_record_analysis, ai_cost_category_analysis, ai_cost_portfolio_analysis, ai_cost_bulk_scan FROM system_configs LIMIT 1;` | Match the console values; all `> 0` | — | — |
| SAD-DB-018 | **SMTP password not stored in plaintext** | `SELECT smtp_password FROM system_configs LIMIT 1;` | Encrypted/opaque — not the password typed into the form. Plaintext ⇒ **S1** | — | — |
| SAD-DB-019 | Only one system config row | `SELECT count(*) FROM system_configs;` | `1` — multiple rows make configuration nondeterministic | — | — |
| SAD-DB-020 | **Platform AI keys encrypted** | `SELECT count(*) FROM api_keys WHERE api_key !~ '^[0-9a-f]+:';` and `SELECT count(*) FROM ai_api_keys WHERE key !~ '^[0-9a-f]+:';` | `0` for both | — | — |
| SAD-DB-021 | Key rotation counters advance | `SELECT label, daily_usage, daily_limit, error_count, last_used_at FROM api_keys ORDER BY priority;` | `daily_usage`/`last_used_at` move as calls are made; no key exceeds its `daily_limit` | — | — |
| SAD-DB-022 | Platform telemetry matches the DB | `SELECT count(*) FROM tenants;`, `SELECT count(*) FROM tenants WHERE is_active;`, `SELECT count(*) FROM users;`, `SELECT count(*) FROM documents;` | Each equals the corresponding figure on `/admin` | — | — |
| SAD-DB-023 | Plan distribution matches the DB | `SELECT s.name, count(t.id) FROM subscription_plans s LEFT JOIN tenants t ON t.subscription_plan_id = s.id GROUP BY s.name ORDER BY 2 DESC;` | Matches the plan-distribution chart on `/admin` | — | — |
| SAD-DB-024 | Revenue total matches the DB | `SELECT sum(amount) FROM payments WHERE status = 'captured';` | Equals the revenue figure on `/admin` | — | — |
| SAD-DB-025 | Aggregate AI credits match | `SELECT sum(ai_credits_balance) FROM tenants;` | Equals the aggregate credit figure on `/admin` | — | — |
| SAD-DB-026 | **Super Admin reads no tenant vault data** | While logged in as SUPER_ADMIN, capture every network response for one full console session and grep for a known TENANT_A record title/number. | Zero occurrences ⇒ pass. Any occurrence ⇒ **S1** | — | — |
| SAD-DB-027 | Console tenant delete is isolated | Before/after deleting TENANT_X: `SELECT count(*) FROM users WHERE tenant_id = ':tenant_b';` and `SELECT count(*) FROM documents WHERE tenant_id = ':tenant_b';` | Both unchanged | — | — |
| SAD-DB-028 | No orphan rows after a console tenant delete | `SELECT count(*) FROM documents d LEFT JOIN tenants t ON t.id = d.tenant_id WHERE t.id IS NULL;` (repeat for other tenant tables) | `0` for every table | — | — |

---

## 5. End-to-End Workflow Test Cases

| TC ID | Workflow | Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| SAD-E2E-001 | Provision a customer end-to-end | 1. Create a plan (₹999/30 days, 5 members, 10 GB, 500 credits).<br>2. Create a tenant on that plan from the console.<br>3. Log in as the new tenant admin.<br>4. Verify the member cap, storage limit and credit balance. | All three entitlements match the plan exactly; the admin can use every module. | — | — |
| SAD-E2E-002 | Manual upgrade with justification | 1. Note a tenant's current plan and expiry.<br>2. Manually upgrade with a reason.<br>3. Verify the new plan, expiry and audit entry.<br>4. Log in as that tenant. | Plan and expiry update per the plan's duration; the reason is captured in `audit_logs`; the tenant sees the new entitlements. | — | — |
| SAD-E2E-003 | Suspend → restore | 1. Suspend a tenant.<br>2. Attempt to log in as their admin → blocked.<br>3. Confirm another tenant still logs in.<br>4. Re-activate and log in again. | Suspension is isolated to the target tenant and fully reversible with no data loss. | — | — |
| SAD-E2E-004 | Discount campaign | 1. Create a 30% code, 10 global uses, 1 per tenant, expiring in 7 days.<br>2. Redeem it in TENANT_A and TENANT_B.<br>3. Attempt a second redemption in TENANT_A.<br>4. Review the admin usage counts. | Both first redemptions succeed with 30% off; the repeat is blocked; the admin list shows 2 of 10 used. | — | — |
| SAD-E2E-005 | Platform branding on invoices | 1. Update platform name, GSTIN, address and logo.<br>2. Set a tenant's billing profile.<br>3. Complete a purchase as that tenant.<br>4. Download the invoice. | The PDF carries the new platform header and the tenant's client details, with the correct GST treatment for the state-code pair. | — | — |
| SAD-E2E-006 | AI capacity management | 1. Add two platform keys with different priorities.<br>2. Drive the higher-priority key to its daily limit.<br>3. Run more tenant AI actions.<br>4. Deactivate both keys and try again. | Traffic rotates to the second key; with both keys off, AI actions fail cleanly with **no** credit deduction. | — | — |
| SAD-E2E-007 | **Super Admin containment sweep** | 1. Populate TENANT_A with records in all 19 modules.<br>2. Log in as SUPER_ADMIN.<br>3. Attempt every tenant route, global search, follow-up, backup export and AI analysis.<br>4. Capture all network traffic and grep for TENANT_A record values. | Every attempt is redirected or refused; zero tenant record values appear in any response. | — | — |
| SAD-E2E-008 | Default-plan safety | 1. Note the current default plan.<br>2. Deactivate/unset it.<br>3. Attempt a public registration.<br>4. Restore a default plan and retry. | Registration is blocked with the documented message in step 3 and works again in step 4. | — | — |
| SAD-E2E-009 | Console-driven deletion | 1. Create a throwaway tenant with records across modules.<br>2. Snapshot TENANT_B's row counts.<br>3. Delete the throwaway tenant from the console.<br>4. Re-check TENANT_B and run the orphan-row queries. | The throwaway tenant is fully erased; TENANT_B is byte-identical; no orphan rows anywhere. | — | — |
