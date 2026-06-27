## Goal
When assigning a document to a folder, let the user **choose which neuron** to digest it into — instead of only confirming the folder's remembered/active neuron.

## Changes (UI only, in `src/components/LibraryCollections.tsx`)

1. **Replace the simple AlertDialog** with a `Dialog` containing:
   - Document name + target folder name (context).
   - A **Select** dropdown listing all of the user's wikis (neurons), pre-selected to:
     1. The folder's `default_wiki_id` if set, else
     2. The currently active wiki.
   - A small caption showing which neuron is the folder's remembered default (if any).
   - Two buttons: **Skip** (just file the doc) and **Digest into selected neuron**.

2. **Confirm handler** (`confirmSingleDigest`)
   - Use the wiki chosen in the dropdown (not the cached default).
   - Enqueue the single ingest job against that wiki via the existing `enqueueIngestJobs` pipeline.
   - Persist the chosen wiki as the folder's new `default_wiki_id` via `setFolderDefaultWiki`, so the next prompt remembers the latest choice.

3. **State additions**
   - `pendingDigest`: `{ bookId, folderId, suggestedWikiId }`
   - `selectedDigestWikiId`: controlled value for the Select.
   - Reset both on close/skip.

## Out of scope
- Bulk "Digest folder" flow stays unchanged (already targets the active neuron and updates the folder default).
- No schema changes, no edge-function changes, no AI tool changes.

## Technical notes
- Wikis list is already fetched/cached in the component — reuse it to populate the Select.
- Use shadcn `Dialog` + `Select` (already in the project) for consistent styling.
- Type-check after the edit; no other files need to change.
