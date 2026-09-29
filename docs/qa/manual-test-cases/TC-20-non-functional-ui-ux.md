# TC-20 — Non-Functional: Responsive · Accessibility · Performance · Compatibility · Resilience

**Prefix:** `NFR` · **Applies to:** every screen
**Stack notes:** Next.js 15.1 App Router, React 19, Tailwind CSS v3 + Radix UI, CSS variables,
glassmorphism dark mode, `framer-motion`, PWA with service worker, `sonner` toasts

---

## 1. Responsive Layout

### 1.1 Breakpoint sweep — run for every screen listed

**Widths:** 320px · 375px · 414px · 768px · 1024px · 1440px · 1920px

| TC ID | Screen | Expected at every width | Actual Result | Status |
|---|---|---|---|---|
| NFR-RSP-001 | `/login`, `/register`, `/forgot-password`, `/reset-password`, `/verify-email` | Card fits the viewport; the register grid collapses 3 → 2 → 1 column; no horizontal page scroll | — | — |
| NFR-RSP-002 | `/onboarding` | Wizard card fits; progress bar readable; buttons reachable | — | — |
| NFR-RSP-003 | `/dashboard` | Metric grid reflows 1 → 2 → 3+ columns; no clipped counters | — | — |
| NFR-RSP-004 | App shell | Sidebar becomes a drawer/bottom nav below 768px; opening it overlays content and closes on selection | — | — |
| NFR-RSP-005 | All 19 record-module list pages | Cards stack; tables scroll inside their own `overflow-x` container; **the page body never scrolls horizontally** | — | — |
| NFR-RSP-006 | All add/edit dialogs | Dialog fits the viewport; long forms scroll inside the dialog; the submit button is always reachable | — | — |
| NFR-RSP-007 | `/users` permission grid | The 20 × 5 checkbox grid scrolls inside its own container | — | — |
| NFR-RSP-008 | `/billing` | Plan cards stack; the order summary stays reachable without scrolling past the fold on mobile | — | — |
| NFR-RSP-009 | `/invoices` + invoice preview | Table scrolls in-container; the preview modal fits and is scrollable | — | — |
| NFR-RSP-010 | `/audit-logs` | Rows reflow/stack; long `details` text wraps | — | — |
| NFR-RSP-011 | `/follow-up` | Four sections stack; long messages wrap | — | — |
| NFR-RSP-012 | Spotlight search panel | Fits the viewport; results scroll within the panel | — | — |
| NFR-RSP-013 | Admin console (`/admin`, `/tenants`, `/admin/*`) | Metric cards reflow; wide tables scroll in-container | — | — |
| NFR-RSP-014 | `/dashboard/bulk-scan` | Drop zone and review list usable on mobile | — | — |
| NFR-RSP-015 | `/profile` | Tabs remain usable (scrollable or stacked); fields full-width | — | — |

### 1.2 Orientation & zoom

| TC ID | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| NFR-RSP-020 | Positive | Rotate a phone between portrait and landscape on 5 representative screens. | Layout reflows without content loss; no element is stranded off-screen. | — | — |
| NFR-RSP-021 | Boundary | Set browser zoom to 200% on `/dashboard` and a module list. | Content remains usable and readable; no overlap; no horizontal page scroll. | — | — |
| NFR-RSP-022 | Boundary | Set zoom to 50%. | Layout does not collapse into unreadable slivers; max-widths keep line lengths sane. | — | — |
| NFR-RSP-023 | Edge | Open on a very tall/narrow viewport (320 × 900). | No clipped controls; the sticky header/nav does not consume the viewport. | — | — |
| NFR-RSP-024 | Edge | Open on an ultrawide viewport (2560px). | Content is centred with a sensible max-width — not stretched into one long line. | — | — |
| NFR-RSP-025 | Positive | Test on a device with a notch/safe-area inset. | No control sits under the notch or the home indicator. | — | — |

---

## 2. Theme, Typography & Visual Consistency

| TC ID | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| NFR-THM-001 | Positive | Toggle dark ⇄ light on every major screen. | All surfaces, text, badges and glassmorphism panels remain legible in both modes; no invisible text. | — | — |
| NFR-THM-002 | Positive | Toggle theme, then reload. | The choice persists. | — | — |
| NFR-THM-003 | Positive | Toggle theme with the app in a dialog/modal. | The dialog re-themes correctly; no flash of the wrong theme. | — | — |
| NFR-THM-004 | Positive | Check the logo variant in each theme. | `logo-dark.png` on light backgrounds, `logo-light.png` on dark — correct on `/login`, `/register` and the shell. | — | — |
| NFR-THM-005 | Positive | Set the OS to dark mode with no explicit app preference. | The app respects the system preference on first load. | — | — |
| NFR-THM-006 | Positive | Cycle the font-size toggle through every option. | Base size changes app-wide; the setting persists across reload. | — | — |
| NFR-THM-007 | Boundary | Set the largest font size and view every module list and dialog. | No text clipping, no overlapping controls, no broken layout. | — | — |
| NFR-THM-008 | Positive | Compare status/severity badges across modules (create/update/delete, paid/pending/overdue, expiring/overdue). | Colour semantics are consistent across the product. | — | — |
| NFR-THM-009 | Positive | Compare empty states across all 19 modules. | Consistent structure: icon, message and a primary CTA. | — | — |
| NFR-THM-010 | Positive | Compare loading states across all modules. | Skeletons everywhere (not bare spinners in some modules and skeletons in others). | — | — |
| NFR-THM-011 | Positive | Compare toast behaviour across modules. | Consistent position, duration and success/error styling; toasts never obscure the primary action button. | — | — |
| NFR-THM-012 | Positive | Check date formatting across all modules. | One consistent format everywhere; no mix of `DD/MM/YYYY` and `MM-DD-YY`. | — | — |
| NFR-THM-013 | Positive | Check currency formatting across billing, investments, loans, LIC and utility bills. | Consistent symbol placement, thousands separators and 2-decimal display. | — | — |
| NFR-THM-014 | Edge | Check `framer-motion` transitions with "reduce motion" enabled at OS level. | Animations are reduced or disabled; no vestibular-triggering movement. | — | — |
| NFR-THM-015 | Positive | Confirm no CSS framework other than Tailwind v3 + Radix has been introduced. | Only the approved stack is present (house rule). | — | — |

---

## 3. Accessibility

| TC ID | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| NFR-A11Y-001 | Positive | Tab through `/login` and `/register` from the top. | Logical focus order; every interactive element reachable; visible focus ring on each. | — | — |
| NFR-A11Y-002 | Positive | Tab through a module list page and an add dialog. | Focus enters the dialog on open, is trapped inside it, and returns to the trigger on close. | — | — |
| NFR-A11Y-003 | Positive | Close a dialog with `Esc`. | Dialog closes; focus returns to the trigger. | — | — |
| NFR-A11Y-004 | Positive | Operate every Radix select, tab set, checkbox, switch and dialog by keyboard only. | All fully operable; arrow keys work within selects and tab sets. | — | — |
| NFR-A11Y-005 | Positive | Operate the spotlight search entirely by keyboard. | Open, type, ↑/↓ to navigate, Enter to select, Esc to close. | — | — |
| NFR-A11Y-006 | Positive | Run an automated axe scan on `/login`, `/dashboard`, `/documents`, `/users` and `/billing`. | Zero critical or serious violations; record any moderate ones. | — | — |
| NFR-A11Y-007 | Positive | Check colour contrast in both themes on body text, muted text, badges and buttons. | All meet WCAG AA (4.5:1 body, 3:1 large text). | — | — |
| NFR-A11Y-008 | Positive | Check every form field for a programmatic label. | Every input has an associated `<label>`; placeholders are never the only label. | — | — |
| NFR-A11Y-009 | Positive | Trigger a validation error and inspect it with a screen reader. | The error is announced and associated with its field. | — | — |
| NFR-A11Y-010 | Positive | Trigger a toast with a screen reader running. | Announced via a live region. | — | — |
| NFR-A11Y-011 | Positive | Inspect every image and icon-only button. | Meaningful `alt` text / accessible names; decorative images marked as such. | — | — |
| NFR-A11Y-012 | Positive | Inspect heading structure on 5 screens. | A single `h1` per page and a sensible, non-skipping hierarchy. | — | — |
| NFR-A11Y-013 | Positive | Navigate a module list with a screen reader. | Table/list semantics are conveyed; column headers announced. | — | — |
| NFR-A11Y-014 | Positive | Check touch target sizes on mobile (reveal/copy/delete icons). | All ≥ 44 × 44 px. | — | — |
| NFR-A11Y-015 | Positive | Verify that information is never conveyed by colour alone. | Overdue/expiring/status states carry an icon or text label as well as colour. | — | — |

---

## 4. Performance

| TC ID | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| NFR-PRF-001 | Positive | Measure first load of `/login` and `/dashboard` on a cold cache. | Interactive within a defined budget (e.g. < 3 s on broadband); record LCP/TBT. | — | — |
| NFR-PRF-002 | Positive | Measure navigation between modules after the first load. | Sub-second client-side transitions. | — | — |
| NFR-PRF-003 | Boundary | Load a module with 1 000 records. | The list paginates; the page stays responsive; no browser freeze. | — | — |
| NFR-PRF-004 | Boundary | Load a module with 5 000 records. | Still usable via pagination; no timeout. Record the response time. | — | — |
| NFR-PRF-005 | Boundary | Open `/dashboard` on a tenant with records across all 19 modules at scale. | Counters resolve within budget; no N+1 stall. | — | — |
| NFR-PRF-006 | Boundary | Run a global search on a tenant with thousands of records. | Debounced; results within ~1 s; capped per module. | — | — |
| NFR-PRF-007 | Boundary | Open `/follow-up` on a large tenant. | The aggregation across 9+ tables completes within budget. Record the time — this page loads several full tables into memory. | — | — |
| NFR-PRF-008 | Boundary | Run the Backup export on a large tenant. | Completes without timeout; the file is complete and valid. | — | — |
| NFR-PRF-009 | Boundary | Upload a large file (at the max permitted size). | Progress feedback; no UI freeze; completes or fails cleanly. | — | — |
| NFR-PRF-010 | Boundary | Run a bulk scan with 20 files. | Progress per stage; no timeout; a complete review list. | — | — |
| NFR-PRF-011 | Positive | Leave the app open for 30 minutes with the 60-second pollers running. | No memory growth trend; no accumulating intervals; the tab stays responsive. | — | — |
| NFR-PRF-012 | Positive | Throttle to Slow 3G and load `/dashboard`. | Skeletons appear promptly; the page degrades gracefully rather than showing a blank screen. | — | — |
| NFR-PRF-013 | Positive | Check the console during a full navigation sweep of all modules. | No errors and no repeated warnings. | — | — |
| NFR-PRF-014 | Positive | Check the network panel for duplicate requests on a single page load. | No duplicated fetches for the same resource. | — | — |
| NFR-PRF-015 | Boundary | Run the k6/stress scripts in the repo against a staging instance. | Error rate and p95 latency within the agreed budget; record the figures. | — | — |

---

## 5. Browser & Device Compatibility

| TC ID | Environment | Scope | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| NFR-CMP-001 | Chrome (latest, desktop) | Full regression checklist G-01…G-12 from the master plan | All pass | — | — |
| NFR-CMP-002 | Firefox (latest, desktop) | Same | All pass | — | — |
| NFR-CMP-003 | Safari (latest, macOS) | Same | All pass; check date inputs and clipboard behaviour specifically | — | — |
| NFR-CMP-004 | Edge (latest, desktop) | Same | All pass | — | — |
| NFR-CMP-005 | Safari (iOS) | Auth, one module CRUD, file upload, PWA install | All pass; file picker and camera capture work | — | — |
| NFR-CMP-006 | Chrome (Android) | Same as NFR-CMP-005 | All pass; push notification permission flow works | — | — |
| NFR-CMP-007 | Any browser with cookies blocked | Login | A clear message explaining cookies are required — not a silent redirect loop | — | — |
| NFR-CMP-008 | Any browser with JavaScript disabled | Load the app | A graceful no-JS message rather than a blank page | — | — |
| NFR-CMP-009 | Clipboard-restricted context (insecure origin) | Copy actions in Passwords | Graceful fallback or a clear error — no unhandled exception | — | — |
| NFR-CMP-010 | Docker/OCI production-like build (`docker compose up -d`) | Full regression checklist | Behaviour matches the dev environment; no dev-only assumptions leak in | — | — |

---

## 6. PWA & Offline Behaviour

| TC ID | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| NFR-PWA-001 | Positive | Load the app in a supported browser. | The install prompt/banner appears; dismissing it hides it for the session. | — | — |
| NFR-PWA-002 | Positive | Install the PWA and launch it from the home screen/app list. | Opens in standalone mode with the correct icon, name and theme colour. | — | — |
| NFR-PWA-003 | Positive | Inspect the manifest and service worker registration. | Manifest valid; the service worker registers without console errors. | — | — |
| NFR-PWA-004 | Negative | Go offline and navigate the installed app. | An offline fallback page or a clear "you are offline" state — not a browser error page. | — | — |
| NFR-PWA-005 | Negative | Go offline and attempt a create/edit action. | A clear network-error toast; entered data is preserved so the user can retry. | — | — |
| NFR-PWA-006 | Positive | Come back online after a failed action and retry. | The action succeeds; no duplicate record from the earlier failed attempt. | — | — |
| NFR-PWA-007 | Positive | Deploy a new build, then reopen the installed PWA. | The service worker updates; the user is not stranded on a stale cached bundle. | — | — |
| NFR-PWA-008 | Positive | Accept push permission and register a device. | A `user_devices` row is created; a test push arrives. | — | — |
| NFR-PWA-009 | Negative | Deny push permission. | The app functions normally; no repeated blocking prompts. | — | — |
| NFR-PWA-010 | Edge | Log out of the PWA, then log in as a different tenant's user on the same device. | No data from the previous session is cached or displayed; the device registration is re-scoped correctly. | — | — |

---

## 7. Error Handling & Resilience

| TC ID | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| NFR-ERR-001 | Negative | Navigate to a nonexistent route (`/does-not-exist`). | A styled 404 page with a route back into the app — not a raw framework error. | — | — |
| NFR-ERR-002 | Negative | Force a server error on a module page. | A styled error boundary with a retry action; no stack trace shown to the user. | — | — |
| NFR-ERR-003 | Negative | Stop the database and load `/dashboard`. | A clear "something went wrong" state; no connection string, SQL text or table name in the message. | — | — |
| NFR-ERR-004 | Negative | Cut the network mid-save on 5 different modules. | Each shows an error toast; the form retains its values; no phantom record is created. | — | — |
| NFR-ERR-005 | Negative | Cut the network mid-upload. | A clear failure; no zero-byte record and no orphan file counted against the quota. | — | — |
| NFR-ERR-006 | Edge | Double-submit every create form across all modules. | Exactly one record each time (buttons disable on submit). | — | — |
| NFR-ERR-007 | Edge | Open the same record in two tabs, edit and save in both. | The second save either wins cleanly or reports a conflict — it must not silently merge into corrupt data. Record actual. | — | — |
| NFR-ERR-008 | Edge | Press the browser Back button after a create, an edit and a delete. | The list reflects the true current state; no stale cached view showing a deleted record. | — | — |
| NFR-ERR-009 | Edge | Refresh mid-dialog with unsaved data. | Data is lost (expected) but the app recovers cleanly to the list view. | — | — |
| NFR-ERR-010 | Edge | Let the session expire while a dialog is open, then save. | Redirected to login rather than failing silently; no partial write. | — | — |
| NFR-ERR-011 | Negative | Trigger the AI provider being unavailable and use every AI feature. | Each surfaces a clear provider error; no credits deducted; no partial record. | — | — |
| NFR-ERR-012 | Negative | Trigger the SMTP server being unavailable during registration and password reset. | The failure is surfaced or logged; the user gets a recovery path (resend); the account is not left unusable. | — | — |
| NFR-ERR-013 | Negative | Trigger Razorpay being unavailable at checkout. | A clear error; no payment row left in a misleading state; the user can retry. | — | — |
| NFR-ERR-014 | Negative | Trigger Google Drive being unavailable during a sync. | A clear reconnect/retry message; no partial or corrupt file written. | — | — |
| NFR-ERR-015 | Edge | Fill the server disk (or simulate a write failure) and upload a file. | A clean failure with a clear message; no half-written file referenced by a record row. | — | — |

---

## 8. Data-Volume & Boundary Scenarios

| TC ID | Type | Test Case / Steps | Expected Result | Actual Result | Status |
|---|---|---|---|---|---|
| NFR-VOL-001 | Boundary | Create a tenant with the maximum members its plan allows, each with records in every module. | All screens remain performant; member dropdowns render fully. | — | — |
| NFR-VOL-002 | Boundary | Add 100 custom fields to a single record. | Saves and renders; the print/share view remains usable. | — | — |
| NFR-VOL-003 | Boundary | Store a 100 000-character note in a text field. | Saved and fully retrievable; the list view truncates the display gracefully. | — | — |
| NFR-VOL-004 | Boundary | Create 500 notifications for one user. | The bell dropdown scrolls/paginates; the badge count is correct; no freeze. | — | — |
| NFR-VOL-005 | Boundary | Generate 1 000 audit entries. | The page shows the newest 100 and stays responsive. | — | — |
| NFR-VOL-006 | Boundary | Create 200 pending to-dos with due dates inside the follow-up window. | `/follow-up` renders them all without freezing; the badge count is correct. | — | — |
| NFR-VOL-007 | Boundary | Upload files totalling exactly the plan storage limit, then one byte more. | Exactly at the limit succeeds; one byte over is rejected with the quota message. | — | — |
| NFR-VOL-008 | Edge | Create records with names that sort at the extremes (leading spaces, symbols, unicode, digits). | Sorting is stable and predictable; no records are hidden by a sort quirk. | — | — |
| NFR-VOL-009 | Edge | Exercise the app with the browser in a non-English locale and a non-IST timezone. | Dates render consistently with no ±1-day drift; numbers parse correctly (decimal separator handling). | — | — |
| NFR-VOL-010 | Edge | Cross a daylight-saving boundary in a DST timezone with due-date records. | Day counts on `/follow-up` remain correct (no off-by-one). | — | — |

---

## 9. Non-Functional Sign-Off Summary

| Area | Owner | Result | Notes |
|---|---|---|---|
| Responsive (§1) | | — | |
| Theme & visual consistency (§2) | | — | |
| Accessibility (§3) | | — | |
| Performance (§4) | | — | |
| Browser compatibility (§5) | | — | |
| PWA & offline (§6) | | — | |
| Error handling (§7) | | — | |
| Data volume (§8) | | — | |
