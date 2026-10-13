# Creative apps: PhotoCraft, DesignCraft, FilmCraft

Counsel can drive three open-source desktop apps from
[github.com/storytold](https://github.com/storytold) and move work between them
and the library. Everything runs on this computer.

| App | Like | Good for |
|---|---|---|
| PhotoCraft | Photoshop | photos, layers, filters, type, retouching |
| DesignCraft | InDesign | page layout, posters, books → PDF / EPUB / IDML |
| FilmCraft | Premiere Pro | timelines, titles, captions → MP4 / GIF / WAV |

## Install / update

```bash
scripts/local-ai/install-crafts.sh     # newest releases, checksum-verified (~650 MB unpacked)
```

It unpacks each Linux AppImage into `~/.local/share/chapter-craft-local/crafts/<app>`
and replaces the apps' menu entries with launchers that open them with their
control port. A window opened from the menu can then be driven from the chat.
Re-run it to update. `scripts/local-up.sh` starts the bridge whenever the apps are installed.

## How it fits together

```
chat (craft tool, src/lib/craftApps.ts)
  → /local/crafts            same-origin proxy (vite.config.ts)
  → craft bridge :8773       scripts/local-ai/craft-bridge.mjs
  → <app>-cli mcp            each app's own MCP server
       live      when the window is open (control ports 7878 / 7979 / 9876)
       headless  otherwise: an engine session that keeps its document between calls
```

- **One tool, `craft`, with an action.** Its actions are status, open, find_commands,
  run, inspect, preview, send, export, transfer, app_tools and call. The apps
  have about 2,300 commands between them. `find_commands` searches an app's
  catalog and `run` executes any command by id, so every menu feature can be
  reached. `app_tools` / `call` reach the raw MCP tools, which include pointer
  input, dialogs and screenshots. It's one tool because the roster is at its
  budget (`toolRosterBudget.test.ts`).
- **Moving things.** `send` takes a library `image_id`, a `chapter_id` or `text`.
  `open` takes the same content. A chapter goes into DesignCraft as a text file
  placed with autoflow, so it gets as many threaded pages as it needs.
  Pictures go into FilmCraft at the end of the timeline, scaled to the frame.
  `export` brings pictures back into the image library and shows them in the
  chat. A PDF or EPUB can go on the bookshelf (`to_library`). Other formats stay
  in the workspace. `transfer` moves one app's work straight into another.
- **Workspace.** `~/.local/share/chapter-craft-local/crafts/workspace` holds
  `in/` and `out/`. Every file passes through it, and it's PhotoCraft's
  automation root, so PhotoCraft can't reach anything else.
- **Who can call the bridge.** It serves only requests carrying the
  `X-Chapter-Craft` header from the app's own origin. A web page can't add that
  header cross-origin without a preflight, which the bridge never approves.
  PhotoCraft's control port is token-protected (`crafts/.state/photocraft.token`).
  DesignCraft's and FilmCraft's ports accept loopback connections only.
- **Permission.** Settings → AI permissions → Creative apps.

## Measurements (2026-10-13, Qwen3-4B Q6_K)

- Roster: the tool card ranks in the top 3 for 10 of 12 everyday requests.
  These include "crop this image to a square" and "make a book trailer video".
  Naming an app ("in Photoshop", "DesignCraft") always adds it (`LOCAL_NAMED_TOOLS`).
  `find_tools` now names an already-offered tool that fits instead of handing
  over the next-best one.
- Calls with an app already in use: blur, adding text and exporting were each
  6/6. Opening the fox in PhotoCraft, PDF to the bookshelf and PhotoCraft →
  FilmCraft were each 6/6. Running a found command was 6/6.
- Cold starts take an extra step. "Lay out the chapter in DesignCraft" opens
  the book first, then calls `craft open` with the chapter (4/4 end correctly).
  "Add a title in FilmCraft" acts about half the time and asks for details otherwise.
- Small-model slips are read for what they meant (`resolveAction`): `run` with
  only a query becomes a search, and an invented action carrying content becomes a send.

## Tests

```bash
npx vitest run src/test/craftApps.test.ts src/test/craftBridge.test.ts src/test/localRosterNamed.test.ts
LIVE_CRAFTS=1 npx vitest run src/test/localCraftLive.test.ts   # needs the app up and the apps installed
```

## Troubleshooting

| Symptom | Check |
|---|---|
| "craft bridge isn't running" | `.local-state/logs/crafts.log`, then `scripts/local-up.sh` |
| "isn't installed" | `scripts/local-ai/install-crafts.sh` |
| Edits don't show in the window | The window was opened some other way (e.g. an old AppImage). Close it and open the app from the menu, or let Counsel open it. |
| Files dropped on PhotoCraft don't open | Wayland has no drag-and-drop in these apps yet. Use File › Open, or send it from the chat. |
