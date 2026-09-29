CREATE TYPE "public"."role" AS ENUM('SUPER_ADMIN', 'TENANT_ADMIN', 'STANDARD');--> statement-breakpoint
CREATE TABLE "addons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"price" numeric(12, 2),
	"price_yearly" numeric(12, 2),
	"price_one_time" numeric(12, 2),
	"price_usd" numeric(12, 2),
	"price_yearly_usd" numeric(12, 2),
	"price_one_time_usd" numeric(12, 2),
	"billing_cycle" varchar(50) DEFAULT 'MONTHLY' NOT NULL,
	"ai_credits" integer DEFAULT 0 NOT NULL,
	"extra_family_members" integer DEFAULT 0 NOT NULL,
	"storage_limit_gb" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_analysis_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid,
	"category" varchar(100) DEFAULT 'all' NOT NULL,
	"analysis_data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" varchar(255),
	"provider" varchar(50) DEFAULT 'GEMINI' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_api_keys_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" varchar(255) NOT NULL,
	"api_key" text NOT NULL,
	"provider" varchar(50) DEFAULT 'gemini' NOT NULL,
	"model" varchar(50) DEFAULT 'gemini-2.5-flash' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"daily_usage" integer DEFAULT 0 NOT NULL,
	"daily_limit" integer DEFAULT 1500 NOT NULL,
	"last_used_at" timestamp with time zone,
	"last_reset_at" timestamp with time zone DEFAULT now() NOT NULL,
	"error_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid,
	"action" varchar(255) NOT NULL,
	"resource" varchar(255),
	"details" text NOT NULL,
	"ip_address" varchar(100),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bank_infos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"holder_id" uuid,
	"is_global" boolean DEFAULT false NOT NULL,
	"bank_name" varchar(255) NOT NULL,
	"account_number" text NOT NULL,
	"account_number_hash" text,
	"account_type" varchar(100) NOT NULL,
	"ifsc_code" varchar(50) NOT NULL,
	"branch" varchar(255),
	"customer_id" text,
	"net_banking_username" text,
	"cards" jsonb,
	"custom_fields" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "contract_agreements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"holder_id" uuid,
	"is_global" boolean DEFAULT true NOT NULL,
	"type" varchar(100) NOT NULL,
	"name" varchar(255) NOT NULL,
	"provider" varchar(255) NOT NULL,
	"account_number" text,
	"start_date" timestamp with time zone,
	"end_date" timestamp with time zone NOT NULL,
	"amount" numeric(12, 2),
	"billing_cycle" varchar(50),
	"notes" text,
	"file_path" text,
	"file_size" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "corporate_compliances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"holder_id" uuid,
	"is_global" boolean DEFAULT false NOT NULL,
	"title" varchar(255) NOT NULL,
	"entity_name" varchar(255) NOT NULL,
	"document_type" varchar(100) NOT NULL,
	"registration_number" text,
	"filing_date" timestamp with time zone,
	"expiry_date" timestamp with time zone,
	"file_path" text,
	"file_size" integer DEFAULT 0 NOT NULL,
	"ai_analysis" jsonb,
	"custom_fields" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "credit_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"holder_id" uuid,
	"is_global" boolean DEFAULT false NOT NULL,
	"card_name" varchar(255) NOT NULL,
	"card_network" varchar(100),
	"card_type" varchar(100),
	"last_four" varchar(4),
	"card_details_encrypted" text NOT NULL,
	"custom_fields" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "discount_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(100) NOT NULL,
	"type" varchar(50) DEFAULT 'PERCENTAGE' NOT NULL,
	"discount_pct" integer NOT NULL,
	"discount_amount" numeric(12, 2),
	"max_uses" integer,
	"max_uses_per_tenant" integer,
	"expires_at" timestamp with time zone,
	"plan_id" uuid,
	"addon_id" uuid,
	"billing_cycle" varchar(50),
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "discount_codes_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "discount_usages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"discount_code_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"payment_id" uuid,
	"amount_saved" numeric(12, 2) NOT NULL,
	"used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"holder_id" uuid,
	"is_global" boolean DEFAULT false NOT NULL,
	"name" varchar(255) NOT NULL,
	"category" varchar(100) NOT NULL,
	"file_path" text NOT NULL,
	"file_name" varchar(255) NOT NULL,
	"mime_type" varchar(100) NOT NULL,
	"file_size" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "emergency_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"role" varchar(100) NOT NULL,
	"phone_number" varchar(50) NOT NULL,
	"email" varchar(255),
	"address" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employment_payrolls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"holder_id" uuid,
	"is_global" boolean DEFAULT false NOT NULL,
	"title" varchar(255) NOT NULL,
	"employer_name" varchar(255) NOT NULL,
	"employee_name" varchar(255) NOT NULL,
	"document_type" varchar(100) NOT NULL,
	"designation" varchar(255),
	"issue_date" timestamp with time zone,
	"file_path" text,
	"file_size" integer DEFAULT 0 NOT NULL,
	"ai_analysis" jsonb,
	"custom_fields" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "investments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"holder_id" uuid,
	"is_global" boolean DEFAULT false NOT NULL,
	"category" varchar(100) NOT NULL,
	"title" varchar(255) NOT NULL,
	"purchase_date" timestamp with time zone NOT NULL,
	"purchase_value" numeric(15, 2) NOT NULL,
	"current_value" numeric(15, 2) NOT NULL,
	"quantity" numeric(15, 4),
	"details" jsonb,
	"ai_analysis" jsonb,
	"custom_fields" jsonb,
	"property_tax_due_date" timestamp with time zone,
	"property_tax_receipt_uploaded" boolean DEFAULT false,
	"has_712_extract" boolean DEFAULT false,
	"has_namuna_d" boolean DEFAULT false,
	"has_map" boolean DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"invoice_number" varchar(100) NOT NULL,
	"invoice_type" varchar(50) DEFAULT 'standard' NOT NULL,
	"client_name" varchar(255) NOT NULL,
	"client_email" varchar(255),
	"client_gstin" varchar(50),
	"client_address" text,
	"client_state_code" varchar(10),
	"client_phone" varchar(50),
	"amount" numeric(12, 2) NOT NULL,
	"base_amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"gst_amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"gst_type" varchar(50) DEFAULT 'EXEMPT' NOT NULL,
	"currency" varchar(10) DEFAULT 'INR' NOT NULL,
	"status" varchar(50) DEFAULT 'pending' NOT NULL,
	"due_date" timestamp with time zone NOT NULL,
	"issued_date" timestamp with time zone DEFAULT now() NOT NULL,
	"notes" text,
	"items" jsonb,
	"payment_link" text,
	"razorpay_invoice_id" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lic_mediclaims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"holder_id" uuid,
	"is_global" boolean DEFAULT false NOT NULL,
	"policy_type" varchar(100) NOT NULL,
	"company_name" varchar(255) NOT NULL,
	"policy_name" varchar(255) NOT NULL,
	"policy_number" text NOT NULL,
	"policy_number_hash" text,
	"insured_person" varchar(255) NOT NULL,
	"sum_assured" numeric(15, 2) NOT NULL,
	"premium_amount" numeric(12, 2) NOT NULL,
	"premium_due_date" timestamp with time zone NOT NULL,
	"expiry_date" timestamp with time zone,
	"file_path" text,
	"file_size" integer DEFAULT 0 NOT NULL,
	"ai_analysis" jsonb,
	"custom_fields" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "loans_debts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"holder_id" uuid,
	"is_global" boolean DEFAULT false NOT NULL,
	"title" varchar(255) NOT NULL,
	"lender_name" varchar(255) NOT NULL,
	"loan_type" varchar(100) NOT NULL,
	"account_number" text NOT NULL,
	"account_number_hash" text,
	"principal_amount" numeric(15, 2),
	"emi_amount" numeric(12, 2),
	"interest_rate" numeric(6, 2),
	"start_date" timestamp with time zone,
	"maturity_date" timestamp with time zone,
	"has_noc" boolean DEFAULT false NOT NULL,
	"file_path" text,
	"file_size" integer DEFAULT 0 NOT NULL,
	"ai_analysis" jsonb,
	"custom_fields" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "medical_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"holder_id" uuid,
	"is_global" boolean DEFAULT false NOT NULL,
	"patient_name" varchar(255) NOT NULL,
	"record_type" varchar(100) NOT NULL,
	"date" timestamp with time zone NOT NULL,
	"doctor_name" varchar(255),
	"hospital_name" varchar(255),
	"details" text,
	"file_path" text,
	"file_size" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb,
	"custom_fields" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"title" varchar(255) NOT NULL,
	"message" text NOT NULL,
	"link" text NOT NULL,
	"is_read" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "passwords" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"holder_id" uuid,
	"is_global" boolean DEFAULT false NOT NULL,
	"title" varchar(255) NOT NULL,
	"category" varchar(100) NOT NULL,
	"url" text,
	"username" varchar(255) NOT NULL,
	"password_encrypted" text NOT NULL,
	"notes" text,
	"custom_fields" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"plan_id" uuid,
	"addon_id" uuid,
	"plan_billing_cycle" varchar(50),
	"addons_purchased" jsonb,
	"invoice_url" text,
	"razorpay_order_id" varchar(255),
	"razorpay_payment_id" varchar(255),
	"razorpay_signature" varchar(255),
	"payment_method" varchar(50) DEFAULT 'RAZORPAY' NOT NULL,
	"payment_ref" varchar(255),
	"amount" numeric(12, 2) NOT NULL,
	"currency" varchar(10) DEFAULT 'INR' NOT NULL,
	"status" varchar(50) DEFAULT 'created' NOT NULL,
	"initiated_by" varchar(50) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "permissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"module" varchar(100) NOT NULL,
	"can_view" boolean DEFAULT false NOT NULL,
	"can_add" boolean DEFAULT false NOT NULL,
	"can_edit" boolean DEFAULT false NOT NULL,
	"can_delete" boolean DEFAULT false NOT NULL,
	"can_share" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"personal_details" jsonb,
	"education_details" jsonb,
	"shopping_details" jsonb,
	"legal_details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profiles_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "subscription_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"price" numeric(12, 2) NOT NULL,
	"price_yearly" numeric(12, 2),
	"price_one_time" numeric(12, 2),
	"price_usd" numeric(12, 2),
	"price_yearly_usd" numeric(12, 2),
	"price_one_time_usd" numeric(12, 2),
	"amc_amount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"amc_amount_usd" numeric(12, 2),
	"ai_credits" integer DEFAULT 0 NOT NULL,
	"max_family_members" integer DEFAULT 1 NOT NULL,
	"storage_limit_gb" integer DEFAULT 1 NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"badge_color" varchar(50) DEFAULT 'secondary' NOT NULL,
	"duration_days" integer,
	"is_lifetime" boolean DEFAULT false,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_configs" (
	"platform_name" varchar(255),
	"platform_gstin" varchar(50),
	"platform_address" text,
	"platform_state_code" varchar(10),
	"platform_logo" text,
	"platform_email" varchar(255),
	"platform_phone" varchar(50),
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"smtp_host" varchar(255) NOT NULL,
	"smtp_port" integer NOT NULL,
	"smtp_user" varchar(255) NOT NULL,
	"smtp_password" text NOT NULL,
	"smtp_secure" boolean DEFAULT true NOT NULL,
	"smtp_from" varchar(255) NOT NULL,
	"ai_cost_record_analysis" numeric(10, 2) DEFAULT '1.00' NOT NULL,
	"ai_cost_category_analysis" numeric(10, 2) DEFAULT '2.00' NOT NULL,
	"ai_cost_portfolio_analysis" numeric(10, 2) DEFAULT '5.00' NOT NULL,
	"ai_cost_bulk_scan" numeric(10, 2) DEFAULT '10.00' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tax_compliances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"holder_id" uuid,
	"is_global" boolean DEFAULT false NOT NULL,
	"title" varchar(255) NOT NULL,
	"form_type" varchar(100) NOT NULL,
	"assessment_year" varchar(50) NOT NULL,
	"acknowledgement_number" text,
	"taxable_amount" numeric(15, 2),
	"tax_paid" numeric(15, 2),
	"filing_date" timestamp with time zone,
	"due_date" timestamp with time zone,
	"file_path" text,
	"file_size" integer DEFAULT 0 NOT NULL,
	"ai_analysis" jsonb,
	"custom_fields" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tenant_addons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"addon_id" uuid NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"purchased_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_ai_usages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"model_name" varchar(100) NOT NULL,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	"cost" numeric(10, 5) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"billing_name" varchar(255),
	"billing_gst" varchar(50),
	"billing_address" text,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"api_key" text,
	"ai_provider" varchar(50) DEFAULT 'gemini' NOT NULL,
	"ai_model" varchar(50) DEFAULT 'gemini-2.5-flash' NOT NULL,
	"subscription_plan_id" uuid,
	"subscription_expiry" timestamp with time zone,
	"ai_credits_balance" integer DEFAULT 0 NOT NULL,
	"google_drive_enabled" boolean DEFAULT false NOT NULL,
	"google_drive_tokens" jsonb,
	"has_completed_onboarding" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"max_family_members" integer DEFAULT 1,
	"extra_family_members" integer DEFAULT 0,
	"amc_last_paid_at" timestamp with time zone,
	"amc_next_due_date" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "todos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"task" text NOT NULL,
	"due_date" timestamp with time zone,
	"status" varchar(50) DEFAULT 'PENDING' NOT NULL,
	"assignee_id" uuid,
	"creator_id" uuid NOT NULL,
	"push_notification" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trading_demats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"holder_id" uuid,
	"is_global" boolean DEFAULT false NOT NULL,
	"broker_name" varchar(255) NOT NULL,
	"client_id" text NOT NULL,
	"client_id_hash" text,
	"demat_account_number" text,
	"demat_account_number_hash" text,
	"login_username" text,
	"nominee_name" varchar(255),
	"details" text,
	"custom_fields" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "trial_used_emails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trial_used_emails_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "user_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"fcm_token" varchar(500) NOT NULL,
	"platform" varchar(50) NOT NULL,
	"last_active_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_devices_fcm_token_unique" UNIQUE("fcm_token")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"email" varchar(255) NOT NULL,
	"password_hash" text NOT NULL,
	"requires_password_change" boolean DEFAULT true NOT NULL,
	"name" varchar(255) NOT NULL,
	"phone_number" varchar(50),
	"role" "role" DEFAULT 'STANDARD' NOT NULL,
	"reset_token" varchar(255),
	"reset_token_expiry" timestamp with time zone,
	"email_verified" boolean DEFAULT true NOT NULL,
	"email_verification_otp" varchar(10),
	"email_verification_otp_expiry" timestamp with time zone,
	"consent_data_processing" boolean DEFAULT false NOT NULL,
	"consent_ai_processing" boolean DEFAULT false NOT NULL,
	"consent_timestamp" timestamp with time zone,
	"consent_ip_address" varchar(45),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "utility_bills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"holder_id" uuid,
	"is_global" boolean DEFAULT false NOT NULL,
	"title" varchar(255) NOT NULL,
	"provider_name" varchar(255) NOT NULL,
	"service_type" varchar(100) NOT NULL,
	"consumer_number" text NOT NULL,
	"consumer_number_hash" text,
	"bill_amount" numeric(12, 2),
	"due_date" timestamp with time zone,
	"billing_period" varchar(100),
	"is_paid" boolean DEFAULT false NOT NULL,
	"file_path" text,
	"file_size" integer DEFAULT 0 NOT NULL,
	"ai_analysis" jsonb,
	"custom_fields" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "vehicles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"holder_id" uuid,
	"is_global" boolean DEFAULT false NOT NULL,
	"vehicle_name" varchar(255) NOT NULL,
	"vehicle_number" varchar(100) NOT NULL,
	"owner_name" varchar(255) NOT NULL,
	"registration_date" timestamp with time zone NOT NULL,
	"insurance_expiry" timestamp with time zone NOT NULL,
	"puc_expiry" timestamp with time zone NOT NULL,
	"fitness_expiry" timestamp with time zone NOT NULL,
	"last_service_date" timestamp with time zone,
	"next_service_date" timestamp with time zone,
	"service_notes" text,
	"file_path" text,
	"file_size" integer DEFAULT 0 NOT NULL,
	"custom_fields" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "warranty_amcs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"holder_id" uuid,
	"is_global" boolean DEFAULT true NOT NULL,
	"appliance_name" varchar(255) NOT NULL,
	"company" varchar(255) NOT NULL,
	"type" varchar(50) NOT NULL,
	"purchase_date" timestamp with time zone,
	"expiry_date" timestamp with time zone NOT NULL,
	"support_contact" varchar(255),
	"file_path" text,
	"file_size" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "wills_estates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"holder_id" uuid,
	"is_global" boolean DEFAULT false NOT NULL,
	"title" varchar(255) NOT NULL,
	"document_type" varchar(100) NOT NULL,
	"testator_name" varchar(255) NOT NULL,
	"execution_date" timestamp with time zone,
	"executor_name" varchar(255),
	"registration_status" varchar(100) DEFAULT 'UNREGISTERED',
	"nominees" jsonb,
	"file_path" text,
	"file_size" integer DEFAULT 0 NOT NULL,
	"ai_analysis" jsonb,
	"custom_fields" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "ai_analysis_cache" ADD CONSTRAINT "ai_analysis_cache_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_analysis_cache" ADD CONSTRAINT "ai_analysis_cache_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_infos" ADD CONSTRAINT "bank_infos_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_infos" ADD CONSTRAINT "bank_infos_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_infos" ADD CONSTRAINT "bank_infos_holder_id_users_id_fk" FOREIGN KEY ("holder_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_agreements" ADD CONSTRAINT "contract_agreements_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_agreements" ADD CONSTRAINT "contract_agreements_holder_id_users_id_fk" FOREIGN KEY ("holder_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corporate_compliances" ADD CONSTRAINT "corporate_compliances_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corporate_compliances" ADD CONSTRAINT "corporate_compliances_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corporate_compliances" ADD CONSTRAINT "corporate_compliances_holder_id_users_id_fk" FOREIGN KEY ("holder_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_cards" ADD CONSTRAINT "credit_cards_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_cards" ADD CONSTRAINT "credit_cards_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_cards" ADD CONSTRAINT "credit_cards_holder_id_users_id_fk" FOREIGN KEY ("holder_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_codes" ADD CONSTRAINT "discount_codes_plan_id_subscription_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."subscription_plans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_codes" ADD CONSTRAINT "discount_codes_addon_id_addons_id_fk" FOREIGN KEY ("addon_id") REFERENCES "public"."addons"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_usages" ADD CONSTRAINT "discount_usages_discount_code_id_discount_codes_id_fk" FOREIGN KEY ("discount_code_id") REFERENCES "public"."discount_codes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_usages" ADD CONSTRAINT "discount_usages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_usages" ADD CONSTRAINT "discount_usages_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_holder_id_users_id_fk" FOREIGN KEY ("holder_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emergency_contacts" ADD CONSTRAINT "emergency_contacts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_payrolls" ADD CONSTRAINT "employment_payrolls_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_payrolls" ADD CONSTRAINT "employment_payrolls_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employment_payrolls" ADD CONSTRAINT "employment_payrolls_holder_id_users_id_fk" FOREIGN KEY ("holder_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investments" ADD CONSTRAINT "investments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investments" ADD CONSTRAINT "investments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investments" ADD CONSTRAINT "investments_holder_id_users_id_fk" FOREIGN KEY ("holder_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lic_mediclaims" ADD CONSTRAINT "lic_mediclaims_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lic_mediclaims" ADD CONSTRAINT "lic_mediclaims_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lic_mediclaims" ADD CONSTRAINT "lic_mediclaims_holder_id_users_id_fk" FOREIGN KEY ("holder_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loans_debts" ADD CONSTRAINT "loans_debts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loans_debts" ADD CONSTRAINT "loans_debts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loans_debts" ADD CONSTRAINT "loans_debts_holder_id_users_id_fk" FOREIGN KEY ("holder_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medical_records" ADD CONSTRAINT "medical_records_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medical_records" ADD CONSTRAINT "medical_records_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medical_records" ADD CONSTRAINT "medical_records_holder_id_users_id_fk" FOREIGN KEY ("holder_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passwords" ADD CONSTRAINT "passwords_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passwords" ADD CONSTRAINT "passwords_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passwords" ADD CONSTRAINT "passwords_holder_id_users_id_fk" FOREIGN KEY ("holder_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_plan_id_subscription_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."subscription_plans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_addon_id_addons_id_fk" FOREIGN KEY ("addon_id") REFERENCES "public"."addons"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permissions" ADD CONSTRAINT "permissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_compliances" ADD CONSTRAINT "tax_compliances_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_compliances" ADD CONSTRAINT "tax_compliances_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_compliances" ADD CONSTRAINT "tax_compliances_holder_id_users_id_fk" FOREIGN KEY ("holder_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_addons" ADD CONSTRAINT "tenant_addons_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_addons" ADD CONSTRAINT "tenant_addons_addon_id_addons_id_fk" FOREIGN KEY ("addon_id") REFERENCES "public"."addons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_ai_usages" ADD CONSTRAINT "tenant_ai_usages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_subscription_plan_id_subscription_plans_id_fk" FOREIGN KEY ("subscription_plan_id") REFERENCES "public"."subscription_plans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "todos" ADD CONSTRAINT "todos_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "todos" ADD CONSTRAINT "todos_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "todos" ADD CONSTRAINT "todos_creator_id_users_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trading_demats" ADD CONSTRAINT "trading_demats_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trading_demats" ADD CONSTRAINT "trading_demats_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trading_demats" ADD CONSTRAINT "trading_demats_holder_id_users_id_fk" FOREIGN KEY ("holder_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_devices" ADD CONSTRAINT "user_devices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_devices" ADD CONSTRAINT "user_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "utility_bills" ADD CONSTRAINT "utility_bills_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "utility_bills" ADD CONSTRAINT "utility_bills_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "utility_bills" ADD CONSTRAINT "utility_bills_holder_id_users_id_fk" FOREIGN KEY ("holder_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicles" ADD CONSTRAINT "vehicles_holder_id_users_id_fk" FOREIGN KEY ("holder_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warranty_amcs" ADD CONSTRAINT "warranty_amcs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warranty_amcs" ADD CONSTRAINT "warranty_amcs_holder_id_users_id_fk" FOREIGN KEY ("holder_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wills_estates" ADD CONSTRAINT "wills_estates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wills_estates" ADD CONSTRAINT "wills_estates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wills_estates" ADD CONSTRAINT "wills_estates_holder_id_users_id_fk" FOREIGN KEY ("holder_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "permissions_user_id_module_idx" ON "permissions" USING btree ("user_id","module");