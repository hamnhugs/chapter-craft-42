# Counsel works the Notebooks tab

2026-11-13 · branch `new1`

Counsel could list, load, create and delete notebooks, and edit notes. It could
not do the rest of what the Notebooks tab does: put a notebook inside another,
rename, recolor or move one, make or change a saved set, run Daily recall,
refile a Workspace file, or simply show a notebook on screen. Now it can.

## What Counsel can do now

| Ask | Tool | Notes |
| --- | --- | --- |
| "Make a Seneca notebook inside Stoics, green" | `create_wiki` (+ `parent_id`, `color`) | Three levels at most, same rule as the dialog. |
| "Rename / recolor / move this notebook" | `update_wiki` (new) | `parent_id: "top"` moves it out. Refuses itself, its own contents, a fourth level, and system notebooks. |
| "What notebooks do I have?" | `list_wikis` | Now also `parent_id`, `path` ("Stoics › Seneca"), `color`, `file_count`. |
| "Delete this notebook" | `delete_wiki` | Notebooks inside it are kept and move up, as in the tab. It used to leave them pointing at a dead parent. |
| "Stop using notebooks / just chat" | `set_active_neurons` with `[]` | A missing list is still an error. |
| "Save these three as a set", "rename that set", "delete it" | `manage_chain` (new) | One verb, `action: create / update / delete`. Delete needs `confirm:true` and never deletes notebooks. |
| "Quiz me", "what's due?" | `review_notes` (new) | `due` lists notes, `record` schedules the next review. Same RPCs as the Daily recall button. |
| "Put that file in my Cooking notebook" | `move_workspace_item` (new) | `wiki_id: "none"` unfiles. |
| "What files are in this notebook?" | `list_workspace_items` (+ `wiki_id`) | Each row now carries `notebook_id`. |
| "Open my Stoics notebook", "show me that note", "take me to settings" | `open_view` (new) | Tabs, one notebook (notes or files), one note, one Workspace file, a settings section. |

Already there and unchanged: notes (create, edit, supersede, delete, link),
conflicts (list, read, resolve), loading notebooks and saved sets, search.

## Decisions worth keeping

- **Opening is not loading.** `open_view` only changes what is on screen. The
  prompt tells the model that "open my X notebook" is `open_view` and "use /
  load / switch to X" is a load — the Notebooks-audit rule, in its words.
- **Five new roster slots, not ten.** The roster budget went 80 → 85
  (`toolRosterBudget.test.ts` says why). Nesting, color, files-per-notebook and
  "just chat" went onto verbs that already existed; saved sets and recall got
  one action-enum verb each; navigation is one verb for every screen.
- **Two new switches** in Settings → AI permissions → Notebooks: *Rename,
  recolor and move notebooks* (`update_wiki`) and *Manage saved sets*
  (`manage_chains`). Both default on, like the rest. `review_notes`,
  `move_workspace_item` and `open_view` have none: they destroy nothing and
  each is one call to undo.
- **No migration.** Nesting is still the `in:<id>` tag; filing is still
  `meta.wikiId`. The tools call the same functions the screens do
  (`notebookTree.ts`, `chainsApi.ts`, `workspaceStore.assignNotebook`,
  `fetchDueReviews` / `recordReview`).
- **Navigation seam** is `src/lib/appNav.ts`. `ChatContext` hands the tool one
  function built from AppContext's `setActiveTab` and `openNotebook`. A
  notebook's Files list and a Workspace file each have a request that waits
  for the panel to mount, plus an event for when it is already up.
- **Notes served for review are fenced** like every other note that reaches
  the model: data, never instructions.

## Not given to Counsel

- The row-level things that are only about the screen: folding the tree,
  Jump back in, the ⌘K switcher.
- "Tidy up now" and the health check — both were cut from the tab itself.
- Settings values (models, keys, themes, memory mode). `open_view` can take
  the user to the section; it cannot change it.

## Where

| Piece | File |
| --- | --- |
| Definitions and executors | `src/lib/chatTools.ts` |
| Permissions | `src/lib/toolPermissions.ts` |
| Prompt lines (gated per tool) | `src/lib/buildChatSystemPrompt.ts` |
| Navigation | `src/lib/appNav.ts`, `WikiPanel.tsx`, `ChatPanel.tsx`, `ChatContext.tsx` |
| Tests | `src/test/notebookAgentTools.test.ts` |
