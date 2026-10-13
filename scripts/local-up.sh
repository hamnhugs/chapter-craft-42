#!/usr/bin/env bash
# Start the whole local edition with one command:
#
#   scripts/local-up.sh            everything; the app is served in the background
#                                  at http://127.0.0.1:8080 and the script returns
#   scripts/local-up.sh --dev      same, but the app runs as the Vite dev server in
#                                  the foreground (hot reload, for editing code)
#   scripts/local-up.sh --no-app   services only
#
# The app menu entry "Chapter Craft" (scripts/local-ai/install-launcher.sh) runs
# this and opens the app in its own window. Re-running is cheap: anything already
# up is left alone, and the app is only rebuilt when its code changed.
#
# First time on a machine: bash scripts/local-ai/setup-once.sh (sudo, once),
# then scripts/local-ai/install-services.sh (models + builds). This script
# checks for both and says which is missing.
#
# Stops with scripts/local-down.sh. Logs: .local-state/logs/.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
CC_HOME="${CC_HOME:-$HOME/.local/share/chapter-craft-local}"
STATE="$ROOT/.local-state"; LOGS="$STATE/logs"; PIDS="$STATE/pids"
mkdir -p "$LOGS" "$PIDS" "$STATE/searxng"
SB=(npx -y supabase@2.120.0)
APP=built
case "${1:-}" in --no-app) APP=none ;; --dev) APP=dev ;; esac

say()  { printf '\033[1;33m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }
svc()  { python3 -c "import json,sys;print(json.load(open('$ROOT/local-services.json'))[sys.argv[1]])" "$1"; }
port() { python3 -c "import urllib.parse,sys;print(urllib.parse.urlparse(sys.argv[1]).port)" "$(svc "$1")"; }
up()   { curl -fs -o /dev/null --max-time 2 "$1"; }
wait_for() { # url name seconds
  for _ in $(seq 1 "${3:-60}"); do up "$1" && return 0; sleep 1; done
  fail "$2 did not come up — see $LOGS/$2.log"
}
start_bg() { # name cmd...   (skips if already running)
  local name="$1"; shift
  if [ -f "$PIDS/$name.pid" ] && kill -0 "$(cat "$PIDS/$name.pid")" 2>/dev/null; then say "$name already running"; return; fi
  say "starting $name"
  nohup "$@" >"$LOGS/$name.log" 2>&1 &
  echo $! >"$PIDS/$name.pid"
}

# --- preflight ---------------------------------------------------------------
if ! docker info >/dev/null 2>&1; then
  # Added to the docker group but this login session predates it: pick the
  # group up for this run instead of requiring a log out/in.
  if [ -z "${CC_NEWGRP:-}" ] && getent group docker | cut -d: -f4 | tr ',' '\n' | grep -qx "$USER"; then
    { printf 'CC_NEWGRP=1 exec'; printf ' %q' "$0" "$@"; echo; } | newgrp docker
    exit $?
  fi
  fail "Docker isn't usable by $USER. Run: bash scripts/local-ai/setup-once.sh (then log out/in)."
fi
up "$(svc ollama)/api/version" || fail "Ollama isn't running. Start it: sudo systemctl start ollama"
for m in qwen3:4b-instruct-2507-q4_K_M nomic-embed-text; do
  ollama show "$m" >/dev/null 2>&1 || fail "Model $m missing. Run: scripts/local-ai/install-services.sh"
done
[ -x "$CC_HOME/src/whisper.cpp/build/bin/whisper-server" ] || fail "Services not installed. Run: scripts/local-ai/install-services.sh"

# GPU COMPUTE profile (see setup-once.sh). Best effort: needs its sudoers rule.
sudo -n /usr/local/bin/cc-amdgpu-compute 2>/dev/null && say "gpu: COMPUTE profile applied" || say "gpu: COMPUTE profile not applied (run setup-once.sh for faster prompts)"

# --- containers: SearXNG + the Ollama bridge ----------------------------------
if [ ! -f "$STATE/searxng/settings.yml" ]; then
  sed "s/REPLACED_ON_FIRST_RUN/$(openssl rand -hex 32)/" local/searxng/settings.yml >"$STATE/searxng/settings.yml"
fi
say "containers: searxng, ollama-bridge"
docker compose -f docker-compose.local.yml up -d >/dev/null

# --- Supabase -----------------------------------------------------------------
PROJECT_ID="$(awk -F'"' '/^project_id/{print $2}' supabase/config.toml)"
# After a reboot Docker brings Supabase's containers back by itself; only run
# the (slow) start when the API isn't answering.
if up "http://127.0.0.1:54321/auth/v1/health" && docker ps --format '{{.Names}}' | grep -qx "supabase_db_$PROJECT_ID"; then
  say "supabase: already running"
else
  say "supabase: start (first run pulls images and applies every migration)"
  "${SB[@]}" start >"$LOGS/supabase-start.log" 2>&1 || { tail -20 "$LOGS/supabase-start.log"; fail "supabase start failed"; }
fi
for f in supabase/local/*.sql; do
  docker exec -i "supabase_db_$PROJECT_ID" psql -q -v ON_ERROR_STOP=1 -U postgres -d postgres <"$f" >/dev/null \
    || fail "applying $f failed"
done

# App env (.env.local overrides .env in Vite; gitignored). Keys never printed.
eval "$("${SB[@]}" status -o env 2>/dev/null | grep -E '^(API_URL|ANON_KEY|PUBLISHABLE_KEY|SERVICE_ROLE_KEY)=')"
ANON="${PUBLISHABLE_KEY:-${ANON_KEY:-}}"
[ -n "${API_URL:-}" ] && [ -n "$ANON" ] && [ -n "${SERVICE_ROLE_KEY:-}" ] || fail "couldn't read local Supabase URL/keys from 'supabase status'"

# No sign-in screen: one owner account for this machine, signed in silently by
# the app (src/lib/localAutoSignIn.ts). Random password, kept in .local-state
# (gitignored, mode 600). The first account is made admin by supabase/local/001.
umask 077
OWNER_EMAIL="owner@chapter-craft.local"
[ -s "$STATE/owner-password" ] || openssl rand -hex 24 >"$STATE/owner-password"
OWNER_PASSWORD="$(cat "$STATE/owner-password")"
API_URL="$API_URL" SRK="$SERVICE_ROLE_KEY" EMAIL="$OWNER_EMAIL" PW="$OWNER_PASSWORD" python3 - <<'PY' || fail "couldn't create the local owner account"
import json, os, urllib.request, urllib.error
base, key = os.environ["API_URL"] + "/auth/v1/admin/users", os.environ["SRK"]
def call(method, url, body=None):
    req = urllib.request.Request(url, json.dumps(body).encode() if body is not None else None,
        {"apikey": key, "Authorization": "Bearer " + key, "Content-Type": "application/json"}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as r: return r.status, json.load(r)
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read() or b"{}")
email, pw = os.environ["EMAIL"], os.environ["PW"]
code, _ = call("POST", base, {"email": email, "password": pw, "email_confirm": True})
if code not in (200, 201):  # already exists: make sure the password matches ours
    code, page = call("GET", base + "?per_page=1000")
    uid = next((u["id"] for u in page.get("users", []) if u.get("email") == email), None)
    if not uid: raise SystemExit("owner account missing and could not be created")
    code, _ = call("PUT", f"{base}/{uid}", {"password": pw})
    if code != 200: raise SystemExit(f"owner password update failed: {code}")
PY
NEW_ENV="VITE_SUPABASE_URL=\"$API_URL\"
VITE_SUPABASE_PUBLISHABLE_KEY=\"$ANON\"
VITE_SUPABASE_PROJECT_ID=\"local\"
VITE_LOCAL_AUTO_EMAIL=\"$OWNER_EMAIL\"
VITE_LOCAL_AUTO_PASSWORD=\"$OWNER_PASSWORD\""
[ "$(cat .env.local 2>/dev/null)" = "$NEW_ENV" ] || { printf '%s\n' "$NEW_ENV" >.env.local; say "wrote .env.local"; }

# Edge-function env. LOVABLE_API_KEY=local satisfies the functions' existing
# "is AI configured?" guards; aiFetch (_shared/ai-local.ts) intercepts the call.
cat >supabase/functions/.env.local <<EOF
AI_PROVIDER=ollama
OLLAMA_URL=http://host.docker.internal:$(port ollama)
LOVABLE_API_KEY=local
LOCAL_LLM_MODEL=${LOCAL_LLM_MODEL:-qwen3:4b-instruct-2507-q4_K_M}
LOCAL_VISION_MODEL=${LOCAL_VISION_MODEL:-qwen3.5:4b}
LOCAL_EMBED_MODEL=${LOCAL_EMBED_MODEL:-nomic-embed-text}
LOCAL_NUM_CTX=16384
EOF
umask 022
start_bg functions "${SB[@]}" functions serve --env-file supabase/functions/.env.local

# --- native AI services ---------------------------------------------------------
start_bg tts "$CC_HOME/venv/bin/python" -m piper.http_server --host 127.0.0.1 --port "$(port tts)" \
  -m "$CC_HOME/voices/en_US-lessac-medium.onnx" --data-dir "$CC_HOME/voices"

W="$CC_HOME/src/whisper.cpp"
# Vulkan device 0 is the integrated Radeon: speech-to-text stays off the
# discrete card, whose VRAM belongs to the chat model.
start_bg stt env LD_LIBRARY_PATH="$W/build/bin" GGML_VK_VISIBLE_DEVICES="${CC_STT_GPU:-0}" \
  "$W/build/bin/whisper-server" -m "$W/models/ggml-base.en.bin" --host 127.0.0.1 --port "$(port stt)" -t 6

SD="$CC_HOME/src/stable-diffusion.cpp/build/bin"; IM="$CC_HOME/image-models"
if [ -s "$IM/TwinFlow_Z_Image_Turbo_exp-Q4_K.gguf" ] && [ -s "$IM/ae.safetensors" ]; then
  # Integrated Radeon (Vulkan0): on the RX 5600M Z-Image trips the driver's
  # lockup timeout ("device lost"); on the iGPU 512x512 takes ~74 s and the
  # chat model keeps the discrete card (docs/local-ai/results/2026-10-12-images.txt).
  start_bg images env LD_LIBRARY_PATH="$SD" GGML_VK_VISIBLE_DEVICES="${CC_IMAGES_GPU:-0}" "$SD/sd-server" \
    --listen-ip 127.0.0.1 --listen-port "$(port images)" \
    --diffusion-model "$IM/TwinFlow_Z_Image_Turbo_exp-Q4_K.gguf" --vae "$IM/ae.safetensors" \
    --llm "$IM/Qwen3-4B-Instruct-2507-Q4_K_M.gguf" \
    --cfg-scale 1.0 --steps 4
else
  say "images: models not downloaded — skipping (install-services.sh fetches them)"
fi

# --- the app ----------------------------------------------------------------------
APP_URL="http://127.0.0.1:8080"
if [ "$APP" = built ]; then
  # Built once and served statically: opens in ~1 s instead of the dev server's
  # thousands of module requests. Rebuilt only when something it's made of changed.
  if [ ! -f dist/index.html ] || [ -n "$(find src public index.html vite.config.ts package.json local-services.json .env.local -newer dist/index.html -print -quit 2>/dev/null)" ]; then
    # Stop the old build first, so nothing opens a stale version meanwhile.
    [ -f "$PIDS/app.pid" ] && kill "$(cat "$PIDS/app.pid")" 2>/dev/null && rm -f "$PIDS/app.pid" && sleep 1
    say "app: building (only when the code changed, ~20 s)"
    npx vite build >"$LOGS/build.log" 2>&1 || { tail -20 "$LOGS/build.log"; fail "app build failed"; }
  fi
  up "$APP_URL" && [ ! -f "$PIDS/app.pid" ] && fail "something else is using port 8080 (stop it, e.g. an 'npm run dev')"
  start_bg app ./node_modules/.bin/vite preview --host 127.0.0.1 --port 8080 --strictPort
  wait_for "$APP_URL" app 30
fi

wait_for "$(svc tts)/voices" tts 60
wait_for "$(svc stt)/" stt 60
wait_for "$(svc searxng)/" searxng 90
say "ready:"
echo "    app        $APP_URL"
echo "    supabase   $API_URL   (studio: http://127.0.0.1:54323)"
echo "    search $(svc searxng)  voice $(svc tts)  stt $(svc stt)  images $(svc images)"

if [ "$APP" = dev ]; then
  say "app: vite dev server on $APP_URL (Ctrl-C stops the app; services keep running — scripts/local-down.sh stops them)"
  exec npm run dev
fi
