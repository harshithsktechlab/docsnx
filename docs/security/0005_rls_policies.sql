-- Enable RLS and create isolation policy for all tenant-scoped tables

-- users
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
DO $$ BEGIN CREATE POLICY tenant_isolation ON users USING (tenant_id = current_setting('app.tenant_id')::uuid); EXCEPTION WHEN duplicate_object THEN null; END $$;

-- documents
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents FORCE ROW LEVEL SECURITY;
DO $$ BEGIN CREATE POLICY tenant_isolation ON documents USING (tenant_id = current_setting('app.tenant_id')::uuid); EXCEPTION WHEN duplicate_object THEN null; END $$;

-- medical_records
ALTER TABLE medical_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE medical_records FORCE ROW LEVEL SECURITY;
DO $$ BEGIN CREATE POLICY tenant_isolation ON medical_records USING (tenant_id = current_setting('app.tenant_id')::uuid); EXCEPTION WHEN duplicate_object THEN null; END $$;

-- passwords
ALTER TABLE passwords ENABLE ROW LEVEL SECURITY;
ALTER TABLE passwords FORCE ROW LEVEL SECURITY;
DO $$ BEGIN CREATE POLICY tenant_isolation ON passwords USING (tenant_id = current_setting('app.tenant_id')::uuid); EXCEPTION WHEN duplicate_object THEN null; END $$;

-- bank_infos
ALTER TABLE bank_infos ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_infos FORCE ROW LEVEL SECURITY;
DO $$ BEGIN CREATE POLICY tenant_isolation ON bank_infos USING (tenant_id = current_setting('app.tenant_id')::uuid); EXCEPTION WHEN duplicate_object THEN null; END $$;

-- credit_cards
ALTER TABLE credit_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_cards FORCE ROW LEVEL SECURITY;
DO $$ BEGIN CREATE POLICY tenant_isolation ON credit_cards USING (tenant_id = current_setting('app.tenant_id')::uuid); EXCEPTION WHEN duplicate_object THEN null; END $$;

-- trading_demats
ALTER TABLE trading_demats ENABLE ROW LEVEL SECURITY;
ALTER TABLE trading_demats FORCE ROW LEVEL SECURITY;
DO $$ BEGIN CREATE POLICY tenant_isolation ON trading_demats USING (tenant_id = current_setting('app.tenant_id')::uuid); EXCEPTION WHEN duplicate_object THEN null; END $$;

-- vehicles
ALTER TABLE vehicles ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehicles FORCE ROW LEVEL SECURITY;
DO $$ BEGIN CREATE POLICY tenant_isolation ON vehicles USING (tenant_id = current_setting('app.tenant_id')::uuid); EXCEPTION WHEN duplicate_object THEN null; END $$;

-- lic_mediclaims
ALTER TABLE lic_mediclaims ENABLE ROW LEVEL SECURITY;
ALTER TABLE lic_mediclaims FORCE ROW LEVEL SECURITY;
DO $$ BEGIN CREATE POLICY tenant_isolation ON lic_mediclaims USING (tenant_id = current_setting('app.tenant_id')::uuid); EXCEPTION WHEN duplicate_object THEN null; END $$;

-- investments
ALTER TABLE investments ENABLE ROW LEVEL SECURITY;
ALTER TABLE investments FORCE ROW LEVEL SECURITY;
DO $$ BEGIN CREATE POLICY tenant_isolation ON investments USING (tenant_id = current_setting('app.tenant_id')::uuid); EXCEPTION WHEN duplicate_object THEN null; END $$;

-- audit_logs
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
DO $$ BEGIN CREATE POLICY tenant_isolation ON audit_logs USING (tenant_id = current_setting('app.tenant_id')::uuid); EXCEPTION WHEN duplicate_object THEN null; END $$;

-- tenant_ai_usages
ALTER TABLE tenant_ai_usages ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_ai_usages FORCE ROW LEVEL SECURITY;
DO $$ BEGIN CREATE POLICY tenant_isolation ON tenant_ai_usages USING (tenant_id = current_setting('app.tenant_id')::uuid); EXCEPTION WHEN duplicate_object THEN null; END $$;

-- emergency_contacts
ALTER TABLE emergency_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE emergency_contacts FORCE ROW LEVEL SECURITY;
DO $$ BEGIN CREATE POLICY tenant_isolation ON emergency_contacts USING (tenant_id = current_setting('app.tenant_id')::uuid); EXCEPTION WHEN duplicate_object THEN null; END $$;

-- warranty_amcs
ALTER TABLE warranty_amcs ENABLE ROW LEVEL SECURITY;
ALTER TABLE warranty_amcs FORCE ROW LEVEL SECURITY;
DO $$ BEGIN CREATE POLICY tenant_isolation ON warranty_amcs USING (tenant_id = current_setting('app.tenant_id')::uuid); EXCEPTION WHEN duplicate_object THEN null; END $$;

-- contract_agreements
ALTER TABLE contract_agreements ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_agreements FORCE ROW LEVEL SECURITY;
DO $$ BEGIN CREATE POLICY tenant_isolation ON contract_agreements USING (tenant_id = current_setting('app.tenant_id')::uuid); EXCEPTION WHEN duplicate_object THEN null; END $$;

-- todos
ALTER TABLE todos ENABLE ROW LEVEL SECURITY;
ALTER TABLE todos FORCE ROW LEVEL SECURITY;
DO $$ BEGIN CREATE POLICY tenant_isolation ON todos USING (tenant_id = current_setting('app.tenant_id')::uuid); EXCEPTION WHEN duplicate_object THEN null; END $$;

-- notifications
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
DO $$ BEGIN CREATE POLICY tenant_isolation ON notifications USING (tenant_id = current_setting('app.tenant_id')::uuid); EXCEPTION WHEN duplicate_object THEN null; END $$;

-- tenant_addons
ALTER TABLE tenant_addons ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_addons FORCE ROW LEVEL SECURITY;
DO $$ BEGIN CREATE POLICY tenant_isolation ON tenant_addons USING (tenant_id = current_setting('app.tenant_id')::uuid); EXCEPTION WHEN duplicate_object THEN null; END $$;

-- payments
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments FORCE ROW LEVEL SECURITY;
DO $$ BEGIN CREATE POLICY tenant_isolation ON payments USING (tenant_id = current_setting('app.tenant_id')::uuid); EXCEPTION WHEN duplicate_object THEN null; END $$;

-- invoices
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices FORCE ROW LEVEL SECURITY;
DO $$ BEGIN CREATE POLICY tenant_isolation ON invoices USING (tenant_id = current_setting('app.tenant_id')::uuid); EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ai_analysis_cache
ALTER TABLE ai_analysis_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_analysis_cache FORCE ROW LEVEL SECURITY;
DO $$ BEGIN CREATE POLICY tenant_isolation ON ai_analysis_cache USING (tenant_id = current_setting('app.tenant_id')::uuid); EXCEPTION WHEN duplicate_object THEN null; END $$;

-- discount_usages
ALTER TABLE discount_usages ENABLE ROW LEVEL SECURITY;
ALTER TABLE discount_usages FORCE ROW LEVEL SECURITY;
DO $$ BEGIN CREATE POLICY tenant_isolation ON discount_usages USING (tenant_id = current_setting('app.tenant_id')::uuid); EXCEPTION WHEN duplicate_object THEN null; END $$;

-- user_devices
ALTER TABLE user_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_devices FORCE ROW LEVEL SECURITY;
DO $$ BEGIN CREATE POLICY tenant_isolation ON user_devices USING (tenant_id = current_setting('app.tenant_id')::uuid); EXCEPTION WHEN duplicate_object THEN null; END $$;

-- tax_compliances
ALTER TABLE tax_compliances ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_compliances FORCE ROW LEVEL SECURITY;
DO $$ BEGIN CREATE POLICY tenant_isolation ON tax_compliances USING (tenant_id = current_setting('app.tenant_id')::uuid); EXCEPTION WHEN duplicate_object THEN null; END $$;

-- wills_estates
ALTER TABLE wills_estates ENABLE ROW LEVEL SECURITY;
ALTER TABLE wills_estates FORCE ROW LEVEL SECURITY;
DO $$ BEGIN CREATE POLICY tenant_isolation ON wills_estates USING (tenant_id = current_setting('app.tenant_id')::uuid); EXCEPTION WHEN duplicate_object THEN null; END $$;

-- loans_debts
ALTER TABLE loans_debts ENABLE ROW LEVEL SECURITY;
ALTER TABLE loans_debts FORCE ROW LEVEL SECURITY;
DO $$ BEGIN CREATE POLICY tenant_isolation ON loans_debts USING (tenant_id = current_setting('app.tenant_id')::uuid); EXCEPTION WHEN duplicate_object THEN null; END $$;

-- utility_bills
ALTER TABLE utility_bills ENABLE ROW LEVEL SECURITY;
ALTER TABLE utility_bills FORCE ROW LEVEL SECURITY;
DO $$ BEGIN CREATE POLICY tenant_isolation ON utility_bills USING (tenant_id = current_setting('app.tenant_id')::uuid); EXCEPTION WHEN duplicate_object THEN null; END $$;

-- corporate_compliances
ALTER TABLE corporate_compliances ENABLE ROW LEVEL SECURITY;
ALTER TABLE corporate_compliances FORCE ROW LEVEL SECURITY;
DO $$ BEGIN CREATE POLICY tenant_isolation ON corporate_compliances USING (tenant_id = current_setting('app.tenant_id')::uuid); EXCEPTION WHEN duplicate_object THEN null; END $$;