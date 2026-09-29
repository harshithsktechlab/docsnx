-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  0061 — an add-on can be bought more than once                           ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- Add-ons were a checkbox: one row in `tenant_addons` meant one unit of
-- whatever the add-on grants. That is fine for "AI Features", which you either
-- have or do not, and useless for the thing the billing screen now sells —
-- three extra members and two extra companies, chosen from a dropdown.
--
-- ── WHY A COLUMN AND NOT N ROWS ────────────────────────────────────────────
-- Five seats could have been five rows, and `activeAddonSeats` would have
-- summed them with no change at all. A quantity is better for the two things
-- that come after the sale: the billing screen can say "Extra Member x5" rather
-- than listing the same line five times, and a refund or downgrade is one row
-- to edit rather than four to find and delete.
--
-- ── SAFE TO BACKFILL BY DEFAULT ────────────────────────────────────────────
-- Every existing row means exactly one unit, which is what `DEFAULT 1` says, so
-- there is no data migration and no window where a live entitlement reads as
-- zero. `activeAddonSeats` multiplies by this column and treats a NULL as 1
-- anyway, so an older build that has not been deployed yet keeps working
-- against the new column.

ALTER TABLE "tenant_addons"
  ADD COLUMN IF NOT EXISTS "quantity" integer DEFAULT 1 NOT NULL;--> statement-breakpoint

-- A quantity of zero is a row that should not exist, and a negative one would
-- SUBTRACT seats from an entitlement. The API clamps to 1..20; this is the
-- floor under it, so no hand-written UPDATE can quietly take seats away.
ALTER TABLE "tenant_addons"
  DROP CONSTRAINT IF EXISTS "tenant_addons_quantity_positive";--> statement-breakpoint

ALTER TABLE "tenant_addons"
  ADD CONSTRAINT "tenant_addons_quantity_positive" CHECK ("quantity" > 0);--> statement-breakpoint

-- ── Prove it ───────────────────────────────────────────────────────────────
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_name = 'tenant_addons' AND column_name = 'quantity';
  IF n <> 1 THEN RAISE EXCEPTION 'tenant_addons.quantity was not added'; END IF;

  SELECT count(*) INTO n FROM tenant_addons WHERE quantity IS NULL OR quantity < 1;
  IF n > 0 THEN RAISE EXCEPTION '% tenant_addons rows have no usable quantity', n; END IF;
END $$;

-- POST-CHECK:
--   SELECT quantity, count(*) FROM tenant_addons GROUP BY quantity;
--   -- expect every existing row at quantity 1
