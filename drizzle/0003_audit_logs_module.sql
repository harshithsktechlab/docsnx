ALTER TABLE "audit_logs" ADD COLUMN "entity_type" varchar(100);--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "entity_id" uuid;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "user_agent" varchar(500);--> statement-breakpoint
CREATE INDEX "audit_logs_tenant_created_idx" ON "audit_logs" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_tenant_action_idx" ON "audit_logs" USING btree ("tenant_id","action");--> statement-breakpoint
CREATE INDEX "audit_logs_tenant_entity_idx" ON "audit_logs" USING btree ("tenant_id","entity_type","entity_id");