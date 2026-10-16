#!/usr/bin/env bash
# Restores the credforge database from a backup (docs/restore-drill.md walks through it).
#
#   deploy/restore.sh latest                         newest backup in the bucket
#   deploy/restore.sh postgres/credforge-….cfbak     a backup by its key (deploy/backup.sh list)
#   deploy/restore.sh --dump file.dump               a plain pg_dump file you already have
#   deploy/restore.sh list                           list the backups in the bucket
#
# It REPLACES the stack's database: stops app and worker, drops and recreates the database,
# restores the dump in one transaction, migrates (which re-creates the app's database role and
# its grants), erases again every recipient erased since the backup was taken (their erasure
# records are in the files bucket), then starts the stack. CREDFORGE_MASTER_KEY in .env must be
# the key the backup was made with: it decrypts the backup and every issuer's signing key.
#
# Run it from the directory with docker-compose.yml, .env and backup.env, or set CREDFORGE_DIR.
# It asks before replacing anything unless --yes is given.
set -euo pipefail

cd "${CREDFORGE_DIR:-$(dirname "$(readlink -f "$0")")/..}"
compose=(docker compose)
[[ -n "${COMPOSE_PROJECT_NAME:-}" ]] && compose+=(-p "$COMPOSE_PROJECT_NAME")
backup_tool=("${compose[@]}" --profile backup run --rm -T --no-deps backup node dist/backup.js)

yes=false
source=""
dump_file=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --yes) yes=true ;;
    --dump) dump_file="$2"; shift ;;
    list) "${backup_tool[@]}" list; exit 0 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) source="$1" ;;
  esac
  shift
done
if [[ -z "$source" && -z "$dump_file" ]]; then
  sed -n '2,16p' "$0"
  exit 2
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/credforge-restore.XXXXXX")"
trap 'rm -rf "$work"' EXIT
chmod 700 "$work"

if [[ -n "$dump_file" ]]; then
  cp "$dump_file" "$work/restore.dump"
else
  echo "Downloading and decrypting ${source}…"
  "${backup_tool[@]}" download --key "$source" >"$work/restore.dump"
fi
"${compose[@]}" up -d --wait db
"${compose[@]}" exec -T db pg_restore --list <"$work/restore.dump" >/dev/null
echo "The dump is readable ($(stat -c %s "$work/restore.dump") bytes)."

if [[ "$yes" != true ]]; then
  read -r -p "Replace the credforge database of the stack in $PWD${COMPOSE_PROJECT_NAME:+ (project $COMPOSE_PROJECT_NAME)}? Type yes: " answer
  [[ "$answer" == yes ]] || { echo "Nothing changed."; exit 1; }
fi

echo "Stopping app and worker…"
"${compose[@]}" stop app worker
echo "Replacing the database…"
"${compose[@]}" exec -T db dropdb --username=credforge --if-exists --force credforge
"${compose[@]}" exec -T db createdb --username=credforge --owner=credforge credforge
"${compose[@]}" exec -T db pg_restore --username=credforge --dbname=credforge \
  --no-owner --no-privileges --exit-on-error --single-transaction <"$work/restore.dump"
echo "Migrating (re-creates the app's role and grants)…"
"${compose[@]}" run --rm migrate
# A backup older than an erasure brings that person's data back (design plan §12.1).
echo "Erasing again the recipients erased since this backup was taken…"
"${compose[@]}" run --rm --no-deps -T app node dist/cli.js reapply-erasures
echo "Starting the stack…"
"${compose[@]}" up -d
for _ in $(seq 1 30); do
  if "${compose[@]}" exec -T app node dist/healthcheck.js >/dev/null 2>&1; then
    echo "Restored, and the app is ready."
    exit 0
  fi
  sleep 2
done
echo "Restored, but the app isn't ready yet: check docker compose logs app migrate." >&2
exit 1
