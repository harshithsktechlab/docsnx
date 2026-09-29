ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "file_size" integer DEFAULT 0 NOT NULL;
ALTER TABLE "medical_records" ADD COLUMN IF NOT EXISTS "file_size" integer DEFAULT 0 NOT NULL;
ALTER TABLE "vehicles" ADD COLUMN IF NOT EXISTS "file_size" integer DEFAULT 0 NOT NULL;
ALTER TABLE "lic_mediclaims" ADD COLUMN IF NOT EXISTS "file_size" integer DEFAULT 0 NOT NULL;
ALTER TABLE "warranty_amcs" ADD COLUMN IF NOT EXISTS "file_size" integer DEFAULT 0 NOT NULL;
ALTER TABLE "contract_agreements" ADD COLUMN IF NOT EXISTS "file_size" integer DEFAULT 0 NOT NULL;
