CREATE TABLE "api_key" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"scopes" jsonb NOT NULL,
	"created_by" uuid,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"last_used_ip" text,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_key_prefix_unique" UNIQUE("prefix")
);
--> statement-breakpoint
ALTER TABLE "issuance_batch" ADD COLUMN "confirmed_by_type" text;--> statement-breakpoint
ALTER TABLE "issuer" ADD COLUMN "domain_token" text;--> statement-breakpoint
ALTER TABLE "issuer" ADD COLUMN "domain" text;--> statement-breakpoint
ALTER TABLE "issuer" ADD COLUMN "domain_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issuer" ADD COLUMN "domain_verification_method" text;--> statement-breakpoint
ALTER TABLE "issuer" ADD COLUMN "domain_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issuer" ADD COLUMN "domain_check_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_revoked_by_user_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_key_org_idx" ON "api_key" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "issuer_domain_verified_idx" ON "issuer" USING btree ("domain_checked_at") WHERE "issuer"."domain_verified_at" is not null;--> statement-breakpoint
ALTER TABLE "issuance_batch" ADD CONSTRAINT "issuance_batch_confirmed_by_type_check" CHECK ("confirmed_by_type" is null or "confirmed_by_type" in ('user', 'api_key'));--> statement-breakpoint
ALTER TABLE "issuer" ADD CONSTRAINT "issuer_domain_verification_method_check" CHECK ("domain_verification_method" is null or "domain_verification_method" in ('dns', 'file'));--> statement-breakpoint
-- Batches confirmed before M5 were confirmed by people.
UPDATE "issuance_batch" SET "confirmed_by_type" = 'user' WHERE "confirmed_by_id" IS NOT NULL;