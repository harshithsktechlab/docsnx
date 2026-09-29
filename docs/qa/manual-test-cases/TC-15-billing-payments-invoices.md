# TC-15 — Billing · Plans · Add-ons · Discounts · Payments · AMC · Invoices

**Prefixes:** `BIL`, `PAY`, `DSC`, `AMC`, `INVC`
**Routes:** `/billing`, `/billing/amc-lock`, `/invoices`
**Tables:** `subscription_plans`, `addons`, `tenant_addons`, `payments`, `invoices`,
`discount_codes`, `discount_usages`, `tenants`

---

## 0. Module Reference

| Aspect | Detail |
|---|---|
| Billing cycles | `MONTHLY` (`price`), `YEARLY` (`price_yearly`), `ONE_TIME` (`price_one_time`); USD equivalents exist for each |
| Subscription expiry on purchase | `YEARLY` → now + 365 days · lifetime plan → `NULL` (never expires) · otherwise → now + 30 days |
| AI credits on purchase | `tenants.ai_credits_balance += plan.ai_credits` (and `+= addon.ai_credits` for each add-on) |
| Zero-amount / manual orders | If the computed amount is ≤ 0 **or** `isManualPayment` (Super Admin only), the payment row is written directly with `status = 'captured'` and no Razorpay order is created |
| Razorpay flow | Create order → checkout → verify signature (HMAC) → activate. An invalid signature returns *"Invalid payment signature."* and activates nothing |
| Discount types | `PERCENTAGE` (`discount_pct`) and `FIXED` (`discount_amount`, capped at the applicable amount). Final price is floored at 0 |
| Discount scoping | Optional `plan_id` / `addon_id` restrict where a code applies; `max_uses` (global) and `max_uses_per_tenant` limit redemption; `expires_at` and `is_active` gate validity |
| Usage tracking | Every redemption writes a `discount_usages` row with `amount_saved` |
| AMC | Lifetime plans set `amc_last_paid_at = now()` and `amc_next_due_date = now() + 1 year`. Paying an `amc` invoice pushes `amc_next_due_date` forward by one year |
| AMC lock | A tenant in AMC-locked state is redirected to `/billing/amc-lock` from every route except `/login` |
| Invoice GST | `base_amount`, `gst_amount`, `gst_type` (default `EXEMPT`); platform GSTIN and client GSTIN are printed on the PDF |
| Invoice status | `pending`, `paid`, `overdue`, `cancelled` |

---

# PART A — Billing & Plan Purchase (`BIL`)

## A1. UI Validation

| TC ID | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| BIL-UI-001 | Positive | Open `/billing` as TENANT_ADMIN. | Current plan, expiry date, credit balance, storage usage, member allowance, plan cards and add-on cards all render. | — | — |
| BIL-UI-002 | Positive | Inspect the plan cards. | Only `is_active` plans are shown, each with name, price, badge colour, AI credits, member limit and storage limit. | — | — |
| BIL-UI-003 | Positive | Toggle the billing cycle (Monthly / Yearly / One-time). | Displayed prices switch to `price` / `price_yearly` / `price_one_time`; a cycle with no configured price is hidden or disabled rather than showing blank/`NaN`. | — | — |
| BIL-UI-004 | Positive | Toggle the currency to USD (if offered). | Prices switch to the `*_usd` columns; the symbol changes; no mixed ₹/$ display. | — | — |
| BIL-UI-005 | Positive | Select an add-on. | It is added to the order summary with the correct price for the chosen duration; the total updates. | — | — |
| BIL-UI-006 | Positive | Select several add-ons. | All appear in the summary; the total equals the plan price plus every add-on price. | — | — |
| BIL-UI-007 | Positive | Deselect an add-on. | Removed from the summary; the total recalculates. | — | — |
| BIL-UI-008 | Positive | Enter a valid discount code and apply it. | Success feedback showing the amount saved; the total drops accordingly. | — | — |
| BIL-UI-009 | Negative | Enter an invalid code. | "Invalid or inactive discount code."; the total is unchanged. | — | — |
| BIL-UI-010 | Positive | Remove an applied discount. | The total reverts to the undiscounted amount. | — | — |
| BIL-UI-011 | Positive | Click Pay and observe the Razorpay checkout. | The Razorpay modal opens with the correct amount and currency; the app shows a pending state behind it. | — | — |
| BIL-UI-012 | Positive | Close the Razorpay modal without paying. | The app returns to `/billing` with no payment recorded and no plan change; a cancel message is shown. | — | — |
| BIL-UI-013 | Positive | Open `/billing?autoCheckout=<planId>` after registration. | Checkout opens automatically for that plan. | — | — |
| BIL-UI-014 | Positive | Open `/billing` on a tenant with no plan. | The user is routed here from everywhere else; a clear "choose a plan to continue" message is shown. | — | — |
| BIL-UI-015 | Positive | View `/billing` at 375px. | Plan cards stack; the order summary stays reachable; no horizontal page scroll. | — | — |
| BIL-UI-016 | Negative | Open `/billing` as a `STANDARD` user. | Purchase actions are unavailable — only a `TENANT_ADMIN` may buy. Record actual. | — | — |
| BIL-UI-017 | Positive | Observe the payment history section. | Past payments listed with date, amount, status, plan/add-on and an invoice link. | — | — |

## A2. Field & Business Rules

| TC ID | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| BIL-BR-001 | Negative | Attempt checkout with neither a plan nor an add-on selected. | Rejected — "planId or addonsPurchased and tenantId are required." | — | — |
| BIL-BR-002 | Negative | Attempt checkout for an inactive plan (set `is_active = false` first). | "Subscription plan not found or inactive." | — | — |
| BIL-BR-003 | Negative | Attempt checkout with an inactive add-on. | "Add-on not found or inactive: `<id>`". | — | — |
| BIL-BR-004 | **Security** | As ADMIN_A, attempt to create an order for TENANT_B's `tenantId`. | "Access denied. Cannot create orders for other tenants." Any success ⇒ **S1**. | — | — |
| BIL-BR-005 | Negative | As a `STANDARD` user, attempt to create an order. | "Access denied. Admin privileges required." | — | — |
| BIL-BR-006 | Negative | As a TENANT_ADMIN, attempt a manual payment (`isManualPayment`). | "Only Super Admins can manually record payments." | — | — |
| BIL-BR-007 | Boundary | Purchase a plan priced at **0** (free plan). | No Razorpay order is created; a payment row is written directly with `status = 'captured'`; the plan activates immediately. | — | — |
| BIL-BR-008 | Boundary | Apply a discount that reduces the total to exactly 0. | Same as BIL-BR-007 — direct capture, no Razorpay round-trip. | — | — |
| BIL-BR-009 | Boundary | Apply a FIXED discount larger than the total. | The discount is capped at the applicable amount; the final price floors at 0 (never negative). | — | — |
| BIL-BR-010 | Positive | Purchase a MONTHLY plan. | `subscription_expiry` = now + **30 days**. | — | — |
| BIL-BR-011 | Positive | Purchase a YEARLY plan. | `subscription_expiry` = now + **365 days**. | — | — |
| BIL-BR-012 | Positive | Purchase a **lifetime** plan (`is_lifetime = true`). | `subscription_expiry` = **NULL**; `amc_last_paid_at` = now; `amc_next_due_date` = now + 1 year. | — | — |
| BIL-BR-013 | Positive | Purchase a plan with `ai_credits = 500` on a tenant holding 120 credits. | Balance becomes **620** (added, not replaced). | — | — |
| BIL-BR-014 | Positive | Purchase an add-on with `ai_credits = 200`. | Balance increases by 200; a `tenant_addons` row is created and marked active. | — | — |
| BIL-BR-015 | Positive | Purchase an add-on with `extra_members = 2`. | The member allowance rises by 2; the previously blocked member creation now succeeds. | — | — |
| BIL-BR-016 | Positive | Purchase an add-on with `storage_limit_gb = 5`. | The storage limit shown on the dashboard rises by 5 GB; a previously quota-blocked upload succeeds. | — | — |
| BIL-BR-017 | Positive | Upgrade from a cheaper plan to a more expensive one. | The new plan replaces the old; limits and expiry update; credits accumulate. Record whether any proration is applied. | — | — |
| BIL-BR-018 | Edge | Downgrade to a plan with fewer allowed members while the tenant already exceeds that limit. | Existing members are not deleted; new additions are blocked. Record actual and confirm this matches intent. | — | — |
| BIL-BR-019 | Positive | Purchase while the subscription is already expired. | The purchase completes and restores access immediately. | — | — |
| BIL-BR-020 | **Security** | Tamper with the amount in the checkout request (e.g. via devtools) and complete payment. | Rejected — the server recomputes the price from the plan/add-on records. Any acceptance of a client-supplied amount ⇒ **S1**. | — | — |
| BIL-BR-021 | **Security** | Complete a payment, then replay the verify step with a **modified signature**. | "Invalid payment signature."; nothing is activated; no credits granted. | — | — |
| BIL-BR-022 | Security | Replay a **valid** verify payload a second time. | The plan is not activated twice and credits are not granted twice. Record actual — double-granting ⇒ **S2**. | — | — |
| BIL-BR-023 | Edge | Interrupt the network between the Razorpay success and the verify call. | The payment row remains in a non-captured state; the tenant is not activated; the user can retry or the webhook reconciles it. | — | — |
| BIL-BR-024 | Positive | Complete a purchase and check `/audit-logs`. | An entry records the payment and plan change. | — | — |

## A3. Database Validation

| TC ID | Validation Point | SQL Query | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| BIL-DB-001 | Payment row created for the right tenant | `SELECT tenant_id, plan_id, amount, currency, status, initiated_by, plan_billing_cycle FROM payments WHERE tenant_id = ':tenant_a' ORDER BY created_at DESC LIMIT 1;` | `:tenant_a`; amount = the computed final price; `status = captured` after success | — | — |
| BIL-DB-002 | Razorpay identifiers recorded | `SELECT razorpay_order_id, razorpay_payment_id, razorpay_signature IS NOT NULL AS has_sig FROM payments WHERE id = ':payment_id';` | All three present for a Razorpay payment; all NULL for a zero-amount/manual capture | — | — |
| BIL-DB-003 | Monthly expiry computed correctly | `SELECT subscription_expiry, subscription_expiry::date - now()::date AS days FROM tenants WHERE id = ':tenant_a';` | `days` ≈ 30 | — | — |
| BIL-DB-004 | Yearly expiry computed correctly | Same query after a YEARLY purchase. | `days` ≈ 365 | — | — |
| BIL-DB-005 | Lifetime plan sets a null expiry and AMC dates | `SELECT subscription_expiry, amc_last_paid_at, amc_next_due_date FROM tenants WHERE id = ':tenant_a';` | `NULL`; `amc_last_paid_at` ≈ now; `amc_next_due_date` ≈ now + 1 year | — | — |
| BIL-DB-006 | Credits added, not replaced | Capture the balance, purchase a plan with known `ai_credits`, re-query: `SELECT ai_credits_balance FROM tenants WHERE id = ':tenant_a';` | Old balance + plan credits (+ add-on credits) | — | — |
| BIL-DB-007 | Add-on activation row | `SELECT ta.tenant_id, a.name, ta.is_active, ta.purchased_at, ta.expires_at FROM tenant_addons ta JOIN addons a ON a.id = ta.addon_id WHERE ta.tenant_id = ':tenant_a';` | One active row per purchased add-on | — | — |
| BIL-DB-008 | Member allowance reflects add-ons | `SELECT p.max_members + COALESCE(sum(a.extra_members),0) AS allowed FROM tenants t JOIN subscription_plans p ON p.id = t.subscription_plan_id LEFT JOIN tenant_addons ta ON ta.tenant_id = t.id AND ta.is_active LEFT JOIN addons a ON a.id = ta.addon_id WHERE t.id = ':tenant_a' GROUP BY p.max_members;` | Matches the allowance shown in the UI and enforced by member creation | — | — |
| BIL-DB-009 | Zero-amount purchase captured directly | `SELECT status, razorpay_order_id FROM payments WHERE id = ':free_payment_id';` | `captured`, `NULL` | — | — |
| BIL-DB-010 | Amount never negative | `SELECT count(*) FROM payments WHERE amount < 0;` | `0` | — | — |
| BIL-DB-011 | Payment plan reference is valid | `SELECT count(*) FROM payments p LEFT JOIN subscription_plans s ON s.id = p.plan_id WHERE p.plan_id IS NOT NULL AND s.id IS NULL;` | `0` | — | — |
| BIL-DB-012 | Cross-tenant isolation (P7) | `SELECT count(*) FROM payments WHERE id = ':payment_id' AND tenant_id = ':tenant_b';` | `0` | — | — |
| BIL-DB-013 | Server-side price authority | Compare `payments.amount` with the plan/add-on prices in the DB after a tampered-amount attempt. | The stored amount equals the server-computed price, never the tampered value | — | — |
| BIL-DB-014 | Audit trail for the purchase | `SELECT action, details FROM audit_logs WHERE tenant_id = ':tenant_a' ORDER BY created_at DESC LIMIT 3;` | An entry describing the plan/add-on purchase | — | — |
| BIL-DB-015 | No duplicate activation on verify replay | `SELECT count(*) FROM payments WHERE razorpay_payment_id = ':rzp_payment_id';` | `1` | — | — |

---

# PART B — Discount Codes (`DSC`)

## B1. Test Cases

| TC ID | Category | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|---|
| DSC-FLD-001 | Field | Negative | Apply a code that does not exist. | "Invalid or inactive discount code." | — | — |
| DSC-FLD-002 | Field | Negative | Apply a code with `is_active = false`. | Same message. | — | — |
| DSC-FLD-003 | Field | Negative | Apply an expired code (`expires_at` in the past). | "Discount code has expired." | — | — |
| DSC-FLD-004 | Field | Boundary | Apply a code expiring **today** at a future hour. | Accepted. | — | — |
| DSC-FLD-005 | Field | Boundary | Apply a code one minute past its expiry. | Rejected. | — | — |
| DSC-FLD-006 | Field | Edge | Apply a code in a different case than stored (`SAVE20` vs `save20`). | Record actual — the lookup is an exact match, so a case mismatch will fail. Judge whether that is acceptable UX ⇒ possible **S4**. | — | — |
| DSC-FLD-007 | Field | Edge | Apply a code with surrounding whitespace. | Record actual — an untrimmed code will fail the exact match ⇒ possible **S4**. | — | — |
| DSC-BR-001 | Business | Boundary | A code with `max_uses = 1`: redeem it once, then attempt a second redemption from another tenant. | Second attempt: "Discount code usage limit reached." | — | — |
| DSC-BR-002 | Business | Boundary | A code with `max_uses_per_tenant = 1`: redeem once in TENANT_A, attempt again in TENANT_A. | "You have reached the maximum usage limit for this discount code." | — | — |
| DSC-BR-003 | Business | Positive | The same per-tenant-limited code redeemed once each by TENANT_A and TENANT_B. | Both succeed (the limit is per tenant). | — | — |
| DSC-BR-004 | Business | Negative | A plan-scoped code applied to a different plan. | "Discount code is not valid for this plan." | — | — |
| DSC-BR-005 | Business | Positive | A plan-scoped code applied to its own plan while add-ons are also in the cart. | The discount applies to the **plan price only**, not the add-on total. | — | — |
| DSC-BR-006 | Business | Negative | An add-on-scoped code applied to a cart without that add-on. | "Discount code is not valid for the addons in the cart." | — | — |
| DSC-BR-007 | Business | Positive | An add-on-scoped code applied to a cart containing that add-on. | The discount applies to that add-on's price only. | — | — |
| DSC-BR-008 | Business | Positive | A PERCENTAGE code of 20% on a ₹1000 total. | Saved = ₹200; final = ₹800. | — | — |
| DSC-BR-009 | Business | Boundary | A PERCENTAGE code of 100%. | Final = ₹0; the purchase completes via the direct-capture path. | — | — |
| DSC-BR-010 | Business | Boundary | A FIXED code of ₹500 on a ₹300 total. | Saved capped at ₹300; final = ₹0 (never negative). | — | — |
| DSC-BR-011 | Business | Edge | A PERCENTAGE code above 100 (e.g. `discount_pct = 150`). | Final floors at 0; no negative amount is ever created. Record actual. | — | — |
| DSC-BR-012 | Business | Positive | Apply a discount, then complete the purchase. | A `discount_usages` row is written with the correct `amount_saved`, tenant and payment reference. | — | — |
| DSC-BR-013 | Business | Edge | Apply a discount, then **abandon** the checkout. | No `discount_usages` row is written; the code's remaining uses are unchanged. | — | — |
| DSC-BR-014 | Business | Positive | Verify the billing cycle scoping of a code restricted to `YEARLY`. | Applies on the yearly cycle only; rejected for monthly. | — | — |
| DSC-DB-001 | DB | Usage row recorded | `SELECT du.tenant_id, dc.code, du.amount_saved, du.payment_id FROM discount_usages du JOIN discount_codes dc ON dc.id = du.discount_code_id WHERE du.tenant_id = ':tenant_a' ORDER BY du.used_at DESC LIMIT 1;` | Correct tenant, code, saved amount and a linked payment id | — | — |
| DSC-DB-002 | DB | Global usage count enforced | `SELECT dc.code, dc.max_uses, count(du.id) AS used FROM discount_codes dc LEFT JOIN discount_usages du ON du.discount_code_id = dc.id WHERE dc.code = 'SAVE20' GROUP BY 1,2;` | `used <= max_uses` always | — | — |
| DSC-DB-003 | DB | Per-tenant usage count enforced | `SELECT tenant_id, count(*) FROM discount_usages WHERE discount_code_id = ':code_id' GROUP BY tenant_id;` | No tenant exceeds `max_uses_per_tenant` | — | — |
| DSC-DB-004 | DB | Saved amount never exceeds the applicable amount | `SELECT count(*) FROM discount_usages du JOIN payments p ON p.id = du.payment_id WHERE du.amount_saved::numeric > (p.amount::numeric + du.amount_saved::numeric);` | `0` | — | — |
| DSC-DB-005 | DB | Payment amount reflects the discount | `SELECT p.amount, du.amount_saved FROM payments p JOIN discount_usages du ON du.payment_id = p.id WHERE p.id = ':payment_id';` | `amount` = pre-discount total − `amount_saved` | — | — |
| DSC-DB-006 | DB | Codes are globally unique | `SELECT code, count(*) FROM discount_codes GROUP BY code HAVING count(*) > 1;` | 0 rows | — | — |
| DSC-DB-007 | DB | Abandoned checkout wrote nothing | After DSC-BR-013: `SELECT count(*) FROM discount_usages WHERE discount_code_id = ':code_id' AND used_at > now() - interval '5 minutes';` | `0` | — | — |

---

# PART C — AMC Lock & Renewal (`AMC`)

## C1. Test Cases

| TC ID | Category | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|---|
| AMC-UI-001 | UI | Positive | Put the tenant into AMC-locked state, then log in. | Redirected to `/billing/amc-lock`; a clear explanation of the outstanding AMC and a Pay action are shown. | — | — |
| AMC-UI-002 | UI | Positive | While AMC-locked, attempt to navigate to `/dashboard`, `/documents` and `/billing`. | All redirect back to `/billing/amc-lock`; only `/login` is exempt. | — | — |
| AMC-UI-003 | UI | Positive | Inspect the AMC-lock page content. | Shows the AMC amount, the due date and the invoice reference. | — | — |
| AMC-UI-004 | UI | Positive | View `/billing/amc-lock` at 375px. | Fully legible; the Pay button is reachable; no horizontal page scroll. | — | — |
| AMC-BR-001 | Business | Positive | Purchase a lifetime plan. | `amc_last_paid_at` = now; `amc_next_due_date` = now + 1 year; the tenant is **not** locked. | — | — |
| AMC-BR-002 | Business | Business rule | Advance `amc_next_due_date` into the past and generate the pending AMC invoice. | The tenant becomes AMC-locked on the next page load. | — | — |
| AMC-BR-003 | Business | Positive | Pay the pending AMC invoice. | Lock clears; `amc_last_paid_at` = now; `amc_next_due_date` moves forward by **one year**; normal navigation resumes. | — | — |
| AMC-BR-004 | Business | Edge | Pay AMC twice in quick succession. | The due date advances only once per paid invoice; no double-charge. | — | — |
| AMC-BR-005 | Business | Negative | With no pending AMC invoice, open the AMC-lock page. | A clear "No pending AMC invoice found" state — not a crash or an infinite spinner. | — | — |
| AMC-BR-006 | Business | Business rule | A non-lifetime plan tenant. | Never enters the AMC-lock flow (AMC applies to lifetime plans). Record actual. | — | — |
| AMC-BR-007 | Business | Business rule | AMC-locked **and** subscription-expired at once. | AMC lock takes precedence in the redirect order. | — | — |
| AMC-BR-008 | Business | Security | While TENANT_A is AMC-locked, confirm TENANT_B is unaffected. | TENANT_B navigates normally. | — | — |
| AMC-DB-001 | DB | Pending AMC invoice exists | `SELECT id, invoice_type, status, amount, due_date FROM invoices WHERE tenant_id = ':tenant_a' AND invoice_type = 'amc' ORDER BY created_at DESC LIMIT 1;` | One row with `status = pending` while locked | — | — |
| AMC-DB-002 | DB | AMC dates set on a lifetime purchase | `SELECT amc_last_paid_at, amc_next_due_date FROM tenants WHERE id = ':tenant_a';` | `amc_last_paid_at` ≈ purchase time; `amc_next_due_date` ≈ +1 year | — | — |
| AMC-DB-003 | DB | Paying AMC advances the due date by one year | Capture `amc_next_due_date`, pay the AMC invoice, re-query. | New value = old value + 1 year (or now + 1 year when the old value was null) | — | — |
| AMC-DB-004 | DB | Invoice marked paid | `SELECT status FROM invoices WHERE id = ':amc_invoice_id';` | `paid` | — | — |
| AMC-DB-005 | DB | AMC payment recorded | `SELECT tenant_id, amount, status FROM payments WHERE tenant_id = ':tenant_a' ORDER BY created_at DESC LIMIT 1;` | A captured payment for the AMC amount | — | — |
| AMC-DB-006 | DB | AMC amount matches the plan | `SELECT p.amc_amount FROM tenants t JOIN subscription_plans p ON p.id = t.subscription_plan_id WHERE t.id = ':tenant_a';` | Equals the invoice amount | — | — |
| AMC-DB-007 | DB | Cross-tenant isolation | `SELECT count(*) FROM invoices WHERE id = ':amc_invoice_id' AND tenant_id = ':tenant_b';` | `0` | — | — |

---

# PART D — Invoices (`INVC`)

**Route:** `/invoices` · **Table:** `invoices`

## D1. UI Validation

| TC ID | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| INVC-UI-001 | Positive | Open `/invoices` with no invoices. | Empty state; no error. | — | — |
| INVC-UI-002 | Positive | Open `/invoices` with invoices present. | List shows invoice number, client, amount, GST, status badge, issued date and due date. | — | — |
| INVC-UI-003 | Positive | Inspect the status badges. | `pending`, `paid`, `overdue` and `cancelled` each render distinctly. | — | — |
| INVC-UI-004 | Positive | Open an invoice preview. | The preview modal shows platform details (name, GSTIN, address), client details, line items, base amount, GST breakdown and total. | — | — |
| INVC-UI-005 | Positive | Download the invoice PDF. | A valid PDF downloads containing the same figures as the preview. | — | — |
| INVC-UI-006 | Positive | Filter/sort invoices by status and date. | Filters apply correctly. | — | — |
| INVC-UI-007 | Positive | Click Pay on a pending invoice. | Razorpay checkout opens for the invoice amount. | — | — |
| INVC-UI-008 | Positive | View `/invoices` at 375px. | The table scrolls inside its own container; the page body does not scroll horizontally. | — | — |
| INVC-UI-009 | Edge | Preview an invoice with 20+ line items. | All items render; the PDF paginates rather than truncating. | — | — |
| INVC-UI-010 | Edge | Preview an invoice where the client GSTIN is blank. | The GSTIN line is omitted cleanly — no `undefined`/`null` on the document. | — | — |

## D2. Business Rules

| TC ID | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| INVC-BR-001 | Positive | Complete a payment. | An invoice is generated with a unique invoice number and `status = paid`. | — | — |
| INVC-BR-002 | Positive | Verify the GST arithmetic on an invoice. | `base_amount + gst_amount = amount`, to 2 decimals. | — | — |
| INVC-BR-003 | Business rule | Compare an intra-state vs. inter-state invoice (matching vs. differing state codes). | GST type and split (CGST+SGST vs. IGST) are correct for each. | — | — |
| INVC-BR-004 | Business rule | Create an invoice for a client without a GSTIN. | `gst_type` defaults to `EXEMPT` and `gst_amount = 0`. | — | — |
| INVC-BR-005 | Business rule | Set an invoice's due date in the past while it is unpaid. | Displayed as `overdue`. | — | — |
| INVC-BR-006 | Positive | Pay a pending invoice. | Status flips to `paid`; the payment appears in history; the invoice PDF reflects paid status. | — | — |
| INVC-BR-007 | Negative | Attempt to pay an already-paid invoice. | Blocked with a clear message; no duplicate charge. | — | — |
| INVC-BR-008 | Negative | Attempt to pay a cancelled invoice. | Blocked. | — | — |
| INVC-BR-009 | **Security** | As ADMIN_B, attempt to open, download or pay a TENANT_A invoice by its id. | 403/404 for all three; no PDF is generated. Any success ⇒ **S1**. | — | — |
| INVC-BR-010 | Security | Inspect a downloaded invoice PDF's content. | Contains only this tenant's data — no other tenant's name, GSTIN or figures. | — | — |
| INVC-BR-011 | Business rule | Update the tenant's billing profile (name, GSTIN, address), then generate a new invoice. | The new invoice carries the updated client details; historical invoices are unchanged. | — | — |
| INVC-BR-012 | Business rule | Update the platform settings (name, GSTIN, logo), then generate a new invoice. | The new PDF reflects the updated platform header. | — | — |
| INVC-BR-013 | Edge | Generate an invoice in USD. | Currency symbol and amounts are consistent throughout the PDF; GST treatment matches the export rules configured. | — | — |

## D3. Database Validation

| TC ID | Validation Point | SQL Query | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| INVC-DB-001 | Invoice created for the right tenant | `SELECT tenant_id, invoice_number, invoice_type, status, amount FROM invoices WHERE tenant_id = ':tenant_a' ORDER BY created_at DESC LIMIT 1;` | `:tenant_a`; a non-empty invoice number; correct amount | — | — |
| INVC-DB-002 | Invoice numbers are unique | `SELECT invoice_number, count(*) FROM invoices GROUP BY invoice_number HAVING count(*) > 1;` | 0 rows | — | — |
| INVC-DB-003 | GST arithmetic holds | `SELECT invoice_number, base_amount, gst_amount, amount, (base_amount::numeric + gst_amount::numeric) = amount::numeric AS balances FROM invoices WHERE tenant_id = ':tenant_a';` | `balances = t` for every row | — | — |
| INVC-DB-004 | Default GST type | `SELECT gst_type, gst_amount FROM invoices WHERE id = ':exempt_invoice_id';` | `EXEMPT`, `0.00` | — | — |
| INVC-DB-005 | Status values constrained | `SELECT DISTINCT status FROM invoices;` | Only `pending`, `paid`, `overdue`, `cancelled` | — | — |
| INVC-DB-006 | Amounts never negative | `SELECT count(*) FROM invoices WHERE amount < 0 OR base_amount < 0 OR gst_amount < 0;` | `0` | — | — |
| INVC-DB-007 | Line items stored as JSON | `SELECT jsonb_typeof(items), jsonb_array_length(items) FROM invoices WHERE id = ':invoice_id';` | `array` with the expected item count | — | — |
| INVC-DB-008 | Line items sum to the base amount | Sum `quantity × price` across `items` and compare with `base_amount`. | Equal to 2 decimals | — | — |
| INVC-DB-009 | Paying an invoice flips the status | `SELECT status, updated_at FROM invoices WHERE id = ':invoice_id';` | `paid`; `updated_at` advanced | — | — |
| INVC-DB-010 | Overdue detection matches the DB | `SELECT count(*) FROM invoices WHERE tenant_id = ':tenant_a' AND status = 'pending' AND due_date < now();` | Matches the number of invoices shown as overdue | — | — |
| INVC-DB-011 | Cross-tenant isolation (P7) | `SELECT count(*) FROM invoices WHERE id = ':invoice_id' AND tenant_id = ':tenant_b';` | `0` | — | — |
| INVC-DB-012 | Audit timestamps (P2) | `SELECT created_at IS NOT NULL, updated_at IS NOT NULL, updated_at >= created_at FROM invoices WHERE id = ':invoice_id';` | `t, t, t` | — | — |
| INVC-DB-013 | Tenant delete cascades invoices | Delete a throwaway tenant, then: `SELECT count(*) FROM invoices WHERE tenant_id = ':tenant_x';` | `0` | — | — |

---

## End-to-End Workflows

| TC ID | Workflow | Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| BIL-E2E-001 | Register → pay → use | 1. Register on a paid plan.<br>2. Verify OTP → redirected to billing checkout.<br>3. Complete the Razorpay payment.<br>4. Land on the dashboard and create a record. | Plan activated; expiry set per cycle; credits granted; invoice generated; modules fully usable. | — | — |
| BIL-E2E-002 | Discounted purchase | 1. Create a 25% code limited to 1 use per tenant.<br>2. Apply it at checkout and observe the total.<br>3. Complete payment.<br>4. Attempt to reuse the code. | Total reduced by exactly 25%; `discount_usages` row written; the reuse attempt is blocked with the per-tenant limit message. | — | — |
| BIL-E2E-003 | Free-plan path | 1. Configure a ₹0 plan.<br>2. Select it and check out. | No Razorpay modal; a captured payment row; the plan activates; an invoice is generated for ₹0. | — | — |
| BIL-E2E-004 | Add-on stacking | 1. Buy an add-on granting +2 members, +5 GB and +200 credits.<br>2. Check the member allowance, storage limit and credit balance.<br>3. Add members up to the new cap and upload past the old storage limit. | All three limits increase; the previously blocked actions now succeed. | — | — |
| BIL-E2E-005 | Expiry → renewal | 1. Expire the subscription.<br>2. Confirm every module is blocked and the user is routed to billing.<br>3. Purchase a renewal.<br>4. Re-check module access. | Access blocked in step 2 and fully restored in step 4 with a new expiry date. | — | — |
| BIL-E2E-006 | Lifetime + AMC cycle | 1. Buy a lifetime plan.<br>2. Confirm `subscription_expiry` is NULL and AMC dates are set.<br>3. Force the AMC due date into the past and generate the AMC invoice.<br>4. Log in → AMC-locked.<br>5. Pay the AMC. | Steps 4 and 5 behave exactly as documented; the due date advances a year; access is restored. | — | — |
| BIL-E2E-007 | Payment failure paths | 1. Start checkout and cancel the Razorpay modal.<br>2. Start checkout and submit a failing test card.<br>3. Start checkout and tamper with the signature at verify. | No plan activation, no credits and no invoice in any of the three cases; each failure surfaces a clear message. | — | — |
| BIL-E2E-008 | Invoice lifecycle | 1. Complete a purchase.<br>2. Open `/invoices`, preview and download the PDF.<br>3. Verify the GST breakdown against the DB.<br>4. Attempt to open the same invoice as ADMIN_B. | Invoice correct and downloadable; GST arithmetic balances; the cross-tenant attempt is refused. | — | — |
| BIL-E2E-009 | Billing profile propagation | 1. Set the tenant billing name, GSTIN and address.<br>2. Make a purchase.<br>3. Inspect the new invoice. | The invoice carries the configured client details and the correct GST type for the state-code pair. | — | — |
