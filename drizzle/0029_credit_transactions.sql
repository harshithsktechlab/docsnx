-- ═══════════════════════════════════════════════════════════════════════════
--  0029 — credit_transactions: the history behind tenants.ai_credits_balance.
--
--  Until now nothing recorded a credit movement. The single spend path deducted
--  with a bare `UPDATE tenants SET ai_credits_balance = ...` and wrote nothing
--  else, and three of the six grant paths bypassed the audited helpers in
--  src/lib/planProvisioning.ts entirely. A tenant could see the balance and had
--  no way to learn how it got there.
--
--  `tenant_ai_usages` is NOT this table and could not be backfilled into it: it
--  stores prompt tokens and a USD estimate rather than credits, carries no
--  action name, and logs calls made on a tenant's OWN api key, which cost zero
--  credits. So this ledger starts empty and the UI says so — see the
--  "history starts <date>" note on /billing/credits.
--
--  PURELY ADDITIVE — one new table. Nothing is dropped, renamed or backfilled.
--
--  ── THREE THINGS THAT LOOK MISSING AND ARE NOT ────────────────────────────
--  1. NO updated_at and NO deleted_at. The ledger is append-only for the same
--     reason audit_logs is: a row that can be edited or soft-deleted is not a
--     ledger. A correction is a new compensating row, not a mutation.
--
--  2. `balance_after` duplicates state that could be re-derived by summing.
--     Deliberate. It is captured from the same `UPDATE ... RETURNING` that
--     moved the balance, so rendering one page never has to sum the whole
--     history — and a row whose balance_after disagrees with the running total
--     is direct evidence of a write that bypassed the planProvisioning helpers.
--
--  3. `user_id` is ON DELETE SET NULL, not CASCADE. Removing a member must not
--     erase the record of credits they spent; the row survives, unattributed.
--     NULL is also the normal value for webhook, cron and system movements.
--
--  ROW LEVEL SECURITY: this table carries a tenant_id and IS registered in
--  scripts/apply-rls.js. Run that script after migrating.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "credit_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid,
	"amount" integer NOT NULL,
	"balance_after" integer NOT NULL,
	"reason" varchar(64) NOT NULL,
	"description" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_tenant_id_tenants_id_fk"
   FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_user_id_users_id_fk"
   FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_transactions_tenant_created_idx"
  ON "credit_transactions" USING btree ("tenant_id","created_at");
