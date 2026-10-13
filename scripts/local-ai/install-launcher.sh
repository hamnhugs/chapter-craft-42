#!/usr/bin/env bash
# Add "Chapter Craft" to the app menu (Super+Space in Omarchy) for this user.
# No sudo. Remove: rm ~/.local/share/applications/chapter-craft.desktop
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ICON_DIR="$HOME/.local/share/icons/hicolor/512x512/apps"
mkdir -p "$ICON_DIR" "$HOME/.local/share/applications"
cp "$ROOT/public/icons/icon-512.png" "$ICON_DIR/chapter-craft.png"
gtk-update-icon-cache "$HOME/.local/share/icons/hicolor" >/dev/null 2>&1 || true
cat >"$HOME/.local/share/applications/chapter-craft.desktop" <<DESKTOP
[Desktop Entry]
Version=1.0
Name=Chapter Craft
Comment=Your library and AI, running on this computer
Exec=$ROOT/scripts/local-ai/launch.sh
Terminal=false
Type=Application
Icon=chapter-craft
Categories=Office;
StartupNotify=true
DESKTOP
update-desktop-database "$HOME/.local/share/applications" >/dev/null 2>&1 || true
echo "Added 'Chapter Craft' to the app menu."
