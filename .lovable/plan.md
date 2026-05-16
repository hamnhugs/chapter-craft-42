## Goal
Let users pick which OpenRouter model powers the Wiki's AI operations (ingest, extract, lint), reusing the saved model list from Chat.

## 1. Database
Add one column to `user_settings`:
- `wiki_model text NULL` — when null, wiki falls back to the current Lovable Gateway default (`google/gemini-3-flash-preview`).

## 2. Settings panel in Wiki tab
Add a **Settings** button (gear icon) in the WikiPanel header next to Reindex/Health Check. Clicking it opens a sheet/dialog with:
- A dropdown listing the user's `saved_models` from `user_settings` (same list as Chat).
- A "Use default (Gemini Flash)" option at the top.
- A small note: "Requires your OpenRouter API key in Chat Settings." Show a warning if `openrouter_api_key` is empty and a custom model is selected.
- Save persists `wiki_model` via the existing settings hook (extend `useChatSettings` with `wikiModel` / `setWikiModel`, or add a tiny `useWikiSettings` reading the same row).

## 3. Edge functions
Update `knowledge-ingest`, `knowledge-extract`, `knowledge-lint`:
- After auth, read `user_settings.wiki_model` and `openrouter_api_key` for the calling user.
- If `wiki_model` is set **and** an OpenRouter key exists → call `https://openrouter.ai/api/v1/chat/completions` with that model and the user's key.
- Otherwise → keep current Lovable Gateway path unchanged.
- Preserve the existing tool-calling payload (works on both gateways since both are OpenAI-compatible).
- On OpenRouter failure, fall back to Lovable Gateway and surface a toast-friendly error message.

## 4. UX details
- Show the active wiki model name as a subtle chip under the Wiki header ("Model: openai/gpt-5-mini" or "Default").
- If the user picks a custom model with no API key saved, the Save button stays enabled but a warning toast points them to Chat Settings.

## Out of scope
- No new model browsing UI (reuses Chat's saved list).
- No separate API key field — the existing `openrouter_api_key` is reused.
- Embedding model unchanged.

## Files touched
- migration: add `wiki_model` column
- `src/hooks/useChatSettings.ts` — add `wikiModel`
- `src/components/WikiPanel.tsx` — Settings button + dialog + active-model chip
- `supabase/functions/knowledge-ingest/index.ts`
- `supabase/functions/knowledge-extract/index.ts`
- `supabase/functions/knowledge-lint/index.ts`
- (optional) `supabase/functions/_shared/llm.ts` — small helper that picks gateway vs OpenRouter