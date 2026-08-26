# Chapter Craft Program Runner

A tiny, self-hosted service that runs the AI-authored programs **you approve**
inside hardened [gVisor](https://gvisor.dev/) (`runsc`) Docker sandboxes on your
own VPS. The in-app Program Foundry talks to it over HTTPS with signed requests;
each program runs in a fresh throwaway container that is destroyed afterward.

Zero npm dependencies — just Node (built-ins only), Docker, and gVisor.

- **`server.mjs`** — the HTTP service (binds `127.0.0.1:8752`).
- **`selftest.mjs`** — proves the allowlist egress lockdown before it's trusted.
- **`egress-proxy.mjs`** — the only outbound path for allowlist jobs.
- **`Dockerfile.sandbox`** — builds the `chapter-craft-sandbox:latest` image.
- **`setup-egress.sh`** — one-time setup for allowlist egress (optional).
- **`systemd/program-runner.service`** — run it as a service.

---

## 1. Prerequisites

- A VPS running **Ubuntu 22.04 / 24.04** or Debian 12 (a Hostinger KVM VPS is
  fine — see the gVisor note below).
- **Docker Engine** installed:
  ```bash
  curl -fsSL https://get.docker.com | sh
  ```
- **Node 20+** (the runner and the self-test are ESM, `node >=20`):
  ```bash
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
  ```

### Install gVisor (runsc)

Follow the official guide: <https://gvisor.dev/docs/user_guide/install/>. On
Debian/Ubuntu the short version is:

```bash
sudo apt-get install -y apt-transport-https ca-certificates curl gnupg
curl -fsSL https://gvisor.dev/archive.key | sudo gpg --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" \
  | sudo tee /etc/apt/sources.list.d/gvisor.list > /dev/null
sudo apt-get update && sudo apt-get install -y runsc

# Register runsc as a Docker runtime and restart Docker:
sudo runsc install
sudo systemctl restart docker
```

Verify:
```bash
docker run --rm --runtime=runsc alpine echo gvisor-ok   # should print: gvisor-ok
```

> **Hostinger / KVM note:** gVisor runs entirely in user space and does **not**
> need KVM or nested virtualization. It works fine inside a Hostinger KVM guest —
> `runsc` intercepts syscalls in a userspace kernel, so there's nothing extra to
> enable. (The default `runsc` platform is `ptrace`, which needs no special
> hardware.)

---

## 2. Build the sandbox image

From this directory:

```bash
docker build -f Dockerfile.sandbox -t chapter-craft-sandbox:latest .
```

This is a small Alpine + Node 20 + bash + python3 image — just the three
interpreters a program can be written in. All the isolation comes from the
runtime flags the server passes (`--runtime=runsc --cap-drop ALL --read-only
--user 65534:65534 --memory … --pids-limit …`), not from the image.

---

## 3. Write `runner.config.json`

Copy the example and fill it in:

```bash
cp runner.config.example.json runner.config.json
chmod 600 runner.config.json
```

Generate a signing secret (this is the shared secret between the app and the
runner — the app signs every request with it):

```bash
openssl rand -hex 32
```

Put it under `keys` with a key id you choose:

```json
{
  "keys": { "prod-key-1": "<paste the openssl output here>" },
  "secrets": { "HERMES_TOKEN": "<a real API token a program may need>" },
  "sandbox_image": "chapter-craft-sandbox:latest",
  "allowed_hosts_global": [],
  "max_timeout_ms": 60000,
  "concurrency": 3
}
```

Every field is documented in `runner.config.example.json`.

**Secrets never leave this file.** A program declares *which* secret **names** it
needs; the runner injects only those, by name, as environment variables into
that one job's container, and then **redacts the values out of stdout/stderr**
before returning anything. The app and the model only ever see the *names* —
never the values. Keep real tokens only here.

---

## 4. Put TLS in front (Caddy)

`server.mjs` binds **`127.0.0.1:8752` only** — it never listens on a public
interface. Terminate TLS with [Caddy](https://caddyserver.com/), which gets you
an automatic Let's Encrypt certificate:

```bash
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy
```

`/etc/caddy/Caddyfile`:

```caddy
runner.yourdomain.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:8752
}
```

```bash
sudo systemctl reload caddy
```

Point `runner.yourdomain.com`'s DNS A record at your VPS first, so Caddy can
issue the certificate.

### Firewall — open 443 only

```bash
sudo ufw allow 22/tcp       # keep your SSH in
sudo ufw allow 443/tcp      # HTTPS (Caddy)
sudo ufw enable
```

Do **not** open 8752 — it's localhost-only behind Caddy.

---

## 5. Install the systemd service

```bash
sudo useradd --system --home-dir /opt/chapter-craft-runner --shell /usr/sbin/nologin ccrunner
sudo usermod -aG docker ccrunner
sudo mkdir -p /opt/chapter-craft-runner /etc/chapter-craft-runner /var/lib/chapter-craft-runner/tmp

# Copy the code into place:
sudo cp server.mjs selftest.mjs egress-proxy.mjs package.json /opt/chapter-craft-runner/
sudo cp -r systemd /opt/chapter-craft-runner/
sudo cp README.md /opt/chapter-craft-runner/
sudo chown -R ccrunner:ccrunner /opt/chapter-craft-runner /var/lib/chapter-craft-runner

# Config goes to /etc (referenced by the unit's RUNNER_CONFIG):
sudo install -o ccrunner -g ccrunner -m 600 runner.config.json /etc/chapter-craft-runner/runner.config.json

# Install and start the unit:
sudo cp systemd/program-runner.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now program-runner
sudo systemctl status program-runner
```

> The unit sets `TMPDIR=/var/lib/chapter-craft-runner/tmp` on purpose: with
> `PrivateTmp=true`, the service's `/tmp` is invisible to the Docker daemon, and
> per-job program files are bind-mounted into containers — so they must live in
> a path the daemon can see. If `which node` isn't found via `env`, edit
> `ExecStart` to the absolute path.

Check health (the `/health` endpoint requires a signed request, so the easiest
smoke test is the log):

```bash
journalctl -u program-runner -f
# expect: [runner] egress allowlist DISABLED (network:none only)
#         [runner] listening on 127.0.0.1:8752 …
```

---

## 6. Connect the app

In the app: **Settings → Program Foundry**, paste:

- **Runner URL:** `https://runner.yourdomain.com`
- **Key id:** `prod-key-1` (whatever you chose in `keys`)
- **Signing key:** the `openssl rand -hex 32` secret for that key id

The app signs each request (HMAC-SHA256 over timestamp + method + path + body +
nonce), so the signing key never travels on the wire and captured requests can't
be replayed.

---

## 7. Egress modes

Every program declares a network mode. There are two.

### `none` — the default, bulletproof

The container runs with `--network none`: **no network stack at all**. Nothing to
misconfigure, nothing to lock down, no setup. This is the recommended default and
what most programs should use. **VERIFY runs are always forced into this mode**
(no network, no secrets) no matter what a draft asks for.

### `allowlist` — opt-in, requires the egress setup

Some programs genuinely need to call an external API. For those, you run
`setup-egress.sh` **once** and list the permitted hostnames in
`allowed_hosts_global`. Then:

1. **Run the setup (root):**
   ```bash
   sudo CCPROG_PROXY_SRC=/opt/chapter-craft-runner/egress-proxy.mjs \
        CCPROG_CONFIG_SRC=/etc/chapter-craft-runner/runner.config.json \
        bash setup-egress.sh
   ```
   This creates the `ccprog-egress` docker network, starts the `ccprog-proxy`
   container, and installs iptables rules that DROP **all** outbound from the
   sandbox network **except** sandbox → proxy on `:8753`.

2. **Populate the allowlist** in `runner.config.json`:
   ```json
   "allowed_hosts_global": ["api.hermes.example.com", "*.openai.com"]
   ```
   An **empty array means deny-all** — allowlist jobs will reach nothing. The
   proxy hot-reloads this list every 30s; `sudo systemctl restart program-runner`
   to be sure.

3. **Prove it and enable it:**
   ```bash
   cd /opt/chapter-craft-runner
   sudo -u ccrunner node selftest.mjs      # expect: RESULT: PASS
   sudo systemctl restart program-runner
   journalctl -u program-runner | grep egress
   # expect: [runner] egress allowlist ENABLED
   ```

**Fail-closed guarantee.** `server.mjs` re-runs the self-test at startup. It
spawns a real gVisor container on the egress network and tries to open raw TCP
sockets to `169.254.169.254:80` (cloud metadata), `127.0.0.1:22`, `172.17.0.1:5432`
(host postgres / docker gateway) and `10.0.0.1:80`. **Unless every one is
blocked, allowlist egress stays OFF** and the runner serves `network:none` only.
So a broken or missing lockdown can never silently expose your host.

#### How the egress guard works

- The sandbox has `HTTP_PROXY`/`HTTPS_PROXY=http://ccprog-proxy:8753` set, so
  well-behaved clients route through the proxy. iptables makes that the *only*
  reachable destination — a program can't skip the proxy and dial an IP directly.
- The proxy resolves each requested hostname and **refuses if any resolved
  address is private/loopback/link-local/ULA/CGNAT/metadata** (IPv4 and IPv6,
  including IPv4-mapped and NAT64). It then dials the *resolved* IP, so DNS
  rebinding can't swing the target between check and connect.
- The proxy also enforces `allowed_hosts_global`: only those hostnames are ever
  dialed.

#### What a blocked program sees

If a program tries to reach a host that **isn't** on the allowlist (or that
resolves to a private address), the **proxy refuses** the connection and logs
`ccprog: egress blocked <host>` to its own stderr:

```bash
docker logs ccprog-proxy | grep 'egress blocked'
```

The **program itself** just gets an ordinary connection error (a 403 from the
proxy, or a dropped socket) — it does **not** automatically see the
`ccprog: egress blocked` marker. `server.mjs` classifies a job as
`egress_blocked` only when that exact marker appears in the *job's* stderr, so if
you want a program to report the block cleanly it should catch the connection
failure and print the marker itself, e.g.:

```python
import os, urllib.request
try:
    urllib.request.urlopen("https://not-allowed.example.com", timeout=5).read()
except Exception as e:
    print("ccprog: egress blocked not-allowed.example.com", e)  # -> status: egress_blocked
```

Otherwise the job simply comes back as a normal non-zero `error` with the
connection failure in stderr — which is still safe; nothing left the box.

> iptables rules from `setup-egress.sh` are not persisted across reboot. Re-run
> the script on boot (a systemd oneshot ordered `After=docker.service`) or
> `netfilter-persistent save` after a good run. The runner's startup self-test
> will catch it if the rules are missing and keep allowlist egress disabled.

---

## 8. Long unattended runs (async + poll)

A schedule in the app can grant a program a **runtime allowance** past the ~60s
sync cap (up to `async_max_timeout_ms`, default 1 hour, hard-capped at 1 hour).
The scheduler then dispatches the job **async**: the runner accepts immediately
(`{"status":"accepted"}`), executes in the background, and writes the finished
result to `results_dir` (default `/var/lib/chapter-craft-runner/results`,
created 0700). Later scheduler ticks collect it via the signed
`GET /result?run_id=…` endpoint. The runner never calls anyone back — it stays
inbound-only with the same HMAC keys.

Semantics worth knowing:

- **A restart aborts in-flight async jobs.** On boot the runner force-removes
  leftover `ccprog_*` containers and converts every dangling started-marker into
  an honest `lost` result, so the scheduler settles instead of waiting forever.
  Finished results are files — they survive restarts.
- **An async job holds a normal concurrency slot** for its whole runtime. With
  `concurrency` > 1 the async lane is capped at `concurrency - 1`, so one slot
  always stays free for interactive runs; on a 1-slot box the single slot is
  shared and interactive runs may see `runner busy` while a long job runs.
- **Result files expire** after `result_ttl_hours` (default 48h); they are
  normally collected within a couple of minutes of finishing.

---

## Operating notes

- **Update the code:** replace the files in `/opt/chapter-craft-runner`, then
  `sudo systemctl restart program-runner`. If you changed `egress-proxy.mjs`,
  re-run `setup-egress.sh` (it recreates the proxy container).
- **Rotate a signing key:** add a new entry under `keys`, update the app, then
  remove the old one and restart.
- **Tune limits:** `concurrency`, `memory`, `cpus`, `pids_limit`,
  `max_timeout_ms` in `runner.config.json`, then restart.
- **Health:** `GET /health` (signed) reports `sandbox_ok` (a real gVisor canary
  container ran) and `egress_ready` (the allowlist self-test passed).
