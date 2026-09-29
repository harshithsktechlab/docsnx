-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  0020 — holder becomes a first-class field                               ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- Two changes, both cheap and both forward-only.
--
-- 1. An index for holder filtering. `listRecords` filters by holder in memory
--    after fetching the module's rows, which is fine at family scale, but the
--    documents list has offered a holder filter since long before consolidation
--    and there has never been an index behind it.
--
-- 2. Align `is_global` with the one-control model. A record with no holder now
--    means "the whole family"; `is_global` is derived from that rather than
--    being a second checkbox that could disagree with it.
--
--    This is SAFE to run as a blanket update because nothing reads the column:
--    it is written by the vault record builder and by the pointer row, and no
--    query, filter or permission check anywhere consults it. Verified before
--    writing this migration. Should it ever become load-bearing, it will do so
--    on data that is already self-consistent.

CREATE INDEX IF NOT EXISTS documents_tenant_holder_idx
  ON documents (tenant_id, holder_id)
  WHERE deleted_at IS NULL;--> statement-breakpoint

UPDATE documents SET is_global = true WHERE holder_id IS NULL AND is_global = false;--> statement-breakpoint

-- A holder must always be a user; the FK already guarantees that, and ON DELETE
-- SET NULL means a removed member turns their records into family-wide ones
-- rather than orphaning them. Nothing to add.
