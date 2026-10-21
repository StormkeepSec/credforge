CREATE TABLE "moderation_evidence" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"file_id" uuid,
	"content_sha256" text NOT NULL,
	"source" text NOT NULL,
	"matcher" text NOT NULL,
	"key_fingerprint" text NOT NULL,
	"envelope" "bytea" NOT NULL,
	"envelope_sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "moderation_evidence_source_check" CHECK ("source" in ('matcher', 'operator'))
);
--> statement-breakpoint
ALTER TABLE "moderation_item" ADD COLUMN "scan_status" text;--> statement-breakpoint
ALTER TABLE "moderation_item" ADD COLUMN "scan_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "moderation_item" ADD COLUMN "scanned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "moderation_item" ADD COLUMN "scan_result" jsonb;--> statement-breakpoint
ALTER TABLE "moderation_evidence" ADD CONSTRAINT "moderation_evidence_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_evidence" ADD CONSTRAINT "moderation_evidence_item_id_moderation_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."moderation_item"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "moderation_evidence_org_idx" ON "moderation_evidence" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "moderation_evidence_item_idx" ON "moderation_evidence" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "moderation_item_scan_waiting_idx" ON "moderation_item" USING btree ("created_at") WHERE "moderation_item"."scan_status" = 'waiting';--> statement-breakpoint
ALTER TABLE "moderation_item" ADD CONSTRAINT "moderation_item_scan_status_check" CHECK ("scan_status" is null or "scan_status" in ('waiting', 'done', 'failed'));--> statement-breakpoint
-- Known-CSAM evidence is never changed once written (design plan §6.5, decision 61). The app's
-- database role can only insert it and read its plain columns (packages/db/src/app-role.ts); this
-- trigger refuses updates for every role, the owner included. Only the owner may delete a row,
-- once the law no longer requires it to be kept.
CREATE FUNCTION "moderation_evidence_unchanged"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'moderation_evidence is never changed: % is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "moderation_evidence_no_update"
  BEFORE UPDATE ON "moderation_evidence"
  FOR EACH ROW EXECUTE FUNCTION "moderation_evidence_unchanged"();
