# Program Foundry — deployment (out-of-band pieces)

A `git push` deploys ONLY the client. Three things apply out of band, in this order.

## 1. Database migration + edge functions — Lovable prompt

Paste this to Lovable (it is a **sync-and-publish** request, not a code request):

> Please apply the repo migration `supabase/migrations/20260824000000_program_foundry.sql`
> exactly as written, without modifications — it is idempotent — and deploy the two new
> edge functions `supabase/functions/program-run/` and `supabase/functions/program-verify/`
> (they share `supabase/functions/_shared/runner.ts`). **Sync and publish only — do not write
> or change any code.** If anything conflicts, stop and report rather than editing.

The edge functions need the standard secrets already present in this project:
`SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` (used only to write the
append-only `program_runs` log and the service-role-only `verifier_report`).

## 2. VPS runner — deploy on your Hostinger box

Everything is in `vps-runner/`. Summary (full steps in `vps-runner/README.md`):

1. Install Docker + the gVisor runtime (`runsc`) — gVisor needs no KVM, so it works on a
   Hostinger KVM guest.
2. Build the sandbox image: `docker build -t chapter-craft-sandbox:latest -f Dockerfile.sandbox .`
3. `cp runner.config.example.json runner.config.json` and fill in:
   - a `keys` entry: pick a key id and a signing secret (`openssl rand -hex 32`),
   - any program `secrets` (name → value) — these live ONLY here; the app and the model
     never see the values,
   - leave `allowed_hosts_global` empty unless you want to allow egress (see below).
4. Put TLS in front (Caddy reverse-proxy 443 → 127.0.0.1:8752 — the runner binds localhost
   only), open the firewall for 443, install the systemd unit.
5. `npm run selftest` (only matters if you enable allowlist egress).

**Egress modes:** the default is `network: none` (fully offline, bulletproof — recommended).
`network: allowlist` requires running `setup-egress.sh` and populating `allowed_hosts_global`;
if that lockdown's self-test fails, the runner refuses allowlist jobs and serves offline only.

## 3. Connect it in the app

Settings → Program Foundry:
- turn on **Forge new programs** and/or **Run approved programs**,
- paste the runner's **https URL**, **key id**, and **signing key**,
- **Test connection** should report the gVisor sandbox healthy.

Then the AI can forge a program → it is smoke-tested hermetically → you approve the exact
source + profile on a card → `run_program` executes it on your VPS.

## Security notes (what the design guarantees)

- An **unapproved draft** can only ever run **hermetically** (verify mode: no secrets,
  `--network none`), enforced by the runner regardless of the declared profile.
- The client never sends code to run — the edge function reads the **pinned-approved** code and
  refuses unless its fingerprint still matches the approval.
- The runner **redacts** declared secret values out of any output before returning it.
- The runner holds **zero Supabase credentials**; it authenticates jobs by HMAC only.

## 4. Long unattended runs (Operator tier, 2026-08-25)

Scheduled programs can run past the ~60s sync cap: set a **runtime allowance** on the
schedule (Settings → Program Foundry → the "Up to …" select, 2 min – 1 hour). The
scheduler dispatches those async and collects the durable result from the runner's signed
`GET /result` endpoint on later ticks — the runner stays inbound-only.

Deploying this feature:

1. **Runner** (PC PowerShell → VPS): scp `vps-runner/server.mjs`, then
   `sudo install -o ccrunner -g ccrunner -m 644 /root/vps-runner/server.mjs /opt/chapter-craft-runner/server.mjs`
   and `sudo systemctl restart program-runner`. Grep discriminator: `grep -c 'asyncLaneMax' /opt/chapter-craft-runner/server.mjs`
   (≥1 = new build). Optional config keys: `async_max_timeout_ms`, `results_dir`, `result_ttl_hours`.
2. **Lovable**: apply migration `supabase/migrations/20260827000000_program_long_runs.sql`
   (idempotent) and redeploy the `program-cron` AND `program-run` edge functions
   (program-run now sheds with `no_wait` and reports a busy runner honestly). No
   config.toml change. The migration adds the `skipped`/`lost` run statuses both
   functions now write, re-hardens the tick RPC grants (anon/authenticated
   revoke), and adds the cascade-safe skip trigger + orphan sweeper.
3. Boot log shows `[runner] async runs: cap 60min, results in /var/lib/chapter-craft-runner/results (ttl 48h)`.
