-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  0047 — vehicle/insurance_cross_ref becomes a MIRROR, not a bucket       ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- A vehicle insurance policy is genuinely two things: an insurance policy and a
-- vehicle paper. The taxonomy tried to say so with a placeholder category named
-- "Vehicle insurance — see Insurance module".
--
-- A placeholder in this table is not a signpost. It is a real category, with a
-- Drive folder, an encryption policy, a field spec and a slot in the AI
-- classifier's list — so motor policies split between it and
-- `insurance/vehicle_policies` depending on which door the user came through,
-- and neither module ever showed the whole set.
--
-- src/lib/categoryMirrors.ts now declares the pair as a MIRROR: the records are
-- stored once, under `insurance/vehicle_policies`, and the Vehicle module lists
-- them through this row. Nothing is ever filed under it again — every write path
-- canonicalises through `resolveCategory`, and every read through
-- `withCategory`.
--
-- ── WHY THE ROW STAYS, AND STAYS ACTIVE ────────────────────────────────────
-- It IS the Vehicle module's tile. Retiring it (is_active = false) would remove
-- the tile, which is the feature. Deleting it is forbidden outright:
-- documents.category_id is ON DELETE RESTRICT, and until the backfill named
-- below has run there are rows pointing at it.
--
-- ── THIS MIGRATION IS DISPLAY-ONLY ─────────────────────────────────────────
-- The (module_key, document_key) pair is NOT touched. It names the Drive folder
-- the ciphertext lives in and is bound into that ciphertext's AAD, so renaming
-- either half orphans data AND makes it undecryptable — see the NEVER list in
-- src/lib/documentCategories.ts. Only `document_name` changes, which is
-- display-only and safe to edit, and the same string is in the TS constant so
-- tests/documentCategories.test.ts keeps the two in step.
--
-- ── THE RECORDS ALREADY FILED THERE ARE NOT MOVED HERE ─────────────────────
-- Deliberately. A record's body is sealed on Drive under
-- `Documents/vehicle/insurance_cross_ref/` with that category bound into its
-- AAD, and its entry lives in that category's own JSON store. An UPDATE of the
-- three category columns would re-point the row while leaving the ciphertext
-- unreadable and the store entry stranded — recoverable only by hand.
--
-- Moving them means reading each record through the vault, re-sealing it under
-- the canonical category and rewriting both stores. That is a program, not a
-- statement: run `npx tsx scripts/refile_mirrored_categories.ts --yes` after
-- deploying. Until it runs those records are reachable by id but list nowhere,
-- which is visible and reversible; a half-moved record is neither.

UPDATE document_categories
SET document_name = 'Vehicle insurance',
    updated_at = now()
WHERE module_key = 'vehicle'
  AND document_key = 'insurance_cross_ref';
