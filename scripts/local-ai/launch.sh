#!/usr/bin/env bash
# What the "Chapter Craft" app-menu entry runs: start whatever isn't running,
# then open (or focus) the app in its own window. Safe to click repeatedly.
# Progress shows as desktop notifications; details in .local-state/logs/launch.log.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
APP_URL="http://127.0.0.1:8080"
LOG="$ROOT/.local-state/logs/launch.log"
mkdir -p "$(dirname "$LOG")"
notify() { command -v notify-send >/dev/null && notify-send -a "Chapter Craft" -i chapter-craft "$@" || true; }
up() { curl -fs -o /dev/null --max-time 2 "$1"; }

open_app() {
  exec 9>&-   # the window must not inherit the start lock
  # Focus by the app window's class (Chromium names --app windows after the
  # URL), never by title: a title match on "Chapter Craft" also hits any
  # terminal or browser tab that mentions it, and focuses that instead.
  # An open window keeps running the JavaScript it loaded, so after a rebuild
  # (`npx vite build`) focusing it alone shows the OLD app — fixes that were
  # built and served never reached the user (2026-10-14). Remember which build
  # the window last loaded and press F5 in it when dist/ is newer.
  local build stamp="$ROOT/.local-state/window-build" addr=""
  build=$(stat -c %Y "$ROOT/dist/index.html" 2>/dev/null || echo 0)
  command -v hyprctl >/dev/null && command -v jq >/dev/null &&
    addr=$(hyprctl clients -j 2>/dev/null | jq -r '[.[] | select(.class | test("^chrome-127\\.0\\.0\\.1__-"))][0].address // empty')
  if [ -n "$addr" ] && [ "$build" != "$(cat "$stamp" 2>/dev/null)" ]; then
    # Lua-config Hyprland (hl.dsp.*); down/up as two calls, the way Omarchy's
    # own clipboard bindings send keys, so F5 can't stick and repeat.
    hyprctl dispatch "hl.dsp.focus({ window = \"address:$addr\" })" >/dev/null 2>&1 ||
      hyprctl dispatch focuswindow "address:$addr" >/dev/null
    sleep 0.1
    hyprctl dispatch 'hl.dsp.send_key_state({ mods = "", key = "F5", state = "down" })' >/dev/null 2>&1
    sleep 0.05
    hyprctl dispatch 'hl.dsp.send_key_state({ mods = "", key = "F5", state = "up" })' >/dev/null 2>&1
    echo "$build" >"$stamp"
    exit 0
  fi
  [ -z "$addr" ] && echo "$build" >"$stamp"   # a new window loads the current build
  if command -v omarchy-launch-or-focus >/dev/null; then
    exec omarchy-launch-or-focus "^chrome-127\.0\.0\.1__-" "omarchy-launch-webapp $APP_URL"
  fi
  exec xdg-open "$APP_URL"
}

# One start at a time, however many clicks.
exec 9>"$ROOT/.local-state/launch.lock"
if ! flock -n 9; then notify "Already starting…"; exit 0; fi

# Fast path: everything the window needs is already answering.
if up "$APP_URL" && up "http://127.0.0.1:54321/auth/v1/health"; then
  # Re-assert the GPU setting local-up.sh applies (awake + COMPUTE); cheap, and it
  # may have been released (local-down, setup-once) while the app kept running.
  sudo -n /usr/local/bin/cc-amdgpu-compute hold 2>/dev/null || true
  open_app
fi

notify "Starting…" "Usually a few seconds; longer after code changes."
# Start in the background and open the window as soon as the app and its
# database answer; speech, search and images finish coming up behind it.
# 9>&-: the long-running services it starts must not inherit the lock.
RC="$ROOT/.local-state/launch.rc"; rm -f "$RC"
( "$ROOT/scripts/local-up.sh" >"$LOG" 2>&1; echo $? >"$RC" ) 9>&- &
starter=$!
for _ in $(seq 1 600); do   # 5 min ceiling (first run builds the app)
  if up "$APP_URL" && up "http://127.0.0.1:54321/auth/v1/health"; then
    # Report a later failure (e.g. voice) without holding the window back.
    ( while kill -0 "$starter" 2>/dev/null; do sleep 1; done
      [ "$(cat "$RC" 2>/dev/null)" = 0 ] || notify -u critical "Part of Chapter Craft didn't start" "See .local-state/logs/launch.log" ) 9>&- &
    open_app
  fi
  if ! kill -0 "$starter" 2>/dev/null; then
    [ "$(cat "$RC" 2>/dev/null)" = 0 ] && continue   # finished between checks; next loop opens it
    notify -u critical "Couldn't start" "$(grep -E 'xx ' "$LOG" | tail -1 | sed 's/\x1b\[[0-9;]*m//g') — see .local-state/logs/launch.log"
    exit 1
  fi
  sleep 0.5
done
notify -u critical "Couldn't start" "Timed out — see .local-state/logs/launch.log"
exit 1
