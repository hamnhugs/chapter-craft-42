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
# The models this install runs. Override any of them in the environment; the
# browser and the edge functions are both told, so they always agree.
LOCAL_LLM_MODEL=${LOCAL_LLM_MODEL:-hf.co/unsloth/Qwen3-4B-Instruct-2507-GGUF:Q6_K}
LOCAL_VISION_MODEL=${LOCAL_VISION_MODEL:-qwen3.5:4b}
LOCAL_EMBED_MODEL=${LOCAL_EMBED_MODEL:-embeddinggemma:300m}
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
# The Q6_K chat model only fits on the card with the 8-bit KV cache (setup-once.sh).
systemctl show ollama -p Environment 2>/dev/null | grep -q "OLLAMA_KV_CACHE_TYPE=q8_0" \
  || say "warning: Ollama lacks the 8-bit KV cache setting, so chat runs ~1/3 slower. Run once: bash scripts/local-ai/setup-once.sh"
for m in "$LOCAL_LLM_MODEL" "$LOCAL_EMBED_MODEL"; do
  ollama show "$m" >/dev/null 2>&1 || fail "Model $m missing. Run: scripts/local-ai/install-services.sh"
done
[ -x "$CC_HOME/src/whisper.cpp/build/bin/whisper-server" ] || fail "Services not installed. Run: scripts/local-ai/install-services.sh"

# GPU COMPUTE profile (see setup-once.sh). Best effort: needs its sudoers rule.
# GPU awake + COMPUTE profile while the app runs; local-down.sh releases it.
# (setup-once.sh step 3: the profile alone hung the card on wake-from-suspend.)
dgpu() { # the AMD card with the most VRAM, as the helper picks it
  local best="" bestv=0 d v
  for d in /sys/class/drm/card[0-9]*/device; do
    [ "$(cat "$d/vendor" 2>/dev/null)" = "0x1002" ] || continue
    v=$(cat "$d/mem_info_vram_total" 2>/dev/null || echo 0)
    [ "$v" -gt "$bestv" ] && { best="$d"; bestv="$v"; }
  done
  echo "$best"
}
if sudo -n /usr/local/bin/cc-amdgpu-compute hold 2>/dev/null \
   && [ "$(cat "$(dgpu)/power/control" 2>/dev/null)" = on ]; then
  say "gpu: held awake with the COMPUTE profile"
else
  say "gpu: not fully tuned — re-run: bash scripts/local-ai/setup-once.sh"
fi

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
  docker exec -i -e PGOPTIONS=--client-min-messages=warning "supabase_db_$PROJECT_ID" psql -q -v ON_ERROR_STOP=1 -U postgres -d postgres <"$f" >/dev/null \
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
VITE_LOCAL_AUTO_PASSWORD=\"$OWNER_PASSWORD\"
VITE_LOCAL_EMBED_MODEL=\"$LOCAL_EMBED_MODEL\""
[ "$(cat .env.local 2>/dev/null)" = "$NEW_ENV" ] || { printf '%s\n' "$NEW_ENV" >.env.local; say "wrote .env.local"; }

# Edge-function env. LOVABLE_API_KEY=local satisfies the functions' existing
# "is AI configured?" guards; aiFetch (_shared/ai-local.ts) intercepts the call.
FN_ENV="AI_PROVIDER=ollama
OLLAMA_URL=http://host.docker.internal:$(port ollama)
LOVABLE_API_KEY=local
LOCAL_LLM_MODEL=$LOCAL_LLM_MODEL
LOCAL_VISION_MODEL=$LOCAL_VISION_MODEL
LOCAL_EMBED_MODEL=$LOCAL_EMBED_MODEL
LOCAL_NUM_CTX=16384"
if [ "$(cat supabase/functions/.env.local 2>/dev/null)" != "$FN_ENV" ]; then
  printf '%s\n' "$FN_ENV" >supabase/functions/.env.local
  # The functions read it only at start: restart them if they're up.
  if [ -f "$PIDS/functions.pid" ] && kill "$(cat "$PIDS/functions.pid")" 2>/dev/null; then
    say "functions: settings changed, restarting"; rm -f "$PIDS/functions.pid"; sleep 2
  fi
fi
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

# --- ArtCraft apps (PhotoCraft, DesignCraft, FilmCraft) ------------------------------
# The bridge Counsel drives them through. Only when they're installed
# (scripts/local-ai/install-crafts.sh); the apps themselves start on demand.
if [ -x "$CC_HOME/crafts/photocraft/usr/bin/photocraft-cli" ] || [ -x "$CC_HOME/crafts/designcraft/usr/bin/designcraft-cli" ] || [ -x "$CC_HOME/crafts/filmcraft/usr/bin/filmcraft-cli" ]; then
  start_bg crafts env CC_HOME="$CC_HOME" node scripts/local-ai/craft-bridge.mjs
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

# --- memories follow the embedding model -----------------------------------------
# Vectors from two models can't be compared, so after LOCAL_EMBED_MODEL changes
# (or on the first run that records it — earlier installs used nomic-embed-text)
# every stored vector is rebuilt once. The 768-d column carries its model id and
# knowledge-embed {stale_model} migrates it. embedding_v2 (search, filing,
# centroids) and the wiki-name cache carry no model id, so they're cleared
# here; stale_model refills embedding_v2 for the rows it migrates.
if [ "$(cat "$STATE/embed-model" 2>/dev/null)" != "$LOCAL_EMBED_MODEL" ]; then
  say "memories: re-embedding with $LOCAL_EMBED_MODEL (once per model change)"
  docker exec -i "supabase_db_$PROJECT_ID" psql -q -v ON_ERROR_STOP=1 -U postgres -d postgres >/dev/null <<SQL || fail "couldn't clear old embeddings"
-- Only rows not yet migrated, so a rerun after an interruption keeps finished work.
UPDATE public.knowledge_entries SET embedding_v2 = NULL
  WHERE embedding_v2 IS NOT NULL AND embedding_768_model IS DISTINCT FROM 'ollama/$LOCAL_EMBED_MODEL';
UPDATE public.wiki_centroids SET name_embedding = NULL, name_embedding_source = NULL WHERE name_embedding IS NOT NULL;
SQL
  API_URL="$API_URL" ANON="$ANON" EMAIL="$OWNER_EMAIL" PW="$OWNER_PASSWORD" python3 - <<'PY' || fail "re-embedding failed (rerun scripts/local-up.sh to retry)"
import json, os, sys, time, urllib.request, urllib.error
api, anon = os.environ["API_URL"], os.environ["ANON"]
def post(path, body, token=None):
    req = urllib.request.Request(api + path, json.dumps(body).encode(),
        {"apikey": anon, "Authorization": "Bearer " + (token or anon), "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=600) as r: return r.status, json.load(r)
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read() or b"{}")
    except (urllib.error.URLError, ConnectionError): return 0, {}
_, s = post("/auth/v1/token?grant_type=password", {"email": os.environ["EMAIL"], "password": os.environ["PW"]})
token = s.get("access_token") or sys.exit("couldn't sign in as the local owner")
def drain(fn, body, key):
    total = 0
    for _ in range(200):
        for wait in range(30):  # the functions runtime may still be booting
            code, r = post("/functions/v1/" + fn, body, token)
            if code not in (0, 502, 503): break
            time.sleep(2)
        if code != 200: sys.exit(f"{fn}: HTTP {code} {json.dumps(r)[:200]}")
        n = int(r.get(key) or 0)
        if not n: return total
        total += n; print(f"    {fn}: {total}", flush=True)
    return total
drain("knowledge-embed", {"stale_model": True}, "updated")
post("/functions/v1/recompute-centroids", {}, token)
PY
  echo "$LOCAL_EMBED_MODEL" >"$STATE/embed-model"
fi

say "ready:"
echo "    app        $APP_URL"
echo "    supabase   $API_URL   (studio: http://127.0.0.1:54323)"
echo "    search $(svc searxng)  voice $(svc tts)  stt $(svc stt)  images $(svc images)"

if [ "$APP" = dev ]; then
  say "app: vite dev server on $APP_URL (Ctrl-C stops the app; services keep running — scripts/local-down.sh stops them)"
  exec npm run dev
fi
