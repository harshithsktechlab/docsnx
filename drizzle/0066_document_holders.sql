-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  0066 — A record can belong to several members                           ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- `documents.holder_id` holds ONE member, or NULL with is_global for "All
-- members". A marriage certificate belongs to two people and a family health
-- policy to three of five, and neither fits either shape.
--
-- This table is the full set. `documents.holder_id` stays as the PRIMARY holder
-- (the first one picked) so every reader of it — profile ID cards, follow-ups,
-- summaries, the Drive vault copy — keeps working untouched. Invariant:
--   is_global            => no rows here, holder_id NULL
--   otherwise            => one row per member, holder_id = one of them
--
-- Additive and idempotent: the backfill copies each existing holder_id in.
CREATE TABLE IF NOT EXISTS "document_holders" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  -- Deliberately NO foreign key onto documents.id: documents must stay
  -- partitionable (tests/partitionReadiness.test.ts), the same reason
  -- audit_logs.entity_id has none. Every read reaches these rows through a
  -- visible documents row, so a leftover one is never shown.
  "document_id" uuid NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "document_holders_pk" PRIMARY KEY ("document_id", "user_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_holders_tenant_user_idx"
  ON "document_holders" ("tenant_id", "user_id");
--> statement-breakpoint
INSERT INTO "document_holders" ("tenant_id", "document_id", "user_id")
SELECT "tenant_id", "id", "holder_id" FROM "documents" WHERE "holder_id" IS NOT NULL
ON CONFLICT DO NOTHING;
