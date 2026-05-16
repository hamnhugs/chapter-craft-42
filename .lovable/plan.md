## What "Reindex" is supposed to do

The Reindex button rebuilds the **vector embeddings** for your knowledge entries. Embeddings are the numeric fingerprints the app uses to:

- Find semantically related entries during chat ("Graph-aware retrieval"),
- Detect contradictions during ingest,
- Power the hybrid + semantic search in the Wiki.

Right now it appears to do nothing because the embedding API call is **failing silently with a 404**.

## Root cause (confirmed from edge logs)

```
embedBatch failed: 404
"models/text-embedding-004 is not found for API version v1beta,
 or is not supported for embedContent."
```

The `knowledge-embed` function calls Google's `v1beta/models/text-embedding-004:embedContent` directly, but the key/endpoint combination is rejecting that model name. Every batch returns `null`, so the function responds with `{updated: 0, failed: N}` — the toast pops but says effectively nothing useful, so it looks like a dead button.

## Fix

1. **Switch embeddings to the Lovable AI Gateway** (OpenAI-compatible `/v1/embeddings`), which already authenticates with `LOVABLE_API_KEY` and works reliably for `google/text-embedding-004` (768 dims — matches the existing `embedding vector(768)` column, no migration needed).
   - Update `supabase/functions/_shared/embed.ts`:
     - `embedOne`, `embedQuery`, `embedBatch` → POST to `https://ai.gateway.lovable.dev/v1/embeddings` with `{ model: "google/text-embedding-004", input: [...] }` and `Authorization: Bearer ${LOVABLE_API_KEY}`.
     - Keep the direct Google REST call as a fallback if the Gateway returns 4xx/5xx (so a future Gateway hiccup still produces embeddings).
   - Keep `EMBEDDING_DIMS = 768` and `EMBEDDING_MODEL_ID = "google/text-embedding-004"`.

2. **Make the Reindex UX honest and actionable** in `WikiPanel.tsx`:
   - Distinguish 3 outcomes in the toast:
     - `total === 0` → "All entries already have embeddings."
     - `updated > 0` → "Embedded N entries · M failed" (warning if any failed).
     - `updated === 0 && failed > 0` → "Reindex failed — embedding service unavailable" (error).
   - Show a small status line under the button: "X / Y entries embedded" computed from a quick count query on mount and after reindex, so users can see whether anything actually needs reindexing.
   - Add an inline "Re-embed all (force)" option in a dropdown next to Reindex for power users — passes `{all_missing: true, force: true}`.

3. **Deploy `knowledge-embed`** after the fix and trigger one Reindex to backfill all current entries.

## Verification

- Click Reindex → toast shows actual numbers; edge function logs show 200s.
- Open Conflicts / chat with a question — graph-aware retrieval now has vectors to work with.
- Status line under the button updates from "0 / N" to "N / N".
