-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  0070 — Wealth & Valuables folded into Bank & Investments                ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- 0069 gave lockers a module of their own, which put a bank locker in two
-- places: `wealth/bank_lockers` beside the long-standing
-- `bank_investments/bank_locker_agreement`. One place is enough. The locker
-- agreement IS the locker record now (its extra fields come from the
-- dictionary on the reseed `npm run migrate` runs next), and what is kept in a
-- locker is its sibling `bank_investments/locker_items`, one record per item.
--
-- Deleting category rows breaks the "retire, never delete" rule, and this is
-- the second sanctioned exception after 0055, on the same terms: the rows are
-- provably empty (guarded below), and leaving a dead module listed would
-- mislead. `wealth` existed for one day on dev only.
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n
    FROM documents d
    JOIN document_categories c ON c.id = d.category_id
   WHERE c.module_key = 'wealth';
  IF n > 0 THEN
    RAISE EXCEPTION '% documents are filed under the wealth module — refusing to delete it', n;
  END IF;

  SELECT count(*) INTO n FROM documents WHERE category_module_key = 'wealth';
  IF n > 0 THEN
    RAISE EXCEPTION '% documents carry the denormalised wealth category key', n;
  END IF;

  SELECT count(*) INTO n FROM vault_json_files WHERE category_module_key = 'wealth';
  IF n > 0 THEN
    RAISE EXCEPTION '% vault stores are keyed to the wealth module', n;
  END IF;
END $$;--> statement-breakpoint

-- Field specs and operator overrides go with their rows (ON DELETE CASCADE).
DELETE FROM "document_categories" WHERE "module_key" = 'wealth';--> statement-breakpoint

DELETE FROM "permissions" WHERE "module" = 'wealth';--> statement-breakpoint

-- Numbered 2011, after the ten bank rows (2001-2010). Additive; a module-level
-- `bank_investments` grant already covers it, so no permission copy is needed.
INSERT INTO "document_categories"
  ("module_no","module_key","module_name","document_key","document_name","sort_order","is_system","is_active")
SELECT v.module_no, v.module_key, v.module_name, v.document_key, v.document_name, v.sort_order, true, true
FROM (VALUES
  (2,'bank_investments','Bank & Investments','locker_items','Locker inventory — jewellery & valuables',2011)
) AS v(module_no, module_key, module_name, document_key, document_name, sort_order)
ON CONFLICT ("module_key","document_key") DO NOTHING;--> statement-breakpoint

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM document_categories WHERE module_key = 'wealth';
  IF n > 0 THEN RAISE EXCEPTION '% wealth categories survived the delete', n; END IF;
END $$;
