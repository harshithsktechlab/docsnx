-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  0083 — `ai_analysis`: who may refresh / generate an AI analysis          ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- Refreshing an analysis is a billed model call against the workspace's shared
-- credits, so it is now a permission the tenant admin sets per member — a flat
-- row in the matrix, where `can_add` is the grant (src/lib/moduleRegistry.js →
-- ACCOUNT_FEATURE_KEYS). New members get it from the Contributor defaults.
--
-- ── EXISTING MEMBERS ───────────────────────────────────────────────────────
-- Same reasoning as 0065 and 0069: an existing standard member has no row for
-- a new key and `hasPermission` denies it. Every one of them could refresh
-- before this migration, so each is granted the Contributor rung — nobody
-- loses the button on deploy; the admin takes it away where they want to.
-- TENANT_ADMIN needs no row: `hasPermission` short-circuits for them.
INSERT INTO permissions (user_id, module, document_key,
                         can_view, can_add, can_edit, can_delete, can_share)
SELECT u.id, 'ai_analysis', NULL, true, true, false, false, false
FROM users u
WHERE u.role = 'STANDARD'
ON CONFLICT (user_id, module, (coalesce(document_key, ''))) DO NOTHING;
