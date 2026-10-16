ALTER TABLE "credential" ALTER COLUMN "recipient_email" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "credential" ALTER COLUMN "recipient_name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "credential" ALTER COLUMN "email_salt" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "credential" ALTER COLUMN "document" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "email_message" ALTER COLUMN "to_email" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "credential" ADD COLUMN "audit_key" "bytea";--> statement-breakpoint
ALTER TABLE "credential" ADD COLUMN "erased_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issuance_batch_row" ADD COLUMN "erased_at" timestamp with time zone;--> statement-breakpoint
-- An audit key for every credential issued so far (design plan §12.1): 32 bytes from two
-- gen_random_uuid() values (Postgres's strong random source; 244 random bits), so no extension is
-- needed. migrate then seals what earlier audit events say about recipients with these keys, once.
UPDATE "credential" SET "audit_key" = decode(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'hex') WHERE "audit_key" IS NULL;--> statement-breakpoint
ALTER TABLE "credential" ADD CONSTRAINT "credential_erased_check" CHECK ("erased_at" is not null or ("document" is not null and "recipient_email" is not null and "recipient_name" is not null and "email_salt" is not null and "audit_key" is not null));
