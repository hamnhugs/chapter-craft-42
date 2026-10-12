# Chapter Craft — Local edition: plan

Branch `local-ai` in `~/Work/chapter-craft-local`, cut from `new1` @ `6a0bbfc` on 2026-10-12.
Goal: **everything Chapter Craft does, running on this laptop**, as close to parity as the
hardware allows. Cloud providers stay selectable but nothing *requires* a key or the internet.

Evidence for every number below is in `docs/local-ai/results/` (raw logs) and reproducible
with `scripts/local-ai/tool-eval.py`.

---

## 0. The machine (measured, not assumed)

| | |
|---|---|
| GPU | RX 5600M (Navi 10, gfx1010), **6 GiB**, Vulkan via `ollama-vulkan`. ROCm doesn't support gfx1010, so Vulkan is the only GPU path. iGPU (Renoir) dropped by Ollama. |
| CPU / RAM | Ryzen 7 4800H 8C/16T, 30 GiB RAM |
| Ollama | 0.33.3 (Omarchy's stable mirror lags; upstream Arch has 0.40.3 since 2026-10-11) |
| Docker | 29.7 running. Deno 2.9, Node 26, Chromium 152 present. No Supabase CLI (use `npx supabase`). |
| dGPU power | runtime-suspends when idle. The first call after idle is ~4-5× slower (`2026-10-12-speed.txt`). |

**What fits:** a ~4B model at Q4 fits entirely in VRAM with room for a 32K context
(qwen3.5:4b = 3.8 GiB at 32K). An 8B model spills to the CPU and prefill collapses.

## 1. The core problem: the chat request is ~30K tokens

- `CHAT_TOOL_DEFINITIONS` (`src/lib/chatTools.ts:544`) = **80 tools, 82,280 chars ≈ 23K tokens**.
  Biggest: `create_blueprint_sheet` 8.5K chars, `create_stage_plan` 5.7K, `generate_video` 5.6K.
- Stable system prompt ≈ 23,103 chars (`promptToolTruth.test.ts` baseline) ≈ 6K tokens.
- At warm qwen3.5:4b speeds (~170-440 tok/s prefill) the first turn is **~3-5 minutes** before
  any text. Measured: the all-80-tools run's first call took 290 s.

Two facts make this solvable:

1. **Ollama reuses the KV cache for a byte-identical prefix.** In the all-tools run, calls 2-14
   took ~10 s each against the same 22K-token prefix. The prefix rules this codebase already
   follows for OpenRouter/Gemini (`docs/variable-system-prompts.md`, `src/lib/cacheLayout.ts`)
   apply to Ollama too, just with no billing involved.
2. **Small rosters work.** With embedding-retrieved top-8 tools, qwen3.5:4b chose a correct
   first tool on **13/14** prompts, with **0 hallucinated tool names**, and retrieval recall was
   14/14. qwen3:8b scored 14/14 but was ~3× slower.

But retrieving fresh tools *every turn* changes the bytes at the top of the prompt (tools render
first in the chat template), which throws the cache away every turn. Hence the design in §3.2.

## 2. Inventory: every AI touchpoint and its local replacement

### Browser side
| Today | Where | Local replacement |
|---|---|---|
| Chat (OpenRouter / Gemini / NVIDIA relay) | `src/lib/providers/*`, `ChatContext.tsx` | **New `ollama` provider** (§3.1) |
| Rolling summary, book summary, chapter gists, shelf digest, gist verification | `bookSummary.ts`, `chapterGists.ts`, `shelfDigest.ts`, `gistVerification.ts` | Same adapter's `completeChat`. These go through `resolveModel`, so they come free with the provider. |
| Image gen / edit (Gemini "Nano Banana", OpenRouter) | `src/lib/imageGen.ts` | stable-diffusion.cpp server on Vulkan (§3.6) |
| Video gen (OpenRouter, fal) | `videoGen.ts`, `falVideoGen.ts` | **Not feasible on 6 GiB.** Keep cloud-optional with clear UI copy. |
| 3D splats (fal) | `splatGen.ts` | Not feasible locally. Cloud-optional. (`render_splat_views` is already local.) |
| Video QC | `videoQc.ts` (transformers.js dinov2-small) | Already in-browser |
| Web search (Tavily / Burplexity) | `tavilySearch.ts`, `chatTools.ts:308` | **SearXNG** container, keyless (§3.5) |
| Speech-to-text | `useHandsFree.ts:38` Web Speech API | Chromium's Web Speech API sends audio to Google, and on Arch builds it often doesn't work at all. Replace with **local Whisper**: whisper.cpp server on Vulkan, keeping the existing VAD (`@ricky0123/vad-web`) to cut segments. |
| VAD / ORT assets | jsdelivr CDN | Vendor into `public/` so voice works offline |
| TTS | `inworld-tts` edge function | **Piper** (benchmarked ~20× faster than Kokoro on this box) |
| Model catalog / key UI | `openrouterCatalog.ts`, `SettingsPanel.tsx`, `SetupWizard.tsx`, `ModelExplorer.tsx` | Read `GET /api/tags` and `/api/show` (capabilities: tools/vision/thinking, context length) |
| Eval grader | `src/harness/e2/grade.e2run.ts` (OpenRouter) | Point at local (8B as grader) |

### Edge functions (`supabase/functions/`)
| Function | Uses | Local |
|---|---|---|
| auto-structure, auto-tag, describe-figures, embed-image | Lovable gateway / OpenRouter chat (+vision) | `_shared/llm.ts` → Ollama |
| knowledge-extract, -consolidate, -lint, video-to-pdf | `_shared/wiki-llm.ts`, `atomicity.ts` | same |
| incubator-sweep, prompt-incubator-sweep, wiki-drift-check | gateway chat + embeddings | same |
| knowledge-embed, knowledge-retrieve, embed-entries, search-knowledge | `_shared/embed.ts` (768-d), `_shared/wiki-embed.ts` (text-embedding-3-small, 1536-d) | Local embedder (§3.4) |
| nvidia-chat | NVIDIA relay | unchanged (cloud-optional) |
| inworld-tts | Inworld | Piper (§3.7) |
| check-subscription, create-checkout, customer-portal | Stripe | Local build: always entitled. Functions stay but aren't called. |
| program-run/-verify/-cron + `vps-runner/` | remote VPS | Run `vps-runner` locally in Docker (it already ships a sandbox Dockerfile) |

## 3. Design

### 3.1 `ollama` provider (browser)
- One row in `PROVIDERS` (`src/lib/providers/registry.ts`): id `ollama`, prefix `ollama:`,
  `keyField: null`, `freeChatTier: true`. Add `"ollama"` to `ProviderId` (`types.ts:6`).
  Note: name helpers carefully, because `localModelId()` already means "provider-local id".
- `ollamaAdapter.ts` speaks **native `/api/chat`**, not `/v1`. Verified: `/v1/chat/completions`
  silently ignored `options.num_ctx` and ran at 4096 (`2026-10-12-speed.txt`), and the native
  API is the one that honours `think: false` and `keep_alive`. Map to the normalized events:
  `message.thinking` → `reasoning`, `message.content` → `text` (through `ThoughtRouter`),
  `message.tool_calls` (whole calls, no index) → `tool_call_delta` via `ToolCallIndexer`,
  `done_reason` → `finish`, `prompt_eval_count`/`eval_count` → `usage`.
- Base URL from settings, default `http://127.0.0.1:11434`. Add it to `CONNECT_ORIGINS`
  (`vite.config.ts:61`); the build-time assertion at `vite.config.ts:81` enforces this.
- CORS: Ollama's default `OLLAMA_ORIGINS` already allows `http://localhost:*`. The local
  build serves from localhost, so no change is needed.
- `textToolCalls.ts` salvage stays on for this provider. Small models sometimes write
  `<tool_call>` into content. All three of its barriers apply unchanged.

### 3.2 Context strategy for 6 GiB: "stable core + append-only tool loading"
1. **Core roster** (~10 tools, chosen from real usage): list_books, get_book, get_chapter_text,
   search_book_text, search_wiki, create_memory_entry, read_span, web_search, save_file,
   set_active_book, plus a new meta-tool **`find_tools(query)`**.
2. `find_tools` embeds the query against tool cards (the Toolshed card pattern already in
   `src/lib/toolshed.ts`), returns the top 3-5, and **appends** them to this conversation's
   roster for all later turns. The roster only grows within a conversation, so the cached prefix
   breaks at most once per tool addition, never every turn. This mirrors the "tool search"
   pattern from hosted agents and RAG-MCP (arXiv 2505.03275: 13.6% → 43.1% selection accuracy
   from retrieval at scale).
3. Pre-seed: before turn 1, run retrieval on the user's first message and seed the roster with
   the top hits. That's what scored 13/14.
4. The system prompt shrinks automatically: its sections are already conditioned on the tool
   roster (the `promptToolTruth` invariant: "no prompt sentence names a tool the request doesn't
   carry"). Verify the local-profile prompt size with a test.
5. **Slim schemas for local:** the 8.5K-char blueprint schema is fine for frontier models but is
   noise to a 4B. Ship a `localDescription` per heavy tool (first paragraph + params), with
   full docs available via `find_tools`.
6. Budget: `num_ctx` 16K default (32K opt-in), retrieval budget lowered via
   `applyRetrievalBudget`, rolling summary kicks in earlier. Lean Mode gets a `local` tier.
7. Hard rule: keep the stable head byte-identical across turns. No timestamps or counters in it.
   This matters more locally than in the cloud: a miss there costs money, a miss here costs minutes.

### 3.3 Models (assigned per role, all swappable in Settings)
| Role | Default | Why |
|---|---|---|
| Interactive chat + vision | `qwen3.5:4b` (Q4_K_M, 3.3 GB, has tools/vision/thinking) | Fits fully in VRAM at 32K. 13/14 on the tool eval. ~45 tok/s gen when warm. |
| Background jobs (extract, tag, consolidate, lint, grading) | `qwen3:8b` / `qwen3.5:9b` | Accuracy over latency, and nobody is waiting on these. 14/14 on the tool eval. Must run when chat is idle (one GPU). |
| Tiny router / classifier | `granite4:1b` or `qwen3.5:0.8b` | Lean-mode phrase detection, routing |
| Embeddings | candidates: `embeddinggemma` (768, MRL), `nomic-embed-text` v1.5 (768, MRL, pulled) | **Pick by eval on the user's own wiki**, not by leaderboard (§5). |
| Thinking | off by default for chat (`think:false`); "deep" toggle turns it on | A thinking turn took 20-50 s in the first eval pass |

Scheduling: `OLLAMA_MAX_LOADED_MODELS=2` (chat + embedder, ~4.2 GiB together),
`OLLAMA_NUM_PARALLEL=1`, `OLLAMA_KEEP_ALIVE=30m`. Keeping the model loaded hides the dGPU's
cold-wake penalty. Background jobs go through a queue that yields while a chat turn is streaming.

### 3.4 Embeddings: one local model, re-embed everything
- `_shared/embed.ts` gains `EMBED_PROVIDER=ollama`. The file's own design already does the hard
  part: one model per deployment, the model id stamped on every row, and
  `knowledge-embed {stale_model:true}` to migrate. Use Ollama `/api/embed` at 768 dims.
- `_shared/wiki-embed.ts` (1536-d text-embedding-3-small) has no 1536-d local equivalent in
  the shortlist. Add a migration that moves those columns to 768 in the same space as
  `knowledge_entries.embedding`, so there's one vector space app-wide, and re-embed.
- Embedding models need task prefixes (`search_query:` / `search_document:` for nomic). Put
  them in one function, not scattered.

### 3.5 Web search
SearXNG in Docker (JSON API, no key). Swap in behind the same `web_search` tool result shape
that `pickCitations` (`chatTools.ts:532`) expects.

### 3.6 Image generation
stable-diffusion.cpp (`sd-server`) built with Vulkan, behind a small adapter in `imageGen.ts`.
Model choice is **still to research** at implementation time: what runs on gfx1010 Vulkan in
≤6 GiB, and how it does at text and edits. Expect tens of seconds per image. `edit_image` needs
an edit-capable model; if none fits, edits stay cloud-optional.

### 3.7 Voice
- TTS: a Piper HTTP server. Point `inworld-tts`'s client at a `tts` adapter. Keep the voice
  list small.
- STT: whisper.cpp server (Vulkan). VAD segments are POSTed to it. Replace the
  `SpeechRecognition` path in `useHandsFree.ts`.

### 3.8 Backend: Supabase running locally
- `npx supabase start` (Docker) with this repo's `supabase/config.toml` + migrations, then
  `npx supabase functions serve` with an env file:
  `AI_BASE_URL=http://host.docker.internal:11434` (Linux needs the host-gateway mapping; verify).
- `_shared/llm.ts`: one Ollama client for every edge function (num_ctx, `think:false`,
  **`format: <JSON schema>`** for structured outputs). Replaces ~10 copies of
  gateway/OpenRouter fetches. Today's JSON-from-prose parsing becomes schema-constrained, which
  is more reliable on small models.
- **Auth**: `src/integrations/lovable/index.ts` is Lovable cloud OAuth, which can't work offline.
  The local build uses Supabase local email/password plus a one-time seeded user.
  `Auth.tsx` gets a local branch.
- **Billing**: entitlement checks short-circuit to "operator tier" when `VITE_LOCAL_MODE=1`.
- **Your existing data**: exporting from the hosted project is the riskiest unknown. Lovable
  Cloud may not expose a direct Postgres connection string. Order of attempts: (1) DB connection
  string from Lovable's project settings → `pg_dump`; (2) the app's own `chapters-api` and
  Storage downloads with your JWT, written as a one-shot import script; (3) start fresh. **Needs
  checking with you before anything is pulled.**
- Migrations: 140 files, some generated by Lovable. Expect a few that assume hosted-only
  extensions or roles. Fix forward in a `local` migration, never by editing history.

### 3.9 One command
`scripts/local-up.sh`: checks Ollama and the pulled models, starts the Supabase stack, functions,
SearXNG, Piper, whisper and sd-server (docker compose), then `vite`. `local-down.sh` stops them.
Ollama service tuning needs a systemd override (sudo, once):
`/etc/systemd/system/ollama.service.d/override.conf` with the env vars from §3.3.
Run it in a real terminal; sudo can't prompt through `!`.

## 4. Phases (each ends runnable and tested)

1. **Local chat.** ollama provider + adapter + CSP + settings UI (detect Ollama, list models,
   pull hints). Unit tests mirror `src/test/providers.test.ts`. *Exit:* chat with tools works
   against hosted data.
2. **Fit the context.** Core roster + `find_tools` + slim schemas + local budget profile + a
   prompt-size test. *Exit:* first turn < 20 s cold, follow-ups < 10 s, tool eval ≥ 13/14 with
   the real app prompt (extend `tool-eval.py` to use `buildChatSystemPrompt`).
3. **Local backend.** Supabase in Docker, `_shared/llm.ts`, local auth, entitlement bypass,
   data import (after your go-ahead on the method). *Exit:* app runs with Wi-Fi off.
4. **Local embeddings.** Pick the model by eval, migrate wiki-embed to 768, re-embed.
   *Exit:* retrieval quality ≥ the cloud baseline on a fixed query set built from your wiki.
5. **Search + voice.** SearXNG, Piper, whisper.cpp, vendored VAD assets.
6. **Images.** sd-server + model research.
7. **Ops polish.** `local-up.sh`, Ollama override, the 0.40.x upgrade when the Omarchy mirror has
   it, then re-test flash attention + q8 KV on Vulkan (unverified on this backend; KV q8 needs FA).

## 5. Open questions / things not yet verified
- **Unexplained per-call overhead**: top-8 calls with ~2K prompt tokens took 20-40 s, and
  cached all-tools calls ~10 s, far above what the measured prefill/gen speeds predict. Suspects:
  dGPU clock ramping between calls, the embedder and chat model alternating, or template
  re-render. Profile with `OLLAMA_DEBUG=1` before tuning anything else.
- Whether `/api/chat` streaming emits tool calls incrementally or only at the end on 0.33.3.
  This affects the "tool card appears" UX.
- Flash attention / KV-cache quantization on the Vulkan backend for gfx1010.
- Hosted-data export path (§3.8).
- Image model choice (§3.6).
- The eval is 14 prompts with first-tool scoring. It's good enough to choose a direction, but
  too small to tune on. Grow it from real transcripts (`20260802152000_transcript_persistence.sql`
  means they're stored).
