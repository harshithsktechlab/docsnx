-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  0100 — Client Documents: permission rows for EXISTING business members  ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- New members get `biz_client_individual` / `biz_client_company` from
-- DEFAULT_BUSINESS_PERMISSIONS. A member who existed before 0097 has no row, and
-- `hasPermission` denies when no row matches — so Client Documents stayed
-- admin-only until a tenant admin edited every member by hand.
--
-- Each such member gets, per flag, the union of the module-level grants they
-- already hold on the company modules (same rule as 0067): a Viewer gets view,
-- a Contributor gets view+add. Nobody ends up with more than they already had.
-- The tenant admin can change any of it under Users → Permissions, where
-- Client Documents is a single row that writes both client-type rows.
--
-- Only members with at least one business-module row are touched (personal
-- members cannot reach a company). Members who already have a client row keep
-- it: ON CONFLICT DO NOTHING, so re-running is a no-op.
INSERT INTO permissions (user_id, module, document_key,
                         can_view, can_add, can_edit, can_delete, can_share)
SELECT p.user_id, c.module, NULL,
       bool_or(p.can_view), bool_or(p.can_add), bool_or(p.can_edit),
       bool_or(p.can_delete), bool_or(p.can_share)
FROM permissions p
CROSS JOIN (VALUES ('biz_client_individual'), ('biz_client_company')) AS c(module)
WHERE p.module LIKE 'biz\_%'
  AND p.module NOT LIKE 'biz\_client\_%'
  AND p.document_key IS NULL
GROUP BY p.user_id, c.module
ON CONFLICT (user_id, module, (coalesce(document_key, ''))) DO NOTHING;
