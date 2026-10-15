#!/usr/bin/env bash
# One-time system setup for the local edition. Needs sudo — run it in a real
# terminal (sudo can't prompt through Claude Code's `!`):
#
#   bash scripts/local-ai/setup-once.sh
#
# Does exactly four things, each idempotent:
#   1. Docker: enable the service and add you to the `docker` group
#      (local Supabase and SearXNG run in containers).
#   2. Ollama: a systemd override with the settings the app was measured with.
#   3. GPU: while Local AI is switched on in the app, keep the RX 5600M awake
#      with the COMPUTE power profile. Measured: under the default "auto" policy VRAM sat at
#      500 MHz and prompts ran ~80 tok/s; COMPUTE gives ~415 tok/s. But with
#      the profile, the card hung ("device lost") 4 times out of 4 on the
#      first request after waking from runtime suspend — so it stays awake
#      while Local AI is on and goes back to stock when it's off
#      (docs/local-ai/results/2026-10-12-gpu-profile.txt).
#   4. Nothing else. No packages are installed.
set -euo pipefail
[ "$(id -u)" -eq 0 ] && { echo "Run as your normal user; the script calls sudo itself." >&2; exit 1; }
say() { printf '\033[1;33m==>\033[0m %s\n' "$*"; }

# 1. Docker -------------------------------------------------------------------
say "docker: enable service, add $USER to group docker"
sudo systemctl enable --now docker
if ! id -nG "$USER" | tr ' ' '\n' | grep -qx docker; then
  sudo usermod -aG docker "$USER"
  NEED_RELOGIN=1
fi

# 2. Ollama -------------------------------------------------------------------
#  KEEP_ALIVE 30m      a resident model never pays the dGPU cold-wake penalty mid-chat
#  MAX_LOADED_MODELS 2 chat + embedder together (~3 GiB + 0.3 GiB)
#  NUM_PARALLEL 1      one 16K context, not four — VRAM is the constraint
#  CONTEXT_LENGTH      requests always send num_ctx; this covers anything that doesn't
#  FLASH_ATTENTION 1   on by default for Vulkan here; pinned because the KV type needs it
#  KV_CACHE_TYPE q8_0  halves the 16K context (2.3 -> 1.2 GiB), which lets the Q6_K chat model
#                      sit wholly on the card: 33 tok/s instead of 22 with f16 KV, answers 267/280
#                      identical. Don't pair it with qwen3:4b at Q4 — that combination reads
#                      prompts 4.5x slower here (docs/local-ai/results/2026-10-13-accuracy-speed.txt).
say "ollama: systemd override"
sudo mkdir -p /etc/systemd/system/ollama.service.d
sudo tee /etc/systemd/system/ollama.service.d/chapter-craft.conf >/dev/null <<'EOF'
[Service]
Environment="OLLAMA_KEEP_ALIVE=30m"
Environment="OLLAMA_MAX_LOADED_MODELS=2"
Environment="OLLAMA_NUM_PARALLEL=1"
Environment="OLLAMA_CONTEXT_LENGTH=16384"
Environment="OLLAMA_FLASH_ATTENTION=1"
Environment="OLLAMA_KV_CACHE_TYPE=q8_0"
EOF
# (Ollama is restarted at the end of step 3, once the helper it calls exists.)

# 3. GPU: awake + COMPUTE while Local AI is on ---------------------------------
# One root-owned helper with exactly two verbs, called by scripts/local-ai/control.mjs
# when Local AI is switched on (hold) or off (release), and by local-down.sh (release):
#   hold     power/control=on (no runtime suspend) + manual level + COMPUTE profile
#   release  power/control=auto + level auto — stock behaviour
# Nothing applies it at boot: outside Local AI the card behaves as shipped.
say "gpu: helper for the app's power settings"
sudo tee /usr/local/bin/cc-amdgpu-compute >/dev/null <<'EOF'
#!/bin/sh
# Chapter Craft local edition — see scripts/local-ai/setup-once.sh step 3.
# Usage: cc-amdgpu-compute hold|release   (acts on the AMD GPU with the most VRAM)
best=""; bestv=0
for d in /sys/class/drm/card[0-9]*/device; do
  [ "$(cat "$d/vendor" 2>/dev/null)" = "0x1002" ] || continue
  v=$(cat "$d/mem_info_vram_total" 2>/dev/null || echo 0)
  [ "$v" -gt "$bestv" ] && { best="$d"; bestv="$v"; }
done
[ -n "$best" ] || exit 0
case "$1" in
  hold)
    echo on > "$best/power/control"          # wake now and stay awake
    echo manual > "$best/power_dpm_force_performance_level" || exit 1
    idx=$(awk '/COMPUTE/{gsub(/[^0-9]/,"",$1); print $1; exit}' "$best/pp_power_profile_mode")
    [ -n "$idx" ] && echo "$idx" > "$best/pp_power_profile_mode" ;;
  release)
    echo auto > "$best/power_dpm_force_performance_level" 2>/dev/null
    echo auto > "$best/power/control" ;;
  *) echo "usage: $0 hold|release" >&2; exit 2 ;;
esac
EOF
sudo chmod 755 /usr/local/bin/cc-amdgpu-compute
# The first version of this script applied the profile at boot and on every
# Ollama start; remove that.
if [ -f /etc/systemd/system/cc-amdgpu-compute.service ]; then
  sudo systemctl disable --now cc-amdgpu-compute.service >/dev/null 2>&1 || true
  sudo rm -f /etc/systemd/system/cc-amdgpu-compute.service
fi
# Passwordless for exactly these two invocations, nothing else.
SUDOERS=/etc/sudoers.d/cc-amdgpu-compute
printf '%s\n' "$USER ALL=(root) NOPASSWD: /usr/local/bin/cc-amdgpu-compute hold, /usr/local/bin/cc-amdgpu-compute release" | sudo tee "$SUDOERS.tmp" >/dev/null
sudo chmod 440 "$SUDOERS.tmp"
if sudo visudo -cf "$SUDOERS.tmp" >/dev/null; then sudo mv "$SUDOERS.tmp" "$SUDOERS"; else sudo rm -f "$SUDOERS.tmp"; echo "  (sudoers rule rejected by visudo; skipped)"; fi
sudo /usr/local/bin/cc-amdgpu-compute release   # stock until Local AI is switched on
say "ollama: restart with the new settings"
sudo systemctl daemon-reload
sudo systemctl restart ollama

say "done."
if [ "${NEED_RELOGIN:-0}" = 1 ]; then
  echo "You were added to the docker group: log out and back in (or run 'newgrp docker') before scripts/local-up.sh."
fi
echo "Undo: sudo /usr/local/bin/cc-amdgpu-compute release; sudo rm /etc/systemd/system/ollama.service.d/chapter-craft.conf /etc/sudoers.d/cc-amdgpu-compute /usr/local/bin/cc-amdgpu-compute"
