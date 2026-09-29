CREATE TABLE "document_category_fields" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"category_id" uuid NOT NULL,
	"field_key" varchar(100) NOT NULL,
	"field_label" varchar(200) NOT NULL,
	"data_type" varchar(24) DEFAULT 'text' NOT NULL,
	"is_pii" boolean DEFAULT true NOT NULL,
	"is_required" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_encryption_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"wrapped_key" text NOT NULL,
	"key_check" varchar(64) NOT NULL,
	"algo" varchar(32) DEFAULT 'AES-256-GCM' NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone,
	"retired_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "user_vault_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"source" varchar(24) DEFAULT 'passphrase' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"wrapped_key" text NOT NULL,
	"kdf" varchar(24) DEFAULT 'PBKDF2-SHA256' NOT NULL,
	"kdf_salt" varchar(64) NOT NULL,
	"kdf_iterations" integer DEFAULT 600000 NOT NULL,
	"key_check" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vault_json_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"module" varchar(40) NOT NULL,
	"category_code" varchar(120) NOT NULL,
	"drive_file_id" varchar(128) NOT NULL,
	"drive_folder_id" varchar(128) NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"record_count" integer DEFAULT 0 NOT NULL,
	"byte_size" integer DEFAULT 0 NOT NULL,
	"drive_modified_time" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document_category_fields" ADD CONSTRAINT "document_category_fields_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_category_fields" ADD CONSTRAINT "document_category_fields_category_id_document_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."document_categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_encryption_keys" ADD CONSTRAINT "tenant_encryption_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_vault_keys" ADD CONSTRAINT "user_vault_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_vault_keys" ADD CONSTRAINT "user_vault_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_json_files" ADD CONSTRAINT "vault_json_files_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "document_category_fields_global_field_idx" ON "document_category_fields" USING btree ("category_id","field_key") WHERE "document_category_fields"."tenant_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "document_category_fields_tenant_field_idx" ON "document_category_fields" USING btree ("tenant_id","category_id","field_key") WHERE "document_category_fields"."tenant_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "document_category_fields_lookup_idx" ON "document_category_fields" USING btree ("category_id","tenant_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_encryption_keys_tenant_version_idx" ON "tenant_encryption_keys" USING btree ("tenant_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_encryption_keys_active_idx" ON "tenant_encryption_keys" USING btree ("tenant_id") WHERE "tenant_encryption_keys"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "user_vault_keys_member_source_idx" ON "user_vault_keys" USING btree ("tenant_id","user_id","source","version");--> statement-breakpoint
CREATE INDEX "user_vault_keys_tenant_idx" ON "user_vault_keys" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vault_json_files_key_idx" ON "vault_json_files" USING btree ("tenant_id","module","category_code");