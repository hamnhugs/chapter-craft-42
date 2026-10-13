#!/usr/bin/env bash
# Stop everything scripts/local-up.sh started. Your data stays: Supabase
# keeps its database in a Docker volume between runs.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
PIDS="$ROOT/.local-state/pids"
say() { printf '\033[1;33m==>\033[0m %s\n' "$*"; }
# Same as local-up.sh: pick up the docker group if this login predates it.
if ! docker info >/dev/null 2>&1 && [ -z "${CC_NEWGRP:-}" ] && getent group docker | cut -d: -f4 | tr ',' '\n' | grep -qx "$USER"; then
  { printf 'CC_NEWGRP=1 exec'; printf ' %q' "$0" "$@"; echo; } | newgrp docker
  exit $?
fi

for f in "$PIDS"/*.pid; do
  [ -f "$f" ] || continue
  name="$(basename "$f" .pid)"; pid="$(cat "$f")"
  if kill -0 "$pid" 2>/dev/null; then say "stopping $name"; kill "$pid" 2>/dev/null; fi
  rm -f "$f"
done
sudo -n /usr/local/bin/cc-amdgpu-compute release 2>/dev/null && say "gpu: back to stock power management"
say "containers: down"
docker compose -f docker-compose.local.yml down >/dev/null 2>&1
say "supabase: stop (data kept)"
npx -y supabase@2.120.0 stop >/dev/null 2>&1
say "done"
