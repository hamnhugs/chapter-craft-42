#!/usr/bin/env bash
#
# Chapter Craft Program Runner — allowlist egress setup (idempotent).
#
# ┌───────────────────────────────────────────────────────────────────────────┐
# │ YOU ONLY NEED THIS FOR "allowlist" EGRESS.                                 │
# │ The default egress mode is network:none (--network none), which needs      │
# │ ZERO setup and is bulletproof. Run this script ONLY if you want approved   │
# │ programs to reach specific external hosts. Requires root.                  │
# └───────────────────────────────────────────────────────────────────────────┘
#
# What it does:
#   1. Creates a normal bridge network `ccprog-egress` with inter-container
#      comms disabled (enable_icc=false). NOT --internal: --internal would block
#      ALL external traffic including the proxy's own dial-outs, defeating the
#      purpose. We want a normal bridge and then surgically DROP everything from
#      the sandbox with iptables, allowing ONLY sandbox -> proxy.
#   2. Starts the `ccprog-proxy` container (plain node:20-alpine) on that network
#      at a fixed IP, mounting egress-proxy.mjs + runner.config.json read-only.
#   3. Installs iptables rules so the sandbox can reach ONLY the proxy on :8753,
#      and nothing else — not the gateway, not 169.254.169.254, not the host.
#
# After running this, run `npm run selftest` (or `node selftest.mjs`) to PROVE
# the lockdown holds. server.mjs re-runs that same proof at startup and refuses
# to serve allowlist egress unless it passes (fail closed).
#
# NOTE: iptables rules are not persisted across reboot by this script. Re-run it
# on boot (e.g. a systemd oneshot that runs after docker.service), or snapshot
# the rules with `netfilter-persistent save` after a successful run.

set -euo pipefail

# ── tunables (override via env) ──────────────────────────────────────────────
NETWORK="${CCPROG_NETWORK:-ccprog-egress}"
SUBNET="${CCPROG_SUBNET:-172.31.99.0/24}"
GATEWAY="${CCPROG_GATEWAY:-172.31.99.1}"
PROXY_IP="${CCPROG_PROXY_IP:-172.31.99.2}"
PROXY_PORT="${CCPROG_PROXY_PORT:-8753}"
BRIDGE_NAME="${CCPROG_BRIDGE:-br-ccprog}"
PROXY_IMAGE="${CCPROG_PROXY_IMAGE:-node:20-alpine}"
PROXY_SRC="${CCPROG_PROXY_SRC:-/opt/chapter-craft-runner/egress-proxy.mjs}"
CONFIG_SRC="${CCPROG_CONFIG_SRC:-/etc/chapter-craft-runner/runner.config.json}"

# ── preflight ────────────────────────────────────────────────────────────────
if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "This script installs iptables rules and must run as root (try: sudo $0)." >&2
  exit 1
fi
command -v docker   >/dev/null 2>&1 || { echo "docker not found on PATH." >&2; exit 1; }
command -v iptables >/dev/null 2>&1 || { echo "iptables not found on PATH." >&2; exit 1; }
[[ -f "$PROXY_SRC"  ]] || { echo "egress-proxy.mjs not found at $PROXY_SRC (set CCPROG_PROXY_SRC)." >&2; exit 1; }
[[ -f "$CONFIG_SRC" ]] || { echo "runner.config.json not found at $CONFIG_SRC (set CCPROG_CONFIG_SRC)." >&2; exit 1; }

# ── 1. docker network ────────────────────────────────────────────────────────
if docker network inspect "$NETWORK" >/dev/null 2>&1; then
  echo "[setup] network $NETWORK already exists."
else
  echo "[setup] creating network $NETWORK ($SUBNET)…"
  docker network create \
    --driver bridge \
    --subnet "$SUBNET" \
    --gateway "$GATEWAY" \
    -o com.docker.network.bridge.enable_icc=false \
    -o "com.docker.network.bridge.name=$BRIDGE_NAME" \
    "$NETWORK" >/dev/null
fi

# Discover the real bridge interface name (in case the network pre-existed).
BRIDGE="$(docker network inspect "$NETWORK" -f '{{index .Options "com.docker.network.bridge.name"}}' 2>/dev/null || true)"
if [[ -z "$BRIDGE" ]]; then
  NETID="$(docker network inspect "$NETWORK" -f '{{.Id}}')"
  BRIDGE="br-${NETID:0:12}"
fi
echo "[setup] bridge interface: $BRIDGE"

# ── 2. proxy container ───────────────────────────────────────────────────────
echo "[setup] (re)starting ccprog-proxy at $PROXY_IP:$PROXY_PORT…"
docker rm -f ccprog-proxy >/dev/null 2>&1 || true
docker run -d \
  --name ccprog-proxy \
  --restart unless-stopped \
  --network "$NETWORK" \
  --ip "$PROXY_IP" \
  -e "RUNNER_CONFIG=/runner.config.json" \
  -e "CCPROG_PROXY_PORT=$PROXY_PORT" \
  -v "$PROXY_SRC:/egress-proxy.mjs:ro" \
  -v "$CONFIG_SRC:/runner.config.json:ro" \
  "$PROXY_IMAGE" node /egress-proxy.mjs >/dev/null
echo "[setup] ccprog-proxy started."

# ── 3. iptables lockdown ─────────────────────────────────────────────────────
# We use two dedicated chains so the whole thing is idempotent (flush + refill)
# and easy to read. DOCKER-USER is evaluated by docker BEFORE its own per-network
# rules (including the enable_icc=false DROP), so our ACCEPT for sandbox->proxy
# wins over the icc DROP.

# --- FORWARD: control traffic LEAVING the sandbox (routed off the bridge, plus
#     intra-bridge sandbox->proxy). Only src=$SUBNET is sent here.
iptables -N CCPROG_FWD 2>/dev/null || true
iptables -F CCPROG_FWD
# Return packets for connections we already allowed.
iptables -A CCPROG_FWD -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
# The proxy itself must reach the internet (it dials on the sandbox's behalf).
# This must precede the catch-all DROP because the proxy shares $SUBNET.
iptables -A CCPROG_FWD -s "$PROXY_IP" -j ACCEPT
# The sandbox may reach ONLY the proxy, ONLY on the proxy port.
iptables -A CCPROG_FWD -s "$SUBNET" -d "$PROXY_IP" -p tcp --dport "$PROXY_PORT" -j ACCEPT
# Everything else from the sandbox subnet (gateway, 169.254.169.254 metadata,
# other private ranges, direct internet, other containers) is dropped.
iptables -A CCPROG_FWD -s "$SUBNET" -j DROP
# Send only egress-subnet-sourced traffic into our chain; everything else falls
# through to docker's normal handling.
iptables -C DOCKER-USER -s "$SUBNET" -j CCPROG_FWD 2>/dev/null \
  || iptables -I DOCKER-USER 1 -s "$SUBNET" -j CCPROG_FWD

# --- INPUT: block traffic destined to the HOST ITSELF from the bridge. Packets
#     to a host-local IP (e.g. docker0 gateway 172.17.0.1, or the host's primary
#     address) hit INPUT, NOT FORWARD, so the rules above wouldn't catch them.
#     Neither the sandbox nor the proxy has any reason to talk to the host.
iptables -N CCPROG_IN 2>/dev/null || true
iptables -F CCPROG_IN
iptables -A CCPROG_IN -j DROP
iptables -C INPUT -i "$BRIDGE" -j CCPROG_IN 2>/dev/null \
  || iptables -I INPUT 1 -i "$BRIDGE" -j CCPROG_IN

echo "[setup] iptables rules installed."
echo
echo "[setup] Done. Now PROVE the lockdown:"
echo "          node selftest.mjs        # expect: RESULT: PASS"
echo "        Then (re)start the runner so it re-runs the proof at boot."
