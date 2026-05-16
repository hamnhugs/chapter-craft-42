## Goal

Right now, when you ask the assistant (chat or voice) to "search online", it only calls `search_wiki` — there is no real web search tool, so it never goes to the internet. We'll add a proper **web search tool** that calls your Burplexity project's `bot-ask` endpoint and is selectable separately from the wiki search and from Deep Research.

## What changes

### 1. New `web_search` tool (Burplexity-backed)

Add a new OpenRouter "function" tool exposed to the assistant in `src/lib/chatTools.ts`:

- **Name:** `web_search`
- **Description (what the model sees):** *"Live web search via Burplexity. Use this when the user asks to search online, look something up, or wants current info. Returns a concise answer + citations. Prefer this over `search_wiki` for anything time-sensitive or not stored locally."*
- **Args:** `{ query: string }`
- **Implementation:** POST to Burplexity's public endpoint:
  - URL: `https://personal-perplex-link.lovable.app/functions/v1/bot-ask` (Burplexity's Supabase functions host)
  - Headers: `x-api-key: pp_…` (your Burplexity bot token), `Content-Type: application/json`
  - Body: `{ query, save_to_wiki: false }`
  - Returns: short summary + first 3–5 citations (title + url) to the model.

### 2. Store the Burplexity API key

A new field in user settings: **Burplexity API Key** (`pp_…`).

- Add `burplexity_api_key TEXT` column to `user_settings` (migration).
- Extend `useChatSettings.ts` with `burplexityApiKey` + `setBurplexityApiKey`.
- Add an input for it in both the Chat settings drawer and Voice settings drawer, right under the OpenRouter key, with help text linking to the Burplexity API Keys page.

If the key is missing, `web_search` returns a friendly error and the assistant tells you to add it in Settings — no crash.

### 3. Quick vs. Deep — keep them separate

- **Quick search = `web_search` tool** (single Burplexity call, fast, ~3-8 s). Always available.
- **Deep Research toggle** stays exactly as it is — it switches the *chat model* to your deep-research model. Unchanged.

### 4. Fix the "it only searches the wiki" behavior

Update the system prompt builder (`src/lib/buildChatSystemPrompt.ts`) so the assistant clearly knows:

> - `search_wiki` → search the user's saved knowledge.
> - `web_search` → search the **live internet** via Burplexity. Use this whenever the user says "search", "look up", "what's the latest", "online", etc.
> - You may call both in the same turn when useful.

This is the actual fix for "voice mode search only hits the wiki" — the model now has a real internet tool and is told to use it.

### 5. Streaming while search runs

Keep current streaming behavior in `ChatContext.tsx`. We show a tool event chip in the UI the moment `web_search` is dispatched (`"Searching the web…"`), so you see it's working. The assistant's spoken/streamed reply resumes as soon as Burplexity returns. No long blocking spinner.

## Out of scope

- No change to Deep Research model behavior.
- No change to wiki / RAG retrieval.
- No new edge function in this project — we call Burplexity directly from `executeChatTool` (browser fetch, same as OpenRouter calls today).

## Technical notes

- Burplexity endpoint is public (CORS open in its function) and authenticates via the `pp_` token, so this works as a direct browser fetch.
- Token is per-user and stored in `user_settings` (RLS already scoped to `auth.uid()`).
- Migration: `ALTER TABLE public.user_settings ADD COLUMN IF NOT EXISTS burplexity_api_key text;`
- `web_search` result sent back to the model is trimmed to ~4 KB (answer + top 5 `{title,url,snippet}`).
