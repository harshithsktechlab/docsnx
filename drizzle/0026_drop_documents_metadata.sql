-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  0026 — documents.metadata goes; Drive is the only source                ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- A document's fields live in the tenant's encrypted store on Drive
-- (JSON/Documents/documents__<module>__<sub>.enc.json), where each record entry
-- carries `open`, `masked`, `sealed`, `searchHashes` and `reminders`.
--
-- `documents.metadata` held a COPY of the first two, so a list could render
-- without a Drive round trip. Two things were wrong with keeping it:
--
--   1. The Documents page read ONLY that copy — alone among the fifteen
--      modules, it never opened Drive at all — so the product's rule that all
--      user data renders from the tenant's own Drive was true everywhere except
--      the page most about documents.
--
--   2. A copy drifts. A bulk-scanned record whose fields were never renamed to
--      taxonomy keys wrote its whole extracted blob into this column, putting a
--      plaintext Aadhaar number, date of birth and address into Postgres in the
--      clear — values the category's policy seals precisely so they cannot be
--      here. See src/lib/records/scanRecordBody.ts.
--
-- Reads now go through `loadRecords` (src/lib/records/handler.ts), one store
-- read per DISTINCT sub-category on the page, served from `storeCache` for 30
-- minutes and revalidated against `vault_json_files.revision` rather than a TTL
-- guess.
--
-- ── IRREVERSIBLE, AND GATED ────────────────────────────────────────────────
-- Rows written before the vault existed kept their `document_number` encrypted
-- in this column and NOWHERE else; `fromLegacy` in docMetadata.ts used to
-- translate them on read. Dropping the column destroys those values.
--
-- The guard below is that check, in the migration rather than in a runbook, so
-- this cannot be applied to a database nobody surveyed. It fails the migration
-- — leaving the column and its data intact — if a single legacy-shaped row is
-- present. Resolve by pushing those rows into their category store with
-- `updateVaultRecordBody` (src/lib/vault/vaultStore.ts) and re-running.
--
-- Take a backup of `documents` before applying. There is no down migration.

DO $$
DECLARE
  legacy_rows bigint;
BEGIN
  SELECT count(*) INTO legacy_rows
    FROM documents
   WHERE metadata IS NOT NULL
     AND NOT (metadata ? 'open');

  IF legacy_rows > 0 THEN
    RAISE EXCEPTION
      'Refusing to drop documents.metadata: % row(s) still hold pre-vault (legacy) metadata whose document_number exists nowhere else. Migrate them into their Drive store first — see scripts/check_metadata_census.mjs.',
      legacy_rows;
  END IF;
END $$;--> statement-breakpoint

ALTER TABLE "documents" DROP COLUMN IF EXISTS "metadata";
