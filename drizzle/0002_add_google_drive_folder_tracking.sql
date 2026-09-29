ALTER TABLE "tenants" ADD COLUMN "google_drive_folder_id" varchar(128);--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "google_drive_file_ids" jsonb;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "google_account_email" varchar(255);