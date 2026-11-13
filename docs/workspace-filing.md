# Workspace filing — every file belongs to a notebook

2026-11-13 · branch `new1`

The Workspace was one flat, newest-first list of everything Counsel ever made,
across every project. Now each item is filed under a notebook.

## What happens

- **A notebook is open in Counsel** → anything made (artifacts, code blocks,
  research, `save_file`) is filed under the primary notebook, silently.
- **No notebook is open ("Just chatting")** → the file is saved, and a sheet asks
  *"Which notebook is this for?"*: pick one, or name a new one. Several files
  from one reply share one question. "Keep it open in Counsel" (on by default)
  loads that notebook so the next file isn't asked about. "Decide later" leaves
  the files under **Needs a notebook**.
- **Workspace panel** opens on the loaded notebook's files. A chip row switches
  to another notebook, to *Needs a notebook*, or to *All*. "Move" on a row, and
  the notebook chip in a file's footer, refile it. "Clear unsaved" clears only
  what is listed.
- **Notebooks tab** → an open notebook has *Notes · Files*. Search looks through
  both (file title, type, and contents). A file opens in the Workspace without
  changing which notebook Counsel has loaded.
- Files made before this have no notebook: they sit in *Needs a notebook*, with
  "Move all N to a notebook".

## How it is built

| Piece | Where |
| --- | --- |
| `meta.wikiId` on the item; stamped in `addItem`, the one seam every creation path passes through | `src/lib/workspaceStore.ts` |
| Filing target = Counsel's primary, set synchronously in `commitActiveSet` | `src/context/AppContext.tsx` |
| The open question (`FilingRequest`), `assignNotebook`, `requestFiling`, `removeMany`, `requestOpen` | `src/lib/workspaceStore.ts` |
| Notebook names/colours for the panel, outside React context | `src/lib/notebookDirectory.ts` |
| The sheet (mounted once in `Index.tsx`) | `src/components/WorkspaceFilingPrompt.tsx` |
| Scope chips, move, scoped clear | `src/components/WorkspacePanel.tsx` |
| Notes · Files and search | `src/components/WikiPanel.tsx` |
| Tests | `src/test/workspaceFiling.test.ts` |

Decisions worth keeping:

- **No migration.** `wikiId` lives in the existing `meta` JSONB, like `focused`,
  so it syncs across devices through the upsert + realtime path already there
  and works on the hosted database as it stands. A real `wiki_id` column with an
  index is the next step only if server-side filtering is ever needed; today
  the whole list is already on the client.
- **Save first, ask second.** The file is written before the question is shown.
  A reload, a crash or a dismissed sheet loses the question, never the file.
- **Stamp at the seam, not the call sites.** Seven places create items; none of
  them changed. A new call site cannot forget to file.
- **Deleting a notebook keeps its files.** Their `wikiId` stops matching and
  they read as *Needs a notebook* again.
- **Viewing is not loading** (the Notebooks-audit rule): opening a file from a
  notebook does not change Counsel's loaded set.

## What the research pointed to

- Notebook-style AI tools keep generated outputs inside the notebook that made
  them, and finding them later is notebook-by-notebook (NotebookLM's Studio
  outputs and saved notes; deleting the notebook deletes them). Scoping by the
  active container is the norm; a global pile is the outlier.
- Interruption guidance is consistent: block only for a decision that needs a
  definite answer, never to confirm a success, and prefer a reversible default
  with an easy way to change it over a gate. That is why filing is silent when
  a notebook is open, the question appears only when there is truly no default,
  and Move exists everywhere.
- Capture tools that "file themselves" fall back to the last place used. Here
  the equivalent is "Keep it open in Counsel" — answer once per session.
- Local-first sync guidance: per-field last-write-wins, optimistic writes,
  realtime as delivery with a fetch as backfill. The store already works this
  way; filing rides on it rather than adding a second mechanism.

Not found: any published write-up of how Claude Projects or ChatGPT Projects
file generated artifacts, or anything specific to prompting during a streamed
reply. Those parts are judgment, not citation.
