#!/usr/bin/env bash
# The typefaces DesignCraft's page looks use (scripts/local-ai/design-looks.mjs):
# a small, curated set of open-licence (SIL OFL) Google Fonts, as static
# TrueType files, one per weight. DesignCraft reads ~/.local/share/fonts, so
# they work in the window and in the headless engine alike. Runs as YOUR user
# (no sudo); re-running skips what is already there.
#
#   scripts/local-ai/install-design-fonts.sh
#
# Why these: each look pairs one display face with one text face, the way
# designers do (one or two families a page, contrast in size and weight, not
# in more fonts). See docs/local-ai/DESIGN-LOOKS.md.
set -euo pipefail

DEST="${CC_FONT_DIR:-$HOME/.local/share/fonts/chapter-craft}"
say() { printf '\033[1;33m==>\033[0m %s\n' "$*"; }
mkdir -p "$DEST"

# Google Fonts css2 axes, one family per line. An old user agent makes the API
# answer with static .ttf instances instead of variable woff2.
FAMILIES=(
  "Inter:wght@300;400;500;600;700;800;900"
  "Inter+Tight:wght@500;700;800;900"
  "Playfair+Display:ital,wght@0,400;0,600;0,700;0,800;0,900;1,400;1,600;1,700"
  "Bebas+Neue"
  "Anton"
  "Archivo+Black"
  "Archivo:wght@400;500;600;700;800"
  "Cormorant+Garamond:ital,wght@0,400;0,500;0,600;0,700;1,400;1,500;1,600"
  "EB+Garamond:ital,wght@0,400;0,500;0,600;0,700;1,400;1,600"
  "Cinzel:wght@400;600;700;900"
  "DM+Serif+Display:ital@0;1"
  "DM+Sans:ital,wght@0,400;0,500;0,700;1,400"
  "Fraunces:ital,wght@0,300;0,400;0,600;0,700;0,900;1,400;1,600"
  "Montserrat:wght@300;400;500;600;700;800;900"
  "Oswald:wght@300;400;500;600;700"
  "Space+Grotesk:wght@400;500;700"
  "Lora:ital,wght@0,400;0,600;0,700;1,400"
  "Abril+Fatface"
  "Libre+Baskerville:ital,wght@0,400;0,700;1,400"
  "Josefin+Sans:wght@300;400;600;700"
)
declare -A WEIGHT=([100]=Thin [200]=ExtraLight [300]=Light [400]=Regular [500]=Medium [600]=SemiBold [700]=Bold [800]=ExtraBold [900]=Black)

n=0
for fam in "${FAMILIES[@]}"; do
  css="$(curl -fsSL -A "Mozilla/4.0" "https://fonts.googleapis.com/css2?family=$fam")"
  # Each @font-face block → name, style, weight, url.
  while IFS='|' read -r name style weight url; do
    [ -n "$url" ] || continue
    w="${WEIGHT[$weight]:-$weight}"
    [ "$style" = "italic" ] && w="$([ "$w" = Regular ] && echo Italic || echo "${w}Italic")"
    file="$DEST/${name// /}-$w.ttf"
    if [ -s "$file" ]; then continue; fi
    curl -fsSL -o "$file.part" "$url" && mv "$file.part" "$file"
    n=$((n + 1))
  done < <(printf '%s\n' "$css" | awk '
    /font-family:/ { gsub(/.*font-family: *.|.;.*/, ""); name=$0 }
    /font-style:/  { gsub(/.*font-style: *|;.*/, ""); style=$0 }
    /font-weight:/ { gsub(/.*font-weight: *|;.*/, ""); weight=$0 }
    /src: *url/    { u=$0; sub(/.*url\(/, "", u); sub(/\).*/, "", u); print name "|" style "|" weight "|" u }')
done
command -v fc-cache >/dev/null && fc-cache -f "$DEST" >/dev/null 2>&1 || true
say "design fonts: $n new, $(ls "$DEST" | wc -l) in $DEST"
