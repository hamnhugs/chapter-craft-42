# Memory redesign (2026-10-20): notes as an index of anchors

Audit and rationale: https://claude.ai/artifact/YZe33pKHfZMqCtAidvMyvz
Evaluation results: `e2-data/memory-ab.json` (rerun with `npm run eval:memory`).

## What users see

Two nouns: **books** and **notes**. Notes live in **notebooks** (one per
subject). The old Neuron + BRAIN tabs are one nav destination, **Notebooks**:
the list (`wikis` tab id) and one open notebook (`wiki` tab id). Internal ids,
table names and tool names (`wikis`, `knowledge_entries`, `search_wiki`,
`set_active_neurons`, …) are unchanged; only words people read changed.

| Before | Now |
|---|---|
| Neuron / wiki | Notebook |
| Entry / card / memory | Note |
| BRAIN tab | Notebooks list |
| Chain | Saved set |
| Recording / retrieval mode | Off the record (Counsel tools, notebook pill, Settings) |
| Memory review | Daily recall — 3 a day, answer first, page link |
| Sleep Cycle / consolidate | Tidy-up — once a day, logged, undoable |
| Working Memory panel, Episodic view, Suggestions tab, BRAIN mind map | Removed |

Every note shows **Why this is here** (who saved it, when, from which
book) with an **Open page** link per anchor (`lib/openPassage.ts`), plus Edit
and Forget. Each reply lists the notes it used; tapping one opens it.

## What the model sees

`buildChatSystemPrompt({ memoryContext: "pointers" })` (the default):

1. **Notes index** — stable prompt, one line per note in the open notebooks:
   `- [ref] title — one-line summary (Book, p. N)`, newest first, capped at
   8,000 chars (16,000 deep, 0 voice). `lib/notesIndex.ts`. Refs are the first
   8 hex digits of the id; every note-id tool argument accepts one
   (`resolveNoteRef` at the `executeChatTool` choke point).
2. **Named notes** — when the message names a note's title or alias, the app
   opens it (turn context). The model never has to guess.
3. **Related notes** — per-turn retrieval, capped at 8 notes (4 voice, 16
   deep). The best one (three in deep) carries its text; the rest ride as
   their one-line summary with "open it with `search_wiki`".

`memoryContext: "full"` is the old behaviour (retrieved text up to 14,000
chars, no index), kept for the A/B harness.

## Write path

`create_memory_entry` takes a `summary` (the hook); notes without one get it
from the daily tidy-up (`knowledge-consolidate` phase 4, one model call per
40 notes). Off the record blocks every save tool except delete.

## Daily tidy-up

`knowledge-consolidate`: embed missing → rerank → link queued notes → queue
orphans → write missing hooks. Each run that changes anything writes a
`memory_sleep_runs` row (link ids, hook ids); `undo_sleep_run(id)` reverses
it. `useAutoSleepCycle` runs it once a day when notes are queued or missing a
summary.

## Removed (migration `20261020120000_memory_redesign.sql`)

- Second embedding space: `knowledge_entries.embedding_v2` and everything
  that only fed it — `smart-file`, `recompute-centroids`, `incubator-sweep`,
  `wiki-drift-check`, `search-knowledge`, `embed-entries`, `_shared/wiki-embed.ts`,
  tables `wiki_centroids`, `incubator_entries`, `routing_decisions`,
  `reroute_suggestions`, `wiki_proposals`, `wiki_health_alerts`. The
  Notebooks search box now uses `knowledge-retrieve`, like the chat.
- Never-called extraction: `knowledge-extract`, `_shared/atomicity.ts`,
  tables `episodic_log`, `conversation_memory`, the Sleep Cycle's
  "semanticize" phase, columns `importance`, `surprise`, `encoding_strength`.
- Unreferenced: `wiki_log`, `wiki_questions`, `subject_progress`,
  `cleanup_flags` (written, never read).
- v1 search fallbacks: `hybrid_search_knowledge`, `get_neighbors`, the
  client multi-notebook fan-out.

The `drizzle/` mirror (hosted Lovable track) was not updated; this branch is
the local edition.

## First evaluation (2026-10-20, partial)

Local Qwen3-4B, real notes, one tool (search_wiki). Questions were written so
the answer is in the note's text but NOT its summary (the hard case for
pointers). The run was stopped at 21 of 32 answers by a low-memory reaper;
10 questions finished in both modes:

| | full | pointers |
|---|---|---|
| correct | 8/10 | 7/10 |
| prompt tokens (first call) | ~6,100 | ~4,960 |
| seconds per answer | 47.6 | 29.4 |
| opened a note itself | 0 | 2 |

Faster and smaller; accuracy within noise at this sample size. Rerun the full
set with `npm run eval:memory` (questions cache in e2-data/memory-questions.json).
