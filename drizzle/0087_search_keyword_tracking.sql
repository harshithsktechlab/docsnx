-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  0087 — Search keyword tracking                                          ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- Records what people search for and which document they then opened, so the
-- keywords that really lead to a document can later be promoted to tags that
-- speed search up.
--
--   search_events             one row per search that ENDED — a result was
--                             opened ('clicked') or the box was closed on a query
--                             that found nothing ('no_result'). Never one row per
--                             keystroke. `query_text` and `terms` are REDACTED
--                             before they get here (src/lib/search/trackingTerms.ts):
--                             long digit runs, PAN-shaped words and exact
--                             identifier lookups are never stored.
--   search_keyword_documents  the aggregate: keyword -> document, with how many
--                             times that keyword led to that document. This is
--                             the future tag source. `document_title` is a
--                             snapshot of the plaintext title, so the history
--                             still reads once a document is renamed.
--
-- Cascades match audit_logs: erasing a tenant, a company, a person or a
-- document takes its search rows with it.
--
-- Idempotent. RLS is applied by scripts/apply-rls.js (both tables are in its
-- tenantScopedTables list), which `npm run migrate` runs after this file.
-- Retention of search_events (180 days): scripts/purge_search_events.ts.
CREATE TABLE IF NOT EXISTS "search_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "user_id" uuid REFERENCES "users"("id") ON DELETE CASCADE,
  "company_id" uuid REFERENCES "companies"("id") ON DELETE CASCADE,
  "query_text" varchar(200) NOT NULL,
  "terms" text[] DEFAULT '{}'::text[] NOT NULL,
  "result_count" integer DEFAULT 0 NOT NULL,
  "outcome" varchar(16) NOT NULL,
  "matched_tier" varchar(16),
  "document_id" uuid REFERENCES "documents"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "search_events_outcome_chk" CHECK ("outcome" IN ('clicked', 'no_result'))
);
CREATE INDEX IF NOT EXISTS "search_events_tenant_created_idx" ON "search_events" ("tenant_id", "created_at");

CREATE TABLE IF NOT EXISTS "search_keyword_documents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "keyword" varchar(100) NOT NULL,
  "document_id" uuid NOT NULL REFERENCES "documents"("id") ON DELETE CASCADE,
  "document_title" varchar(255) NOT NULL,
  "category_key" varchar(200),
  "click_count" integer DEFAULT 1 NOT NULL,
  "first_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "search_keyword_documents_uq"
  ON "search_keyword_documents" ("tenant_id", "keyword", "document_id");
CREATE INDEX IF NOT EXISTS "search_keyword_documents_keyword_idx"
  ON "search_keyword_documents" ("tenant_id", "keyword");
