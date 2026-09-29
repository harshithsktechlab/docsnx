-- Enable RLS and create isolation policy for each tenant-scoped table

ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "users" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "documents" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "documents" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "medical_records" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "medical_records" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "passwords" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "passwords" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "bank_infos" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "bank_infos" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "trading_demats" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "trading_demats" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "vehicles" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "vehicles" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "lic_mediclaims" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "lic_mediclaims" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "investments" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "investments" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "audit_logs" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "tenant_ai_usages" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "tenant_ai_usages" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "emergency_contacts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "emergency_contacts" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "warranty_amcs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "warranty_amcs" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "contract_agreements" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "contract_agreements" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "todos" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "todos" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "notifications" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "payments" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "payments" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "invoices" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "invoices" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "ai_analysis_cache" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "ai_analysis_cache" AS PERMISSIVE FOR ALL TO public USING (tenant_id = current_setting('app.tenant_id', true)::uuid);