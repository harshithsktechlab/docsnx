-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  0088 — Search keyword tracking: one table instead of two                ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- 0087 added `search_events` (raw trail) and `search_keyword_documents`
-- (keyword -> document counts). One table is enough for what the log is for:
-- keyword -> document counts to turn into tags later.
--
-- `search_keywords` holds one row per (tenant, keyword, document):
--   · document_id set   — the keyword led to that document; hit_count = how many
--                         times it was opened from that keyword.
--   · document_id NULL  — the keyword found nothing; hit_count = how many times.
-- The latest search's details (query text, result count, best matching field,
-- who searched) are kept on the row as last_*; the per-search history is not.
--
-- Existing rows are carried over, then the two 0087 tables are dropped. They
-- hold only redacted search words, never record contents.
--
-- Idempotent. RLS is applied by scripts/apply-rls.js (search_keywords is in its
-- tenantScopedTables list), which `npm run migrate` runs after this file.
CREATE TABLE IF NOT EXISTS "search_keywords" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "keyword" varchar(100) NOT NULL,
  "document_id" uuid REFERENCES "documents"("id") ON DELETE CASCADE,
  "document_title" varchar(255),
  "category_key" varchar(200),
  "company_id" uuid REFERENCES "companies"("id") ON DELETE CASCADE,
  "hit_count" integer DEFAULT 1 NOT NULL,
  "last_query_text" varchar(200),
  "last_result_count" integer DEFAULT 0 NOT NULL,
  "last_matched_tier" varchar(16),
  "last_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "first_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- A NULL document_id never collides under a plain unique index, so the two kinds
-- of row get one partial unique index each.
CREATE UNIQUE INDEX IF NOT EXISTS "search_keywords_doc_uq"
  ON "search_keywords" ("tenant_id", "keyword", "document_id") WHERE "document_id" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "search_keywords_nodoc_uq"
  ON "search_keywords" ("tenant_id", "keyword") WHERE "document_id" IS NULL;
CREATE INDEX IF NOT EXISTS "search_keywords_keyword_idx" ON "search_keywords" ("tenant_id", "keyword");

DO $$
BEGIN
  IF to_regclass('public.search_keyword_documents') IS NOT NULL THEN
    INSERT INTO "search_keywords"
      ("tenant_id", "keyword", "document_id", "document_title", "category_key",
       "hit_count", "last_query_text", "first_at", "last_at")
    SELECT k."tenant_id", k."keyword", k."document_id", k."document_title", k."category_key",
           k."click_count", k."keyword", k."first_at", k."last_at"
      FROM "search_keyword_documents" k
    ON CONFLICT DO NOTHING;
  END IF;

  IF to_regclass('public.search_events') IS NOT NULL THEN
    INSERT INTO "search_keywords"
      ("tenant_id", "keyword", "document_id", "hit_count", "last_query_text",
       "last_result_count", "last_user_id", "first_at", "last_at")
    SELECT e."tenant_id", t."term", NULL, count(*)::int, (array_agg(e."query_text" ORDER BY e."created_at" DESC))[1],
           0, (array_agg(e."user_id" ORDER BY e."created_at" DESC))[1], min(e."created_at"), max(e."created_at")
      FROM "search_events" e
      CROSS JOIN LATERAL unnest(e."terms") AS t("term")
     WHERE e."outcome" = 'no_result'
     GROUP BY e."tenant_id", t."term"
    ON CONFLICT DO NOTHING;
  END IF;
END $$;

DROP TABLE IF EXISTS "search_keyword_documents";
DROP TABLE IF EXISTS "search_events";
