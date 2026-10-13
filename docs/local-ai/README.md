# Chapter Craft — Local edition

Everything runs on this computer: chat, memory, search, voice, images, and the
backend. No keys and no account elsewhere. Cloud models stay selectable in
Settings if you add keys.

## Start (first time)

```bash
bash scripts/local-ai/setup-once.sh       # sudo, once: Docker access, Ollama settings, GPU profile
scripts/local-ai/install-services.sh      # models + Vulkan builds (~9 GB, no sudo, re-runnable)
scripts/local-ai/install-launcher.sh      # adds "Chapter Craft" to the app menu
```

There is no sign-in: the first start creates an owner account for this computer
(admin) and the app signs into it by itself. Its random password is in
`.local-state/owner-password`.

Bringing your hosted library across (optional, reads only your own data):

```bash
node scripts/local-ai/import-hosted.mjs   # instructions at the top of the file
```

## Every day

Open **Chapter Craft** from the app menu (Super+Space). It starts whatever isn't
running and opens the app in its own window — about 5 s after a reboot, ~35 s after
`local-down.sh`, instant if it's already up. Progress shows as notifications.

```bash
scripts/local-up.sh        # the same start, from a terminal (--dev: hot-reload dev server)
scripts/local-down.sh      # stop everything (your data stays)
```

## What runs where

| Piece | Runs on | Model / engine |
|---|---|---|
| Chat + tools | RX 5600M (Vulkan, Ollama) | `qwen3:4b-instruct-2507` |
| Image understanding | RX 5600M | `qwen3.5:4b` |
| Deep Research | RX 5600M + CPU | `qwen3:8b` |
| Background jobs (tagging, memory, figures) | Same as chat by default | `LOCAL_LLM_MODEL` overrides |
| Embeddings | RX 5600M | `nomic-embed-text` (768-d) |
| Speech-to-text | Integrated Radeon | whisper.cpp `base.en` |
| Text-to-speech | CPU | Piper (`lessac`, `amy`, `alan`) |
| Images | Integrated Radeon | sd.cpp Z-Image-Turbo (TwinFlow, Q4_K) |
| Web search | Docker | SearXNG |
| Database, auth, storage, edge functions | Docker | Supabase local |
| Video, 3D splats | — | Cloud only (needs keys). Not feasible on 6 GB. |

Ports: `local-services.json` (the single source the CSP, clients and scripts read).

## Why it's built this way

The measurements behind every choice are in `results/`. The design is in `PLAN.md`.
- **Smaller tool roster per turn** (`src/lib/localRoster.ts`): 80 tools ≈ 23K tokens
  takes a 4B model minutes to read. Core tools + matches + `find_tools`, append-only so
  Ollama's prompt cache survives.
- **Native Ollama API** (`src/lib/providers/ollamaAdapter.ts`): `/v1` ignores `num_ctx`.
- **Edge functions unchanged in shape** (`supabase/functions/_shared/ai-local.ts`): the
  same OpenAI-style requests, answered locally; forced tool calls become schema-constrained output.
- **Images and speech on the iGPU**: keeps the discrete card's 6 GB for the chat model,
  and Z-Image hangs the Navi 10 driver (`results/2026-10-12-images.txt`).

## Troubleshooting

| Symptom | Check |
|---|---|
| "Can't reach Ollama" | `systemctl status ollama` |
| First reply slow, later fast | Normal: the first turn fills the prompt cache. If *every* turn is slow, the GPU profile isn't applied: `sudo /usr/local/bin/cc-amdgpu-compute` |
| Voice input does nothing | `curl 127.0.0.1:8771/` and `.local-state/logs/stt.log` |
| Search errors | `docker compose -f docker-compose.local.yml ps` |
| Image fails | `.local-state/logs/images.log`; ~75 s per image is expected |
| Launcher says "Couldn't start" | `.local-state/logs/launch.log` |
| Background jobs fail ("local embedder unavailable") | ufw blocks containers → Ollama. One rule: `sudo ufw allow proto tcp from 172.16.0.0/12 to 172.17.0.1 port 11434 comment chapter-craft-ollama`. Logs: `.local-state/logs/functions.log` |
