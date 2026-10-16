#!/usr/bin/env bash
# Builds the credforge image on this machine and ships it to the server over SSH, with no registry
# (design plan §13.3, decision 35). Works from Git Bash on Windows, and on macOS and Linux.
#
#   deploy/ship.sh user@droplet               build, ship and restart the stack
#   CREDFORGE_SSH=credforge deploy/ship.sh    the same, with the host (or an ~/.ssh/config alias)
#                                             from the environment
#
# Options:
#   --tag TAG     image tag (default: <UTC date>-<time>-<commit>, plus -dirty with uncommitted changes)
#   --no-build    ship an image that is already built here (needs --tag). Rolling back to an image
#                 the server still has: deploy/ship.sh --no-build --tag <older tag> user@droplet
#   --no-up       load the image and copy the files, but leave the running stack alone
#   --dir DIR     the stack's directory on the server (default /opt/credforge, or CREDFORGE_DIR)
#   --keep N      how many credforge images to keep on the server (default 3)
#
# CREDFORGE_SSH_OPTS adds ssh options, e.g. "-i ~/.ssh/credforge -p 2222".
#
# Steps:
#   1. checks the server: Docker and Compose, the directory, .env present with mode 600, disk space
#   2. docker build --platform linux/amd64 --pull -t credforge:TAG .
#   3. docker save credforge:TAG | gzip | ssh … docker load    (skipped when the server has it)
#   4. copies docker-compose.yml, the backup scripts and units in deploy/, and the example
#      configuration files to DIR (keep server-side changes in DIR/docker-compose.override.yml)
#   5. tags the image credforge:latest there and runs the migration on its own while the old app
#      and worker keep running (if it fails, they stay, and latest goes back to the old image);
#      then docker compose up -d recreates app and worker, and it waits until the app is ready
#   6. removes credforge images older than the newest N
#
# It never reads or prints .env or backup.env: secrets stay on the server. The SSH user must be
# able to run docker (be in the docker group). Three SSH connections are made.
set -euo pipefail

usage() { awk 'NR > 1 && !/^#/ { exit } NR > 1 { sub(/^# ?/, ""); print }' "$0"; }
die() { echo "ship: $*" >&2; exit 1; }
step() { echo "==> $*"; }

host="${CREDFORGE_SSH:-}"
dir="${CREDFORGE_DIR:-/opt/credforge}"
tag=""
build=true
up=true
keep=3
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag) tag="${2:?--tag needs a value}"; shift ;;
    --no-build) build=false ;;
    --no-up) up=false ;;
    --dir) dir="${2:?--dir needs a value}"; shift ;;
    --keep) keep="${2:?--keep needs a value}"; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) die "unknown option $1 (see --help)" ;;
    *) host="$1" ;;
  esac
  shift
done

[[ -n "$host" ]] || { usage; exit 2; }
[[ "$keep" =~ ^[1-9][0-9]*$ ]] || die "--keep must be a positive number"
[[ "$dir" =~ ^/[A-Za-z0-9._/-]+$ ]] || die "--dir must be an absolute path without spaces"
[[ "$host" =~ ^[A-Za-z0-9._@:-]+$ ]] || die "the SSH host should look like user@host or an alias"
if [[ "$build" == false && -z "$tag" ]]; then die "--no-build needs --tag"; fi

repo="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo"

read -r -a ssh_opts <<<"${CREDFORGE_SSH_OPTS:-}"
for tool in docker git gzip ssh tar base64; do
  command -v "$tool" >/dev/null || die "$tool is not on PATH"
done

commit="$(git rev-parse --short=7 HEAD)"
dirty=false
[[ -n "$(git status --porcelain)" ]] && dirty=true
if [[ -z "$tag" ]]; then
  tag="$(date -u +%Y%m%d-%H%M)-${commit}"
  [[ "$dirty" == true ]] && tag+="-dirty"
fi
[[ "$tag" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$ && "$tag" != latest ]] ||
  die "the tag must be letters, digits, '.', '_' or '-' (and not 'latest')"
image="credforge:${tag}"

# The files the server needs besides the image. Shell scripts break with CRLF line endings.
files=(docker-compose.yml deploy/backup.sh deploy/restore.sh .env.example)
for optional in backup.env.example deploy/systemd/credforge-backup.service \
  deploy/systemd/credforge-backup.timer; do
  [[ -f "$optional" ]] && files+=("$optional")
done
for f in "${files[@]}"; do
  [[ -f "$f" ]] || die "$f is missing"
  if grep -q $'\r' "$f"; then die "$f has CRLF line endings; check .gitattributes (eol=lf)"; fi
done

# Runs the script on stdin with bash on the server. Values reach it through printf %q, never
# through the remote command line. The braces make bash read the whole script before running it,
# so a command that reads stdin can't swallow the rest of the script.
remote() {
  { printf '{\ndir=%q tag=%q keep=%q\n' "$dir" "$tag" "$keep"; cat; printf '\n}\n'; } |
    ssh ${ssh_opts[@]+"${ssh_opts[@]}"} "$host" bash -s
}

# ---- 1. check the server ----
step "Checking ${host}:${dir}"
preflight="$(remote <<'REMOTE'
set -uo pipefail
problems=0
problem() { echo "  ✗ $*" >&2; problems=1; }
arch="$(uname -m)"
[[ "$arch" == x86_64 ]] || problem "the server is $arch; the image is built for linux/amd64"
if ! server_version="$(docker version --format '{{.Server.Version}}' 2>/dev/null)"; then
  echo "  ✗ can't use Docker as $(id -un): add the user to the docker group, then log in again" >&2
  exit 1
fi
compose_version="$(docker compose version --short 2>/dev/null)" ||
  { echo "  ✗ the Docker Compose plugin isn't installed" >&2; exit 1; }
# docker-compose.yml uses env_file entries with "required: false" (Compose 2.24 or newer).
IFS=. read -r major minor _ <<<"${compose_version#v}"
if (( major < 2 || (major == 2 && minor < 24) )); then
  problem "Docker Compose $compose_version is too old (2.24 or newer is needed)"
fi
echo "  Docker $server_version, Compose $compose_version, $(. /etc/os-release && echo "$PRETTY_NAME")" >&2
if [[ ! -d "$dir" ]]; then
  problem "$dir doesn't exist: sudo install -d -o $(id -un) -g $(id -gn) -m 750 $dir"
elif [[ ! -w "$dir" ]]; then
  problem "$(id -un) can't write to $dir"
else
  for env in .env backup.env; do
    if [[ -f "$dir/$env" ]]; then
      mode="$(stat -c %a "$dir/$env")"
      [[ "$mode" == 600 || "$mode" == 400 ]] || problem "$dir/$env has mode $mode: chmod 600 $dir/$env"
    elif [[ "$env" == .env ]]; then
      problem "$dir/.env is missing (docs/deployment.md, “Write the production configuration”)"
    fi
  done
  free_mb="$(df -Pm "$dir" | awk 'NR == 2 { print $4 }')"
  (( free_mb >= 2048 )) || problem "only ${free_mb} MB free on the disk with $dir (2 GB needed)"
fi
if docker image inspect "credforge:$tag" >/dev/null 2>&1; then echo has-image; fi
exit "$problems"
REMOTE
)" || die "the server isn't ready (see above)"

# ---- 2. build ----
if [[ "$build" == true ]]; then
  [[ "$dirty" == true ]] && echo "    (the working tree has uncommitted changes: they are in the image)"
  step "Building ${image}"
  # A plain image, not an index with attestations: every Docker Engine loads it the same way.
  docker build --platform linux/amd64 --pull --provenance=false \
    --label "org.opencontainers.image.version=${tag}" \
    --label "org.opencontainers.image.revision=${commit}$([[ "$dirty" == true ]] && echo -dirty)" \
    --label "org.opencontainers.image.created=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    -t "$image" .
fi

# ---- 3. ship the image ----
if [[ "$preflight" == *has-image* ]]; then
  step "The server already has ${image}"
else
  docker image inspect "$image" >/dev/null 2>&1 || die "there is no image ${image} here"
  size_mb="$(docker image inspect --format '{{.Size}}' "$image" | awk '{ printf "%d", $1 / 1048576 }')"
  step "Streaming ${image} (${size_mb} MB unpacked) to ${host}"
  docker save "$image" | gzip -6 | ssh ${ssh_opts[@]+"${ssh_opts[@]}"} "$host" docker load
fi

# ---- 4–6. copy the files, restart, clean up ----
payload="$(tar -cf - "${files[@]}" | base64 | tr -d '\n')"
if [[ "$up" == true ]]; then
  step "Copying ${#files[@]} files and starting ${image}"
else
  step "Copying ${#files[@]} files (the running stack is left alone)"
fi
{
  printf 'payload=%q up=%q\n' "$payload" "$up"
  cat <<'REMOTE'
set -euo pipefail
cd "$dir"
base64 -d <<<"$payload" | tar -xf - --no-same-owner --no-same-permissions
chmod 755 deploy/*.sh
if [[ "$up" != true ]]; then
  echo "  Loaded credforge:$tag. To start it: cd $dir && docker tag credforge:$tag credforge:latest && docker compose up -d"
  exit 0
fi

previous="$(docker image inspect --format '{{range .RepoTags}}{{println .}}{{end}}' credforge:latest 2>/dev/null |
  grep -v ':latest$' | head -n 1 | cut -d: -f2 || true)"
back="docker tag credforge:$previous credforge:latest && docker compose up -d"
docker tag "credforge:$tag" credforge:latest

# Migrate on its own first, while the running app and worker carry on. A plain "up" would replace
# them before knowing whether the migration works, and leave nothing running if it doesn't.
docker compose up -d --wait --no-build db
if ! docker compose run --rm -T --no-deps migrate </dev/null; then
  [[ -n "$previous" ]] && docker tag "credforge:$previous" credforge:latest
  echo "  ✗ the migration failed (above). The running app and worker were left alone." >&2
  exit 1
fi
printf '%s %s (was %s)\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$tag" "${previous:-none}" >>deploy-history.log

if ! docker compose up -d --no-build; then
  echo "  ✗ docker compose up failed (above)." >&2
  [[ -n "$previous" ]] && echo "  To go back: $back" >&2
  exit 1
fi

health=starting
for _ in $(seq 1 60); do
  container="$(docker compose ps -q app)"
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container" 2>/dev/null || echo starting)"
  [[ "$health" == healthy || "$health" == unhealthy || "$health" == exited ]] && break
  sleep 2
done
ready=false
if [[ "$health" == healthy ]] && docker compose exec -T app node -e \
  'fetch("http://127.0.0.1:3000/readyz").then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))' \
  </dev/null; then
  ready=true
fi
docker compose ps --format 'table {{.Service}}\t{{.Image}}\t{{.Status}}'
if [[ "$ready" != true ]]; then
  echo "  ✗ the app isn't ready (health: $health). Its last lines:" >&2
  docker compose logs --no-log-prefix --tail 40 app >&2 || true
  [[ -n "$previous" ]] && echo "  To go back: $back" >&2
  exit 1
fi
[[ -n "$(docker compose ps -q --status running worker)" ]] ||
  { echo "  ✗ the worker isn't running: docker compose logs worker" >&2; exit 1; }

# Keep the newest $keep versioned images (rollback targets); images in use are never removed.
old_tags="$(docker image ls credforge --format '{{.CreatedAt}}|{{.Tag}}' | grep -v '|latest$' |
  sort -r | tail -n "+$((keep + 1))" | cut -d'|' -f2 || true)"
for old in $old_tags; do
  [[ "$old" == "$tag" || "$old" == "$previous" || "$old" == '<none>' ]] && continue
  if docker image rm "credforge:$old" >/dev/null 2>&1; then echo "  removed credforge:$old"; fi
done
docker image prune -f --filter label=org.opencontainers.image.title=credforge >/dev/null
echo "  credforge:$tag is live (previous: ${previous:-none})."
REMOTE
} | remote
