## Problem

You added `perplexity/pplx-embed-v1-4b` to your saved OpenRouter models (it's the new embeddings model the Wiki uses for Reindex). OpenRouter's `/chat/completions` endpoint rejects it because it's an embedding-only model — that's the 400 error you're seeing in Chat.

Nothing is actually "leaking" from Wiki settings into Chat. Both selectors share the same saved-models list, and the embedding model is a valid entry for Wiki reindex but invalid for Chat. It happens to be your currently selected Chat model.

## Fix

1. **Tag embedding models** — add a small helper `isEmbeddingModel(id)` in `src/lib/utils.ts` (matches `/embed`, `pplx-embed`, `text-embedding`, etc.).
2. **Filter the Chat selector** (`src/components/ChatPanel.tsx`)
   - Hide embedding models from the Active Model `<select>` and the chip row.
   - If `selectedModel` is an embedding model on load, auto-switch to the first non-embedding saved model and toast "Switched off embedding model — not usable in Chat."
3. **Block adding embedding models as Chat model** — in `addModel` (`useChatSettings.ts`), if the new id looks like an embedding model, still save it to `savedModels` (so Wiki can use it) but do **not** flip `selectedModel` to it, and toast a hint.
4. **Guard the send path** (`src/context/ChatContext.tsx`) — before calling OpenRouter, if `model` is an embedding model, fail fast with a clear in-chat error instead of round-tripping a 400.
5. **Wiki picker stays unchanged** — embedding models remain selectable there (that's where you actually want `pplx-embed-v1-4b`). No backend / edge function changes needed.

## Out of scope

- No DB migration, no edge function changes.
- No separate model list for Wiki — sharing stays, embeddings just get filtered per-context.