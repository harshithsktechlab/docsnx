ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "consent_data_processing" boolean DEFAULT false;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "consent_timestamp" timestamp;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "consent_ip_address" varchar(45);
