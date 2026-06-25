## Goal : This Program Currently only works with Open Router so Work it around that please

Let external bots and users call Bookworm's "Counsel" assistant over HTTP with the same brain the in-app chat uses — same model routing, same tools (memory retrieval, books, notes, web search, image gen, etc.), scoped to the API key owner's data and plan.

Authentication reuses the existing `worm_*` keys in `api_keys`. No new auth surface for end users.

## API shape (OpenAI-compatible)

One new edge function: `counsel-chat` (verify_jwt = false; auth = `x-api-key: worm_...` **or** `Authorization: Bearer worm_...`).

- `POST /counsel-chat/v1/chat/completions` — mirrors OpenAI's contract so any OpenAI SDK can be pointed at it.
  - Body: `{ model?, messages: [...], stream?: bool, conversation_id?: string, tools?: "all" | string[] }`.
  - `stream: true` → SSE chunks (`data: {...}\n\n`, terminating `data: [DONE]`).
  - `stream: false` → single JSON `{ id, choices: [{ message }], usage }`.
  - When `conversation_id` is omitted → fully stateless (caller owns history).
  - When `conversation_id` is provided → server loads prior turns from `chat_messages` (scoped to the key's user) and appends the new ones after the run completes.
- `GET  /counsel-chat/v1/models` — returns the models the key owner is allowed to call.
- `GET  /counsel-chat/v1/conversations` and `GET /v1/conversations/{id}/messages` — list/read server-managed threads.
- `DELETE /v1/conversations/{id}` — wipe a thread.

All responses include CORS headers and rate-limit headers (`X-RateLimit-Limit-Minute`, `...-Remaining`, `Retry-After`).

## Tool parity with Counsel

The function imports the existing tool catalog and porter-executes each tool with a **service-role Supabase client manually scoped to `keyOwnerId**` (RLS bypass is required because there is no user JWT). Each tool wrapper:

1. Forces `user_id = keyOwnerId` on every read/write.
2. Honors the key owner's `user_settings` (active neuron, `access_all_neurons`, model choices, OpenRouter key, Burplexity token, etc.).
3. Honors the key owner's plan: image generation / edit tools refuse with a clean error if the owner isn't paid (matches in-app behavior).
4. Respects the key's `allowed_tools` scope (see below).

Tools exposed initially: `list_books`, `get_book`, `get_chapter_text`, `set_active_book`, `search_knowledge`, `retrieve_knowledge_graph`, `save_knowledge`, `list_notes`, `read_note`, `write_note`, `web_search`, `deep_research`, `generate_image`, `edit_image`, `show_image`, `switch_wiki`, plus the rest of `CHAT_TOOL_DEFINITIONS`. Anything that touches `window`/DOM (e.g. UI-only side effects) is stubbed to a no-op result the model can still reason about.

Model routing matches `ChatContext`: if the key owner has `wiki_model`/`selected_model` + OpenRouter key → call OpenRouter; otherwise fall back to Lovable AI Gateway (`google/gemini-3-flash-preview`). Tool loop cap: 50 steps.

## Per-key configuration (new columns on `api_keys`)

Migration adds:

- `allowed_tools text[] null` — `null` = all tools the plan allows; otherwise whitelist.
- `allowed_wiki_ids uuid[] null` — `null` = same neuron scope as the owner's UI; otherwise restrict.
- `rate_limit_per_minute int not null default 60`
- `rate_limit_per_day int not null default 1000`
- `last_used_at timestamptz`

Plus a new table `api_key_usage(api_key_id, window_start, minute_count, day_count, updated_at)` with a `SECURITY DEFINER` function `consume_api_key_quota(_key_id uuid)` that atomically increments and returns `{ allowed, retry_after, remaining_minute, remaining_day }`. Tradeoff: this is an ad-hoc per-key limiter (the platform has no standard rate-limit primitive); it protects the owner's LLM credits but won't survive multi-region scale-out. The user explicitly opted in.

All new tables get `GRANT`s + RLS so only the key owner can read their own usage rows.

## Frontend additions

Extend the existing **API Keys** card in Settings (`ApiKeyManager.tsx`):

- After generating a key, show the full key once with a copy button and a "Connect a bot" panel containing:
  - Base URL: `https://<project>.supabase.co/functions/v1/counsel-chat`
  - Curl + Python + Node snippets (OpenAI SDK pointed at base URL).
  - Tool scope multi-select, neuron scope, and rate-limit sliders editable per key.
- Show `last_used_at` and today's usage from `api_key_usage` next to each key.

A new docs page `/api-docs` (linked from Settings) explains: auth header, endpoints, streaming format, tool list, conversation_id behavior, error codes (`401`, `403 invalid_key`, `429 rate_limited` with `Retry-After`, `402 plan_required` for image tools on free, `400 tool_not_allowed`).

## Security & safety

- Edge function uses `SUPABASE_SERVICE_ROLE_KEY` and **never** trusts a `user_id` from the request body — it's always derived from the API key row.
- Key lookup is constant-time-safe enough via a single `eq("key_value", ...)` query; we'll also hash-index `key_value` (already unique).
- Every tool wrapper re-asserts `user_id = keyOwnerId` on insert/update/delete.
- Image generation and other paid tools verify `subscribers.subscribed` for the owner before spending.
- Errors return structured JSON (`{ error: { type, message } }`) — never leak stack traces or secrets.
- Logs: write a row per request to a new `api_request_log` table (status, tool calls invoked, tokens) so the user can audit bot activity from Settings.

## Research notes (cutting-edge practices applied)

- **OpenAI-compatible surface** is the de-facto 2025/26 standard (Anthropic, Together, Groq, OpenRouter, vLLM, Ollama, Lovable AI Gateway itself all mirror it) → maximum SDK reuse, zero learning curve for bot authors.
- **SSE framing** matches OpenAI's `data: {...}\n\ndata: [DONE]\n\n` exactly so existing client libraries' stream parsers work unmodified.
- **Bearer-token alias** for the API key (alongside `x-api-key`) is what OpenAI SDKs send by default; supporting both means `OpenAI({ apiKey: "worm_...", baseURL: ... })` works out of the box.
- **Per-key scoping (`allowed_tools`, neuron scope, rate limits)** follows the "principle of least authority" pattern Anthropic and OpenAI both adopted for their 2025 Agent/API key UX — one key per bot, narrow capabilities.
- `**conversation_id` (server threads) as an optional add-on to stateless `messages[]**` mirrors OpenAI's Responses API direction (stateless default, `previous_response_id` for continuity) while preserving compatibility with the older Chat Completions shape.
- **Atomic quota function in Postgres** (single `UPDATE ... RETURNING`) is the standard pattern for ad-hoc per-key throttling without Redis; documented as such by Supabase and PostgREST community.
- **Tool loop cap of 50** matches AI SDK's recommended `stepCountIs(50)` for agent loops.

## Files to add / change (technical)

New:

- `supabase/functions/counsel-chat/index.ts` — router, auth, rate-limit gate, model call, tool loop, SSE.
- `supabase/functions/counsel-chat/tools.ts` — service-role-scoped reimplementation of the Counsel tool set (mirrors `src/lib/chatTools.ts` definitions, but executes server-side).
- `supabase/functions/counsel-chat/system-prompt.ts` — mirrors `buildChatSystemPrompt`.
- `supabase/migrations/<ts>_counsel_api.sql` — `api_keys` new columns, `api_key_usage`, `api_request_log`, `consume_api_key_quota()`, GRANTs, RLS.
- `src/pages/ApiDocs.tsx` — public docs page (linked from Settings, route `/api-docs`).
- Route registration in `src/App.tsx`.

Changed:

- `src/components/ApiKeyManager.tsx` — per-key scopes, usage display, connect-a-bot snippet panel.
- `supabase/config.toml` — add `[functions.counsel-chat] verify_jwt = false`.

No changes to existing tool code in `src/lib/chatTools.ts` or `ChatContext.tsx` — the server tool set is a parallel implementation so the UI stays untouched.

## Out of scope (call out)

- Per-end-user OAuth (each bot user signing in to Bookworm individually). The API key represents the owner; bots act on the owner's behalf, same as the Chapters API today.
- Streaming **tool-call deltas** in OpenAI's newest format — v1 streams assistant text only; tool calls are executed server-side and their final results stream as text. Can be added later if a bot needs tool transparency.
- Webhooks / push from Bookworm to bots — pull-only for now.