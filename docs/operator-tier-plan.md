# Chapter Craft Program Foundry — Operator Tier: FINAL Implementation Plan

Verified against the real code: `vps-runner/server.mjs`, `runner.config.example.json`,
`egress-proxy.mjs`, `setup-egress.sh`, `selftest.mjs`, `Dockerfile.sandbox`,
`systemd/program-runner.service`; `supabase/functions/_shared/runner.ts`, `program-run/index.ts`,
`program-verify/index.ts`; `supabase/migrations/20260824000000_program_foundry.sql`; and the client
`src/lib/programFoundry.ts`, `src/lib/chatTools.ts`, `src/components/ProgramApprovalCard.tsx`,
`src/components/ProgramRunnerSettings.tsx`.

**Scope.** The Operator tier stays entirely inside gVisor and runs only pinned-approved, not-disabled
code. It adds (a) larger/configurable resources, (b) persistent `/state`, (c) cron, (d) wider egress —
all under the sandbox and the human approval gate. **Host-admin / host-root execution is explicitly NOT
in this tier** (a separate future opt-in, never scheduled). Nothing here grants program code any host
reach it lacks today.

**Master rule.** Every new capability is a fingerprinted `manifest` field (any change re-pins → forces
fresh human re-approval) that the runner CLAMPS to an operator ceiling in root-owned, chmod-600
`runner.config.json`. The AI requests; only the operator's config grants; only the human approves.
`0`/`-1`/`"unlimited"` NEVER means infinity — it falls back to the small default (fail-safe).

**One honest boundary up front (from the verdicts).** "Effectively unlimited" applies to **memory, CPU,
output, concurrency, and persistent storage**. **Wall-clock does NOT become unlimited in this tier.**
Interactive runs stay bounded by the edge window (~90 s). Cron runs are bounded to a value that fits
inside `program-cron`'s own edge wall-clock (`CRON_SYNC_MAX_MS`, ~75 s). Longer unattended runs require
an **async report-back path** (`program-report`, section 9) that is DESIGNED here but DEFERRED as its own
future opt-in — so nothing in this tier ever dispatches a run it cannot await. This is the deliberate
resolution of verdict `cron-wrong-code` fix 3 and verdict `limits-egress-host` fix 3.

---

## 0. How every required_fix is discharged (traceability)

| Verdict (severity) | Required fix | Where addressed |
|---|---|---|
| persistence-exfil-escape (high) | 1. Fence `/state` across versions; re-approval re-gates state contents | §3 state-epoch + explicit disposition; §6 migration `approve_program(p_state_disposition)`; §7 card carry-forward confirm |
| | 2. Persist runs redact the FULL secrets map, not just declared names | §2c `redactNames` = all `SECRETS` keys when `persist` |
| | 3. Warn on EVERY persist program (ancestor may have written data/secrets/executable code) | §7 card `persistWarn` (always for persist) |
| | 4. Drop the "noexec ⇒ never executable" claim | §3 "noexec is NOT a script-exec control"; config docs; §8 note |
| | 5. Aggregate host-state ceiling + reclaim orphaned/disabled images | §3 `state_max_total_mb` pre-check + epoch-sibling GC + `/gc` live-set sweep |
| cron-wrong-code (high) | 1. Authorization predicate INSIDE the atomic claim; re-verify per row; auto-pause | §6 `claim_due_schedules` `WHERE EXISTS(approved head + inline sha == pin) AND NOT EXISTS(disables)`; §9 program-cron re-checks each row |
| | 2. REVOKE claim from PUBLIC; GRANT service_role only | §6 grants block |
| | 3. Lease > max run; resolve >90 s cron vs edge wall-clock | §6 lease = 2×dispatched+120 s, floored 5 min; cron clamped to `CRON_SYNC_MAX_MS`; async path deferred (§9) |
| | 4. Log a typed skip/failure row on claim-then-crash; monitor tick liveness | §9 pending-then-settle + lease-reaper skip rows; `program_cron_health` + UI badge |
| limits-egress-host (high) | 1. CPU guard CLAMPS (not warns); reserve ≥1 core + ≥15% RAM; sandbox cpu weight below host | §2b `CONCURRENCY_EFF` min(RAM,CPU) clamp; §2c `--cpu-shares 512`; §1 stop recommending cores==concurrency |
| | 2. Under `"*"`: always-deny host public IPs/gateways; refuse literal-IP CONNECT; intersect per-job ⋂ global | §5 per-job ACL intersection + `_deny.json` auto public-IP deny + literal-IP refusal |
| | 3. Lease tied to run; single-flight per schedule | §6 lease formula + `in_flight` single-flight |
| | 4. Aggregate state ceiling + GC; avoid host-side ext4 bug surface | §3 ceiling+GC; `e2fsck -p -f` preen + `errors=remount-ro` on every mount; userspace fallback documented |

---

## 1. `runner.config.json` schema ADDITIONS

All additive; every default reproduces today's behavior (out-of-box grants nothing new until a ceiling is
deliberately raised or persistence is switched on).

```jsonc
// ── resource CEILINGS (a manifest request is clamped to these; never 0/"unlimited") ──
"max_memory":     "512m",   // ceiling for manifest.memory. default = today's `memory`.
"max_cpus":       "1",      // ceiling for manifest.cpus.  default = today's `cpus`.
"max_pids":       256,      // ceiling for manifest.pids (counts THREADS).
"max_output_kb":  128,      // NEW. makes the hardcoded 128*1024 OUTPUT_CAP configurable.
"max_timeout_ms": 60000,    // EXISTS. See wall-clock note below — raising it has no effect until §9 ships.
// "concurrency" (3) and "queue_max" (10) already exist — global, unchanged.

// ── host reservation (mandatory CPU/RAM clamp — verdict limits-egress-host fix 1) ──
"reserve_cores":    1,       // cores held back for Hermes/docker/runner; effective drops to cores-1 on a 1-core box
"reserve_ram_frac": 0.15,    // fraction of RAM held back (>=0.15). Boot guard clamps effective concurrency.

// ── persistence (master switch OFF = today; /state never exists) ──
"persist_enabled":   false,
"state_dir":         "/var/lib/chapter-craft-runner/state",  // per-lineage-epoch .img files
"state_quota_mb":    256,     // HARD per-program image size (kernel ENOSPC at the cap)
"state_max_total_mb": 4096,   // NEW. aggregate ceiling across ALL images; creation refused past it

// ── wider egress (read + hot-reloaded every 30s by egress-proxy.mjs) ──
"allowed_hosts_global": ["api.example.com"],  // EXISTS. Now also accepts "*" = any hostname (see §5).
"denied_hosts_global":  [],   // NEW. hostnames refused at every width, even under "*".
"denied_cidrs_global":  []     // NEW. extra CIDRs refused (host public IP is auto-added regardless — §5).
```

**Ceiling guidance (replaces the old "cores == concurrency" advice — that starved Hermes).** Pick
numbers so that after reservation the box still runs the co-resident Hermes bots + docker + runner:
`concurrency × max_cpus ≤ cores − reserve_cores` and `concurrency × max_memory ≤ (1 − reserve_ram_frac) × RAM`.
Example 8 GB / 4-core box: `max_memory 2g`, `max_cpus 1`, `max_pids 1024`, `max_output_kb 512`,
`concurrency 2`, `reserve_cores 1` → CPU-bound `floor((4−1)/1)=3 ≥ 2`, RAM-bound `floor(8×0.85/2)=3 ≥ 2`.
The boot guard (§2b) enforces both and can only LOWER effective concurrency, never raise it.

---

## 2. `server.mjs` CHANGES

### 2a. Config parse + clamp helpers (replace the fixed `OUTPUT_CAP` at line 55)

```js
import os from "node:os";
const MB = 1024*1024;
const memToBytes = s => { const m=String(s).trim().match(/^(\d+(?:\.\d+)?)\s*([bkmg]?)$/i);
  if(!m) return null; return Math.floor(parseFloat(m[1]) * ({ "":1,b:1,k:1024,m:MB,g:1024*MB }[m[2].toLowerCase()])); };
const bytesToMem = b => `${Math.floor(b/MB)}m`;
const cpuToMilli = s => { const n=parseFloat(String(s)); return Number.isFinite(n)&&n>0?Math.round(n*1000):null; };
const ceil = (v, dflt) => (Number.isFinite(v) && v > 0) ? v : dflt;   // 0/-1/NaN → default, NEVER infinity

const MEM_DEFAULT  = memToBytes(config.memory) ?? 512*MB;
const MEM_MAX      = ceil(memToBytes(config.max_memory), MEM_DEFAULT);
const CPU_DEFAULT  = cpuToMilli(config.cpus) ?? 1000;
const CPU_MAX      = ceil(cpuToMilli(config.max_cpus), CPU_DEFAULT);
const PIDS_DEFAULT = Number(config.pids_limit) || 256;
const PIDS_MAX     = ceil(Number(config.max_pids), PIDS_DEFAULT);
const OUTPUT_CAP   = ceil(Number(config.max_output_kb), 128) * 1024;   // replaces fixed 128*1024
const MEM_FLOOR = 64*MB, PIDS_FLOOR = 128;   // invariant #5: too-low kills the runsc sentry at spawn

const RESERVE_CORES    = Math.max(0, Number(config.reserve_cores) || 1);
const RESERVE_RAM_FRAC = Math.min(0.9, Math.max(0.15, Number(config.reserve_ram_frac) || 0.15));

const PERSIST_ENABLED   = config.persist_enabled === true;
const STATE_DIR         = String(config.state_dir || "/var/lib/chapter-craft-runner/state");
const STATE_QUOTA_MB    = Math.max(16, Number(config.state_quota_mb) || 256);
const STATE_MAX_TOTAL_MB= Math.max(STATE_QUOTA_MB, Number(config.state_max_total_mb) || 4096);
const CRON_SYNC_MAX_MS  = 75_000;   // cron dispatched wall-clock ceiling that fits program-cron's edge budget
```

### 2b. Boot-time CLAMP guard (in the startup IIFE, before `server.listen`) — verdict limits-egress-host fix 1

```js
let CONCURRENCY_EFF = CONCURRENCY;
{
  const ram = os.totalmem(), cores = os.cpus().length;
  const effReserveCores = cores > RESERVE_CORES ? RESERVE_CORES : Math.max(0, cores - 1);
  const ramBound = Math.max(1, Math.floor((ram * (1 - RESERVE_RAM_FRAC)) / MEM_MAX));
  const cpuBound = Math.max(1, Math.floor((cores - effReserveCores) / (CPU_MAX / 1000)));
  CONCURRENCY_EFF = Math.max(1, Math.min(CONCURRENCY, ramBound, cpuBound));
  if (CONCURRENCY_EFF < CONCURRENCY)
    console.error(`[runner] SAFETY CLAMP effective concurrency ${CONCURRENCY}→${CONCURRENCY_EFF} `
      + `(RAM-bound ${ramBound}, CPU-bound ${cpuBound}; reserving ${effReserveCores} core(s) + `
      + `${Math.round(RESERVE_RAM_FRAC*100)}% RAM for host/Hermes). Lower ceilings or raise the box.`);
  console.log(`[runner] ceilings: mem<=${bytesToMem(MEM_MAX)} cpus<=${(CPU_MAX/1000).toFixed(2)} `
    + `pids<=${PIDS_MAX} output<=${OUTPUT_CAP/1024}kb concurrency_eff=${CONCURRENCY_EFF} `
    + `persist=${PERSIST_ENABLED}`);
}
```
`acquire()` (line 105) compares against `CONCURRENCY_EFF` instead of `CONCURRENCY`. The clamp can only
LOWER; on a correctly sized box it equals `concurrency`.

### 2c. Per-job resource mapping in `runJob` (verify stays small)

Insert before `dockerArgs` (line 166). `req()` only honors a manifest request when `mode==="run"`, so an
unapproved 64 GB verify draft can never DoS the box:

```js
const req = (raw, parse, dflt, cap) => {
  let v = dflt;
  if (mode === "run" && raw != null) { const p = parse(raw); if (p != null && p > 0) v = p; }
  return Math.min(v, cap);
};
const memB = Math.max(MEM_FLOOR,  req(manifest.memory, memToBytes, MEM_DEFAULT, MEM_MAX));
const cpuM =                       req(manifest.cpus,   cpuToMilli, CPU_DEFAULT, CPU_MAX);
const pids = Math.max(PIDS_FLOOR, req(manifest.pids,   x=>Number(x)||null, PIDS_DEFAULT, PIDS_MAX));
```

Replace the fixed resource args at line 169. **`--memory-swap` stays pinned equal to `--memory`** (no-swap
invariant). **`--cpu-shares 512`** puts the sandbox cgroup weight BELOW host services (docker/Hermes at the
1024 default), so under contention sandbox jobs yield first (verdict limits-egress-host fix 1):

```js
"--memory", bytesToMem(memB), "--memory-swap", bytesToMem(memB),
"--cpus", (cpuM/1000).toFixed(3),
"--cpu-shares", "512",
"--pids-limit", String(pids),
```

**Full-secret redaction for persist runs (verdict persistence-exfil-escape fix 2).** `/state` may hold a
secret an ANCESTOR version stashed that the current manifest does not declare, so declared-names redaction
is inert against it. When this is a persist run, redact EVERY configured secret name:

```js
const persistRun = mode === "run" && manifest.persist === true && PERSIST_ENABLED;
const redactNames = persistRun ? Object.keys(SECRETS) : secretNames;
// ... at lines 230-231:
stdout = truncate(redact(stdout, redactNames));
stderr = truncate(redact(stderr, redactNames));
```
(This closes the unredacted stdout→`program_runs`→model leak. It CANNOT close CONNECT-tunneled egress —
that is covered by the state-epoch fence §3 and the card warnings §7. `redact()` itself is unchanged.)

### 2d. Persistence + per-job egress-IP branch (mechanism in §3 and §5)

Insert after the tmpfs lines (171-172), producing arrays spliced into `dockerArgs`. **Verify never touches
the durable volume** — a throwaway empty tmpfs `/state` exercises a program's cold-start `open('/state/..')`
path hermetically without leaking or persisting anything:

```js
let stateArgs = [], egressIp = null, aclPath = null;
if (mode === "verify") {
  stateArgs = ["--tmpfs", "/state:size=16m,mode=0700,noexec,nosuid,nodev"];
} else if (manifest.persist === true && PERSIST_ENABLED) {
  const key = sanitizeUuid(job.state_key);                    // strict UUID regex else null (path-traversal)
  const epoch = Number.isInteger(job.state_epoch) && job.state_epoch > 0 ? job.state_epoch : null;
  if (!key || !epoch) return { status:"error", exit_code:null, stdout:"", stderr:"persistent state requested but no valid state key/epoch", ms:0 };
  const vol = await ensureStateVolume(key, epoch);            // §3 (throws typed error past the aggregate cap)
  if (vol.error) return { status:"error", exit_code:null, stdout:"", stderr:vol.error, ms:0 };
  stateArgs = ["-v", `${vol.name}:/state`];
}
// else: no /state mount at all (byte-for-byte backward compatible)

if (wantsAllowlist) { ({ egressIp, aclPath } = await reserveEgressIp(manifest.allowed_hosts || [])); } // §5
```
`dockerArgs` splices `...stateArgs`, and when `wantsAllowlist` adds `"--ip", egressIp` inside `netArgs`.
The `finally` block (237-242) removes the container + per-job temp dir and now ALSO
`await releaseEgressIp(egressIp, aclPath)` — **but must never delete the `.img`/volume**.

Everything else in the envelope is untouched: `--user 65534:65534`, `--read-only`, `--cap-drop ALL`,
`no-new-privileges`, ulimits, HMAC verify, `egressReady` gate, 90 s egress re-validation, health canary.

### 2e. Same-lineage-epoch serialization (invariant C.11)

Two concurrent persist runs of one `(lineage,epoch)` share one image, so gate them with a per-key async
mutex (a `Map<string, Promise>` keyed by `${key}:${epoch}`) around the run so they cannot corrupt the volume
or read each other's half-written state. Different lineages/epochs run concurrently as before.

### 2f. New signed maintenance endpoint `POST /gc` (state reclaim — verdict fixes persistence-5 / limits-4)

Same HMAC auth as `/run`. Body `{ live: [{ lineage, epoch }] }` = the authoritative set of
approved-and-enabled persist lineages+epochs the edge side still has. The runner deletes every
`STATE_DIR/*.img` and `ccstate-*` volume whose `(lineage,epoch)` is NOT in `live` (disabled/superseded/stale
epochs). Bounded, DB-credential-free reclaim. Returns `{ removed:[...], freed_mb }`.

---

## 3. PERSISTENCE — image-per-(lineage, state-epoch), fenced across versions

- **Host path** `state_dir` (default `/var/lib/chapter-craft-runner/state`) — under `/var/lib`, so it is
  daemon-visible (NOT the unit's `PrivateTmp`; same lesson as the TMPDIR note, invariant #5). Owned
  `ccrunner:ccrunner`, mode `0700`.
- **Keying (verdict persistence-exfil-escape fix 1).** State is keyed by **`state_key` = `COALESCE(root_id,id)`
  AND a `state_epoch` integer**. Image = `${STATE_DIR}/${key}-${epoch}.img`, volume `ccstate-${key}-${epoch}`.
  Both are derived SERVER-SIDE by program-run/program-cron from the RLS-scoped row + the `program_state`
  table (§6), never from client/manifest/args, and the runner UUID-sanitizes `key` and integer-checks
  `epoch`. Because the epoch is part of the path, a NEW approved version cannot silently inherit the old
  image unless the user explicitly chose "carry forward".
- **Re-approval re-gates state (the fence).** `approve_program` takes a new arg `p_state_disposition`:
  - lineage has no prior persist state → epoch starts at 1 (implicit fresh).
  - lineage HAS state and the new version requests `persist` → the RPC REQUIRES `p_state_disposition`:
    - `'fresh'` → `epoch := epoch + 1` (new empty image; the old epoch's image becomes orphaned and
      GC-eligible). Default the card offers.
    - `'carry'` → epoch unchanged (reuse the image). The card shows an explicit confirmation:
      *"Carry existing state forward — it may contain secrets and interpreter-executable code written by the
      PREVIOUS approved version of this program."* Choosing this is the human re-gating the state contents.
- **Mount** `/state`, opt-in via fingerprinted `manifest.persist === true`. Off ⇒ no mount at all.
- **Mechanism — per-(lineage,epoch) ext4 loop image via a Docker volume, zero per-program root:**

```js
let stateTotalBytes = null;
async function currentStateBytes() { /* sum sizes of STATE_DIR/*.img once, cache, adjust on create/gc */ }

async function ensureStateVolume(key, epoch) {              // key = sanitized UUID, epoch = positive int
  const base = `${key}-${epoch}`;
  const img = join(STATE_DIR, `${base}.img`), vol = `ccstate-${base}`;
  if (await volumeExists(vol)) return { name: vol };
  if (!existsSync(img)) {
    // Aggregate ceiling BEFORE allocation (verdict persistence-5 / limits-4).
    const used = await currentStateBytes();
    if (used + STATE_QUOTA_MB*MB > STATE_MAX_TOTAL_MB*MB)
      return { error: `state storage full: ${Math.round(used/MB)}MB used + ${STATE_QUOTA_MB}MB requested > ${STATE_MAX_TOTAL_MB}MB cap` };
    // Opportunistic reclaim: delete sibling images of THIS lineage with a different epoch (a 'fresh' bump).
    await gcSiblingEpochs(key, epoch);
    await run("fallocate", ["-l", `${STATE_QUOTA_MB}m`, img]);                 // unprivileged
    await run("mkfs.ext4", ["-F","-q","-m","0","-E","root_owner=65534:65534", img]); // inner root inode = nobody
  }
  await run("e2fsck", ["-p","-f", img]).catch(()=>{});       // preen on every mount (host-kernel fs-bug window ↓)
  await run("docker", ["volume","create","--driver","local",
    "--opt","type=ext4","--opt",`device=${img}`,
    "--opt","o=noexec,nosuid,nodev,errors=remount-ro", vol]); // daemon does the one privileged loop-mount
  return { name: vol };
}
```

Why this satisfies the requirements:
- **noexec,nosuid,nodev are real ext4 mount flags** carried into the sandbox (a plain `-v hostdir` bind
  cannot). **Correction (verdict persistence-exfil-escape fix 4):** noexec/nosuid/nodev block `execve()` of a
  file and setuid/dev nodes — they do **NOT** stop `bash|python3|node /state/x` from *interpreting* a
  persisted file as a script. So "a persisted file can never become executable" is **dropped as a security
  claim**. The control against a prior version planting a payload for a later version to interpret is the
  **state-epoch fence** (explicit `'carry'` disposition) + the always-on persist card warning (§7), not the
  mount flags.
- **Hard per-program quota** — fixed-size image ⇒ kernel **ENOSPC** at the cap, hitting the image, never
  host `/`. **Aggregate ceiling** — `state_max_total_mb` checked before every new image; refuses past it.
- **Ownership without root** — `mkfs.ext4 -E root_owner=65534:65534`; the unchanged `--user 65534:65534`
  reads/writes `/state` immediately. ccrunner formats unprivileged; only the daemon loop-mounts.
- **Host-kernel fs surface (verdict limits-4).** `e2fsck -p -f` preen before every mount + `errors=remount-ro`
  narrows the access-pattern-triggered ext4-bug window on a program-mutated image. Residual is nonzero and
  surfaced in §11. Conservative fallback if the operator declines that surface: keep state as a plain gofer
  directory tree with a `du`-based soft quota (loses the hard ENOSPC + real mount flags) — documented, not
  recommended.
- **Verify** gets a fresh throwaway tmpfs `/state`, never the durable volume — an unapproved draft can
  neither read accumulated state nor corrupt it.
- **Reclaim (verdict persistence-5 / limits-4):** (i) `gcSiblingEpochs` on a `'fresh'` bump; (ii) the signed
  `/gc` sweep (§2f) driven by the edge side removes disabled/superseded/stale images against the live-set.
  Cleanup NEVER deletes the current `.img` in the per-job `finally`.
- **Secrets-at-rest** — a program that writes a declared secret to `/state` persists it plaintext in its
  lineage-epoch image. Mitigations: per-(lineage,epoch) isolation, `0700` dir/image, host-readable only by
  ccrunner/root, full-secrets redaction on output (§2c), and the always-on card warning (§7). Redaction is
  explicitly NOT claimed to stop CONNECT-tunneled exfil.

---

## 4. CRON — Supabase-side scheduler; the runner box is untouched

Architecture: a `pg_cron` heartbeat wakes a new service-role `program-cron` edge fn every minute; it claims
due schedules (with authorization INSIDE the claim), re-checks each, then calls the SAME `callRunner`
(IP-pinned TLS, HMAC, SSRF screen — all reused). Rejected alternatives: host-cron→`/run` and runner
self-schedule both force Supabase creds onto the credential-less, secret-bearing VPS (breaks invariant #4)
and neither is Lovable/git-deployable. The runner gains **no** new credential, role, endpoint, or config for
cron — unique to this lens (invariant #4 fully preserved).

- **Trigger:** `pg_cron` + `pg_net` POST to `program-cron` every minute with `Authorization: Bearer
  <cron_key from Supabase Vault>`; `program-cron` accepts only that secret. pg_cron only "wakes the
  function"; all HMAC/IP-pin/SSRF trust stays in the reviewed `_shared/runner.ts`. Supabase Scheduled Edge
  Functions are an equivalent heartbeat substitute.
- **Timezone:** store an IANA name; `next_run_at` is precomputed tz/DST-aware at set-time and each fire.
  Spring-forward → advance to next valid instant; fall-back → the monotonic `next_run_at` advance fires once.
- **Catch-up:** if many slots elapsed while down, fire ONCE and skip to the next future slot (no backlog storm).
- **Rate + fencing:** cron runs log `mode='cron'` into the SAME per-user rate budget (insert-then-count), so a
  mis-set every-minute schedule self-throttles as `PROGRAM_RATE_LIMITED`. Unattended blast radius = the
  approved manifest exactly (same egress ceiling, secrets, resources, fingerprint). A scheduled program's
  output is untrusted and must not auto-enter model context (extends existing fencing to the unattended path).

---

## 5. WIDER EGRESS — per-job ⋂ global, with always-on public-IP deny

Enforcement stays the operator's global allowlist in `runner.config.json`, hot-reloaded (30 s) by
`egress-proxy.mjs`. "Wider" = add hosts; "fully open" = `["*"]`. The verdict `limits-egress-host` fix 2
requires that `"*"` NOT silently reopen SSRF to the box's own public services and NOT silently widen each
program past what it declared. Both are closed:

**Per-job intersection (the true per-program bound).** Today the sandbox receives its `manifest.allowed_hosts`
only as an advisory env var; the proxy enforces just the global list. Change:
- `server.mjs` assigns each allowlist job a distinct egress-network IP via `--ip` (subnet is /24; proxy `.2`,
  gateway `.1`, so `.3–.254` ≫ concurrency) and writes `${STATE_DIR}/../egress-acl/${ip}.json` =
  `{ hosts: manifest.allowed_hosts }`, deleting it in `finally` (`reserveEgressIp`/`releaseEgressIp`, §2d).
- `egress-proxy.mjs` reads the requesting sandbox's source IP (`req.socket.remoteAddress` for HTTP,
  `clientSocket.remoteAddress` for CONNECT), loads that IP's per-job hosts, and `screen()` requires the host
  to pass **`hostAllowed(host)` AND `perJobAllowed(host)`** (intersection). Missing per-job file ⇒ empty ⇒
  deny (fail closed). Effect: `"*"` only widens the OPERATOR ceiling; a program still reaches only the hosts
  it declared and the human approved.
- Mount the ACL dir into the proxy: add `-v /var/lib/chapter-craft-runner/egress-acl:/egress-acl:ro` in
  `setup-egress.sh`'s `docker run ccprog-proxy`, and set `CCPROG_ACL_DIR=/egress-acl`.

**Name-check widening + always-on denies (belt-and-suspenders).**
- `hostAllowed(host)`: if `allowlist` contains `"*"`, return `true` — but first `false` if `host` matches
  `denied_hosts_global`, or if `host` is a **literal IP** (refuse literal-IP CONNECT targets under `"*"`
  unless that exact IP string is an explicit allowlist entry).
- `screen()` after `hostAllowed`, before dialing: keep the existing `resolveAll` + `isBlockedIP`
  (private/loopback/link-local/ULA/CGNAT/metadata, v4+v6, mapped/NAT64) AND additionally refuse if any
  resolved IP is in `denied_cidrs_global` **or in `_deny.json`** — a file `server.mjs` writes at boot into
  the ACL dir containing the runner host's own public IP(s) (`os.networkInterfaces()`, non-internal) plus
  the docker/egress gateways. This auto-detects and ALWAYS denies the box's own public services regardless
  of allowlist width (verdict fix 2's mandatory floor), without the operator having to enumerate them.
- `loadConfig()` also loads `denied_hosts_global` / `denied_cidrs_global`. Keep `MAX_SOCKETS` + per-request
  bounds at every width.

**Unchanged and load-bearing:** unreadable/empty config = deny-all (line 58); `manifest.network==='allowlist'`
still required per job; `egressReady` still gated by the 90 s selftest; a dropped iptables rule still flips
egress off. Under `"*"`, declared secrets are **fully exfiltratable to any host the program declared** (CONNECT
bytes are opaque; redaction void) — the card warns on open-egress + secrets (§7).

---

## 6. Migration + RPCs (new file `supabase/migrations/20260825000000_operator_tier.sql`)

Resources + persistence need **no schema for the manifest** (`manifest` is free-form JSONB; `root_id`
exists). Adding `memory/cpus/pids/output_kb/persist` to a program changes its fingerprint → re-verify +
re-approve (correct: the human approves the new envelope). New schema is for cron + the state epoch:

- **`program_state`** — per-lineage epoch: `(root_id uuid PK, user_id uuid, epoch int NOT NULL DEFAULT 1,
  updated_at timestamptz)`. RLS SELECT own; writes only via `approve_program`.
- **`program_schedules`** — `(id, user_id, program_id, root_id, name, pinned_sha256, cron_expr, tz,
  enabled, next_run_at, in_flight bool, lease_until, last_tick_at, fail_count, paused_reason, created_at)`.
  RLS: **SELECT own only; NO client INSERT/UPDATE/DELETE** — all writes via SECURITY DEFINER RPCs (mirrors
  approve/disable owning their tables).
- **`program_cron_health`** — singleton `(id bool PK DEFAULT true, last_tick_at, last_ok_at, note)` for
  liveness; SELECT own-scoped view or a simple readable row.
- **Widen `program_runs` CHECKs** (line 231/233): `mode IN ('run','verify','cron')`,
  `status IN (...,'skipped')`.

RPCs:
- **`set_program_schedule(program_id, cron_expr, tz)`** SECURITY DEFINER, `auth.uid()`-scoped. Refuses unless
  at call time the row is `status='approved' AND superseded_by IS NULL`, its recomputed fingerprint equals
  the latest `program_approvals.sha256`, and its name/root_id is NOT in `program_disables`. Records
  `pinned_sha256` = that pin, computes tz/DST-aware `next_run_at`. **Invoked only from a browser click by the
  owner; no model-facing tool calls it** (tool-truth law) — the AI can never self-schedule.
- **`pause_program_schedule(id)` / `delete_program_schedule(id)`** SECURITY DEFINER, owner-scoped.
- **`claim_due_schedules()`** SECURITY DEFINER (reads across users). **Authorization is INSIDE the atomic
  claim (verdict cron-wrong-code fix 1)** — never a comment, never `RETURNING`-as-filter:

```sql
UPDATE program_schedules s
   SET in_flight = true,
       lease_until = now() + make_interval(secs =>
         GREATEST(300, 2 * LEAST(75, COALESCE((ap.manifest->>'timeout_ms')::numeric/1000, 15)) + 120)),
       last_tick_at = now(),
       next_run_at = <next slot after now(), computed in s.tz>
  FROM agent_programs ap
 WHERE ap.id = s.program_id
   AND s.enabled
   AND (NOT s.in_flight OR s.lease_until < now())          -- single-flight; reclaim only after lease
   AND s.next_run_at <= now()
   AND ap.status = 'approved' AND ap.superseded_by IS NULL
   AND encode(digest(convert_to(                            -- inline, matches approve_program 292-295
         ap.code || E'\n--lang--\n' || ap.language ||
         E'\n--io--\n' || ap.io_spec::text ||
         E'\n--manifest--\n' || ap.manifest::text, 'UTF8'), 'sha256'), 'hex') = s.pinned_sha256
   AND NOT EXISTS (SELECT 1 FROM program_disables d
                    WHERE d.user_id = s.user_id AND (d.name = s.name OR d.root_id = s.root_id))
 RETURNING s.*;
```
  (Runs under service role, so it recomputes the digest inline — the `auth.uid()`-scoped `program_fingerprint`
  RPC will NOT work here. `next_run_at` is advanced INSIDE the claim before dispatch, so a long run cannot
  re-queue its own slot.) Rows that fail authorization are **auto-paused** by a companion statement
  (`enabled=false, paused_reason=...`) and get a `skipped` `program_runs` row.
- **A lease-reaper** (top of `claim_due_schedules`, or a sibling): any row with `in_flight AND lease_until <
  now()` and no settled run for the tick → clear `in_flight`, write a typed `skipped`/`error` `program_runs`
  row ("tick crashed mid-run") — verdict cron-wrong-code fix 4.
- **`approve_program(p_program_id, p_expected_sha256, p_state_disposition text DEFAULT NULL)`** — after the
  existing checks, upsert `program_state`: fresh lineage ⇒ epoch 1; existing state + new persist version ⇒
  require `p_state_disposition IN ('fresh','carry')`, `'fresh'` ⇒ `epoch := epoch+1`. Also, on approval,
  leave any schedule pinned to a now-superseded version to be auto-paused at the next tick (pin drift).
- **`disable_program`** additionally sets `enabled=false, paused_reason='disabled'` on that lineage's
  schedules (permanent). GC of its images happens via the `/gc` sweep.

**Grants (verdict cron-wrong-code fix 2):**
```sql
REVOKE ALL ON FUNCTION public.claim_due_schedules() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.claim_due_schedules() TO service_role;   -- never authenticated/anon
```
`set_/pause_/delete_program_schedule` are `GRANT EXECUTE ... TO authenticated` (owner-scoped inside).

- Enable `pg_cron` + `pg_net`; store the cron key in Vault; register
  `cron.schedule('program-cron-tick','* * * * *', $$ select net.http_post(url:=..., headers:=...) $$)`.

---

## 7. Edge functions + `_shared`

- **`_shared/runner.ts`** — factor the pin/ban/rate/job-build logic into a shared `authorizeAndBuildJob()` so
  `program-run` and `program-cron` cannot drift. If (and only if) `max_output_kb` is raised above ~700 KB,
  bump `MAX_RESPONSE_BYTES` (line 121) to match (truncation otherwise silently corrupts the JSON body).
- **`program-run/index.ts`** (Lovable deploy):
  - `select` (line 88) also fetches **`root_id`**; join `program_state.epoch` for the lineage.
  - the forwarded `manifest` (lines 134-139) also carries `memory, cpus, pids, output_kb, persist`.
  - the job also sends `state_key: program.root_id ?? program.id` and `state_epoch: <epoch>`.
  - `RUN_TIMEOUT_MS = 90_000` and Supabase's edge wall-clock still bound INTERACTIVE runs to ~90 s — do not
    advertise longer interactive runs.
- **`program-verify/index.ts`** — unchanged in trust (hermetic, throwaway `/state`); no persist/state_key ever
  sent for verify.
- **New `program-cron/index.ts`** (service-role tick, Lovable deploy). Flow:
  1. Require the Vault cron-key bearer; else 401.
  2. Update `program_cron_health.last_tick_at` (liveness — verdict cron-wrong-code fix 4).
  3. `claim_due_schedules()`; for EACH returned row **re-verify** approved-head + fingerprint==pin +
     not-disabled before dispatch (never trust `RETURNING` as the filter — verdict cron-wrong-code fix 1);
     unauthorized ⇒ auto-pause + `skipped` row.
  4. Insert a `program_runs` `mode='cron' status='pending'` row, then rate-check (shared budget).
  5. Dispatch via `callRunner` with the SAME job builder; **dispatched `timeout_ms` clamped to
     `min(pinned timeout_ms, CRON_SYNC_MAX_MS=75_000)`** so the awaited run fits program-cron's edge budget
     (verdict cron-wrong-code fix 3 / limits-egress-host fix 3). Wide manifests (larger memory/cpu/persist)
     are fine; only wall-clock is bounded.
  6. Settle the run row with the typed status; advance `program_state`/counters; clear `in_flight`. On any
     early return (disabled, unreachable, rate-limited) settle a typed `skipped`/`sandbox_unavailable` row.
  7. Auto-suspend a schedule after a bounded consecutive-failure streak (`fail_count`) with a `paused_reason`.
  8. After processing, call the runner's signed `/gc` with the current live `(lineage,epoch)` set so
     orphaned/disabled images are reclaimed (verdict persistence-5 / limits-4).

---

## 8. Client (git push only)

- **`ProgramApprovalCard.tsx`** — three warning states + the carry-forward confirm:
  - EXISTING: `exfilRisk` (secrets + allowlist) — keep.
  - NEW `openEgressWarn` (proposal flag `openEgress`, set when the operator's effective egress is `"*"` or
    the program's hosts resolve under an open ceiling + it declares secrets): "Under open egress a declared
    secret can be sent to any host this program reaches."
  - NEW `persistWarn` — shown for **EVERY** persist program (verdict persistence-exfil-escape fix 3):
    "This program keeps persistent state on your VPS. It can read and write data, secrets, and
    interpreter-executable code that EARLIER approved versions of this program wrote — the code shown here is
    not its whole behavior."
  - NEW carry-forward control when re-approving a persist lineage that already has state: a radio
    **Start fresh (recommended)** / **Carry existing state forward** feeding `p_state_disposition` into
    `approveProgram(...)`; "carry" requires an explicit checkbox acknowledging secrets/payloads may persist.
- **`programFoundry.ts`** — `approveProgram(programId, sha, disposition?)` passes the new RPC arg; add
  `setProgramSchedule/pauseProgramSchedule/deleteProgramSchedule/listSchedules` RPC wrappers + a
  `cronHealth()` reader.
- **`ProgramRunnerSettings.tsx`** — a **"Run on a schedule"** control on each approved (not superseded/
  disabled) program calling `set_program_schedule` (never writing the table); a read-only
  **schedule history** view over `program_runs (mode='cron')`; a **scheduler-liveness badge** from
  `program_cron_health` ("scheduler last ran N min ago", amber if stale — verdict cron-wrong-code fix 4).
- **`chatTools.ts`** — the forge_program proposal carries `persist` and (from settings) `openEgress` so the
  card can render the new warnings.

Note (verdict persistence-exfil-escape fix 4): wherever docs say "noexec ⇒ never executable", correct to
"noexec blocks execve/setuid, not `bash|python3|node /state/x` interpretation — the fence is the state epoch".

---

## 9. Deferred, DESIGNED, not shipped: long unattended runs (`program-report`)

To lift cron wall-clock past `CRON_SYNC_MAX_MS`, the ONLY safe path (invariant #4 preserved) is async
report-back: `program-cron` dispatches fire-and-forget with a `run_id`; when the job finishes the RUNNER
POSTs the result to a new `program-report` edge fn, **HMAC-signed with the same signing key it already
holds** (no Supabase credential added — only the Supabase URL, passed in the job payload), which verifies the
HMAC + nonce and settles the run row + advances the schedule. This is a NEW outbound path from the runner and
a new replay-protected inbound edge fn — a separate future opt-in, exactly like host-admin. **Until it ships,
cron never dispatches a run it cannot await, so there is no orphaned-pending / double-fire class.** This is
the deliberate resolution of "the synchronous callRunner cannot deliver multi-minute runs."

---

## 10. GUIDED OPERATOR STEPS (copy-paste; the user runs every command)

Matches the existing `scp` → `sudo install -o ccrunner -g ccrunner` → `systemctl restart` pattern.

**A. One-time prerequisites for persistence (only if enabling it):**
```bash
sudo apt-get install -y e2fsprogs util-linux         # mkfs.ext4 + fallocate + e2fsck
sudo mkdir -p /var/lib/chapter-craft-runner/state /var/lib/chapter-craft-runner/egress-acl
sudo chown ccrunner:ccrunner /var/lib/chapter-craft-runner/state /var/lib/chapter-craft-runner/egress-acl
sudo chmod 700 /var/lib/chapter-craft-runner/state
sudo chmod 750 /var/lib/chapter-craft-runner/egress-acl
```

**B. Deploy the new runner code (from your laptop, in vps-runner/):**
```bash
scp server.mjs      YOUR_USER@YOUR_VPS:/tmp/server.mjs
scp egress-proxy.mjs YOUR_USER@YOUR_VPS:/tmp/egress-proxy.mjs   # only if you use egress
# on the VPS:
sudo install -o ccrunner -g ccrunner -m 644 /tmp/server.mjs      /opt/chapter-craft-runner/server.mjs
sudo install -o ccrunner -g ccrunner -m 644 /tmp/egress-proxy.mjs /opt/chapter-craft-runner/egress-proxy.mjs
```

**C. Edit config to raise ceilings / enable persistence / widen egress:**
```bash
sudo nano /etc/chapter-craft-runner/runner.config.json   # add §1 keys; keep concurrency×max_cpus <= cores-reserve_cores
```

**D. If using wider egress, re-run the egress setup so the proxy gets the ACL mount, then re-prove:**
```bash
sudo CCPROG_PROXY_SRC=/opt/chapter-craft-runner/egress-proxy.mjs bash /opt/chapter-craft-runner/setup-egress.sh
node /opt/chapter-craft-runner/selftest.mjs      # expect: RESULT: PASS  (independent of allowlist width)
```

**E. Restart + confirm the NEW code is live (grep discriminators):**
```bash
sudo systemctl restart program-runner
sudo journalctl -u program-runner -n 25 --no-pager      # expect the ceilings / SAFETY CLAMP boot line
grep -c CONCURRENCY_EFF   /opt/chapter-craft-runner/server.mjs        # >=1  resource/clamp code live
grep -c ensureStateVolume /opt/chapter-craft-runner/server.mjs        # >=1  persistence code live
grep -c CCPROG_ACL_DIR    /opt/chapter-craft-runner/egress-proxy.mjs  # >=1  per-job intersection live
```

**F. (persistence only) confirm the state dir is writable + daemon-visible:**
```bash
sudo -u ccrunner touch /var/lib/chapter-craft-runner/state/.probe && sudo rm -f /var/lib/chapter-craft-runner/state/.probe && echo OK
```

**systemd:** `ReadWritePaths` (line 46) already lists `/var/lib/chapter-craft-runner`, covering both new
subdirs — no unit edit required; keep `PrivateTmp=true` and `TMPDIR` as-is (state lives under `/var/lib`, not
`/tmp`). If your distro ships a stricter unit, confirm `ReadWritePaths` still includes the parent.

---

## 11. DEPLOY SPLIT — Lovable vs git push vs VPS

- **Lovable prompt (out-of-band; migrations + edge fns):** apply
  `supabase/migrations/20260825000000_operator_tier.sql` (idempotent); deploy the updated
  `program-run/` + `_shared/runner.ts` and the NEW `program-cron/`; enable `pg_cron` + `pg_net`, store the
  cron key in Vault, register the every-minute `program-cron-tick`. "Sync and publish only — do not write
  code." Same shape as `docs/program-foundry-deploy.md` §1.
- **git push (client only):** `ProgramApprovalCard.tsx`, `ProgramRunnerSettings.tsx`, `programFoundry.ts`,
  `chatTools.ts`.
- **VPS (the operator, §10):** `server.mjs`, `egress-proxy.mjs`, config edits, `setup-egress.sh` re-run,
  restart. **No new secret custody on the box for cron** (invariant #4 preserved).

**Files edited:** `vps-runner/server.mjs`, `vps-runner/runner.config.example.json`, `vps-runner/egress-proxy.mjs`,
`vps-runner/setup-egress.sh`, `vps-runner/systemd/program-runner.service` (doc/ReadWritePaths confirm only);
`supabase/functions/_shared/runner.ts`, `supabase/functions/program-run/index.ts`, new
`supabase/functions/program-cron/index.ts`; new `supabase/migrations/20260825000000_operator_tier.sql`;
`src/components/ProgramApprovalCard.tsx`, `src/components/ProgramRunnerSettings.tsx`, `src/lib/programFoundry.ts`,
`src/lib/chatTools.ts`.

---

## 12. SECURITY INVARIANTS PRESERVED

1. **VERIFY hermetic** — `req()` ignores manifest resource requests unless `mode==="run"`; verify gets a
   throwaway empty tmpfs `/state`, `--network none`, no secrets. Cron only dispatches `mode:'run'` of approved
   code — never a verify. *Strengthened:* hermeticity now also covers resources and storage.
2. **Only pinned-approved code runs** — resources/persist/egress-intent live in the fingerprinted manifest, so
   gaining any re-pins → fresh human approval. `state_key`+`state_epoch` are server-derived; a new version
   cannot silently inherit state without an explicit `'carry'` disposition. Cron re-checks approved-head +
   inline fingerprint==pin + not-disabled INSIDE the atomic claim AND again per row before dispatch;
   disable/re-forge auto-pauses the schedule.
3. **Egress fails closed + re-validates** — 90 s selftest still gates `egressReady`; unreadable/empty config =
   deny-all; dropped iptables rule still flips egress off. `"*"` bypasses only the hostname check; the
   resolve+screen+dial-vetted-IP path applies at every width, PLUS per-job⋂global intersection, always-on
   host-public-IP `_deny.json`, and literal-IP CONNECT refusal.
4. **Runner holds no Supabase creds; secret values app/model-invisible** — the scheduler lives app/DB-side;
   the runner gains no role/self-fetch/self-schedule (the deferred `program-report` async path, §9, would add
   only an HMAC-signed callback using the key it already holds, and is NOT in this tier). Persist runs redact
   the FULL secrets map. New persistence-plaintext and open-egress exfil risks are surfaced as card warnings,
   not claimed as controls.
5. **gVisor operational laws** — `--pids-limit` still counts threads, honoring `PIDS_FLOOR` (128) so the
   sentry boots; per-job code stays in daemon-visible `TMPDIR`; state images live daemon-visible under
   `/var/lib`; the volume is noexec/nosuid/nodev via real ext4 flags (defense-in-depth against execve, NOT a
   script-exec control); root fs stays read-only with tmpfs scratch.
6. **Host untouched by program code** — "effectively unlimited" is always a finite operator-donated ceiling
   (`ceil()` refuses 0/-1/"unlimited"); the boot guard CLAMPS effective concurrency by BOTH RAM and CPU,
   reserving ≥`reserve_cores` core(s) + `reserve_ram_frac` RAM; `--cpu-shares 512` yields to host services
   under contention; swap pinned equal to memory; output bounded in runner heap; per-image ENOSPC + aggregate
   `state_max_total_mb` + GC keep host disk bounded. No host-root program execution; host-admin excluded and
   never scheduled.

---

## 13. RESIDUAL RISK — the user should decide

- **Open egress (`allowed_hosts_global: ["*"]`) + secrets:** even with per-job intersection, a program that
  DECLARES a host and a secret can tunnel that secret to that host over CONNECT (opaque to the proxy;
  redaction cannot help). The intersection means it can only reach hosts it declared and the human approved —
  it does not make secrets un-exfiltratable. Recommendation: keep the global allowlist to specific hosts; use
  `"*"` only when you accept that every approved allowlist program can reach the whole public internet within
  its own declared hosts.
- **Persisted secrets at rest:** a persist program can write a plaintext secret into its lineage-epoch image;
  isolation/mode/redaction reduce but do not eliminate exposure to anyone with host root. Prefer non-persist
  for secret-bearing programs, or accept the tradeoff.
- **Host-kernel ext4 surface:** mounting a program-mutated ext4 image uses the host kernel's ext4 driver;
  `e2fsck -p -f` preen + `errors=remount-ro` narrow but do not zero the access-pattern-triggered-bug surface
  that the throwaway design avoided. Decline persistence, or accept this, or opt for the userspace-directory
  fallback (soft quota, no real mount flags).
- **Wall-clock is bounded, not unlimited:** interactive ~90 s (edge), cron ~75 s (`CRON_SYNC_MAX_MS`). Truly
  long unattended runs need the deferred `program-report` async path (§9). If the user needs 5-minute cron
  jobs now, that is the one piece to green-light next; nothing else in the tier pretends to offer it.
- **Undersized box:** the safety clamp can lower effective concurrency below the configured value (logged at
  boot). This protects Hermes; if the user wants more parallelism they must raise the box or lower ceilings —
  the runner will not overcommit.
