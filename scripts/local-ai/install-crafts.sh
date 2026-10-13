#!/usr/bin/env bash
# Install the ArtCraft apps Counsel can drive: PhotoCraft (Photoshop-style),
# DesignCraft (InDesign-style) and FilmCraft (Premiere-style). Runs as YOUR
# user (no sudo); re-running updates to the newest release.
#
# Each app's Linux AppImage comes from its GitHub release (github.com/storytold)
# and is checked against the release's SHA256SUMS.txt, then unpacked so the
# desktop app and its headless CLI (the MCP server the craft bridge talks to)
# run directly. Lands in ~/.local/share/chapter-craft-local/crafts/<app>.
#
#   scripts/local-ai/install-crafts.sh            # all three
#   scripts/local-ai/install-crafts.sh photocraft # just one
set -euo pipefail

CC_HOME="${CC_HOME:-$HOME/.local/share/chapter-craft-local}"
CRAFTS="$CC_HOME/crafts"
say() { printf '\033[1;33m==>\033[0m %s\n' "$*"; }
command -v gh >/dev/null || { echo "Needs the GitHub CLI (pacman -S github-cli)." >&2; exit 1; }
case "$(uname -m)" in x86_64) ARCH=x86_64 ;; aarch64) ARCH=aarch64 ;; *) echo "Unsupported CPU: $(uname -m)" >&2; exit 1 ;; esac

mkdir -p "$CRAFTS/workspace"
APPS=("${@:-photocraft designcraft filmcraft}")
# shellcheck disable=SC2206
APPS=(${APPS[*]})

for app in "${APPS[@]}"; do
  case "$app" in photocraft|designcraft|filmcraft) ;; *) echo "Unknown app: $app" >&2; exit 1 ;; esac
  tag="$(gh release view -R "storytold/$app" --json tagName --jq .tagName)"
  dest="$CRAFTS/$app"
  if [ "$(cat "$dest/VERSION" 2>/dev/null)" = "$tag" ] && [ -x "$dest/usr/bin/$app-cli" ]; then
    say "$app $tag present"; continue
  fi
  file="$app-${tag#v}-linux-$ARCH.AppImage"
  tmp="$(mktemp -d)"
  say "$app $tag: downloading"
  gh release download -R "storytold/$app" "$tag" -p "$file" -p SHA256SUMS.txt -D "$tmp"
  (cd "$tmp" && grep -E "[ *]$file\$" SHA256SUMS.txt | sha256sum -c --quiet -) || { echo "$app: checksum mismatch, not installed" >&2; rm -rf "$tmp"; exit 1; }
  chmod +x "$tmp/$file"
  (cd "$tmp" && "./$file" --appimage-extract >/dev/null)
  rm -rf "$dest.new" && mv "$tmp/squashfs-root" "$dest.new"
  echo "$tag" > "$dest.new/VERSION"
  rm -rf "$dest" && mv "$dest.new" "$dest"
  rm -rf "$tmp"
  "$dest/usr/bin/$app-cli" --version >/dev/null 2>&1 || "$dest/usr/bin/$app" --version >/dev/null
  say "$app $tag installed"
done
# --- menu launchers ------------------------------------------------------------
# The app menu opens each app with its control port, the same way the craft
# bridge does (desktopArgs in craft-bridge.mjs), so a window opened by hand can
# be driven from the chat too. Ports: CC_<APP>_PORT, defaults below.
APPS_DIR="$HOME/.local/share/applications"
mkdir -p "$CRAFTS/bin" "$APPS_DIR" "$CRAFTS/.state" && chmod 700 "$CRAFTS/.state"
for app in photocraft designcraft filmcraft; do
  dest="$CRAFTS/$app"; [ -x "$dest/usr/bin/$app" ] || continue
  case "$app" in
    photocraft) args="--control ${CC_PHOTOCRAFT_PORT:-7878} --control-token-file \"$CRAFTS/.state/photocraft.token\" --automation-read-root \"$CRAFTS/workspace\" --automation-write-root \"$CRAFTS/workspace\"" ;;
    designcraft) args="--control ${CC_DESIGNCRAFT_PORT:-7979}" ;;
    filmcraft) args="--control ${CC_FILMCRAFT_PORT:-9876}" ;;
  esac
  printf '#!/bin/sh\n# Written by install-crafts.sh: %s with the control port Chapter Craft drives.\nexec "%s" %s "$@"\n' \
    "$app" "$dest/usr/bin/$app" "$args" > "$CRAFTS/bin/$app"
  chmod +x "$CRAFTS/bin/$app"
  # The app's own entry, pointed at the wrapper (same file name, so it replaces
  # the one an AppImage registers for itself).
  sed -e "s|^Exec=.*|Exec=\"$CRAFTS/bin/$app\" %F|" -e "/^TryExec=/d" -e "s|^Icon=.*|Icon=$dest/ai.storyteller.$app.png|" \
    "$dest/ai.storyteller.$app.desktop" > "$APPS_DIR/ai.storyteller.$app.desktop"
done
command -v update-desktop-database >/dev/null && update-desktop-database "$APPS_DIR" 2>/dev/null || true
say "crafts ready in $CRAFTS (start them with scripts/local-up.sh)"
