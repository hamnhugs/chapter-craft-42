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
  if command -v omarchy-launch-or-focus-webapp >/dev/null; then
    exec omarchy-launch-or-focus-webapp "Chapter Craft" "$APP_URL"
  fi
  exec xdg-open "$APP_URL"
}

# One start at a time, however many clicks.
exec 9>"$ROOT/.local-state/launch.lock"
if ! flock -n 9; then notify "Already starting…"; exit 0; fi

# Fast path: everything the window needs is already answering.
if up "$APP_URL" && up "http://127.0.0.1:54321/auth/v1/health"; then
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
