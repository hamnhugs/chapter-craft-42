# Plan: Compress the NotebookLM research prompt to <5,000 chars

The previous 8-section briefing is too long for NotebookLM's input limit. I'll rewrite it as a tight, single-pass prompt that keeps every research target but drops prose padding, repeated framing, and example lists.

## Compression strategy

- Collapse the 8 sections into 6 tighter ones (Input, Vision models, Visual memory, Retrieval, Lifecycle, Safety+UX+Architecture).
- Replace bulleted example lists with comma-separated keyword runs (e.g. "MMMU, MMBench, DocVQA, ChartQA, V*, BLINK, MM-Vet").
- Keep the source-priority list and date window (2024–2026), but as one line.
- Keep the strict output rules (inline citations, comparison tables, confidence flags, contradiction flags, final "Decisions I'd make today" list of 8–12 items).
- Drop redundant role framing and motivational language.
- Target ~4,500 chars to leave headroom.

## What the rewritten prompt will still cover

1. Context: React + Vite + Supabase chat app with pgvector memory; user uploads images, AI sees them, system remembers them.
2. Input pipeline — formats, resize/compress, EXIF strip, NSFW/CSAM pre-checks, cost/latency.
3. Vision model selection — current SOTA + open-weights, benchmarks, failure modes, when to route to which.
4. Visual memory storage — caption-first vs embedding-first vs hybrid; multimodal embedding models (CLIP-L, SigLIP-2, Gemini Embedding, Cohere Embed v4, Nomic Embed Vision, Voyage Multimodal); schema shape; pixels-on-demand.
5. Retrieval — multimodal RAG, hybrid (BM25 caption + vision embedding + graph edges), deictic reference resolution ("that fox logo").
6. Lifecycle — consolidation, decay, dedup, conflict handling.
7. Safety/Privacy — image prompt injection, CSAM/biometric/GDPR, signed-URL TTLs, C2PA/watermarking.
8. UX patterns from ChatGPT, Claude, Gemini, Perplexity, Notion, Mem.
9. Reference architecture + 3–5 highest-leverage decisions + open questions.

## Output format rules carried over

- Cite every non-obvious claim inline with source + year.
- Comparison tables where useful.
- Mark each claim's confidence (established / emerging / disputed).
- Surface contradictions instead of hiding them.
- End with 8–12 opinionated "Decisions I'd make today".

## Deliverable

A single Markdown prompt block under 5,000 characters that you can paste straight into NotebookLM. I'll print it in chat — no project file changes.