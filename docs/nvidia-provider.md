# NVIDIA provider (second chat provider)

Shipped 2026-07-31 on `new1` (commit `47c24fe`). NVIDIA's hosted catalog —
Nemotron 3, DeepSeek V4, Kimi K2.6, GPT-OSS, GLM, **DiffusionGemma** — usable
anywhere OpenRouter models are, on the user's own free trial credits.

## Deploying (the two user actions)

1. **Lovable prompt** (migration + function together):

   > Please run the repo migration `supabase/migrations/20260731093000_nvidia_provider.sql`
   > exactly as written, and deploy the edge function `supabase/functions/nvidia-chat`
   > (its config.toml entry is already in the repo). The migration is idempotent.

2. **A free NVIDIA key**: build.nvidia.com → Settings → API Keys → Generate
   (starts `nvapi-`), pasted into Settings → AI Models & Keys.

Before both: the NVIDIA key field reports the missing columns, and any NVIDIA
model errors in-bubble with the deploy hint. Nothing else changes.

## Why a relay exists

`integrate.api.nvidia.com` enforces a **CORS origin allowlist** — an OPTIONS
preflight from any origin but NVIDIA's own frontend returns 200 with *no*
`Access-Control-Allow-Origin`. Probed directly, twice, months after NVIDIA
declined to commit to a fix on their forum. Browser-direct is impossible, so
`supabase/functions/nvidia-chat` relays: JWT verified in code (`verify_jwt`
is also true in config.toml), hardcoded upstream host (no caller-supplied
URL ⇒ no SSRF), the caller's own key read under RLS, and the SSE body piped
through with **fresh headers** (Deno's fetch already decompressed it —
forwarding `Content-Encoding` corrupts the stream). `signal: req.signal`
propagates aborts so Stop doesn't keep burning credits.

The relay is on the already-allowlisted Supabase origin, so the app CSP is
unchanged.

## The adapter seam

`src/lib/providers/` — `ChatContext` owns the conversation (tool loop,
sentence cap, persistence, Memory Lens); adapters own the wire protocol.
Normalized events: `text` · `reasoning` · `tool_call_delta` · `finish`.

- `openrouterAdapter` — today's request verbatim (headers, body, error copy),
  plus `delta.reasoning`, which the old parser silently dropped.
- `nvidiaAdapter` — relay transport + every NVIDIA quirk (below).
- `registry.resolveModel(id)` — the ONLY routing decision.

**Model ids: `nvidia:vendor/model`.** Colon, because NVIDIA ids contain
slashes; explicit, because bare ids cannot disambiguate —
`nvidia/nemotron-nano-12b-v2-vl` is a real id on *both* services (the repo
already shipped the OpenRouter flavor in `figureModels.ts`). Every existing
saved model id stays valid; no data migration.

### NVIDIA quirks, all adapter-internal

- Reasoning arrives as `delta.reasoning_content`, **or** inlined as
  `<think>` / `<|channel>thought` tags. `ThoughtRouter` strips both
  unconditionally (DiffusionGemma emits an *empty* tag pair even with
  thinking off) and is split-chunk safe.
- Streamed tool calls may arrive whole and **without `index`** —
  `ToolCallIndexer` opens a new slot per named call, so parallel calls can't
  overwrite each other's arguments.
- A 200 response can carry an error object (both stream and non-stream
  paths check).
- **Non-streaming fallback**: if a model refuses `stream:true` (nobody has
  published a streamed DiffusionGemma example), the JSON completion is
  rendered as one burst of events instead of failing.
- Reasoning toggles are per-family `chat_template_kwargs` and are **always
  sent explicitly** — the documented defaults could not be verified.
  Background summaries force thinking OFF (`nvidiaNoThinkingBody`), or a
  reasoning model spends the whole 500-token budget before writing a word
  and the summary never advances.
- Tools are omitted entirely (not sent empty) when a model lacks function
  calling, and on image turns for VL models flagged `imagesDisableTools`.

### Latent bugs this fixed on the OpenRouter path too

- Tool calls were discarded unless `finish_reason` was exactly `"tool_calls"`
  — now honored regardless, **except** on `length`/`content_filter`, where
  the last call's arguments are truncated mid-JSON.
- The cost valve now arms on the 40th dropped delta and fires at the *next*
  one, so a tool call already in flight behind capped narration still lands.
- A reasoning-only reply no longer persists "(No response received)" under a
  full Thinking strip, and no longer feeds that placeholder to the summary.

## Catalog

NVIDIA's `/v1/models` returns ids only — no context length, no modalities,
no capability flags. So `src/lib/nvidiaCatalog.ts` ships a **curated table**
(11 featured models with verified context windows and caps) plus name-pattern
filters that hide ~40 non-chat rows (embeddings, safety guards, rerankers,
OCR/parse, translators, code specialists, legacy VLMs served on a different
endpoint family). Uncurated rows get conservative defaults. Nothing scrapes
NVIDIA at runtime; refresh the table by hand.

`isEmbeddingModel` gained NVIDIA cases (`bge-`, `nvclip`, `nemoretriever`) —
their embedding ids don't contain "embed".

## Key handling (write-only)

`nvidia_api_key` + `nvidia_key_last4` on `user_settings`. The key is saved by
a **targeted upsert** (`saveNvidiaKey`), deliberately excluded from the
debounced full-row settings write so an unrelated save can't blank it, and
the settings load enumerates columns instead of `select("*")` so the
plaintext key never transits to the browser at all (falls back to `*` if a
column hasn't been migrated yet). Only the relay reads it. Not exposed in
Admin.

## Scope: what stays on OpenRouter

Chat, deep research, voice and vision chat work on both providers. Image and
video generation (OpenRouter's image-output extension / jobs API), splats
(fal), book digestion, figure extraction, wiki ops and embeddings are
OpenRouter/gateway-only **server-side** — so NVIDIA ids are excluded from
those pickers *and* stripped at the call sites (`figureJobs.enqueue`,
`LibraryCollections` ingest, `generate_video`). Forwarding one would 400 on
every retry after a minutes-long client-side scan.

## Free-tier reality

~1,000 trial requests (≈1 credit each), ~40 requests/min, **no self-serve
top-up**. One chat turn costs up to 5 tool rounds + 1 summary, so ~170–500
turns. Settings copy says so. NVIDIA's per-account "Function not found for
account" provisioning failures (a June–July wave affecting many models) are
detected and explained with NVIDIA's own remedy (email help@build.nvidia.com);
`google/gemma-4-31b-it` is featured as the fallback.

## Verification status

tsc clean · 67/67 vitest · production build green · built preview boots with
zero console errors under the real CSP. A 4-lens hunter/skeptic review over
the diff produced 16 findings — all 16 addressed (1 blocker: digestion
forwarding NVIDIA ids server-side; 3 major: the key transiting on the wire,
figure-extraction leakage, and an NVIDIA-only onboarding dead-end).

**Not yet exercised live** (needs the deploy + a real key): every streamed
NVIDIA path. `scripts/nvidia-probe.mjs` captures raw transcripts for the 8
cases that matter (streamed tool calls on two backends, reasoning,
DiffusionGemma stream + tools, image+tools on the VL model, no-max_tokens,
tools on a non-tool model):

```
NVAPI_KEY=nvapi-... node scripts/nvidia-probe.mjs
```
