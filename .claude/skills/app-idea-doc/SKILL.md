---
name: app-idea-doc
description: >-
  Turn a raw app, product, or feature idea into a structured product brief
  (a.k.a. one-pager / PRD-lite). Use whenever the user wants to capture,
  brainstorm, flesh out, or document an idea — covering the concept, problem &
  pain points, target users & personas, use cases / user stories, features
  (MoSCoW), value proposition, success metrics, competitive landscape, risks,
  and open questions. The document is generated dynamically: sections adapt to
  whether it's a whole app or a single feature, and every section is filled with
  concrete, idea-specific content (never generic filler). Triggers on: "app
  idea", "product idea", "feature idea", "document this idea", "product brief",
  "one-pager", "PRD", "spec out", "brainstorm an app/feature", "use cases",
  "pain points", "personas", "MVP".
---

# App / Feature Idea Document Generator

Produce a crisp, decision-ready product brief from an idea. The value is in
**specificity** — turn vague ideas into concrete users, jobs, and features.

## Step 1 — Gather the essentials (interview, briefly)
You need four things before writing. If any are missing or vague from the user's
message, ask for the **most important 2–4 unknowns in ONE round** using the
`AskUserQuestion` tool (offer sensible options + let them free-type). Don't
interrogate — one round, then proceed and mark anything still unknown as an
explicit assumption.

Core inputs:
1. **What** is the idea? (one sentence — the app/feature and what it does)
2. **Who** is it for? (target users / segment)
3. **What problem / pain point** does it solve, and how is that handled today?
4. **Scope**: a whole app/MVP, or a single feature inside an existing product?
   (For docsnx-style work, note the module it belongs to.)

Also infer where useful: monetization, platform (web/mobile/desktop),
constraints (timeline, budget, compliance), and any differentiator.

If the user already gave rich detail, skip the questions and go straight to
drafting — synthesize what they said and flag gaps in **Open Questions**.

## Step 2 — Choose the output location
- Default path: `docs/ideas/<kebab-slug>.md` (create the folder if missing).
- If the user named a path/format, use it. If they want a polished, shareable
  visual, offer to also publish it as an **Artifact** (see Step 4).
- Slug from the idea name, e.g. "Family Bill Splitter" → `family-bill-splitter.md`.

## Step 3 — Write the document (adapt sections to the idea)
Use the template below. **Scale it:** a full app uses all sections; a single
feature can drop Competitive Landscape / Business Model and focus on Problem,
Users, Use Cases, Feature Spec, and Metrics. Fill every kept section with real,
specific content. Prefer tables and bullets over prose. Quantify where you can
(users affected, time saved, frequency). Mark guesses as _(assumption)_.

```markdown
# <Idea Name>

> **One-liner:** <a single sentence a stranger would understand>
> **Status:** Draft · **Owner:** <name> · **Date:** <YYYY-MM-DD> · **Scope:** <App / MVP / Feature>

## 1. Overview
2–4 sentences: what it is, who it's for, and the core value. End with the
"elevator pitch": _For [target user] who [need], [product] is a [category] that
[key benefit], unlike [alternative]._

## 2. Problem & Pain Points
- **Problem statement:** the core problem in one sentence.
- **Pain points** (who feels each, how often, how painful — High/Med/Low):
  | Pain point | Who feels it | Frequency | Severity | How it's handled today |
  |---|---|---|---|---|
  | … | … | … | … | … |
- **Why now:** what makes this timely (tech shift, market, regulation, behavior).

## 3. Target Users & Personas
| Persona | Role / context | Goals | Key frustrations | Tech comfort |
|---|---|---|---|---|
| <name> | … | … | … | … |
- **Primary persona:** who we optimize for first.

## 4. Use Cases / User Stories
Written as `As a <persona>, I want <goal>, so that <benefit>.` Group into
scenarios; order by importance.
- **Core scenarios** (the must-work paths): …
- **Secondary scenarios:** …
- (Optional) **Key user flow** for the top scenario: step 1 → 2 → 3 → outcome.

## 5. Features (MoSCoW)
| Feature | Priority | What it does | Ties to which pain point / use case |
|---|---|---|---|
| … | **Must** | … | … |
| … | Should | … | … |
| … | Could | … | … |
| … | Won't (now) | … | … |
- **MVP cut line:** the smallest set that delivers the core value.

## 6. Value Proposition & Differentiation
- **Value prop:** the payoff in the user's words.
- **Differentiators:** what makes this better/different from alternatives.

## 7. Success Metrics
- **North-star metric:** the one number that means it's working.
- **Supporting KPIs:** activation, retention, task-completion, time saved, etc.
  (each with a rough target where possible).

## 8. Competitive Landscape / Alternatives
| Alternative | Who uses it | Strength | Weakness / gap we exploit |
|---|---|---|---|
| Status quo / manual | … | … | … |
| <competitor> | … | … | … |

## 9. Assumptions & Risks
| Assumption or risk | Type | Impact | How we'd validate / mitigate |
|---|---|---|---|
| … | Assumption/Risk | H/M/L | … |

## 10. Technical & Data Considerations
- **Shape:** platform(s), rough architecture, key integrations.
- **Data & sensitivity:** what data it touches; privacy/security/compliance
  needs (for docsnx: tenant isolation, encryption of sensitive fields, AI
  privacy shield — reference AGENTS.md if relevant).
- **Effort / unknowns:** rough T-shirt size (S/M/L) and the riskiest tech bit.

## 11. Open Questions & Next Steps
- [ ] <question that must be answered before building>
- [ ] <next concrete action + owner>

## Changelog
- <YYYY-MM-DD>: Initial draft.
```

## Step 4 — Finish
- Save the file, then show the user a short summary: the one-liner, the MVP cut
  line, and the top 3 open questions.
- Offer next steps: iterate a section, expand into a full PRD, generate a
  build/task list, or **publish as an Artifact** (load the `artifact-design`
  skill first) for a shareable one-pager.

## Quality bar
- Specific over generic: name real personas and real competitors; no "users want
  a good experience" filler.
- Traceable: every Must-have feature maps to a pain point or use case.
- Honest: separate facts from _(assumptions)_; surface unknowns rather than
  papering over them.
- Concise: a reader should grasp the idea in under two minutes.
