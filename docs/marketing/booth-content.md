# DocsNX — booth content (MSME expo)

**Status:** direction settled. Final copy gets written after the open items in §6 are closed.

**Pieces to produce:** 3 m × 3 m wall backdrop + bi-fold brochure (A4 → A5, 4 panels).
**Event:** MSME / SME business expo. **No pricing anywhere.** CTA: QR → `docsnx.com` + "Start your free trial".
**Company:** HSK Tech Lab Pvt Ltd. **Product:** DocsNX.

---

## 1. The USP — "We don't save files on our server. It stays with you."

Checked against the code. It is almost exactly true, and the precise version is stronger than the loose one.

**What actually happens:**

- **Files:** an upload is refused unless Google Drive is connected (`requireDriveConnected`, `src/app/api/documents/route.ts:341`). Bytes are encrypted in the browser (AES-256-GCM, key derived from the user's passphrase) and written to `/DocsNX_Data/…` on the **customer's own Drive**. Our database stores only a Drive file ID. Even the Drive link is useless to an outsider — it points at ciphertext.
- **What does sit on our server:** the *index* — document name, category, and the extracted dates/numbers that power the alerts (sensitive values encrypted at rest). Plus users, permissions and the audit log.
- **During Power Scan:** the page passes through our server in memory/tmp and reaches the AI model only after credentials are stripped and PAN / Aadhaar / account / phone are masked. Then it's gone.

**Recommended wall wording:**

> **Your files never live on our servers.**
> Encrypted in your browser, stored in your own Google Drive.
> We can't read them — and neither can anyone who breaches us.

The last clause is the part an owner actually feels. "It stays with you" works as the spoken version at the stall; on a wall, "never live on our servers" is tighter and survives a sceptical CA asking *"so what IS on your server?"* — answer: *"the index, yes. Your documents, no."*

**Decided:** Google Drive **is** named on the wall. It's concrete, it's trusted, and it pre-answers "so where does it go?" before anyone has to ask.

---

## 2. Feature inventory, ranked for a business buyer

### Tier 1 — wall-worthy (understood in 3 seconds, from 3 m away)

| Feature | What the buyer hears |
|---|---|
| Zero-knowledge; files in their own Drive | "My documents aren't sitting on some startup's server" ← the USP |
| Expiry alerts: 15 days out → urgent → lapsed, in-app bell + phone push | "I won't get caught with a lapsed license again" |
| Power Scan — photograph it, AI names it, categorises it, fills in dates and numbers | "I don't have to type anything" |
| Per-module staff permissions + full audit log | "My accountant sees Tax, not Contracts — and I can see who opened what" |

### Tier 2 — brochure-worthy (needs one sentence of context)

- **14 business modules built around Indian paperwork** — GST / TDS / ITR, ROC filings (AOC-4, MGT-7), EPF & ESI, FSSAI / trade license / IEC / Udyam, contracts, HR, IP, banking & credit, insurance, governance, procurement, sales, operations. A genuine differentiator against foreign tools that just give you "Folder 1". Worth a visual — the coloured module pills.
- **Multi-company under one login** — each company its own workspace, its own staff, its own records.
- **AI Privacy Shield** — the model never sees passwords or card numbers; PAN, Aadhaar and account numbers are masked before anything is sent. Pairs directly with the USP: *"even our AI doesn't see your secrets."*
- **Encrypted password manager, assignable to-dos, important contacts** — the shared utilities a small team actually runs on.
- **Works on any device** — installs straight from the browser, no app store.
- **Duplicate detection on upload** — it recognises a re-scanned document as the same subject.

### Tier 3 — exists, but leave it off the print

- **AI assistant / analysis** (coverage gaps, premium savings) — household-flavoured, and hard to demo reliably at a noisy stall.
- **Backup / export, bulk download** — table stakes; mention verbally if asked.
- **WhatsApp** — used only for OTP and password reset, **not** for alerts. ⚠ Make sure the designer never writes "WhatsApp alerts" anywhere.

---

## 3. Settled direction

**Headline idea (your call, 2026-09-22):** all important documents in one place, shared with your **business partner** and your **family**.

This is a better hook than either of my earlier suggestions, and the product genuinely backs it: an account carries a **personal workspace and a business workspace at once** (`account_type = 'both'`), family members sit on the personal roster, a co-owner sits on the company roster, and each person's access is set per module. So "one place, shared with the two circles that matter" is a product fact, not a slogan.

It also quietly answers the succession question every owner has and nobody asks out loud — *if something happens to me, can my family find the policy, the loan papers, the license?*

**Decisions locked:**
- "Partner" means **business partner / co-owner** — not the CA, not a reseller programme.
- The tagline *"AI-Powered Records. Alerts that Matter."* is **off the wall** entirely. It can stay on the brochure.
- Google Drive **is** named on the wall.
- No pricing anywhere.

---

## 4. Wall layout — 3 m × 3 m

Navy field. Brand gradient used on one accent word and the QR frame only. One headline, one sub-line, four chips, a big QR. Nothing else.

**Top-left — brand lockup**
- DocsNX mark + wordmark (≈ 40 cm wide) — asset exists at `public/brand/docsnx-mark.svg`
- **Placeholder: HSK Tech Lab Pvt Ltd logo**, smaller, set beneath or to the right of the DocsNX lockup with a hairline divider between them. ⚠ I don't have this asset — send a vector or high-res PNG. Keep the two distinct: DocsNX is the product, HSK Tech Lab is the company behind it.

**Headline** (≈ 25–30 cm cap height, white, "one place" in gradient)
> **Everything important, in one place.**

Alternates in the same direction, pick one:
- *One place for everything that matters.*
- *Your business and your family, one secure place.*
- *All your important papers. One place. The right people.*

**Sub-line** (≈ 10 cm, white 85%) — carries the sharing *and* the USP:
> Shared with your business partner. Shared with your family.
> **Never stored on our servers** — encrypted, in your own Google Drive.

**Four chips** (≈ 7 cm text, icon + 2–4 words, one row)
- 🤝 **Business partner access**
- 👨‍👩‍👧 **Family access, your control**
- 📄 **Scan it, AI files it**
- 🔔 **Alerts before anything expires**

"All documents in one place" is now the headline, so it stops being a chip. Google Drive lives in the sub-line for the same reason.

**Bottom-right — QR block** (QR ≥ 50 cm so it scans from 2 m)
> **Start your free trial** · QR → `https://docsnx.com/register` · `docsnx.com`

**Bottom strip** (≈ 4 cm): encrypted end-to-end · a product of **HSK Tech Lab Pvt Ltd**

---

## 5. Where each thing goes

- **Wall:** headline + sub-line + four chips + QR. Nothing else competes at 3 m.
- **Brochure panel 1 (cover):** mirror the wall exactly — same headline, small QR.
- **Brochure panel 2:** the problem, then Power Scan → auto-filing → alerts.
- **Brochure panel 3:** the 14 business modules, per-module access for partner/staff/family, multi-company, and the data-ownership block.
- **Brochure panel 4:** QR, URL, free trial, works-on-any-device, HSK Tech Lab Pvt Ltd, tagline footer.

**30-second spoken pitch at the stall:**
> "Every important paper — your GST and licenses on the business side, your policies and property papers on the family side — in one place. Photograph it and the AI files it and warns you before it expires. Your partner sees the business, your family sees the family, and none of it ever sits on our servers — it's encrypted in your own Google Drive."

---

## 6. Still open

- **HSK Tech Lab logo file** — needed before artwork.
- **Support email / fine print** for the brochure back panel — confirm what exists.
- **Anything under-ranked?** If there's a feature people react to in live demos, that beats my ranking from reading the code.

---

## 7. Claims we must not make

No pricing. No customer counts. No "WhatsApp alerts". No "we store nothing" without the index caveat if anyone technical asks. Nothing about ISO / SOC certification — we hold none.
