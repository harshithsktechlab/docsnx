# TC-01 — Authentication, Registration & Session

**Prefix:** `AUTH` · **Routes:** `/register`, `/verify-email`, `/login`, `/forgot-password`,
`/reset-password` · **Tables:** `tenants`, `users`, `profiles`, `trial_used_emails`, `audit_logs`

## Module Reference

| Aspect | Detail |
|---|---|
| Registration fields | Workspace Name*, Full Name*, Email*, Phone Number*, Security Password*, Plan*, Consent (data)*, Consent (AI)* |
| Server rules | tenantName ≥2 & ≤255, name ≥2 & ≤255, valid email, password ≥8 chars, phone ≥10 (optional at server), both consents must be `true` |
| Registration side-effects | Creates `tenants` + `users` (role `TENANT_ADMIN`, `email_verified=false`) + empty `profiles` + `trial_used_emails` + audit log `REGISTER_TENANT`, all in one transaction |
| OTP | 6-digit, 15-minute expiry, **stored hashed** in `users.email_verification_otp` |
| Login | Accepts email **or** phone number as identifier; blocked if tenant `is_active=false` (403) or `email_verified=false` (403 + redirect to verify) |
| Session | JWT (`JWT_SECRET`), 7-day expiry, `HttpOnly` cookie `auth_token`, `sameSite=strict` on login |
| Reset token | 32-byte hex, 1-hour expiry, **stored hashed** in `users.reset_token` |
| Rate limiting | IP-based limiter on login and registration; returns 429 with `Retry-After` |
| Trial rule | An email present in `trial_used_emails` does **not** get a fresh trial plan on re-registration |

---

## 1. UI Validation Test Cases

| TC ID | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| AUTH-UI-001 | Positive | Open `/login`. Inspect the page. | Logo (light/dark variant per theme), heading "Welcome to DocsNX", Email/Mobile field, Password field, "Forgot password?" link, "Sign In" button, "Create an Account" link, Terms & Privacy links, security footer all render. | — | — |
| AUTH-UI-002 | Positive | On `/login`, click the eye icon in the password field. | Password toggles between masked (`••••`) and plaintext; icon switches Eye ⇄ EyeOff. | — | — |
| AUTH-UI-003 | Positive | Submit the login form with valid credentials and observe the button. | Button becomes disabled, shows a spinner and the text "Authenticating…". Both inputs become disabled. | — | — |
| AUTH-UI-004 | Positive | Click "Forgot password?" on `/login`. | Navigates to `/forgot-password`. | — | — |
| AUTH-UI-005 | Positive | Click "Create an Account" on `/login`. | Navigates to `/register`. | — | — |
| AUTH-UI-006 | Positive | Open `/register`. | Four numbered sections render in order: 1. Workspace Information, 2. Admin Credentials, 3. Select Plan, 4. Legal Consent. "Back to Sign In" link present. | — | — |
| AUTH-UI-007 | Positive | Observe `/register` while plans are loading. | A spinner with "Loading plans…" is shown in section 3; it is replaced by the plan card grid once loaded. | — | — |
| AUTH-UI-008 | Positive | On `/register`, click a plan card. | Selected card gets primary border + tinted background + glow; previously selected card reverts to the default border. Only one card can be selected. | — | — |
| AUTH-UI-009 | Positive | Open `/register?plan=<valid-plan-id>`. | That plan is pre-selected on load. | — | — |
| AUTH-UI-010 | Edge | Open `/register?plan=not-a-real-id`. | Page still loads; the **first active plan** is selected as fallback (no crash, no blank state). | — | — |
| AUTH-UI-011 | Positive | Inspect a plan card showing a free plan and a paid plan. | Free plan shows "Free"; paid plan shows `₹<price>` plus `/<durationDays>d`. AI-credit badge appears only when `aiCredits > 0`. | — | — |
| AUTH-UI-012 | Positive | Submit `/register` with valid data and observe the button. | Button disabled, spinner, text "Provisioning Tenant…". | — | — |
| AUTH-UI-013 | Positive | Open the Privacy / Terms links in section 4 of `/register`. | Open in a new tab to `/privacy` and `/terms`; both render legal content. | — | — |
| AUTH-UI-014 | Positive | Open `/verify-email?email=<registered-email>`. | OTP entry field visible, target email displayed, "Resend code" action available. | — | — |
| AUTH-UI-015 | Edge | Open `/verify-email` with no `email` query parameter. | Page renders without crashing; the user is prompted for the email or redirected to login (no blank screen / unhandled exception). | — | — |
| AUTH-UI-016 | Positive | Open `/forgot-password` and submit an address. | Generic confirmation message is shown ("If the email exists…"), regardless of whether the address exists. | — | — |
| AUTH-UI-017 | Positive | Open `/reset-password?token=<valid>`. | New-password field(s) and submit button render. | — | — |
| AUTH-UI-018 | Negative | Open `/reset-password` with no token. | An error/invalid-link state is shown; the submit action is not usable. | — | — |
| AUTH-UI-019 | Positive | Resize `/login` and `/register` to 375px width. | No horizontal scroll; the register grid collapses from 2/3 columns to 1 column; all controls remain reachable. | — | — |
| AUTH-UI-020 | Positive | Toggle OS/browser theme to light and dark on `/login`. | The correct logo variant (`logo-dark.png` on light theme, `logo-light.png` on dark theme) is shown; contrast remains legible. | — | — |
| AUTH-UI-021 | Positive | Tab through `/login` from the top. | Focus order = Email → Password → (show/hide) → Forgot password → Sign In → Create an Account; visible focus ring on each. | — | — |
| AUTH-UI-022 | Positive | Trigger any auth error (e.g. wrong password). | A toast appears with the server's message; the form remains populated (email not cleared) and re-enabled. | — | — |

---

## 2. Field Validation Test Cases

### 2.1 Registration (`/register`)

| TC ID | Field | Type | Input / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|---|
| AUTH-FLD-001 | All | Negative | Submit with every field blank. | Toast: "Please fill in all required fields and select a plan". No network submit. | — | — |
| AUTH-FLD-002 | Workspace Name | Negative | `A` (1 char) + other fields valid. | Rejected — "Tenant name is too short". No tenant row created. | — | — |
| AUTH-FLD-003 | Workspace Name | Boundary | Exactly 2 chars (`QA`). | Accepted. | — | — |
| AUTH-FLD-004 | Workspace Name | Boundary | Exactly 255 chars. | Accepted; stored untruncated. | — | — |
| AUTH-FLD-005 | Workspace Name | Boundary | 256 chars. | Rejected with a max-length error; no row created. | — | — |
| AUTH-FLD-006 | Workspace Name | Edge | `  QA Household A  ` (leading/trailing spaces). | Accepted; verify how it is stored (record actual — trimmed vs. raw). | — | — |
| AUTH-FLD-007 | Workspace Name | Edge | Unicode + emoji: `शर्मा Household 👨‍👩‍👧`. | Accepted and rendered correctly on the dashboard header. | — | — |
| AUTH-FLD-008 | Full Name | Negative | `J` (1 char). | Rejected — "Name is too short". | — | — |
| AUTH-FLD-009 | Full Name | Boundary | Exactly 2 chars. | Accepted. | — | — |
| AUTH-FLD-010 | Email | Negative | `notanemail`. | Rejected — "Invalid email format". | — | — |
| AUTH-FLD-011 | Email | Negative | `user@`, `@domain.com`, `user@@domain.com`, `user domain.com`. | Each rejected with the same invalid-email message. | — | — |
| AUTH-FLD-012 | Email | Positive | `qa.admin.a+tag@example.co.in`. | Accepted (plus-addressing and multi-part TLD are valid). | — | — |
| AUTH-FLD-013 | Email | Edge | `QA.Admin.A@EXAMPLE.COM` (mixed case). | Accepted and **normalised to lowercase** in the DB. | — | — |
| AUTH-FLD-014 | Email | Negative | Email already registered to any tenant. | Rejected — "Email already registered". No new tenant/user rows. | — | — |
| AUTH-FLD-015 | Email | Edge | An email that differs only by case from an existing one. | Treated as a duplicate and rejected (case-insensitive uniqueness). | — | — |
| AUTH-FLD-016 | Password | Negative | `Pass123` (7 chars). | Rejected — "Password must be at least 8 characters". | — | — |
| AUTH-FLD-017 | Password | Boundary | Exactly 8 chars (`Pass1234`). | Accepted. | — | — |
| AUTH-FLD-018 | Password | Boundary | 200-char password. | Accepted; login with the same 200-char value succeeds. | — | — |
| AUTH-FLD-019 | Password | Edge | Password containing spaces, unicode and symbols: `pä ss!@#$%^&*()_+`. | Accepted; login with the identical string succeeds. | — | — |
| AUTH-FLD-020 | Password | Edge | Password of exactly 72 bytes and one of 73+ bytes (bcrypt input limit). | Record actual behaviour — registration must not throw a 500; if truncation occurs, login with the full string must still behave consistently. | — | — |
| AUTH-FLD-021 | Phone | Negative | `12345` (5 digits). | Rejected — "Phone number is too short" (min 10). | — | — |
| AUTH-FLD-022 | Phone | Boundary | Exactly 10 digits. | Accepted. | — | — |
| AUTH-FLD-023 | Phone | Positive | `+919876543210` selected via the country-code control. | Accepted; stored with the country code. | — | — |
| AUTH-FLD-024 | Phone | Negative | Alphabetic input `abcdefghij`. | Blocked by the PhoneInput control or rejected on submit. | — | — |
| AUTH-FLD-025 | Plan | Negative | Leave no plan selected (clear selection if possible) and submit. | Toast: "…select a plan"; no submit. | — | — |
| AUTH-FLD-026 | Consent (Data) | Negative | Tick AI consent only, submit. | Toast: "You must agree to the Data Processing and AI policies to register." | — | — |
| AUTH-FLD-027 | Consent (AI) | Negative | Tick Data consent only, submit. | Same rejection as above. | — | — |
| AUTH-FLD-028 | Consent (both) | Positive | Tick both, submit with otherwise valid data. | Registration proceeds. | — | — |
| AUTH-FLD-029 | All | Edge | Paste `<script>alert(1)</script>` into Workspace Name and Full Name, register, then view the dashboard header. | Value is rendered as literal text — no script execution, no HTML injection. | — | — |
| AUTH-FLD-030 | All | Edge | Submit the form twice rapidly (double-click "Initialize Workspace"). | Only ONE tenant + user pair is created (button disables on first submit). | — | — |

### 2.2 Login (`/login`)

| TC ID | Field | Type | Input / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|---|
| AUTH-FLD-031 | Both | Negative | Submit both fields empty. | Toast "Please fill in all fields"; no request sent. | — | — |
| AUTH-FLD-032 | Email | Negative | Valid-format but unregistered email + any password. | Generic "Invalid credentials" (must NOT reveal that the account does not exist). | — | — |
| AUTH-FLD-033 | Password | Negative | Registered email + wrong password. | Generic "Invalid credentials" — identical message to AUTH-FLD-032. | — | — |
| AUTH-FLD-034 | Identifier | Positive | Log in using the registered **phone number** instead of the email. | Login succeeds. | — | — |
| AUTH-FLD-035 | Identifier | Edge | Email with leading/trailing whitespace: `  qa.admin.a@example.com  `. | Trimmed client-side; login succeeds. | — | — |
| AUTH-FLD-036 | Identifier | Edge | Email in a different case than registered. | Login succeeds (identifier lower-cased server-side). | — | — |
| AUTH-FLD-037 | Password | Edge | Password differing only in case. | Rejected — password comparison is case-sensitive. | — | — |
| AUTH-FLD-038 | Identifier | Negative | SQL-injection payload `' OR 1=1 --` in the identifier. | Rejected as invalid credentials; no error page; no rows leaked. | — | — |
| AUTH-FLD-039 | Password | Boundary | Empty password with a valid email. | Blocked client-side; if bypassed, server rejects with "Password is required". | — | — |
| AUTH-FLD-039a | Identifier | Positive | Email of an account that was **erased** from Settings → Delete account + any password. | HTTP 410; inline notice "This account was permanently deleted on DD/MM/YYYY…" with a "Create a new account →" link; toast with the same sentence. NOT "Invalid credentials". | — | — |
| AUTH-FLD-039b | Identifier | Positive | The erased account's **mobile number** (any spelling: `98765 43210`, `+919876543210`) + any password. | Same 410 notice as AUTH-FLD-039a — the lookup matches on the normalised number. | — | — |
| AUTH-FLD-039c | Identifier | Negative | Email of a **member** (STANDARD) of an erased workspace. | 410 notice reads "The workspace "<name>" this account belonged to was permanently deleted by its admin on …". | — | — |
| AUTH-FLD-039d | Password | Negative | A **live** account's email + wrong password, where the same email also has an older erasure record (register → erase → register again). | Generic "Invalid credentials" — the erased notice must never appear for a live account. | — | — |

### 2.3 OTP verification (`/verify-email`)

| TC ID | Field | Type | Input / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|---|
| AUTH-FLD-040 | OTP | Negative | Submit empty OTP. | "Email and verification code are required". | — | — |
| AUTH-FLD-041 | OTP | Negative | Wrong 6-digit code. | "Invalid verification code"; `email_verified` stays `false`. | — | — |
| AUTH-FLD-042 | OTP | Boundary | 5-digit and 7-digit codes. | Both rejected as invalid. | — | — |
| AUTH-FLD-043 | OTP | Edge | Correct code with surrounding whitespace `  123456  `. | Trimmed and accepted. | — | — |
| AUTH-FLD-044 | OTP | Negative | Correct code **after** expiry (see §3.3 SQL to force expiry). | "Verification code has expired. Please request a new code."; `email_verified` stays `false`. | — | — |
| AUTH-FLD-045 | OTP | Edge | Non-numeric code `abcdef`. | Rejected as invalid. | — | — |
| AUTH-FLD-046 | Email | Negative | Unknown email + any OTP. | "User not found" (404). | — | — |
| AUTH-FLD-047 | OTP | Edge | Submit the **same valid OTP twice** — once to verify, once again. | First succeeds; second reports "Email already verified" and logs the user in (OTP is cleared after first use). | — | — |

### 2.4 Forgot / Reset password

| TC ID | Field | Type | Input / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|---|
| AUTH-FLD-048 | Email | Negative | Submit empty email on `/forgot-password`. | "Email is required". | — | — |
| AUTH-FLD-049 | Email | Positive | Submit an unregistered address. | Generic success message; **no** email sent; no reset token created anywhere. | — | — |
| AUTH-FLD-050 | Email | Positive | Submit a registered address. | Generic success message; a reset email arrives with a `/reset-password?token=…` link. | — | — |
| AUTH-FLD-050a | Email | Positive | Submit the email of an **erased** account. | HTTP 410; inline notice "This account was permanently deleted on …" with a "Create a new account →" link; **no** email sent (`journalctl -u docsnx` shows no "Password reset email" line). | — | — |
| AUTH-FLD-050b | Email | Negative | Submit 11+ requests from one IP within 15 minutes. | The 11th answers 429 with `Retry-After` — the route shares the login/register limiter. | — | — |
| AUTH-FLD-051 | Token | Negative | Open `/reset-password?token=garbage` and submit a new password. | "Invalid or expired token"; password unchanged. | — | — |
| AUTH-FLD-052 | Token | Negative | Use a valid token **after** its 1-hour expiry. | "Invalid or expired token". | — | — |
| AUTH-FLD-053 | Token | Edge | Reuse a token that was already consumed. | "Invalid or expired token" (token nulled after use). | — | — |
| AUTH-FLD-054 | New Password | Negative | Submit an empty new password with a valid token. | "Token and new password are required". | — | — |
| AUTH-FLD-055 | New Password | Boundary | Submit a 1-character new password. | Record actual behaviour. **Expected (spec):** rejected for being under the 8-character minimum used at registration. If accepted, raise as **S2** (inconsistent password policy). | — | — |
| AUTH-FLD-056 | New Password | Positive | Submit an 8+ char password with a valid token. | "Password reset successful"; login with the new password works and the old password fails. | — | — |

---

## 3. Business Rule Test Cases

| TC ID | Type | Rule / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| AUTH-BR-001 | Positive | Register a brand-new workspace. | The created user gets role `TENANT_ADMIN` (never `STANDARD`), and is the only user in the new tenant. | — | — |
| AUTH-BR-002 | Positive | Register with an email never seen before. | Tenant is assigned the plan with `is_default = true`, and `subscription_expiry = today + plan.durationDays` (default 14 when null). | — | — |
| AUTH-BR-003 | Business rule | Delete a tenant but leave its email in `trial_used_emails`, then register again with the same email. | No trial is granted: `subscription_plan_id` is NULL and `subscription_expiry` is set to *now* (immediately expired). The user must pay to proceed. | — | — |
| AUTH-BR-004 | Negative | Temporarily set every plan's `is_default` to false, then attempt registration. | Blocked with "Registration disabled: No default subscription plan configured in the system." No partial rows created. | — | — |
| AUTH-BR-005 | Positive | Complete registration. | User is redirected to `/verify-email?email=…`; the account cannot be used until OTP verification. | — | — |
| AUTH-BR-006 | Negative | Attempt to log in before verifying the OTP. | 403 with "Email verification required…"; UI redirects to `/verify-email`. | — | — |
| AUTH-BR-007 | Positive | Verify the OTP. | An `auth_token` cookie is set and the user is logged in immediately without a second login. | — | — |
| AUTH-BR-008 | Positive | Click "Resend code" on `/verify-email`. | A new OTP is emailed; the previous OTP no longer works; new expiry is 15 minutes out. | — | — |
| AUTH-BR-009 | Negative | Click "Resend code" for an already-verified account. | "Email is already verified." | — | — |
| AUTH-BR-010 | Negative | Suspend the tenant (`is_active = false`) then log in. | 403 "Account inactive or suspended". | — | — |
| AUTH-BR-011 | Negative | Set the user's `deleted_at` then attempt login. | Login fails with "Invalid credentials" (soft-deleted users cannot authenticate). | — | — |
| AUTH-BR-012 | Business rule | Expire the tenant subscription, then log in and open any record module. | Login succeeds but every permission check fails → module access denied / renewal prompt. | — | — |
| AUTH-BR-013 | Positive | Log in successfully and inspect the browser cookie jar. | `auth_token` present, flagged `HttpOnly`, `SameSite=Strict`, `Path=/`, `Max-Age ≈ 604800`. `Secure` is set when served over HTTPS. | — | — |
| AUTH-BR-014 | Security | Attempt `document.cookie` in the browser console after login. | `auth_token` is NOT readable from JavaScript. | — | — |
| AUTH-BR-015 | Negative | Delete the `auth_token` cookie manually and reload `/dashboard`. | Redirected to `/login`. | — | — |
| AUTH-BR-016 | Negative | Tamper with the `auth_token` value (change one character) and reload. | Treated as unauthenticated → redirected to `/login`. No 500 error. | — | — |
| AUTH-BR-017 | Edge | Craft a token signed with a different secret and set it as `auth_token`. | Rejected; redirected to `/login`. | — | — |
| AUTH-BR-018 | Positive | Click Logout. | Cookie cleared; navigating back to `/dashboard` (including via browser Back) does not show tenant data. | — | — |
| AUTH-BR-019 | Boundary | Submit the login form ~6+ times in rapid succession from the same IP with bad credentials. | Rate limiter returns 429 "Too many login attempts…" with a `Retry-After` header; UI surfaces the message. | — | — |
| AUTH-BR-020 | Boundary | Submit the registration form repeatedly from one IP. | 429 "Too many registration attempts…". | — | — |
| AUTH-BR-021 | Edge | After being rate-limited, wait for the window to elapse and retry. | Request succeeds again. | — | — |
| AUTH-BR-022 | Security | Request a password reset, then request a second one before using the first link. | Only the most recent token is valid; the first link is rejected. | — | — |
| AUTH-BR-023 | Security | Complete a password reset while a session is already open in another browser. | Record actual behaviour: whether the pre-existing JWT continues to work. Any continued access after a password reset should be raised as **S2**. | — | — |
| AUTH-BR-024 | Positive | Register, then check `users.requires_password_change`. | Defaults to `true` for new users; becomes `false` after a password reset. | — | — |
| AUTH-BR-025 | Positive | Register and check the consent columns. | `consent_data_processing = true`, `consent_timestamp` set, `consent_ip_address` populated. `consent_ai_processing` no longer exists — 0060 dropped it along with the second consent checkbox. | — | — |
| AUTH-BR-026 | Edge | Register two tenants concurrently using the same email from two browsers. | Exactly one succeeds; the other is rejected by the unique email constraint with a clean 400, not a 500. | — | — |

---

## 4. End-to-End Workflow Test Cases

| TC ID | Workflow | Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| AUTH-E2E-001 | Happy-path signup | 1. `/register` → fill all fields, select free/default plan, tick both consents → submit.<br>2. Read the OTP from the verification email.<br>3. Enter the OTP on `/verify-email`.<br>4. Complete/skip onboarding.<br>5. Land on `/dashboard`. | Tenant + admin user + empty profile created; email verified; session established; dashboard shows the workspace name and zeroed module counts. | — | — |
| AUTH-E2E-002 | Signup on a paid plan | Register selecting a paid plan → verify OTP → observe redirect. | After verification the user is routed toward billing/checkout for the selected plan (`/billing?autoCheckout=<planId>`). | — | — |
| AUTH-E2E-003 | Forgotten password recovery | 1. `/forgot-password` → submit registered email.<br>2. Open the emailed link.<br>3. Set a new password.<br>4. Log in with the new password.<br>5. Attempt login with the old password. | Steps 1–4 succeed; step 5 fails with "Invalid credentials". | — | — |
| AUTH-E2E-004 | Expired OTP recovery | 1. Register.<br>2. Force OTP expiry via SQL.<br>3. Attempt verification → expired error.<br>4. Click "Resend code".<br>5. Verify with the new code. | User recovers without re-registering; account verified. | — | — |
| AUTH-E2E-005 | Session persistence | 1. Log in.<br>2. Close the browser tab.<br>3. Re-open the app URL within the 7-day window. | Still authenticated; lands on `/dashboard` without re-login. | — | — |
| AUTH-E2E-006 | Suspended tenant lifecycle | 1. Log in as ADMIN_A (works).<br>2. Super Admin suspends TENANT_A.<br>3. Log out and log in again. | Step 3 blocked with "Account inactive or suspended". Re-activating restores login. | — | — |
| AUTH-E2E-007 | Trial-abuse prevention | 1. Register `qa.trial@example.com`.<br>2. Delete the tenant.<br>3. Register again with the same email. | The second registration receives no trial plan and lands in an immediately-expired state requiring payment. | — | — |
| AUTH-E2E-009 | Erase, then forget | 1. Log in as a tenant admin.<br>2. Settings → Delete account → type the workspace name → confirm.<br>3. On landing at `/login`, read the toast.<br>4. Try to log in with the same email.<br>5. Try `/forgot-password` with the same email.<br>6. Register again with the same email and mobile. | Step 3: toast "Your account and all its data have been permanently erased." is visible on `/login` (it was previously lost to the hard navigation). Steps 4–5: the 410 "deleted on <date>" notice with a Register link. Step 6: registration succeeds (email and number are free again); after verifying, login works and the notice no longer appears. | — | — |
| AUTH-E2E-008 | Multi-device login | Log in as the same user in two different browsers, then log out from one. | The second browser's session continues to work (independent cookies) — confirm this matches product intent; record actual. | — | — |

---

## 5. Database Validation Test Cases

> Replace `:email_a` with the ADMIN_A email and `:tenant_a` with the TENANT_A UUID.

| TC ID | Validation Point | SQL Query | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| AUTH-DB-001 | Registration creates exactly one tenant | `SELECT count(*) FROM tenants WHERE name = 'QA Household A';` | `1` | — | — |
| AUTH-DB-002 | Admin user created with correct role & tenant | `SELECT role, tenant_id, email_verified FROM users WHERE email = ':email_a';` | `TENANT_ADMIN`, `:tenant_a`, `false` (before verification) | — | — |
| AUTH-DB-003 | Email stored lower-cased | `SELECT email = lower(email) AS is_lower FROM users WHERE lower(email) = lower(':email_a');` | `t` | — | — |
| AUTH-DB-004 | Email uniqueness enforced | `SELECT email, count(*) FROM users GROUP BY email HAVING count(*) > 1;` | 0 rows | — | — |
| AUTH-DB-005 | Password stored as a bcrypt hash, never plaintext | `SELECT password_hash LIKE '$2%' AS is_bcrypt, password_hash = 'Pass1234' AS is_plain, length(password_hash) FROM users WHERE email = ':email_a';` | `t`, `f`, `60` | — | — |
| AUTH-DB-006 | OTP is stored hashed, not as the 6 digits emailed | `SELECT email_verification_otp, email_verification_otp ~ '^[0-9]{6}$' AS looks_plain, length(email_verification_otp) FROM users WHERE email = ':email_a';` | `looks_plain = f`; value is a long hex digest (≥64 chars) | — | — |
| AUTH-DB-007 | OTP expiry is 15 minutes out | `SELECT email_verification_otp_expiry - now() AS ttl FROM users WHERE email = ':email_a';` | An interval > 14 min and ≤ 15 min | — | — |
| AUTH-DB-008 | OTP cleared after successful verification | `SELECT email_verified, email_verification_otp, email_verification_otp_expiry FROM users WHERE email = ':email_a';` | `true`, `NULL`, `NULL` | — | — |
| AUTH-DB-009 | Empty profile row created at registration | `SELECT personal_details, education_details, shopping_details, legal_details FROM profiles WHERE user_id = (SELECT id FROM users WHERE email = ':email_a');` | Exactly 1 row, all four columns = `{}` | — | — |
| AUTH-DB-010 | Trial email recorded | `SELECT count(*) FROM trial_used_emails WHERE email = ':email_a';` | `1` | — | — |
| AUTH-DB-011 | Default plan assigned & expiry computed | `SELECT t.subscription_plan_id, t.subscription_expiry, p.is_default, p.duration_days FROM tenants t JOIN subscription_plans p ON p.id = t.subscription_plan_id WHERE t.id = ':tenant_a';` | `is_default = t`; `subscription_expiry ≈ created_at + duration_days` | — | — |
| AUTH-DB-012 | Registration audit log written | `SELECT action, details FROM audit_logs WHERE tenant_id = ':tenant_a' AND action = 'REGISTER_TENANT';` | 1 row; details mention the workspace name and pending OTP verification | — | — |
| AUTH-DB-013 | OTP verification audit log written | `SELECT count(*) FROM audit_logs WHERE tenant_id = ':tenant_a' AND action = 'VERIFY_EMAIL_OTP';` | `1` | — | — |
| AUTH-DB-014 | Consent captured with IP and timestamp | `SELECT consent_data_processing, consent_timestamp IS NOT NULL AS ts, consent_ip_address IS NOT NULL AS ip FROM users WHERE email = ':email_a';` | `t`, `t`, `t` | — | — |
| AUTH-DB-015 | Failed registration leaves no partial rows (transaction integrity) | After a deliberately failing registration (e.g. duplicate email): `SELECT count(*) FROM tenants WHERE name = 'QA Rollback Test';` | `0` | — | — |
| AUTH-DB-016 | Reset token stored hashed with 1-hour expiry | `SELECT reset_token ~ '^[0-9a-f]{64}$' AS hashed, reset_token_expiry - now() AS ttl FROM users WHERE email = ':email_a';` | `hashed = t`; hash ≠ the token in the emailed URL; `ttl` ≈ 1 hour | — | — |
| AUTH-DB-017 | Reset token cleared after use | `SELECT reset_token, reset_token_expiry, requires_password_change FROM users WHERE email = ':email_a';` | `NULL`, `NULL`, `false` | — | — |
| AUTH-DB-018 | Password hash actually changes on reset | Capture `password_hash` before and after: `SELECT password_hash FROM users WHERE email = ':email_a';` | The two values differ | — | — |
| AUTH-DB-019 | Password-reset audit trail | `SELECT action FROM audit_logs WHERE tenant_id = ':tenant_a' AND action IN ('PASSWORD_RESET_REQUESTED','PASSWORD_RESET_SUCCESSFUL') ORDER BY created_at;` | Both rows present, request before success | — | — |
| AUTH-DB-020 | Audit timestamps mandatory on users & tenants | `SELECT count(*) FROM users WHERE created_at IS NULL OR updated_at IS NULL;` and the same for `tenants` | `0` for both | — | — |
| AUTH-DB-021 | New tenant defaults | `SELECT is_active, has_completed_onboarding, google_drive_enabled, ai_credits_balance, ai_provider, ai_model FROM tenants WHERE id = ':tenant_a';` | `true`, `false`, `false`, `0`, `gemini`, `gemini-2.5-flash` | — | — |
| AUTH-DB-022 | No orphan users (every user has a valid tenant) | `SELECT count(*) FROM users u LEFT JOIN tenants t ON t.id = u.tenant_id WHERE t.id IS NULL;` | `0` | — | — |
| AUTH-DB-023 | Tenant delete cascades to users & profiles | Delete a throwaway tenant, then: `SELECT count(*) FROM users WHERE tenant_id = ':tenant_x';` | `0` | — | — |
| AUTH-DB-024 | No plaintext password ever persisted anywhere in `users` | `SELECT count(*) FROM users WHERE password_hash = 'Pass1234' OR reset_token = 'Pass1234';` | `0` | — | — |
