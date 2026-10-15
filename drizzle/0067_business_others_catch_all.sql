-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  0067 — Others (biz 116): the company workspace's catch-all              ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- A household has `other/uncategorized`, where a document the classifier could
-- not place is filed for the member to re-file. A company had nothing: `other`
-- is a personal module and the write gate refuses it with a company id, so an
-- unplaced company document came back with no category and a blank picker.
--
-- `biz_other/uncategorized` is that catch-all for the business taxonomy.
-- Business modules end at 115, so it is 116.
--
-- Additive only, ON CONFLICT DO NOTHING like 0050 and 0065: re-running this or
-- the seed script is a no-op. The TS constant in src/lib/documentCategories.ts
-- carries the same row and tests/documentCategories.test.ts diffs the two.
INSERT INTO "document_categories"
  ("module_no","module_key","module_name","document_key","document_name","sort_order","is_system","is_active")
SELECT v.module_no, v.module_key, v.module_name, v.document_key, v.document_name, v.sort_order, true, true
FROM (VALUES
  (116,'biz_other','Others','uncategorized','Others',116001)
) AS v(module_no, module_key, module_name, document_key, document_name, sort_order)
ON CONFLICT ("module_key","document_key") DO NOTHING;--> statement-breakpoint

-- ── EXISTING MEMBERS ───────────────────────────────────────────────────────
-- New members get it from DEFAULT_BUSINESS_PERMISSIONS. An existing member with
-- no row would be denied by `hasPermission`, so every document filed here would
-- be invisible to all but the tenant admin. Each member gets, per flag, the
-- union of the module-level grants they hold on any business module — anyone
-- who can file a company document anywhere can file it under Others.
INSERT INTO permissions (user_id, module, document_key,
                         can_view, can_add, can_edit, can_delete, can_share)
SELECT p.user_id, 'biz_other', NULL,
       bool_or(p.can_view), bool_or(p.can_add), bool_or(p.can_edit),
       bool_or(p.can_delete), bool_or(p.can_share)
FROM permissions p
WHERE p.module LIKE 'biz\_%' AND p.module <> 'biz_other' AND p.document_key IS NULL
GROUP BY p.user_id
ON CONFLICT (user_id, module, (coalesce(document_key, ''))) DO NOTHING;
