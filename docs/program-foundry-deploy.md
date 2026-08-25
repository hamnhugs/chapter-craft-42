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
