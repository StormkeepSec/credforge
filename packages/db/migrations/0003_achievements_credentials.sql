CREATE TABLE "achievement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"issuer_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"criteria_narrative" text,
	"criteria_url" text,
	"achievement_type" text DEFAULT 'Badge' NOT NULL,
	"image_file_id" uuid,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"alignments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"valid_for_days" integer,
	"revision" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_by" uuid,
	"published_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "achievement_status_check" CHECK ("status" in ('draft', 'active', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "achievement_revision" (
	"achievement_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"org_id" uuid NOT NULL,
	"data" jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "achievement_revision_achievement_id_revision_pk" PRIMARY KEY("achievement_id","revision")
);
--> statement-breakpoint
CREATE TABLE "credential" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"issuer_id" uuid NOT NULL,
	"achievement_id" uuid NOT NULL,
	"achievement_revision" integer NOT NULL,
	"image_file_id" uuid,
	"batch_id" uuid,
	"recipient_email" text NOT NULL,
	"recipient_name" text NOT NULL,
	"email_salt" text NOT NULL,
	"status" text DEFAULT 'issued' NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_until" timestamp with time zone,
	"document" jsonb NOT NULL,
	"signing_key_id" uuid NOT NULL,
	"status_list_id" uuid,
	"status_list_index" integer,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"visibility" text DEFAULT 'public' NOT NULL,
	"claim_token_hash" text,
	"claim_token_expires_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revocation_reason" text,
	"replaced_by_id" uuid,
	"issued_by_type" text NOT NULL,
	"issued_by_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credential_claim_token_hash_unique" UNIQUE("claim_token_hash"),
	CONSTRAINT "credential_status_check" CHECK ("status" in ('draft', 'issued', 'revoked')),
	CONSTRAINT "credential_visibility_check" CHECK ("visibility" in ('public', 'hidden')),
	CONSTRAINT "credential_issued_by_type_check" CHECK ("issued_by_type" in ('user', 'api_key'))
);
--> statement-breakpoint
CREATE TABLE "email_message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"credential_id" uuid,
	"kind" text NOT NULL,
	"to_email" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"transport" text,
	"provider_message_id" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"bounced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_message_status_check" CHECK ("status" in ('queued', 'sent', 'delivered', 'bounced', 'dropped', 'spam_reported', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "file" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"subject_id" uuid,
	"driver" text NOT NULL,
	"bucket" text,
	"key" text NOT NULL,
	"mime_type" text NOT NULL,
	"size" integer NOT NULL,
	"sha256" text NOT NULL,
	"width" integer,
	"height" integer,
	"variants" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"visibility" text NOT NULL,
	"retain" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "file_kind_check" CHECK ("kind" in ('issuer_logo', 'badge_image', 'csv_import', 'export')),
	CONSTRAINT "file_visibility_check" CHECK ("visibility" in ('public', 'private')),
	CONSTRAINT "file_driver_check" CHECK ("driver" in ('local', 's3'))
);
--> statement-breakpoint
CREATE TABLE "status_list" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"issuer_id" uuid NOT NULL,
	"list_number" integer NOT NULL,
	"purpose" text DEFAULT 'revocation' NOT NULL,
	"size" integer NOT NULL,
	"allocated" "bytea" NOT NULL,
	"allocated_count" integer DEFAULT 0 NOT NULL,
	"statuses" "bytea" NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"document" jsonb NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "status_list_purpose_check" CHECK ("purpose" in ('revocation', 'suspension'))
);
--> statement-breakpoint
ALTER TABLE "issuer" ADD COLUMN "image_file_id" uuid;--> statement-breakpoint
ALTER TABLE "organization" ADD COLUMN "daily_send_limit" integer;--> statement-breakpoint
ALTER TABLE "achievement" ADD CONSTRAINT "achievement_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "achievement" ADD CONSTRAINT "achievement_issuer_id_issuer_id_fk" FOREIGN KEY ("issuer_id") REFERENCES "public"."issuer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "achievement" ADD CONSTRAINT "achievement_image_file_id_file_id_fk" FOREIGN KEY ("image_file_id") REFERENCES "public"."file"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "achievement" ADD CONSTRAINT "achievement_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "achievement_revision" ADD CONSTRAINT "achievement_revision_achievement_id_achievement_id_fk" FOREIGN KEY ("achievement_id") REFERENCES "public"."achievement"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "achievement_revision" ADD CONSTRAINT "achievement_revision_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "achievement_revision" ADD CONSTRAINT "achievement_revision_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential" ADD CONSTRAINT "credential_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential" ADD CONSTRAINT "credential_issuer_id_issuer_id_fk" FOREIGN KEY ("issuer_id") REFERENCES "public"."issuer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential" ADD CONSTRAINT "credential_achievement_id_achievement_id_fk" FOREIGN KEY ("achievement_id") REFERENCES "public"."achievement"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential" ADD CONSTRAINT "credential_image_file_id_file_id_fk" FOREIGN KEY ("image_file_id") REFERENCES "public"."file"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential" ADD CONSTRAINT "credential_signing_key_id_signing_key_id_fk" FOREIGN KEY ("signing_key_id") REFERENCES "public"."signing_key"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential" ADD CONSTRAINT "credential_status_list_id_status_list_id_fk" FOREIGN KEY ("status_list_id") REFERENCES "public"."status_list"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential" ADD CONSTRAINT "credential_replaced_by_id_credential_id_fk" FOREIGN KEY ("replaced_by_id") REFERENCES "public"."credential"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_message" ADD CONSTRAINT "email_message_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_message" ADD CONSTRAINT "email_message_credential_id_credential_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credential"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file" ADD CONSTRAINT "file_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file" ADD CONSTRAINT "file_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_list" ADD CONSTRAINT "status_list_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_list" ADD CONSTRAINT "status_list_issuer_id_issuer_id_fk" FOREIGN KEY ("issuer_id") REFERENCES "public"."issuer"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "achievement_org_idx" ON "achievement" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "achievement_issuer_idx" ON "achievement" USING btree ("issuer_id");--> statement-breakpoint
CREATE INDEX "credential_org_created_idx" ON "credential" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "credential_achievement_idx" ON "credential" USING btree ("achievement_id");--> statement-breakpoint
CREATE INDEX "credential_org_email_idx" ON "credential" USING btree ("org_id","recipient_email");--> statement-breakpoint
CREATE UNIQUE INDEX "credential_status_entry_idx" ON "credential" USING btree ("status_list_id","status_list_index");--> statement-breakpoint
CREATE INDEX "email_message_credential_idx" ON "email_message" USING btree ("credential_id");--> statement-breakpoint
CREATE INDEX "email_message_org_created_idx" ON "email_message" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "email_message_provider_id_idx" ON "email_message" USING btree ("provider_message_id");--> statement-breakpoint
CREATE INDEX "file_org_id_idx" ON "file" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "file_subject_sha256_idx" ON "file" USING btree ("kind","subject_id","sha256") WHERE "file"."subject_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "status_list_issuer_number_idx" ON "status_list" USING btree ("issuer_id","list_number");--> statement-breakpoint
ALTER TABLE "issuer" ADD CONSTRAINT "issuer_image_file_id_file_id_fk" FOREIGN KEY ("image_file_id") REFERENCES "public"."file"("id") ON DELETE no action ON UPDATE no action;