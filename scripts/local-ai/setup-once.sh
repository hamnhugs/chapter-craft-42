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
#   3. GPU: keep the RX 5600M out of its lowest memory clock while computing.
#      Measured: VRAM sat at 500 MHz under load with the default "auto"
#      policy and prompt processing ran ~79 tok/s instead of 230-440
#      (docs/local-ai/results/2026-10-12-latency-profile.txt).
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
say "ollama: systemd override"
sudo mkdir -p /etc/systemd/system/ollama.service.d
sudo tee /etc/systemd/system/ollama.service.d/chapter-craft.conf >/dev/null <<'EOF'
[Service]
Environment="OLLAMA_KEEP_ALIVE=30m"
Environment="OLLAMA_MAX_LOADED_MODELS=2"
Environment="OLLAMA_NUM_PARALLEL=1"
Environment="OLLAMA_CONTEXT_LENGTH=16384"
# Re-apply the GPU COMPUTE profile whenever Ollama (re)starts ("+" = as root).
ExecStartPost=+-/usr/local/bin/cc-amdgpu-compute
EOF
# (Ollama is restarted at the end of step 3, once the helper it calls exists.)

# 3. GPU compute power profile -----------------------------------------------
# Finds the discrete AMD card (largest VRAM) and switches its power profile to
# COMPUTE, which raises the clock floor under load but still idles down —
# unlike "high", which pins clocks (heat + battery) even when nothing runs.
say "gpu: COMPUTE power profile on the discrete AMD card"
sudo tee /usr/local/bin/cc-amdgpu-compute >/dev/null <<'EOF'
#!/bin/sh
# Set the COMPUTE power profile on the AMD GPU with the most VRAM.
best=""; bestv=0
for d in /sys/class/drm/card[0-9]*/device; do
  [ "$(cat "$d/vendor" 2>/dev/null)" = "0x1002" ] || continue
  v=$(cat "$d/mem_info_vram_total" 2>/dev/null || echo 0)
  [ "$v" -gt "$bestv" ] && { best="$d"; bestv="$v"; }
done
[ -n "$best" ] || exit 0
echo manual > "$best/power_dpm_force_performance_level" || exit 0
idx=$(awk '/COMPUTE/{gsub(/[^0-9]/,"",$1); print $1; exit}' "$best/pp_power_profile_mode")
[ -n "$idx" ] && echo "$idx" > "$best/pp_power_profile_mode"
EOF
sudo chmod 755 /usr/local/bin/cc-amdgpu-compute
sudo tee /etc/systemd/system/cc-amdgpu-compute.service >/dev/null <<'EOF'
[Unit]
Description=Chapter Craft local: AMD GPU COMPUTE power profile
After=multi-user.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/cc-amdgpu-compute
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now cc-amdgpu-compute.service || echo "  (profile not applied now — the card may be suspended; it applies at boot)"
# The profile can be lost when the laptop dGPU runtime-suspends, so
# scripts/local-up.sh re-applies it on every start. This rule lets it run
# THAT ONE root-owned script without a password — nothing else.
SUDOERS=/etc/sudoers.d/cc-amdgpu-compute
echo "$USER ALL=(root) NOPASSWD: /usr/local/bin/cc-amdgpu-compute" | sudo tee "$SUDOERS.tmp" >/dev/null
sudo chmod 440 "$SUDOERS.tmp"
if sudo visudo -cf "$SUDOERS.tmp" >/dev/null; then sudo mv "$SUDOERS.tmp" "$SUDOERS"; else sudo rm -f "$SUDOERS.tmp"; echo "  (sudoers rule rejected by visudo; skipped)"; fi
say "ollama: restart with the new settings"
sudo systemctl daemon-reload
sudo systemctl restart ollama

say "done."
if [ "${NEED_RELOGIN:-0}" = 1 ]; then
  echo "You were added to the docker group: log out and back in (or run 'newgrp docker') before scripts/local-up.sh."
fi
echo "Undo: sudo systemctl disable --now cc-amdgpu-compute; sudo rm /etc/systemd/system/ollama.service.d/chapter-craft.conf /etc/sudoers.d/cc-amdgpu-compute /usr/local/bin/cc-amdgpu-compute"
