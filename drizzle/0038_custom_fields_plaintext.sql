-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  0038 — custom_fields becomes plain text on every category               ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- Reverses the second half of 0025, which appended `custom_fields` to every
-- category's encrypt list and raised if any row omitted it.
--
-- ── WHY, GIVEN 0025 ARGUED THE OPPOSITE ────────────────────────────────────
-- 0025's reasoning was that a field nobody declared is the likeliest place for
-- an account number someone had nowhere else to put. That was overruled
-- deliberately by the platform owner: the taxonomy now covers the fields that
-- matter with their own per-field classification, and `custom_fields` is the
-- free-text remainder — wanted readable in lists, exports and AI analysis.
--
-- The trade was accepted knowingly and is worth stating plainly: whatever a
-- user types into "Additional Details" is now stored in the clear and reaches
-- the model, with only maskSensitiveText's regex pass (PAN, Aadhaar and
-- account-number shapes) over it. `notes` is unaffected and stays sealed.
--
-- ── EXISTING RECORDS ARE NOT REWRITTEN ─────────────────────────────────────
-- A record's values were split into open and sealed tiers when it was WRITTEN,
-- so rows saved before this keep their custom_fields ciphertext and stay
-- readable through the audited reveal path. Only records saved from now on
-- store it openly. Nothing is decrypted here, and nothing needs to be.
--
-- ── THE CODE FLOOR MATTERS MORE THAN THIS MIGRATION ────────────────────────
-- BASELINE_OPEN_KEYS in src/lib/documentCategoryFields.ts, applied by
-- withBaseline() in src/lib/vault/fieldSplitter.ts, strips the key whatever a
-- stored policy says. That is what makes the behaviour uniform even on a
-- database where this migration ran but the seed script did not — or a tenant
-- whose category row was written before either. This statement keeps the stored
-- lists honest; the floor is what guarantees the behaviour.
--
-- Idempotent: re-running finds nothing left to strip.

UPDATE "document_category_fields"
   SET "encrypted_fields" = coalesce(nullif(array_to_string(
         ARRAY(
           SELECT btrim(k)
             FROM unnest(string_to_array("encrypted_fields", ',')) AS k
            WHERE btrim(k) <> ''
              AND btrim(k) <> 'custom_fields'
         ), ','), ''), ''),
       "updated_at" = now()
 WHERE 'custom_fields' = ANY (
         SELECT btrim(k) FROM unnest(string_to_array(coalesce("encrypted_fields", ''), ',')) AS k
       );
--> statement-breakpoint

DO $$
DECLARE still int; unsealed int;
BEGIN
  SELECT count(*) INTO still
    FROM "document_category_fields" f,
         unnest(string_to_array(f."encrypted_fields", ',')) AS k
   WHERE btrim(k) = 'custom_fields';
  IF still > 0 THEN
    RAISE EXCEPTION '% row(s) still seal custom_fields', still;
  END IF;

  -- The floor this migration is NOT allowed to take down with it. `notes` is
  -- the other free-text baseline key and stays sealed everywhere; a stripping
  -- statement broad enough to catch it would be a silent, tenant-wide leak.
  SELECT count(*) INTO unsealed
    FROM "document_category_fields" f
   WHERE 'notes' <> ALL (
           SELECT btrim(k) FROM unnest(string_to_array(coalesce(f."encrypted_fields", ''), ',')) AS k
         );
  IF unsealed > 0 THEN
    RAISE EXCEPTION '% row(s) stopped sealing notes — the strip was too broad', unsealed;
  END IF;
END $$;
