#!/usr/bin/env bash
# Update an already-installed Chapter Craft Program Runner, in one command.
#
#   sudo bash vps-runner/update.sh
#
# What it does, in order, and nothing else:
#   1. pulls the repo (only if this is a git checkout and it is clean)
#   2. copies the runner code into the installed location
#   3. opens up runner.config.json:
#        • drops `memory` / `cpus` so each job gets the largest share the box
#          can serve at the configured concurrency, after the host reserve
#        • raises `pids_limit` off the old 256 (it counts THREADS, and 256 is
#          tight for anything that builds a package)
#        • turns persistence ON, which is also what lets a program install its
#          own libraries and keep them
#        • adds the pip/npm index hosts to the egress allowlist
#   4. creates the state directory with the right owner and 0700 parent
#   5. restarts the service and reports what actually happened
#
# Every config edit is idempotent and backed up first. Anything already set the
# way you want it is left alone, and an explicit choice of yours is never
# overwritten without saying so. Run it twice and the second run changes nothing.
set -euo pipefail

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
skip() { printf '  \033[2m·\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31m✗ %s\033[0m\n\n' "$*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "Run this with sudo:  sudo bash $0"

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT=/etc/systemd/system/program-runner.service
[ -f "$UNIT" ] || die "The runner does not look installed — $UNIT is missing.
If you have not set the VPS up yet, follow vps-runner/README.md sections 1-5 first."

# Read the real paths out of the installed unit rather than assuming them, so a
# non-standard install still updates the files it is actually running.
unit_val() { sed -n "s/^$1=//p" "$UNIT" | tail -1; }
APP_DIR="$(unit_val WorkingDirectory)"; APP_DIR="${APP_DIR:-/opt/chapter-craft-runner}"
RUN_USER="$(unit_val User)";            RUN_USER="${RUN_USER:-ccrunner}"
RUN_GROUP="$(unit_val Group)";          RUN_GROUP="${RUN_GROUP:-$RUN_USER}"
CONFIG="$(sed -n 's/^Environment=RUNNER_CONFIG=//p' "$UNIT" | tail -1)"
CONFIG="${CONFIG:-/etc/chapter-craft-runner/runner.config.json}"

[ -d "$APP_DIR" ] || die "Install directory $APP_DIR does not exist."
[ -f "$CONFIG" ]  || die "Config $CONFIG does not exist."
command -v node >/dev/null || die "node is not on PATH — the runner needs Node 20+."

say "Chapter Craft runner update"
echo "  code      $APP_DIR"
echo "  config    $CONFIG"
echo "  service   program-runner (user $RUN_USER)"

# ── 1. pull ──────────────────────────────────────────────────────────────────
say "1. Latest code"
if [ -d "$SRC/../.git" ]; then
  if [ -n "$(git -C "$SRC/.." status --porcelain 2>/dev/null)" ]; then
    warn "the checkout has local changes — skipping git pull, copying what is on disk"
  elif git -C "$SRC/.." pull --ff-only >/dev/null 2>&1; then
    ok "pulled $(git -C "$SRC/.." rev-parse --short HEAD)"
  else
    warn "git pull did not fast-forward — copying what is on disk"
  fi
else
  skip "not a git checkout — copying what is on disk"
fi

# ── 2. copy code ─────────────────────────────────────────────────────────────
say "2. Install the code"
for f in server.mjs selftest.mjs egress-proxy.mjs package.json; do
  [ -f "$SRC/$f" ] || die "missing $SRC/$f — is this the vps-runner directory?"
done
node --check "$SRC/server.mjs" || die "server.mjs does not parse — refusing to install it."
install -o "$RUN_USER" -g "$RUN_GROUP" -m 644 \
  "$SRC/server.mjs" "$SRC/selftest.mjs" "$SRC/egress-proxy.mjs" "$SRC/package.json" "$APP_DIR/"
ok "copied server.mjs, selftest.mjs, egress-proxy.mjs, package.json"
if [ -f "$SRC/README.md" ]; then
  install -o "$RUN_USER" -g "$RUN_GROUP" -m 644 "$SRC/README.md" "$APP_DIR/"
  ok "copied README.md"
fi

UNIT_CHANGED=0
if [ -f "$SRC/systemd/program-runner.service" ] && ! cmp -s "$SRC/systemd/program-runner.service" "$UNIT"; then
  cp "$SRC/systemd/program-runner.service" "$UNIT"
  UNIT_CHANGED=1
  ok "updated the systemd unit"
fi

# ── 3. config ────────────────────────────────────────────────────────────────
say "3. Open up the limits"
BACKUP="$CONFIG.bak.$(date +%Y%m%d-%H%M%S)"
cp -p "$CONFIG" "$BACKUP"

# Node does the editing: it is already a dependency, and it parses the file the
# same way the runner does, so a config this accepts is a config that will boot.
if ! CONFIG_PATH="$CONFIG" node <<'NODE'
const fs = require("fs");
const path = process.env.CONFIG_PATH;
let cfg;
try { cfg = JSON.parse(fs.readFileSync(path, "utf8")); }
catch (e) { console.error(`  \x1b[31m✗\x1b[0m ${path} is not valid JSON (${e.message}) — nothing changed.`); process.exit(3); }

const ok   = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const skip = (m) => console.log(`  \x1b[2m·\x1b[0m ${m}`);
let changed = false;

// Auto-sizing: an ABSENT memory/cpus means "give this job the largest share the
// box can serve". A pinned value is an operator decision, but the shipped
// example pins the old conservative defaults, so those two exact values are
// treated as "never actually chosen" and removed.
for (const [key, stale] of [["memory", "512m"], ["cpus", "1"]]) {
  if (!(key in cfg)) { skip(`${key} already auto-sizes`); continue; }
  if (String(cfg[key]) === stale) { delete cfg[key]; changed = true; ok(`${key}: ${stale} → sized to this machine`); }
  else skip(`${key} is pinned to ${JSON.stringify(cfg[key])} — leaving your choice alone`);
}
for (const key of ["max_memory", "max_cpus"]) {
  if (key in cfg && String(cfg[key]) === (key === "max_memory" ? "512m" : "1")) {
    delete cfg[key]; changed = true; ok(`${key}: ceiling lifted off the old default`);
  }
}

// pids counts THREADS; 256 starves pip/npm/numpy. Unused pids cost nothing.
if (Number(cfg.pids_limit) > 0 && Number(cfg.pids_limit) < 1024) {
  ok(`pids_limit: ${cfg.pids_limit} → 1024`); cfg.pids_limit = 1024; changed = true;
} else skip("pids_limit already has room");
if (Number(cfg.max_pids) > 0 && Number(cfg.max_pids) < 1024) { cfg.max_pids = 1024; changed = true; }

// Persistence is the switch that lets a program keep files AND installed
// libraries between runs.
if (cfg.persist_enabled === true) skip("persistence already on");
else { cfg.persist_enabled = true; changed = true; ok("persistence: ON (programs keep /state between runs)"); }

// The package index hosts. Harmless when egress is off — the runner refuses
// allowlist jobs outright until its lockdown self-test passes.
const INDEX_HOSTS = ["pypi.org", "files.pythonhosted.org", "registry.npmjs.org"];
if (!Array.isArray(cfg.allowed_hosts_global)) cfg.allowed_hosts_global = [];
const added = INDEX_HOSTS.filter((h) => !cfg.allowed_hosts_global.includes(h));
// Drop the placeholder from the shipped example so it does not look allowed.
const ph = cfg.allowed_hosts_global.indexOf("api.example.com");
if (ph >= 0) { cfg.allowed_hosts_global.splice(ph, 1); changed = true; ok("removed the api.example.com placeholder"); }
if (added.length) { cfg.allowed_hosts_global.push(...added); changed = true; ok(`egress allowlist += ${added.join(", ")}`); }
else skip("package index hosts already allowed");

if (!changed) { skip("config already set up this way — nothing to write"); process.exit(0); }

// Atomic write, preserving the file's owner/mode via a temp file beside it.
const tmp = path + ".tmp";
fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n");
try { const st = fs.statSync(path); fs.chmodSync(tmp, st.mode); fs.chownSync(tmp, st.uid, st.gid); } catch { /* keep going */ }
JSON.parse(fs.readFileSync(tmp, "utf8"));   // never install a file we cannot read back
fs.renameSync(tmp, path);
NODE
then
  die "config update failed — your original is untouched at $CONFIG (backup: $BACKUP)"
fi
if cmp -s "$BACKUP" "$CONFIG"; then rm -f "$BACKUP"; else ok "backup saved: $BACKUP"; fi

# ── 4. state directory ───────────────────────────────────────────────────────
say "4. State directory"
STATE_DIR="$(CONFIG_PATH="$CONFIG" node -e 'const c=JSON.parse(require("fs").readFileSync(process.env.CONFIG_PATH,"utf8"));process.stdout.write(c.state_dir||"/var/lib/chapter-craft-runner/state")')"
install -d -o "$RUN_USER" -g "$RUN_GROUP" -m 0700 "$STATE_DIR"
ok "$STATE_DIR (0700, owned by $RUN_USER)"

# ── 5. restart ───────────────────────────────────────────────────────────────
say "5. Restart"
if [ "$UNIT_CHANGED" = "1" ]; then systemctl daemon-reload; ok "systemd reloaded"; fi
systemctl restart program-runner
sleep 5
if systemctl is-active --quiet program-runner; then
  ok "program-runner is running"
else
  warn "the service did not come up — the last 30 log lines:"
  journalctl -u program-runner -n 30 --no-pager || true
  die "restart failed. Your previous config is at $BACKUP if you need to put it back."
fi

say "What the runner decided for this box"
# --since, not -n: a plain tail can hand back the PREVIOUS boot's summary while
# journald is still flushing this one, which reads as "nothing changed" when in
# fact everything did. Anything older than this restart is not this restart.
SUMMARY="$(journalctl -u program-runner --since "-90 seconds" --no-pager 2>/dev/null | grep -E '\[runner\] (ceilings|SAFETY CLAMP|egress|listening|persist)' | tail -6 || true)"
if [ -n "$SUMMARY" ]; then printf '%s\n' "$SUMMARY"
else skip "journald has not flushed this boot yet — run: journalctl -u program-runner --since '-2 min'"; fi

say "Done"
cat <<EOF
  Programs now get the largest slice this machine can safely serve, keep their
  files between runs, and can install their own libraries.

  Installing libraries also needs outbound network, which is a separate,
  deliberately-locked-down setup. If the lines above say egress is DISABLED and
  you want pip/npm to work, run:

      sudo bash $SRC/setup-egress.sh
      sudo RUNNER_CONFIG=$CONFIG node $SRC/selftest.mjs      # expect: RESULT: PASS
      sudo systemctl restart program-runner

  Then check the app: Settings → Program Foundry → Test connection.
EOF
