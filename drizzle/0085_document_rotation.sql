-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  0085 — documents.rotation: the turn a member gave a scan in the viewer  ║
-- ╚══════════════════════════════════════════════════════════════════════════╝
--
-- A photographed or scanned document often arrives sideways. The viewer lets a
-- member turn it, and the turn is remembered here so the next open — theirs or
-- anyone else's — starts upright without turning it again.
--
-- Degrees clockwise, quarter turns only. One value for the whole document, not
-- per page. It is a DISPLAY preference: the stored (encrypted) bytes are never
-- touched, and print / share / download still serve the original orientation.
--
-- Additive and idempotent.
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "rotation" smallint NOT NULL DEFAULT 0;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'documents_rotation_check'
  ) THEN
    ALTER TABLE "documents"
      ADD CONSTRAINT "documents_rotation_check" CHECK ("rotation" IN (0, 90, 180, 270));
  END IF;
END $$;
