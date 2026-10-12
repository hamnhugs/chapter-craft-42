#!/usr/bin/env bash
# Start the whole local edition with one command:
#
#   scripts/local-up.sh            everything, then the app at http://127.0.0.1:8080
#   scripts/local-up.sh --no-app   services only (e.g. to run `npm run dev` yourself)
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
RUN_APP=1; [ "${1:-}" = "--no-app" ] && RUN_APP=0

say()  { printf '\033[1;33m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }
svc()  { python3 -c "import json,sys;print(json.load(open('$ROOT/local-services.json'))[sys.argv[1]])" "$1"; }
port() { python3 -c "import urllib.parse,sys;print(urllib.parse.urlparse(sys.argv[1]).port)" "$(svc "$1")"; }
up()   { curl -fsS -o /dev/null --max-time 2 "$1"; }
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
docker info >/dev/null 2>&1 || fail "Docker isn't usable by $USER. Run: bash scripts/local-ai/setup-once.sh (then log out/in)."
up "$(svc ollama)/api/version" || fail "Ollama isn't running. Start it: sudo systemctl start ollama"
for m in qwen3:4b-instruct-2507-q4_K_M nomic-embed-text; do
  ollama list | awk '{print $1}' | grep -qx "$m" || fail "Model $m missing. Run: scripts/local-ai/install-services.sh"
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
say "supabase: start (first run pulls images and applies every migration)"
"${SB[@]}" start >"$LOGS/supabase-start.log" 2>&1 || { tail -20 "$LOGS/supabase-start.log"; fail "supabase start failed"; }
PROJECT_ID="$(awk -F'"' '/^project_id/{print $2}' supabase/config.toml)"
for f in supabase/local/*.sql; do
  docker exec -i "supabase_db_$PROJECT_ID" psql -q -v ON_ERROR_STOP=1 -U postgres -d postgres <"$f" >/dev/null \
    || fail "applying $f failed"
done

# App env (.env.local overrides .env in Vite; gitignored). Keys never printed.
eval "$("${SB[@]}" status -o env 2>/dev/null | grep -E '^(API_URL|ANON_KEY|PUBLISHABLE_KEY)=')"
ANON="${PUBLISHABLE_KEY:-${ANON_KEY:-}}"
[ -n "${API_URL:-}" ] && [ -n "$ANON" ] || fail "couldn't read local Supabase URL/key from 'supabase status'"
umask 077
NEW_ENV="VITE_SUPABASE_URL=\"$API_URL\"
VITE_SUPABASE_PUBLISHABLE_KEY=\"$ANON\"
VITE_SUPABASE_PROJECT_ID=\"local\""
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

wait_for "$(svc tts)/voices" tts 60
wait_for "$(svc stt)/" stt 60
wait_for "$(svc searxng)/" searxng 90
say "ready:"
echo "    app        http://127.0.0.1:8080"
echo "    supabase   $API_URL   (studio: http://127.0.0.1:54323)"
echo "    search $(svc searxng)  voice $(svc tts)  stt $(svc stt)  images $(svc images)"

if [ "$RUN_APP" = 1 ]; then
  say "app: vite on http://127.0.0.1:8080 (Ctrl-C stops the app; services keep running — scripts/local-down.sh stops them)"
  exec npm run dev
fi
