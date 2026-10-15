-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  0065 — Travel & Tickets (personal 14) and Travel & Expenses (biz 115)   ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- Neither taxonomy had anywhere to file a ticket. A flight e-ticket uploaded to
-- a household was filed under rentals_subscriptions/subscription_receipts: the
-- classifier was told every readable document has a closest entry, and the
-- closest it could find to a booking that printed a convenience fee and a
-- card-offer banner was a subscription receipt.
--
-- Module number 14 has been free since 0023 numbered the personal modules 1-13
-- and the catch-all 15. Business modules end at 114, so the new one is 115.
--
-- Additive only: no existing (module_key, document_key) pair is touched, so no
-- Drive folder or AAD binding moves. The TS constant in
-- src/lib/documentCategories.ts carries the same rows and
-- tests/documentCategories.test.ts diffs the two.
--
-- ON CONFLICT DO NOTHING, same as 0050: re-running this or the seed script is a
-- no-op.
INSERT INTO "document_categories"
  ("module_no","module_key","module_name","document_key","document_name","sort_order","is_system","is_active")
SELECT v.module_no, v.module_key, v.module_name, v.document_key, v.document_name, v.sort_order, true, true
FROM (VALUES
  -- Travel & Tickets (personal)
  (14,'travel','Travel & Tickets','flight_tickets','Flight tickets / e-tickets',14001),
  (14,'travel','Travel & Tickets','train_tickets','Train tickets (IRCTC etc.)',14002),
  (14,'travel','Travel & Tickets','bus_tickets','Bus tickets',14003),
  (14,'travel','Travel & Tickets','hotel_bookings','Hotel / stay booking confirmations',14004),
  (14,'travel','Travel & Tickets','cab_car_rentals','Cab / self-drive car rental bookings',14005),
  (14,'travel','Travel & Tickets','event_tickets','Event, movie & other tickets',14006),
  -- Travel & Expenses (business)
  (115,'biz_travel','Travel & Expenses','flight_tickets','Flight tickets / e-tickets',115001),
  (115,'biz_travel','Travel & Expenses','train_tickets','Train tickets',115002),
  (115,'biz_travel','Travel & Expenses','bus_tickets','Bus tickets',115003),
  (115,'biz_travel','Travel & Expenses','hotel_bookings','Hotel / stay booking confirmations',115004),
  (115,'biz_travel','Travel & Expenses','cab_car_rentals','Cab / car rental bookings',115005),
  (115,'biz_travel','Travel & Expenses','travel_expense_claims','Travel expense claims / reimbursements',115006)
) AS v(module_no, module_key, module_name, document_key, document_name, sort_order)
ON CONFLICT ("module_key","document_key") DO NOTHING;--> statement-breakpoint

-- ── EXISTING MEMBERS ───────────────────────────────────────────────────────
-- A new member's default grant is built from the module list
-- (DEFAULT_PERSONAL_PERMISSIONS / DEFAULT_BUSINESS_PERMISSIONS in
-- src/lib/moduleRegistry.js), so they get these modules automatically. An
-- EXISTING STANDARD member has no row for them, and `hasPermission` denies a
-- module with no row — so without this, every ticket filed here would be
-- invisible to everyone but the tenant admin.
--
-- Each member inherits the module-level grant they already hold on a sibling:
--   travel     ← `other`, the household catch-all where unplaced documents —
--                tickets included, until now — have always been filed;
--   biz_travel ← `biz_operations`, the business module nearest in kind.
-- Module-level only (document_key NULL); a tenant admin narrows it on the
-- member's permissions screen like any other. ON CONFLICT DO NOTHING against
-- permissions_user_module_doc_idx, so a re-run never overwrites an edit.
INSERT INTO permissions (user_id, module, document_key,
                         can_view, can_add, can_edit, can_delete, can_share)
SELECT p.user_id, m.new_module, NULL,
       p.can_view, p.can_add, p.can_edit, p.can_delete, p.can_share
FROM permissions p
JOIN (VALUES ('other', 'travel'), ('biz_operations', 'biz_travel'))
  AS m(source_module, new_module) ON p.module = m.source_module
WHERE p.document_key IS NULL
ON CONFLICT (user_id, module, (coalesce(document_key, ''))) DO NOTHING;
