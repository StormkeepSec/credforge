#!/usr/bin/env bash
# Nightly credforge database backup (design plan §13.4).
#
# Dumps PostgreSQL with pg_dump (inside the db container, so the client matches the server),
# checks that pg_restore can read the dump, then hands it to the "backup" compose service, which
# encrypts it (with a key derived from CREDFORGE_MASTER_KEY) and uploads it to the backups bucket
# with its own limited key (backup.env), and deletes backups past their retention.
#
# Run it from the directory with docker-compose.yml, .env and backup.env, or set CREDFORGE_DIR.
# The systemd timer in deploy/systemd runs it every night. Exit status 0 means the backup is in
# the bucket. Nothing secret is printed.
set -euo pipefail

cd "${CREDFORGE_DIR:-$(dirname "$(readlink -f "$0")")/..}"
compose=(docker compose)
[[ -n "${COMPOSE_PROJECT_NAME:-}" ]] && compose+=(-p "$COMPOSE_PROJECT_NAME")

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
name="credforge-${stamp}.dump"
work="$(mktemp -d "${TMPDIR:-/tmp}/credforge-backup.XXXXXX")"
trap 'rm -rf "$work"' EXIT
chmod 700 "$work"

echo "$(date -u +%FT%TZ) dumping the database"
"${compose[@]}" exec -T db pg_dump --username=credforge --dbname=credforge \
  --format=custom --compress=9 >"$work/$name"

# A truncated or unreadable dump must never replace a good one.
"${compose[@]}" exec -T db pg_restore --list <"$work/$name" >/dev/null
echo "$(date -u +%FT%TZ) dump OK ($(stat -c %s "$work/$name") bytes), uploading"

"${compose[@]}" --profile backup run --rm -T --no-deps backup \
  node dist/backup.js upload --name "$name" <"$work/$name"
echo "$(date -u +%FT%TZ) backup ${name} done"
