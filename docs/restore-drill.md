# Backups and the restore drill

credforge's database is backed up every night to its own bucket, and restoring it is a practised
procedure, not a hope. This page says what is backed up, how to set it up, how to restore, and
records the drill that was run (design plan §13.4).

## What is backed up, and what isn't

| What | How |
|---|---|
| **The PostgreSQL database** (accounts, organizations, issuers and their encrypted signing keys, achievements, every signed credential, status lists, the audit log, API key hashes, the job queue) | `deploy/backup.sh` every night: `pg_dump` (custom format) → encrypted → the `credforge-backups` bucket |
| **Badge images and logos** | Not in the dump. On credforge.app they live in the `credforge-prod` Space, which has versioning on (§13.5). With `STORAGE_DRIVER=local` they are in the `uploads` volume: back it up yourself |
| **`CREDFORGE_MASTER_KEY`** | **Not in any backup, on purpose.** Keep it offline (a password manager, and a printed copy in a safe place). Without it a backup can't be decrypted, no issuer key can sign, and revocations can't be published |
| **`.env` and `backup.env`** | Keep a copy offline with the master key. Every other secret in them can be rotated; the master key and `AUTH_SECRET` (it encrypts two-step verification secrets) can't |

### How a backup is protected

- The dump is encrypted with AES-256-GCM before it leaves the server, under a key derived
  (HKDF-SHA256, a random salt per backup) from `CREDFORGE_MASTER_KEY`. A backup is useless without
  the master key anyway, so no second secret has to be kept. Decrypting checks the GCM tag first:
  a damaged or altered backup, or the wrong key, is refused before anything reaches `pg_restore`.
- The bucket is private, and the backup uses its own limited access key (Read/Write/Delete on
  `credforge-backups` only), in `backup.env`, which only the `backup` compose service reads. The
  app and worker never hold it.
- Backups older than `BACKUP_RETENTION_DAYS` (30) are deleted after each upload, but the newest
  `BACKUP_KEEP_MIN` (7) always stay, so a stretch of failed nights never leaves none behind.

## Set it up (once, on the droplet)

1. **Spaces** (the README's checklist): a `credforge-backups` Space in `sfo3`, File Listing
   restricted, and a limited access key with Read/Write/Delete on it only.
2. **`backup.env`** next to `.env`, from `backup.env.example`:

   ```bash
   cp backup.env.example backup.env
   chmod 600 backup.env
   # fill in BACKUP_S3_ACCESS_KEY_ID and BACKUP_S3_SECRET_ACCESS_KEY
   ```

3. **The nightly timer** (03:17 UTC, plus a run at boot if one was missed). The unit assumes
   credforge lives in `/opt/credforge`; edit `WorkingDirectory` and the paths otherwise.

   ```bash
   sudo cp deploy/systemd/credforge-backup.service deploy/systemd/credforge-backup.timer /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now credforge-backup.timer
   ```

4. **Run one now and look at it:**

   ```bash
   sudo systemctl start credforge-backup.service
   journalctl -u credforge-backup -n 20
   bash deploy/restore.sh list
   ```

`systemctl list-timers credforge-backup.timer` shows the next run. A failed run is in
`journalctl -u credforge-backup` and leaves the previous backups untouched.

## Restore

`deploy/restore.sh` replaces the stack's database with a backup. It downloads and decrypts the
backup (inside the `backup` service), checks that `pg_restore` can read it, asks before going on,
stops `app` and `worker`, drops and recreates the database, restores the dump in one transaction,
and starts the stack: `migrate` then re-creates the app's restricted role and its grants.

```bash
cd /opt/credforge
bash deploy/restore.sh list                          # the backups, newest first
bash deploy/restore.sh latest                        # or a key from the list
bash deploy/restore.sh --dump /path/to/file.dump     # a plain pg_dump file you already have
```

**On a new droplet** (the old one is gone): install Docker, load the image (`deploy/ship.sh`), put
the saved `.env` and `backup.env` in place (same `CREDFORGE_MASTER_KEY`, `AUTH_SECRET` and
`PUBLIC_BASE_URL`), then run `bash deploy/restore.sh latest`. It starts an empty database first.
Then point DNS at the new droplet. Badge images are still in Spaces; nothing else needs restoring.

**Without the droplet tooling** (from any machine with Docker and the image), the same steps by
hand: `docker compose run --rm -T backup node dist/backup.js download --key latest > db.dump`, then
`pg_restore --no-owner --no-privileges --exit-on-error --single-transaction -d credforge` into an
empty database owned by the owner role, then `docker compose up -d`.

After any restore, check:

- `curl -fsS http://127.0.0.1:3000/readyz` answers `ready`;
- you can sign in, and an organization's awarded badges are listed;
- a badge's page and `/verify` report it as before (a revoked one still revoked);
- awarding a badge works (the master key decrypts the issuer's signing key);
- the worker publishes: revoke a test badge and see its status list change within seconds.

## The drill, as run (2026-10-15)

Run on the development machine against throwaway stacks built from the production image, so the
real `.env`, the development stack and the owner's data were never involved. Adobe's S3Mock stood
in for the Space (the backup tool only speaks the S3 API); the scripts were the ones above,
unchanged.

1. **Source stack** (`credforge-drill`, port 3101, generated secrets): through the API, an account,
   an organization, an issuer, an achievement with SVG artwork, three badges, one of them revoked
   (the worker re-signed the status list), and an API key.
2. **Backup:** `deploy/backup.sh` dumped the database (135,288 bytes), `pg_restore --list` read it,
   and the `backup` service uploaded it encrypted (135,342 bytes: 54 bytes of header and tag).
3. **Wrong key:** downloading with a different `CREDFORGE_MASTER_KEY` failed with "The backup
   couldn't be decrypted" and wrote nothing.
4. **Restore into a fresh stack** (`credforge-drill-restore`, port 3102, empty volumes, the same
   `.env`): `deploy/restore.sh latest --yes` finished in 16 seconds with the app ready.
5. **Checks on the restored stack, all passed (16 of 16):** the owner signed in with their
   password; the same three badges were listed; each signed credential, the signed status list and
   the issuer profile with its keys were byte for byte what the source served; the badge page
   rendered; the audit log had all 11 events; the API key worked; a new badge was signed with the
   restored issuer key; `/api/v1/verify` reported the two valid badges verified and the revoked one
   revoked; revoking another badge worked and the worker re-signed the list (the job queue came
   back too).
6. **Still append-only:** after the restore, `UPDATE audit_event` as the app's role was refused
   (`permission denied`), and `DELETE` as the owner was stopped by the trigger.
7. **Multipart:** a 40 MB upload went up in three parts and came back with the same SHA-256.

The stacks, volumes, the stand-in and the generated secrets were deleted afterwards.

**Repeat the drill** after the first deploy (restore last night's backup into a throwaway stack on
your PC or a scratch droplet), and then every few months and after any change to the database or
the backup scripts.
