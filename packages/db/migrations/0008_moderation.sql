CREATE TABLE "content_report" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"category" text NOT NULL,
	"details" text,
	"reporter_email" text,
	"status" text DEFAULT 'open' NOT NULL,
	"held_item_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"resolution_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_report_target_check" CHECK ("target_type" in ('credential', 'achievement', 'issuer')),
	CONSTRAINT "content_report_category_check" CHECK ("category" in ('child_safety', 'sexual_content', 'hate_harassment', 'violence', 'impersonation', 'scam_phishing', 'personal_data', 'other')),
	CONSTRAINT "content_report_status_check" CHECK ("status" in ('open', 'resolved', 'dismissed'))
);
--> statement-breakpoint
CREATE TABLE "moderation_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"file_id" uuid,
	"content" jsonb,
	"content_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"submitted_by" uuid,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" uuid,
	"decision_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "moderation_item_kind_check" CHECK ("kind" in ('image', 'text')),
	CONSTRAINT "moderation_item_subject_check" CHECK ("subject_type" in ('organization', 'issuer', 'achievement')),
	CONSTRAINT "moderation_item_status_check" CHECK ("status" in ('pending', 'cleared', 'removed')),
	CONSTRAINT "moderation_item_shape_check" CHECK (("kind" = 'image' and "file_id" is not null) or ("kind" = 'text' and "content" is not null))
);
--> statement-breakpoint
ALTER TABLE "achievement" ADD COLUMN "text_item_id" uuid;--> statement-breakpoint
ALTER TABLE "achievement" ADD COLUMN "removed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "achievement" ADD COLUMN "removed_by" uuid;--> statement-breakpoint
ALTER TABLE "achievement" ADD COLUMN "removed_reason" text;--> statement-breakpoint
ALTER TABLE "credential" ADD COLUMN "held_item_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "issuer" ADD COLUMN "text_item_id" uuid;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "trusted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "trusted_by" uuid;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "name_item_id" uuid;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "upload_rate_limit" integer;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "storage_quota_mb" integer;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "disabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "disabled_reason" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "disabled_by" uuid;--> statement-breakpoint
ALTER TABLE "content_report" ADD CONSTRAINT "content_report_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_report" ADD CONSTRAINT "content_report_resolved_by_user_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_item" ADD CONSTRAINT "moderation_item_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_item" ADD CONSTRAINT "moderation_item_file_id_file_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."file"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_item" ADD CONSTRAINT "moderation_item_submitted_by_user_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_item" ADD CONSTRAINT "moderation_item_decided_by_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "content_report_open_idx" ON "content_report" USING btree ("created_at") WHERE "content_report"."status" = 'open';--> statement-breakpoint
CREATE INDEX "content_report_org_idx" ON "content_report" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "moderation_item_org_idx" ON "moderation_item" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "moderation_item_subject_idx" ON "moderation_item" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "moderation_item_pending_idx" ON "moderation_item" USING btree ("created_at") WHERE "moderation_item"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "moderation_item_file_idx" ON "moderation_item" USING btree ("file_id") WHERE "moderation_item"."file_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "moderation_item_text_idx" ON "moderation_item" USING btree ("subject_type","subject_id","content_hash") WHERE "moderation_item"."kind" = 'text';--> statement-breakpoint
ALTER TABLE "achievement" ADD CONSTRAINT "achievement_text_item_id_moderation_item_id_fk" FOREIGN KEY ("text_item_id") REFERENCES "public"."moderation_item"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "achievement" ADD CONSTRAINT "achievement_removed_by_user_id_fk" FOREIGN KEY ("removed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issuer" ADD CONSTRAINT "issuer_text_item_id_moderation_item_id_fk" FOREIGN KEY ("text_item_id") REFERENCES "public"."moderation_item"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization" ADD CONSTRAINT "organization_trusted_by_user_id_fk" FOREIGN KEY ("trusted_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization" ADD CONSTRAINT "organization_name_item_id_moderation_item_id_fk" FOREIGN KEY ("name_item_id") REFERENCES "public"."moderation_item"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_disabled_by_user_id_fk" FOREIGN KEY ("disabled_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credential_held_idx" ON "credential" USING btree ("org_id") WHERE "credential"."held_item_ids" <> '{}'::uuid[];