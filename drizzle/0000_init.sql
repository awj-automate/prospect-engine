CREATE TYPE "public"."brief_status" AS ENUM('generating', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."job_kind" AS ENUM('person', 'company_resolve', 'company', 'contact');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('pending', 'processing', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."sync_status" AS ENUM('running', 'done', 'failed');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"leadshark_id" text NOT NULL,
	"name" text,
	"first_name" text,
	"title" text,
	"linkedin_url" text,
	"linkedin_username" text,
	"commenter_id" text,
	"source" text,
	"lead_type" text,
	"post_id" text,
	"icp_score" real,
	"icp_fit" text,
	"icp_analysis" jsonb,
	"engagements" jsonb DEFAULT '[]'::jsonb,
	"archived" boolean DEFAULT false NOT NULL,
	"ls_created_at" timestamp with time zone,
	"ls_updated_at" timestamp with time zone,
	"heat_score" real,
	"signal_count" integer,
	"signal_breakdown" jsonb,
	"top_signals" jsonb DEFAULT '[]'::jsonb,
	"connection_status" text,
	"score" real,
	"score_breakdown" jsonb,
	"last_engagement_at" timestamp with time zone,
	"person_enriched" jsonb,
	"person_enriched_at" timestamp with time zone,
	"company_slug" text,
	"company_enriched" jsonb,
	"company_enriched_at" timestamp with time zone,
	"email" text,
	"phone" text,
	"contact_enriched_at" timestamp with time zone,
	"contact_source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "leads_leadshark_id_unique" UNIQUE("leadshark_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "enrichment_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
	"kind" "job_kind" NOT NULL,
	"status" "job_status" DEFAULT 'pending' NOT NULL,
	"priority" real DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"scheduled_for" timestamp with time zone DEFAULT now() NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "daily_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"date" date NOT NULL,
	"kind" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "research_briefs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
	"status" "brief_status" DEFAULT 'generating' NOT NULL,
	"content" text,
	"structured" jsonb,
	"citations" jsonb DEFAULT '[]'::jsonb,
	"model" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"leads_upserted" integer DEFAULT 0 NOT NULL,
	"signals_updated" integer DEFAULT 0 NOT NULL,
	"status" "sync_status" DEFAULT 'running' NOT NULL,
	"error" text
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "enrichment_jobs" ADD CONSTRAINT "enrichment_jobs_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "research_briefs" ADD CONSTRAINT "research_briefs_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "leads_commenter_id_idx" ON "leads" USING btree ("commenter_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "leads_score_idx" ON "leads" USING btree ("score");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "leads_icp_fit_idx" ON "leads" USING btree ("icp_fit");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "enrichment_jobs_lead_kind_unq" ON "enrichment_jobs" USING btree ("lead_id","kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "enrichment_jobs_status_priority_idx" ON "enrichment_jobs" USING btree ("status","priority");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "daily_usage_date_kind_unq" ON "daily_usage" USING btree ("date","kind");
