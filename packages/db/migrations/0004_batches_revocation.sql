CREATE TABLE "issuance_batch" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"achievement_id" uuid NOT NULL,
	"source" text NOT NULL,
	"file_id" uuid,
	"file_name" text,
	"has_header" boolean DEFAULT true NOT NULL,
	"columns" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"options" jsonb DEFAULT '{"sendEmail":true,"awardExisting":false}'::jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"total_rows" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_by_type" text NOT NULL,
	"created_by_id" text,
	"confirmed_by_id" text,
	"confirmed_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issuance_batch_status_check" CHECK ("status" in ('draft', 'queued', 'running', 'completed', 'failed')),
	CONSTRAINT "issuance_batch_source_check" CHECK ("source" in ('csv', 'api')),
	CONSTRAINT "issuance_batch_created_by_type_check" CHECK ("created_by_type" in ('user', 'api_key'))
);
--> statement-breakpoint
CREATE TABLE "issuance_batch_row" (
	"batch_id" uuid NOT NULL,
	"row_number" integer NOT NULL,
	"org_id" uuid NOT NULL,
	"cells" jsonb NOT NULL,
	"values" jsonb,
	"validation" text DEFAULT 'invalid' NOT NULL,
	"issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"credential_id" uuid,
	"error_code" text,
	"error_message" text,
	"processed_at" timestamp with time zone,
	CONSTRAINT "issuance_batch_row_batch_id_row_number_pk" PRIMARY KEY("batch_id","row_number"),
	CONSTRAINT "issuance_batch_row_validation_check" CHECK ("validation" in ('ready', 'invalid', 'duplicate', 'existing')),
	CONSTRAINT "issuance_batch_row_status_check" CHECK ("status" in ('draft', 'pending', 'issued', 'failed', 'skipped'))
);
--> statement-breakpoint
ALTER TABLE "credential" ADD COLUMN "batch_row_number" integer;--> statement-breakpoint
ALTER TABLE "credential" ADD COLUMN "revocation_public_reason" text;--> statement-breakpoint
ALTER TABLE "credential" ADD COLUMN "revocation_kind" text;--> statement-breakpoint
ALTER TABLE "credential" ADD COLUMN "replaces_id" uuid;--> statement-breakpoint
ALTER TABLE "credential" ADD COLUMN "custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "status_list" ADD COLUMN "needs_publish" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "issuance_batch" ADD CONSTRAINT "issuance_batch_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issuance_batch" ADD CONSTRAINT "issuance_batch_achievement_id_achievement_id_fk" FOREIGN KEY ("achievement_id") REFERENCES "public"."achievement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issuance_batch" ADD CONSTRAINT "issuance_batch_file_id_file_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."file"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issuance_batch_row" ADD CONSTRAINT "issuance_batch_row_batch_id_issuance_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."issuance_batch"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issuance_batch_row" ADD CONSTRAINT "issuance_batch_row_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issuance_batch_row" ADD CONSTRAINT "issuance_batch_row_credential_id_credential_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credential"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issuance_batch_org_created_idx" ON "issuance_batch" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "issuance_batch_active_idx" ON "issuance_batch" USING btree ("status") WHERE "issuance_batch"."status" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "issuance_batch_row_status_idx" ON "issuance_batch_row" USING btree ("batch_id","status");--> statement-breakpoint
ALTER TABLE "credential" ADD CONSTRAINT "credential_batch_id_issuance_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."issuance_batch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential" ADD CONSTRAINT "credential_replaces_id_credential_id_fk" FOREIGN KEY ("replaces_id") REFERENCES "public"."credential"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credential_org_batch_idx" ON "credential" USING btree ("org_id","batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "credential_batch_row_idx" ON "credential" USING btree ("batch_id","batch_row_number") WHERE "credential"."batch_id" is not null;--> statement-breakpoint
CREATE INDEX "status_list_needs_publish_idx" ON "status_list" USING btree ("id") WHERE "status_list"."needs_publish";--> statement-breakpoint
ALTER TABLE "credential" ADD CONSTRAINT "credential_revocation_kind_check" CHECK ("revocation_kind" is null or "revocation_kind" in ('revoked', 'superseded'));