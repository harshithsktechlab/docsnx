-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  0021 — deletion is a status, not just a timestamp                       ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- No schema change: `documents.status` and `documents.deleted_at` both already
-- exist. What was missing is that deletion only ever wrote `deleted_at`, so
-- every row deleted before today still reads `status = 'active'` — a row the
-- product now says a user must never see, sitting there labelled visible.
--
-- Two forward-only backfills bring that history in line with what the code
-- writes from here on (see src/lib/records/documentVisibility.ts):
--
-- 1. Label the tombstones. Reads filter on BOTH `deleted_at` and `status`, so
--    leaving these at 'active' would make the two predicates disagree on
--    exactly the rows where it matters.
--
-- 2. Clear their URL. `file_path` IS the document's URL — the route the client
--    fetches bytes through. A deleted document must not carry one.
--
-- Deliberately NOT touched: `file_drive_id`, `content_hash` and the Drive
-- objects themselves. The bytes stay recoverable, which is what lets a
-- re-upload revive the row rather than mint a second one.

UPDATE documents
   SET status = 'deleted',
       file_path = NULL
 WHERE deleted_at IS NOT NULL
   AND status <> 'deleted';--> statement-breakpoint

-- The inverse skew: a row marked deleted but never stamped. None are expected —
-- nothing has written 'deleted' to this column until now — but the two columns
-- are read together and a row that satisfies one and not the other would be
-- invisible to lists yet still countable, which is the confusing half-state
-- this migration exists to remove.
UPDATE documents
   SET deleted_at = updated_at,
       file_path = NULL
 WHERE status = 'deleted'
   AND deleted_at IS NULL;--> statement-breakpoint

-- Serves the revival lookup: given a category and a title/filename, find this
-- tenant's most recently deleted matching row. Partial, so it indexes only the
-- tombstones — a small fraction of the table.
CREATE INDEX IF NOT EXISTS documents_tenant_deleted_category_idx
  ON documents (tenant_id, category_id, deleted_at DESC)
  WHERE status = 'deleted';
