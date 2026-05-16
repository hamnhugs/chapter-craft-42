## Goal
Use OpenRouter's embedding endpoint (default model `perplexity/pplx-embed-v1-4b`) to power Reindex and semantic search, replacing the broken Lovable Gateway / Google paths.

## 1. Edge function: `supabase/functions/_shared/embed.ts`
Add OpenRouter as the **primary** embedding path:

- Read `OPENROUTER_API_KEY` from env (already a project secret — confirmed).
- POST to `https://openrouter.ai/api/v1/embeddings` with `{ model: "perplexity/pplx-embed-v1-4b", input: [...] }` and `Authorization: Bearer ${OPENROUTER_API_KEY}`.
- Keep existing Lovable Gateway + Google paths as **fallback** in case OpenRouter rejects the model later.
- Make the model id configurable via `OPENROUTER_EMBED_MODEL` env, defaulting to `perplexity/pplx-embed-v1-4b`.

### Dimension handling (important tradeoff)
The DB column is fixed at `vector(768)`. `pplx-embed-v1-4b` likely returns more (e.g. 1024 or 1536). Two choices:

- **Default (recommended for now):** truncate the returned vector to the first 768 floats. Works immediately, no migration, but retrieval quality drops a bit vs. native dims.
- **Optional later:** if you want full quality, I can run a migration to change the column to the model's native dimension and reindex everything. We can do that after confirming the model's actual output size from one successful call.

I'll default to **truncate-to-768** so Reindex starts working right away, and log the actual returned dim so we know what a future migration target would be.

## 2. Reindex UX (`src/components/WikiPanel.tsx`)
Already shows distinct toasts for success/partial/failure. No changes unless errors persist after deploy.

## 3. Verification
- Deploy `knowledge-embed` + `_shared`.
- Click Reindex from the Wiki tab.
- Watch edge logs: expect `gatewayEmbed` and `googleEmbed` to no longer be reached, and OpenRouter to return 200.
- If model returns a dim != 768, log a one-line warning ("openrouter returned N dims — truncated to 768").

## Out of scope
- Per-user OpenRouter embedding model (uses project-wide `OPENROUTER_API_KEY` for now). The wiki *chat* model selector you just got stays user-scoped.
- Changing the `vector(768)` column dimension — can be a follow-up if truncation quality isn't enough.

## Files touched
- `supabase/functions/_shared/embed.ts` — add `openrouterEmbed()`, reorder fallbacks, truncate to 768.