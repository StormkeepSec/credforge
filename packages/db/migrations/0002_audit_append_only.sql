-- The audit log is append-only (design plan §7, §12). The app's database role is also never
-- granted UPDATE, DELETE or TRUNCATE on it (packages/db/src/app-role.ts); these triggers stop
-- every other role too, including the owner that runs migrations.
CREATE FUNCTION "audit_event_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_event is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "audit_event_no_update_delete"
  BEFORE UPDATE OR DELETE ON "audit_event"
  FOR EACH ROW EXECUTE FUNCTION "audit_event_append_only"();
--> statement-breakpoint
CREATE TRIGGER "audit_event_no_truncate"
  BEFORE TRUNCATE ON "audit_event"
  FOR EACH STATEMENT EXECUTE FUNCTION "audit_event_append_only"();
