# Chapter Craft TTS Audio Cache

Read Along speaks each page through Inworld, and Inworld bills every request —
including the tenth time you re-read the same page. This small service stores
every clip Inworld produces **per book** on your VPS. When the same passage is
read again (same text, voice and model), the app's `inworld-tts` edge function
serves the saved clip instead of paying for it again.

- **`server.mjs`** — the HTTP service (binds `127.0.0.1:8760`). Zero npm dependencies.
- **`check.mjs`** — end-to-end check of a running cache, signed like the app signs.
- **`systemd/tts-cache.service`** — run it as a service.

How it fits together:

```
Read tab ──► inworld-tts edge function ──(signed)──► this cache on your VPS
                    │  hit: saved clip back, no Inworld call
                    └─ miss: Inworld ─► clip back to the reader, and saved here
```

- Clips live at `/var/lib/chapter-craft-tts-cache/<bookId>/<hash>.mp3`, with the
  word timings for the highlight in `<hash>.json`. A clip is typically 20–80 KB.
- Only the edge function can use it: every request is HMAC-signed with a secret
  that exists only in this config and in the app's edge-function secrets.
- The key includes the voice and model, so changing voice makes new clips
  rather than playing the wrong voice. Reading speed doesn't matter (the player
  changes speed itself), so one clip serves every speed.
- `max_total_mb` caps disk use (default 20 GB). When full, the clips played
  least recently are deleted first.
- Permanently deleting a book in the app deletes its saved audio.
- If this service is down or slow, reading still works — it just costs what it
  did before (the edge function waits at most 2s for a lookup).

It needs very little: any small VPS (1 vCPU / 1 GB) with disk space for the
audio. It can share the box with the program runner or live on its own.

---

## 1. Prerequisites

Ubuntu 22.04/24.04 or Debian 12, and **Node 20+**:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

A DNS **A record** for a subdomain (e.g. `tts.yourdomain.com`) pointing at the VPS.

## 2. Install

From this folder (copy it to the VPS first, e.g. `scp -r vps-tts-cache root@your-vps:~`):

```bash
sudo useradd --system --home-dir /opt/chapter-craft-tts-cache --shell /usr/sbin/nologin cctts
sudo mkdir -p /opt/chapter-craft-tts-cache /etc/chapter-craft-tts-cache /var/lib/chapter-craft-tts-cache
sudo cp server.mjs check.mjs package.json README.md /opt/chapter-craft-tts-cache/
sudo chown -R cctts:cctts /opt/chapter-craft-tts-cache /var/lib/chapter-craft-tts-cache
sudo chmod 700 /var/lib/chapter-craft-tts-cache
```

Make the config and a signing secret:

```bash
openssl rand -hex 32          # copy this — it's the signing key
cp tts-cache.config.example.json tts-cache.config.json
nano tts-cache.config.json    # paste the key in place of PASTE_OUTPUT_OF...
sudo install -o cctts -g cctts -m 600 tts-cache.config.json /etc/chapter-craft-tts-cache/tts-cache.config.json
```

Start it:

```bash
sudo cp systemd/tts-cache.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tts-cache
journalctl -u tts-cache -n 5
# expect: [tts-cache] listening on 127.0.0.1:8760
```

## 3. HTTPS with Caddy

The service only listens on localhost; Caddy terminates TLS with an automatic
Let's Encrypt certificate. If Caddy isn't installed yet:

```bash
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy
```

Add to `/etc/caddy/Caddyfile` (keep any existing `runner.…` block):

```caddy
tts.yourdomain.com {
    request_body {
        max_size 8MB
    }
    reverse_proxy 127.0.0.1:8760
}
```

```bash
sudo systemctl reload caddy
sudo ufw allow 443/tcp        # if ufw is on; never open 8760
```

## 4. Check it

From any machine with Node:

```bash
node check.mjs https://tts.yourdomain.com tts-key-1 <the signing key>
# expect: RESULT: PASS
```

## 5. Connect the app

Add three **edge function secrets** to the Supabase project (in Lovable: ask it
to add secrets; in Supabase: Project Settings → Edge Functions → Secrets):

| Secret | Value |
| --- | --- |
| `TTS_CACHE_URL` | `https://tts.yourdomain.com` |
| `TTS_CACHE_KEY_ID` | `tts-key-1` |
| `TTS_CACHE_SIGNING_KEY` | the `openssl rand -hex 32` value |

Then redeploy the `inworld-tts` function. Without these secrets the function
simply doesn't cache.

To confirm it's working: read a page twice in the Read tab. In the function's
logs there are no Inworld errors, and in the browser's network tab the second
read's `inworld-tts` responses carry `X-TTS-Cache: hit`. On the VPS:

```bash
sudo du -sh /var/lib/chapter-craft-tts-cache
```

---

## Operating notes

- **Disk use:** `max_total_mb` in the config, then `sudo systemctl restart tts-cache`.
- **Clear everything:** `sudo systemctl stop tts-cache && sudo rm -rf /var/lib/chapter-craft-tts-cache/* && sudo systemctl start tts-cache`.
- **Rotate the key:** add a second entry under `keys`, update the three app
  secrets, then remove the old entry and restart.
- **Backups are optional:** everything here can be regenerated (at Inworld's price).
- **Changing chunk sizes** in `src/lib/readAlongPlayer.ts` (`INWORLD_MAX_CHUNK`,
  `INWORLD_FIRST_CHUNK`) changes every clip's text, so old clips stop matching
  and age out on their own.
