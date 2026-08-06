CREATE TYPE "public"."asset_condition" AS ENUM('new', 'good', 'fair', 'poor', 'end_of_life');--> statement-breakpoint
CREATE TYPE "public"."attendance_kind" AS ENUM('shift_in', 'shift_out', 'break_start', 'break_end');--> statement-breakpoint
CREATE TYPE "public"."contract_status" AS ENUM('draft', 'pending_signature', 'active', 'suspended', 'expired', 'cancelled', 'renewed');--> statement-breakpoint
CREATE TYPE "public"."employment_type" AS ENUM('direct', 'contract_supply', 'subcontractor');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('draft', 'issued', 'part_paid', 'paid', 'overdue', 'written_off', 'credited');--> statement-breakpoint
CREATE TYPE "public"."job_priority" AS ENUM('p1_emergency', 'p2_urgent', 'p3_standard', 'p4_planned');--> statement-breakpoint
CREATE TYPE "public"."job_source" AS ENUM('web_quote', 'phone', 'whatsapp', 'ai_receptionist', 'customer_portal', 'contract_ppm', 'internal', 'recurring');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('draft', 'submitted', 'triaged', 'scheduled', 'dispatched', 'en_route', 'on_site', 'paused', 'work_complete', 'signed_off', 'invoiced', 'closed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."lead_stage" AS ENUM('new', 'contacted', 'qualified', 'quoted', 'negotiating', 'won', 'lost', 'dormant');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('card', 'bank_transfer', 'cash', 'cheque', 'online_gateway', 'credit_note');--> statement-breakpoint
CREATE TYPE "public"."property_type" AS ENUM('apartment', 'villa', 'office', 'retail', 'hotel', 'building', 'warehouse', 'mixed_use', 'other');--> statement-breakpoint
CREATE TYPE "public"."quote_status" AS ENUM('draft', 'sent', 'viewed', 'approved', 'rejected', 'expired', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('owner', 'admin', 'operations_manager', 'dispatcher', 'supervisor', 'technician', 'accountant', 'sales', 'customer', 'readonly');--> statement-breakpoint
CREATE TYPE "public"."visit_status" AS ENUM('proposed', 'assigned', 'accepted', 'declined', 'en_route', 'arrived', 'completed', 'no_access', 'aborted');--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "user_role" DEFAULT 'readonly' NOT NULL,
	"permission_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"customer_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"invited_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"tenant_id" uuid,
	"token_hash" text NOT NULL,
	"user_agent" text,
	"ip_address" varchar(45),
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" varchar(64) NOT NULL,
	"legal_name" varchar(200) NOT NULL,
	"brand_name" varchar(120) NOT NULL,
	"domain" varchar(200),
	"country_code" varchar(2) DEFAULT 'AE' NOT NULL,
	"default_currency" varchar(3) DEFAULT 'AED' NOT NULL,
	"timezone" varchar(64) DEFAULT 'Asia/Dubai' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(200) NOT NULL,
	"phone" varchar(24),
	"full_name" varchar(160) NOT NULL,
	"avatar_url" text,
	"locale" varchar(8) DEFAULT 'en' NOT NULL,
	"password_hash" text,
	"mfa_enabled_at" timestamp with time zone,
	"mfa_secret" text,
	"email_verified_at" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"failed_login_count" varchar(8) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"unit_id" uuid,
	"tag" varchar(48) NOT NULL,
	"name" varchar(160) NOT NULL,
	"service_slug" varchar(64),
	"manufacturer" varchar(120),
	"model" varchar(120),
	"serial_number" varchar(120),
	"location" varchar(160),
	"installed_on" timestamp with time zone,
	"warranty_expires_on" timestamp with time zone,
	"condition" "asset_condition" DEFAULT 'good' NOT NULL,
	"ppm_interval_days" integer,
	"last_serviced_at" timestamp with time zone,
	"next_service_due_at" timestamp with time zone,
	"specs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "communications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid,
	"lead_id" uuid,
	"job_id" uuid,
	"channel" varchar(24) NOT NULL,
	"direction" varchar(8) NOT NULL,
	"subject" varchar(240),
	"body" text,
	"author_id" uuid,
	"is_automated" boolean DEFAULT false NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "customer_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"full_name" varchar(160) NOT NULL,
	"role" varchar(80),
	"email" varchar(200),
	"phone" varchar(24),
	"is_primary" boolean DEFAULT false NOT NULL,
	"notify_on_jobs" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" varchar(32) NOT NULL,
	"name" varchar(200) NOT NULL,
	"is_company" boolean DEFAULT true NOT NULL,
	"industry" varchar(80),
	"trn" varchar(32),
	"billing_email" varchar(200),
	"phone" varchar(24),
	"payment_terms_days" integer DEFAULT 30 NOT NULL,
	"credit_limit" numeric(14, 2),
	"currency" varchar(3) DEFAULT 'AED' NOT NULL,
	"account_manager_id" uuid,
	"notes" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(200) NOT NULL,
	"company_name" varchar(200),
	"email" varchar(200),
	"phone" varchar(24),
	"service_slug" varchar(64),
	"city" varchar(80),
	"area" varchar(120),
	"property_type_guess" "property_type",
	"stage" "lead_stage" DEFAULT 'new' NOT NULL,
	"score" integer,
	"score_reason" text,
	"estimated_value" numeric(14, 2),
	"currency" varchar(3) DEFAULT 'AED' NOT NULL,
	"source" varchar(64) DEFAULT 'website' NOT NULL,
	"attribution" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"message" text,
	"owner_id" uuid,
	"converted_customer_id" uuid,
	"lost_reason" text,
	"next_follow_up_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "properties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"name" varchar(200) NOT NULL,
	"type" "property_type" DEFAULT 'apartment' NOT NULL,
	"address_line" text NOT NULL,
	"area" varchar(120),
	"city" varchar(80) NOT NULL,
	"country" varchar(2) DEFAULT 'AE' NOT NULL,
	"lat" double precision,
	"lng" double precision,
	"access_instructions" text,
	"floors" integer,
	"unit_count" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "property_units" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"reference" varchar(40) NOT NULL,
	"floor" varchar(16),
	"occupant_name" varchar(160),
	"occupant_phone" varchar(24),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "attendance_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"technician_id" uuid NOT NULL,
	"kind" "attendance_kind" NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lat" double precision,
	"lng" double precision,
	"accuracy_metres" integer,
	"within_geofence" boolean,
	"recorded_offline_at" timestamp with time zone,
	"device_id" varchar(80),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "leave_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"technician_id" uuid NOT NULL,
	"kind" varchar(32) DEFAULT 'annual' NOT NULL,
	"starts_on" timestamp with time zone NOT NULL,
	"ends_on" timestamp with time zone NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"reason" text,
	"approved_by_id" uuid,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "shifts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"technician_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"kind" varchar(24) DEFAULT 'standard' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "technician_certifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"technician_id" uuid NOT NULL,
	"name" varchar(160) NOT NULL,
	"issuer" varchar(160),
	"reference" varchar(80),
	"document_url" text,
	"issued_on" timestamp with time zone,
	"expires_on" timestamp with time zone,
	"required_for_services" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "technician_locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"technician_id" uuid NOT NULL,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"heading_degrees" integer,
	"speed_kph" integer,
	"battery_percent" smallint,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "technician_performance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"technician_id" uuid NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"jobs_completed" integer DEFAULT 0 NOT NULL,
	"first_time_fix_count" integer DEFAULT 0 NOT NULL,
	"revisit_count" integer DEFAULT 0 NOT NULL,
	"sla_met_basis_points" integer,
	"avg_rating_basis_points" integer,
	"billable_minutes" integer DEFAULT 0 NOT NULL,
	"travel_minutes" integer DEFAULT 0 NOT NULL,
	"revenue_generated" numeric(14, 2),
	"currency" varchar(3) DEFAULT 'AED' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "technician_skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"technician_id" uuid NOT NULL,
	"service_slug" varchar(64) NOT NULL,
	"proficiency" smallint DEFAULT 3 NOT NULL,
	"verified_by_id" uuid,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "technicians" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid,
	"employee_code" varchar(32) NOT NULL,
	"full_name" varchar(160) NOT NULL,
	"phone" varchar(24) NOT NULL,
	"email" varchar(200),
	"photo_url" text,
	"employment" "employment_type" DEFAULT 'direct' NOT NULL,
	"primary_trade" varchar(64) NOT NULL,
	"grade" varchar(24) DEFAULT 'technician' NOT NULL,
	"supervisor_id" uuid,
	"base_lat" double precision,
	"base_lng" double precision,
	"base_city" varchar(80),
	"hourly_cost" numeric(14, 2),
	"hourly_charge" numeric(14, 2),
	"currency" varchar(3) DEFAULT 'AED' NOT NULL,
	"deployed_customer_id" uuid,
	"deployed_property_id" uuid,
	"visa_expires_on" timestamp with time zone,
	"joined_on" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "job_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"visit_id" uuid,
	"kind" varchar(24) NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" varchar(80),
	"size_bytes" integer,
	"caption" text,
	"captured_at" timestamp with time zone,
	"captured_lat" double precision,
	"captured_lng" double precision,
	"uploaded_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "job_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"from_status" varchar(32),
	"to_status" varchar(32) NOT NULL,
	"note" text,
	"actor_id" uuid,
	"actor_kind" varchar(16) DEFAULT 'user' NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_materials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"visit_id" uuid,
	"sku" varchar(64),
	"description" varchar(240) NOT NULL,
	"quantity" numeric(12, 3) DEFAULT '1' NOT NULL,
	"unit" varchar(16) DEFAULT 'ea' NOT NULL,
	"unit_cost" numeric(14, 2),
	"unit_price" numeric(14, 2),
	"currency" varchar(3) DEFAULT 'AED' NOT NULL,
	"is_billable" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "job_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"visit_id" uuid,
	"fault_found" text,
	"work_carried_out" text,
	"recommendation" text,
	"raw_notes" text,
	"ai_summary" text,
	"ai_summary_approved_by_id" uuid,
	"follow_up_required" boolean DEFAULT false NOT NULL,
	"follow_up_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "job_signoffs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"visit_id" uuid,
	"signed_by_name" varchar(160) NOT NULL,
	"signed_by_role" varchar(80),
	"signature_storage_key" text NOT NULL,
	"satisfaction_rating" smallint,
	"comments" text,
	"signed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"signed_lat" double precision,
	"signed_lng" double precision,
	"ip_address" varchar(45),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "job_visits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"technician_id" uuid NOT NULL,
	"sequence" smallint DEFAULT 1 NOT NULL,
	"status" "visit_status" DEFAULT 'assigned' NOT NULL,
	"scheduled_start" timestamp with time zone,
	"scheduled_end" timestamp with time zone,
	"dispatched_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"en_route_at" timestamp with time zone,
	"arrived_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"arrival_lat" double precision,
	"arrival_lng" double precision,
	"within_geofence" boolean,
	"travel_minutes" integer,
	"work_minutes" integer,
	"outcome_note" text,
	"assignment_method" varchar(24) DEFAULT 'manual' NOT NULL,
	"assignment_score" double precision,
	"assignment_reason" text,
	"assigned_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"reference" varchar(32) NOT NULL,
	"customer_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"unit_id" uuid,
	"asset_id" uuid,
	"service_slug" varchar(64) NOT NULL,
	"title" varchar(240) NOT NULL,
	"description" text,
	"status" "job_status" DEFAULT 'submitted' NOT NULL,
	"priority" "job_priority" DEFAULT 'p3_standard' NOT NULL,
	"source" "job_source" DEFAULT 'web_quote' NOT NULL,
	"contract_id" uuid,
	"quote_id" uuid,
	"respond_by_at" timestamp with time zone,
	"resolve_by_at" timestamp with time zone,
	"first_response_at" timestamp with time zone,
	"scheduled_for" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"estimated_minutes" integer,
	"actual_minutes" integer,
	"quoted_amount" numeric(14, 2),
	"final_amount" numeric(14, 2),
	"currency" varchar(3) DEFAULT 'AED' NOT NULL,
	"is_contract_covered" boolean DEFAULT false NOT NULL,
	"requires_quote_approval" boolean DEFAULT false NOT NULL,
	"customer_rating" smallint,
	"customer_feedback" text,
	"parent_job_id" uuid,
	"is_revisit" boolean DEFAULT false NOT NULL,
	"created_by_id" uuid,
	"ai_triage" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "contract_properties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"visits_per_year" smallint,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "contract_visits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"due_on" timestamp with time zone NOT NULL,
	"service_slug" varchar(64),
	"job_id" uuid,
	"status" varchar(16) DEFAULT 'planned' NOT NULL,
	"skipped_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "contracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"reference" varchar(32) NOT NULL,
	"customer_id" uuid NOT NULL,
	"name" varchar(240) NOT NULL,
	"kind" varchar(32) DEFAULT 'amc' NOT NULL,
	"status" "contract_status" DEFAULT 'draft' NOT NULL,
	"starts_on" timestamp with time zone NOT NULL,
	"ends_on" timestamp with time zone NOT NULL,
	"annual_value" numeric(14, 2) DEFAULT '0' NOT NULL,
	"currency" varchar(3) DEFAULT 'AED' NOT NULL,
	"billing_frequency" varchar(24) DEFAULT 'annually' NOT NULL,
	"visits_per_year" smallint DEFAULT 4 NOT NULL,
	"covered_services" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"exclusions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"includes_emergency_callouts" boolean DEFAULT true NOT NULL,
	"sla_targets" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"auto_renew" boolean DEFAULT false NOT NULL,
	"renewal_notice_days" smallint DEFAULT 30 NOT NULL,
	"renewed_from_contract_id" uuid,
	"document_storage_key" text,
	"signed_at" timestamp with time zone,
	"ai_analysis" jsonb,
	"owner_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "invoice_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"position" smallint DEFAULT 1 NOT NULL,
	"service_slug" varchar(64),
	"description" text NOT NULL,
	"quantity" numeric(12, 3) DEFAULT '1' NOT NULL,
	"unit" varchar(24) DEFAULT 'ea' NOT NULL,
	"unit_price" numeric(14, 2) DEFAULT '0' NOT NULL,
	"line_total" numeric(14, 2) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"reference" varchar(32) NOT NULL,
	"customer_id" uuid NOT NULL,
	"job_id" uuid,
	"contract_id" uuid,
	"quote_id" uuid,
	"status" "invoice_status" DEFAULT 'draft' NOT NULL,
	"issued_on" timestamp with time zone,
	"due_on" timestamp with time zone,
	"subtotal" numeric(14, 2) DEFAULT '0' NOT NULL,
	"discount_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"tax_rate_basis_points" integer DEFAULT 500 NOT NULL,
	"tax_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"total" numeric(14, 2) DEFAULT '0' NOT NULL,
	"amount_paid" numeric(14, 2) DEFAULT '0' NOT NULL,
	"currency" varchar(3) DEFAULT 'AED' NOT NULL,
	"customer_trn" varchar(32),
	"pdf_storage_key" text,
	"notes" text,
	"sent_at" timestamp with time zone,
	"last_reminder_at" timestamp with time zone,
	"reminder_count" smallint DEFAULT 0 NOT NULL,
	"written_off_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"currency" varchar(3) DEFAULT 'AED' NOT NULL,
	"method" "payment_method" DEFAULT 'bank_transfer' NOT NULL,
	"reference" varchar(120),
	"gateway_provider" varchar(40),
	"gateway_payment_id" varchar(120),
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reconciled_at" timestamp with time zone,
	"recorded_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "quote_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"quote_id" uuid NOT NULL,
	"position" smallint DEFAULT 1 NOT NULL,
	"service_slug" varchar(64),
	"description" text NOT NULL,
	"quantity" numeric(12, 3) DEFAULT '1' NOT NULL,
	"unit" varchar(24) DEFAULT 'ea' NOT NULL,
	"unit_price" numeric(14, 2) DEFAULT '0' NOT NULL,
	"line_total" numeric(14, 2) DEFAULT '0' NOT NULL,
	"is_optional" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"reference" varchar(32) NOT NULL,
	"customer_id" uuid,
	"lead_id" uuid,
	"property_id" uuid,
	"job_id" uuid,
	"title" varchar(240) NOT NULL,
	"status" "quote_status" DEFAULT 'draft' NOT NULL,
	"subtotal" numeric(14, 2) DEFAULT '0' NOT NULL,
	"discount_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"tax_rate_basis_points" integer DEFAULT 500 NOT NULL,
	"tax_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"total" numeric(14, 2) DEFAULT '0' NOT NULL,
	"currency" varchar(3) DEFAULT 'AED' NOT NULL,
	"valid_until" timestamp with time zone,
	"terms_text" text,
	"notes" text,
	"sent_at" timestamp with time zone,
	"viewed_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"rejection_reason" text,
	"approval_token_hash" text,
	"supersedes_quote_id" uuid,
	"ai_generation" jsonb,
	"prepared_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ai_interactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"capability" varchar(48) NOT NULL,
	"model" varchar(64) NOT NULL,
	"prompt_hash" varchar(64),
	"input_tokens" integer,
	"output_tokens" integer,
	"latency_ms" integer,
	"cost_micros" integer,
	"subject_table" varchar(64),
	"subject_id" uuid,
	"accepted_by_human" boolean,
	"reviewed_by_id" uuid,
	"confidence_basis_points" integer,
	"error" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"table_name" varchar(64) NOT NULL,
	"record_id" uuid,
	"action" varchar(16) NOT NULL,
	"changed_fields" jsonb,
	"actor_id" uuid,
	"actor_kind" varchar(16) DEFAULT 'user' NOT NULL,
	"ip_address" varchar(45),
	"user_agent" text,
	"request_id" varchar(64),
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"channel" varchar(16) NOT NULL,
	"template" varchar(64) NOT NULL,
	"recipient_user_id" uuid,
	"recipient_address" varchar(200) NOT NULL,
	"subject_table" varchar(64),
	"subject_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" varchar(16) DEFAULT 'queued' NOT NULL,
	"provider_message_id" varchar(120),
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_unit_id_property_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."property_units"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communications" ADD CONSTRAINT "communications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communications" ADD CONSTRAINT "communications_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communications" ADD CONSTRAINT "communications_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communications" ADD CONSTRAINT "communications_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_contacts" ADD CONSTRAINT "customer_contacts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_contacts" ADD CONSTRAINT "customer_contacts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_account_manager_id_users_id_fk" FOREIGN KEY ("account_manager_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_converted_customer_id_customers_id_fk" FOREIGN KEY ("converted_customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "properties" ADD CONSTRAINT "properties_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_units" ADD CONSTRAINT "property_units_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_units" ADD CONSTRAINT "property_units_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_events" ADD CONSTRAINT "attendance_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_events" ADD CONSTRAINT "attendance_events_technician_id_technicians_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."technicians"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_technician_id_technicians_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."technicians"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_approved_by_id_users_id_fk" FOREIGN KEY ("approved_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_technician_id_technicians_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."technicians"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technician_certifications" ADD CONSTRAINT "technician_certifications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technician_certifications" ADD CONSTRAINT "technician_certifications_technician_id_technicians_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."technicians"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technician_locations" ADD CONSTRAINT "technician_locations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technician_locations" ADD CONSTRAINT "technician_locations_technician_id_technicians_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."technicians"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technician_performance" ADD CONSTRAINT "technician_performance_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technician_performance" ADD CONSTRAINT "technician_performance_technician_id_technicians_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."technicians"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technician_skills" ADD CONSTRAINT "technician_skills_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technician_skills" ADD CONSTRAINT "technician_skills_technician_id_technicians_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."technicians"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technician_skills" ADD CONSTRAINT "technician_skills_verified_by_id_users_id_fk" FOREIGN KEY ("verified_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technicians" ADD CONSTRAINT "technicians_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technicians" ADD CONSTRAINT "technicians_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technicians" ADD CONSTRAINT "technicians_deployed_customer_id_customers_id_fk" FOREIGN KEY ("deployed_customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technicians" ADD CONSTRAINT "technicians_deployed_property_id_properties_id_fk" FOREIGN KEY ("deployed_property_id") REFERENCES "public"."properties"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_attachments" ADD CONSTRAINT "job_attachments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_attachments" ADD CONSTRAINT "job_attachments_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_attachments" ADD CONSTRAINT "job_attachments_visit_id_job_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."job_visits"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_attachments" ADD CONSTRAINT "job_attachments_uploaded_by_id_users_id_fk" FOREIGN KEY ("uploaded_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_events" ADD CONSTRAINT "job_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_events" ADD CONSTRAINT "job_events_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_events" ADD CONSTRAINT "job_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_materials" ADD CONSTRAINT "job_materials_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_materials" ADD CONSTRAINT "job_materials_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_materials" ADD CONSTRAINT "job_materials_visit_id_job_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."job_visits"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_reports" ADD CONSTRAINT "job_reports_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_reports" ADD CONSTRAINT "job_reports_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_reports" ADD CONSTRAINT "job_reports_visit_id_job_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."job_visits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_reports" ADD CONSTRAINT "job_reports_ai_summary_approved_by_id_users_id_fk" FOREIGN KEY ("ai_summary_approved_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_signoffs" ADD CONSTRAINT "job_signoffs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_signoffs" ADD CONSTRAINT "job_signoffs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_signoffs" ADD CONSTRAINT "job_signoffs_visit_id_job_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."job_visits"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_visits" ADD CONSTRAINT "job_visits_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_visits" ADD CONSTRAINT "job_visits_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_visits" ADD CONSTRAINT "job_visits_technician_id_technicians_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."technicians"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_visits" ADD CONSTRAINT "job_visits_assigned_by_id_users_id_fk" FOREIGN KEY ("assigned_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_unit_id_property_units_id_fk" FOREIGN KEY ("unit_id") REFERENCES "public"."property_units"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_properties" ADD CONSTRAINT "contract_properties_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_properties" ADD CONSTRAINT "contract_properties_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_properties" ADD CONSTRAINT "contract_properties_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_visits" ADD CONSTRAINT "contract_visits_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_visits" ADD CONSTRAINT "contract_visits_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_visits" ADD CONSTRAINT "contract_visits_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract_visits" ADD CONSTRAINT "contract_visits_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_contract_id_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contracts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_recorded_by_id_users_id_fk" FOREIGN KEY ("recorded_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_prepared_by_id_users_id_fk" FOREIGN KEY ("prepared_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_interactions" ADD CONSTRAINT "ai_interactions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_interactions" ADD CONSTRAINT "ai_interactions_reviewed_by_id_users_id_fk" FOREIGN KEY ("reviewed_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_user_id_users_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_tenant_user_key" ON "memberships" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "memberships_tenant_role_idx" ON "memberships" USING btree ("tenant_id","role");--> statement-breakpoint
CREATE INDEX "memberships_customer_idx" ON "memberships" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_key" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "tenants_domain_key" ON "tenants" USING btree ("domain");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "users_phone_idx" ON "users" USING btree ("phone");--> statement-breakpoint
CREATE UNIQUE INDEX "assets_tenant_tag_key" ON "assets" USING btree ("tenant_id","tag");--> statement-breakpoint
CREATE INDEX "assets_property_idx" ON "assets" USING btree ("tenant_id","property_id");--> statement-breakpoint
CREATE INDEX "assets_due_idx" ON "assets" USING btree ("tenant_id","next_service_due_at");--> statement-breakpoint
CREATE INDEX "communications_customer_idx" ON "communications" USING btree ("tenant_id","customer_id","occurred_at");--> statement-breakpoint
CREATE INDEX "communications_lead_idx" ON "communications" USING btree ("tenant_id","lead_id","occurred_at");--> statement-breakpoint
CREATE INDEX "communications_job_idx" ON "communications" USING btree ("tenant_id","job_id");--> statement-breakpoint
CREATE INDEX "customer_contacts_customer_idx" ON "customer_contacts" USING btree ("tenant_id","customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_tenant_code_key" ON "customers" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE INDEX "customers_tenant_name_idx" ON "customers" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE INDEX "leads_tenant_stage_idx" ON "leads" USING btree ("tenant_id","stage");--> statement-breakpoint
CREATE INDEX "leads_followup_idx" ON "leads" USING btree ("tenant_id","next_follow_up_at");--> statement-breakpoint
CREATE INDEX "leads_tenant_created_idx" ON "leads" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "properties_tenant_customer_idx" ON "properties" USING btree ("tenant_id","customer_id");--> statement-breakpoint
CREATE INDEX "properties_tenant_city_idx" ON "properties" USING btree ("tenant_id","city");--> statement-breakpoint
CREATE INDEX "properties_geo_idx" ON "properties" USING btree ("lat","lng");--> statement-breakpoint
CREATE UNIQUE INDEX "property_units_ref_key" ON "property_units" USING btree ("tenant_id","property_id","reference");--> statement-breakpoint
CREATE INDEX "attendance_tech_time_idx" ON "attendance_events" USING btree ("tenant_id","technician_id","occurred_at");--> statement-breakpoint
CREATE INDEX "leave_tenant_window_idx" ON "leave_requests" USING btree ("tenant_id","starts_on","ends_on","status");--> statement-breakpoint
CREATE INDEX "shifts_tenant_window_idx" ON "shifts" USING btree ("tenant_id","starts_at","ends_at");--> statement-breakpoint
CREATE INDEX "tech_certs_technician_idx" ON "technician_certifications" USING btree ("tenant_id","technician_id");--> statement-breakpoint
CREATE INDEX "tech_certs_expiry_idx" ON "technician_certifications" USING btree ("tenant_id","expires_on");--> statement-breakpoint
CREATE INDEX "tech_locations_latest_idx" ON "technician_locations" USING btree ("tenant_id","technician_id","recorded_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tech_perf_period_key" ON "technician_performance" USING btree ("tenant_id","technician_id","period_start","period_end");--> statement-breakpoint
CREATE UNIQUE INDEX "technician_skills_key" ON "technician_skills" USING btree ("tenant_id","technician_id","service_slug");--> statement-breakpoint
CREATE INDEX "technician_skills_lookup_idx" ON "technician_skills" USING btree ("tenant_id","service_slug","proficiency");--> statement-breakpoint
CREATE UNIQUE INDEX "technicians_tenant_code_key" ON "technicians" USING btree ("tenant_id","employee_code");--> statement-breakpoint
CREATE INDEX "technicians_tenant_trade_idx" ON "technicians" USING btree ("tenant_id","primary_trade","is_active");--> statement-breakpoint
CREATE INDEX "technicians_deployed_idx" ON "technicians" USING btree ("tenant_id","deployed_customer_id");--> statement-breakpoint
CREATE INDEX "job_attachments_job_idx" ON "job_attachments" USING btree ("tenant_id","job_id","kind");--> statement-breakpoint
CREATE INDEX "job_events_job_time_idx" ON "job_events" USING btree ("tenant_id","job_id","occurred_at");--> statement-breakpoint
CREATE INDEX "job_materials_job_idx" ON "job_materials" USING btree ("tenant_id","job_id");--> statement-breakpoint
CREATE INDEX "job_reports_job_idx" ON "job_reports" USING btree ("tenant_id","job_id");--> statement-breakpoint
CREATE INDEX "job_signoffs_job_idx" ON "job_signoffs" USING btree ("tenant_id","job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "job_visits_seq_key" ON "job_visits" USING btree ("tenant_id","job_id","sequence");--> statement-breakpoint
CREATE INDEX "job_visits_tech_window_idx" ON "job_visits" USING btree ("tenant_id","technician_id","scheduled_start");--> statement-breakpoint
CREATE INDEX "job_visits_status_idx" ON "job_visits" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_tenant_reference_key" ON "jobs" USING btree ("tenant_id","reference");--> statement-breakpoint
CREATE INDEX "jobs_board_idx" ON "jobs" USING btree ("tenant_id","status","priority","scheduled_for");--> statement-breakpoint
CREATE INDEX "jobs_customer_idx" ON "jobs" USING btree ("tenant_id","customer_id","created_at");--> statement-breakpoint
CREATE INDEX "jobs_property_idx" ON "jobs" USING btree ("tenant_id","property_id");--> statement-breakpoint
CREATE INDEX "jobs_service_idx" ON "jobs" USING btree ("tenant_id","service_slug");--> statement-breakpoint
CREATE INDEX "jobs_sla_idx" ON "jobs" USING btree ("tenant_id","resolve_by_at","status");--> statement-breakpoint
CREATE INDEX "jobs_contract_idx" ON "jobs" USING btree ("tenant_id","contract_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contract_properties_key" ON "contract_properties" USING btree ("tenant_id","contract_id","property_id");--> statement-breakpoint
CREATE INDEX "contract_visits_due_idx" ON "contract_visits" USING btree ("tenant_id","due_on","status");--> statement-breakpoint
CREATE INDEX "contract_visits_contract_idx" ON "contract_visits" USING btree ("tenant_id","contract_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contracts_tenant_reference_key" ON "contracts" USING btree ("tenant_id","reference");--> statement-breakpoint
CREATE INDEX "contracts_tenant_status_idx" ON "contracts" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "contracts_expiry_idx" ON "contracts" USING btree ("tenant_id","ends_on","status");--> statement-breakpoint
CREATE INDEX "contracts_customer_idx" ON "contracts" USING btree ("tenant_id","customer_id");--> statement-breakpoint
CREATE INDEX "invoice_lines_invoice_idx" ON "invoice_lines" USING btree ("tenant_id","invoice_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_tenant_reference_key" ON "invoices" USING btree ("tenant_id","reference");--> statement-breakpoint
CREATE INDEX "invoices_tenant_status_idx" ON "invoices" USING btree ("tenant_id","status","due_on");--> statement-breakpoint
CREATE INDEX "invoices_customer_idx" ON "invoices" USING btree ("tenant_id","customer_id");--> statement-breakpoint
CREATE INDEX "invoices_ageing_idx" ON "invoices" USING btree ("tenant_id","due_on","status");--> statement-breakpoint
CREATE INDEX "payments_invoice_idx" ON "payments" USING btree ("tenant_id","invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_gateway_key" ON "payments" USING btree ("tenant_id","gateway_provider","gateway_payment_id");--> statement-breakpoint
CREATE INDEX "quote_lines_quote_idx" ON "quote_lines" USING btree ("tenant_id","quote_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "quotes_tenant_reference_key" ON "quotes" USING btree ("tenant_id","reference");--> statement-breakpoint
CREATE INDEX "quotes_tenant_status_idx" ON "quotes" USING btree ("tenant_id","status","created_at");--> statement-breakpoint
CREATE INDEX "quotes_customer_idx" ON "quotes" USING btree ("tenant_id","customer_id");--> statement-breakpoint
CREATE INDEX "ai_interactions_tenant_cap_idx" ON "ai_interactions" USING btree ("tenant_id","capability","occurred_at");--> statement-breakpoint
CREATE INDEX "ai_interactions_subject_idx" ON "ai_interactions" USING btree ("subject_table","subject_id");--> statement-breakpoint
CREATE INDEX "audit_log_tenant_time_idx" ON "audit_log" USING btree ("tenant_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_log_record_idx" ON "audit_log" USING btree ("table_name","record_id");--> statement-breakpoint
CREATE INDEX "audit_log_actor_idx" ON "audit_log" USING btree ("actor_id","occurred_at");--> statement-breakpoint
CREATE INDEX "notifications_status_idx" ON "notifications" USING btree ("tenant_id","status","created_at");--> statement-breakpoint
CREATE INDEX "notifications_subject_idx" ON "notifications" USING btree ("tenant_id","subject_table","subject_id");