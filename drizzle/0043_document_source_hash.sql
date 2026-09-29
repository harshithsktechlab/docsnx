-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  0043 — documents.source_hash: the file-identity arm of the dup check    ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- The duplicate check had three arms (src/lib/records/duplicateMatch.ts): a
-- declared identifier matched through the blind index, then the same title, then
-- the same filename. The last two are scoped to ONE sub-category, so the same
-- document re-uploaded under a different filename — or filed under a different
-- sub-category — was caught only when its number had been read off the page.
-- A scan that misread the number, or a category with no identifier at all, went
-- straight through and the tenant kept two copies.
--
-- `source_hash` is sha256 of the bytes the user handed us, hashed BEFORE any
-- page splitting. It is deliberately not `content_hash`, which is the hash of
-- the primary page AFTER splitting and so is only known once the Drive objects
-- have been written — too late for a check whose job is to refuse the write.
--
-- ── WHAT THIS DOES NOT DO ──────────────────────────────────────────────────
-- It does not backfill. The plaintext of an existing record lives sealed on the
-- tenant's Drive, one object per page, and re-deriving the original upload from
-- those is not possible. Existing rows stay NULL, never match, and take a hash
-- the next time they are written. The other three arms cover them meanwhile.
--
-- Additive: one nullable column and one partial index. Nothing is rewritten.

ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "source_hash" varchar(64);
--> statement-breakpoint

-- Partial on both counts: a soft-deleted row is never offered as a duplicate
-- (the user cannot see it, so being blocked by it is inexplicable), and a
-- file-less record — a bank account, an investment — has no bytes to hash.
CREATE INDEX IF NOT EXISTS "documents_tenant_source_hash_idx"
  ON "documents" ("tenant_id", "source_hash")
  WHERE "deleted_at" IS NULL AND "source_hash" IS NOT NULL;
