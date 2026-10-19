-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  0077 — ₹0 MANUAL payments for plans granted by a super admin            ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- Admin → Tenants → "Change Plan" (/api/admin/tenants/[id]/upgrade) applied the
-- plan and its AI credits and wrote an audit row, but no `payments` row — so
-- the Payments page listed only the workspaces that went through checkout. The
-- route now inserts a ₹0 MANUAL payment with every grant; this backfills one
-- for each grant made before that, from the audit trail.
--
-- Data only, additive. Idempotent: each backfilled row's payment_ref names the
-- audit row it came from (`audit:<id>`), and a grant that already has one is
-- skipped, so re-running inserts nothing.
--
-- The plan is matched by the name quoted in the audit sentence
-- ('Granted plan "Personal" — …'); a plan since deleted leaves plan_id NULL and
-- the row still records the grant. No credits are touched — they were granted
-- at the time and are already in credit_transactions.
INSERT INTO "payments"
  ("tenant_id", "plan_id", "applies_to", "plans_purchased", "amount", "currency", "status",
   "payment_method", "payment_ref", "initiated_by", "created_at", "updated_at")
SELECT
  a.tenant_id,
  p.id,
  p.applies_to,
  CASE WHEN p.id IS NULL THEN NULL
       ELSE jsonb_build_array(jsonb_build_object('planId', p.id, 'appliesTo', p.applies_to, 'billingCycle', NULL, 'amount', 0))
  END,
  0,
  'INR',
  'captured',
  'MANUAL',
  left('Plan granted by admin (audit:' || a.id::text || '): '
       || COALESCE(substring(a.details from 'Granted plan "([^"]+)"'), 'plan'), 255),
  left(COALESCE(u.email, 'migration 0077'), 50),
  a.created_at,
  a.created_at
FROM "audit_logs" a
JOIN "tenants" t ON t.id = a.tenant_id
LEFT JOIN "users" u ON u.id = a.user_id
LEFT JOIN LATERAL (
  SELECT sp.id, sp.applies_to FROM "subscription_plans" sp
  WHERE sp.name = substring(a.details from 'Granted plan "([^"]+)"')
  ORDER BY sp.created_at
  LIMIT 1
) p ON TRUE
WHERE a.action = 'tenant.manual_upgrade'
  AND NOT EXISTS (
    SELECT 1 FROM "payments" x
    WHERE x.tenant_id = a.tenant_id
      AND x.payment_ref LIKE '%audit:' || a.id::text || '%'
  );
