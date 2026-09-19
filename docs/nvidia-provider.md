# NVIDIA provider (second chat provider)

Shipped 2026-07-31 on `new1` (`47c24fe`, clarity follow-up `fa42ac2`).
NVIDIA's hosted catalog — Nemotron 3, DeepSeek V4, Kimi K2.6, GPT-OSS, GLM,
**DiffusionGemma** — usable anywhere OpenRouter models are, free with the
user's own NVIDIA key.

## Deploying — DONE, kept for the record

Applied 2026-07-31: the columns landed via Lovable's own migration
`20260731091309_…` (identical to `20260731093000_nvidia_provider.sql`) and
the relay was deployed in `89e6c38`. The prompt used:

   > Please run the repo migration `supabase/migrations/20260731093000_nvidia_provider.sql`
   > exactly as written, and deploy the edge function `supabase/functions/nvidia-chat`
   > (its config.toml entry is already in the repo). The migration is idempotent.

**`nvidia-chat` must be re-deployed after `fa42ac2`** — it gained the
`action: "validate"` branch behind the Test key button. Until then that
button reports a bad-request error; nothing else regresses.

A free NVIDIA key comes from build.nvidia.com → Settings → API Keys →
Generate (starts `nvapi-`), pasted into Settings → AI Models & Keys.

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

**NVIDIA retired its credit system in 2025** (staff-confirmed; the "Request
More" button is gone). Free usage is governed by **rate limits that vary by
model and current traffic**, with no time limit and no self-serve increase.
There is no balance to display and no usage endpoint — the only way to know a
key works is a real request, which is what the **Test key** button and the
relay's `action: "validate"` branch do.

By contrast **OpenRouter requires a lifetime top-up (~$10) before even its
`:free` models will run**, which is what sent the first user here. Its key
status *is* readable from the browser (`GET /api/v1/key`, CORS-open), so
Settings can answer "am I out of credit?" before a failed send.

NVIDIA's per-account "Function not found for account" provisioning failures
(a June–July wave affecting many models) are detected and explained with
NVIDIA's own remedy (email help@build.nvidia.com); `google/gemma-4-31b-it` is
featured as the fallback.

## Provider must be visible, not inferred (the follow-up ship, `fa42ac2`)

The first ship routed on an invisible `nvidia:` prefix and left every error
anonymous. A real user with both keys saved an NVIDIA key, kept getting
OpenRouter's "Insufficient credits", and could not tell why. Three causes:

1. **Saving a key changed no model.** The wizard's auto-add was disabled for
   anyone who already had an OpenRouter key, and the Settings field had no
   model side effect at all — so chat stayed on OpenRouter.
2. **Errors named no provider.** `ProviderError.provider` was populated and
   then dropped at the display layer.
3. **The catalogs genuinely look alike.** 67% of NVIDIA's chat-worthy rows
   are other vendors' models, and **13 ids are byte-identical across both
   services** (`SHARED_WITH_OPENROUTER` in `nvidiaCatalog.ts`, measured).
   Stripping the prefix from dropdown labels made them indistinguishable.

Fixes: provider leads every error and every reply (`describeModel`); the
add-model box has a provider selector with paste repair; chips are grouped
and badged; option labels always carry the provider; all four model roles
(chat / deep research / voice / vision) are listed together with a warning
when one points at a keyless provider — each swaps in on its own kind of turn
and fails alone; saving a key offers the switch; Diagnostics block for the
next report.

**Also fixed a self-inflicted 402:** OpenRouter reserves the *maximum*
possible reply against the balance before running, and the streaming path
sent no `max_tokens`, so it reserved OpenRouter's ~65k default. A funded key
could be refused on every turn. Now sends an explicit cap, keeps upstream's
real message, and tells the two 402 meanings apart.

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
