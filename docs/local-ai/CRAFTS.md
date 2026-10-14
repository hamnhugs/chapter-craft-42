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

## Working in PhotoCraft without painting over things (2026-10-13)

Why: docs/local-ai/PHOTOCRAFT-AI-FINDINGS.md (the user's purple-cat session).

- **One window per app.** Opens are queued per app. A window that's still starting
  is waited for instead of launched again. A window started some other way, without
  the control port, gets reported instead of having a second copy opened beside it.
  The menu launchers (`crafts/bin/<app>`, written by install-crafts.sh) focus the
  open window and pass it any files through the bridge instead of starting another copy.
- **Pictures come in as layers.** Picture sends now detect the document the window
  already has open; before, they missed it and opened a new tab every time. The open
  window refuses Place Embedded from automation, so the bridge opens the picture in a
  scratch tab, scales it to fit, copies it over with `layer.copyToDocument` and closes the tab.
- **Edits target a layer.** `run`/`send` take `layer` (a name or id). Colour fixes
  and filters with no layer named go to the active layer if it holds picture content,
  otherwise to the topmost picture layer. They never go to the text. `image.adjustments.*` runs as the
  matching adjustment layer, so the photo's pixels stay untouched (`options.bake` opts out).
  New text starts below the text already on the canvas.
- **Every edit returns the layer stack.** It's top first, with `box: {x,y,w,h}`, so the
  model can see where the edit landed without an extra inspect round. Failed steps make
  `ok` false. A guessed command id comes back with `did_you_mean`, the closest real
  commands with their params. Search knows everyday words ("text" → type, "brighter" →
  brightness), and the top 3 hits carry their full param docs.
- **Asking.** The tool card says to just do clear, undoable asks; to ask one short
  question with 2-4 choices when the layer is unclear or it's a matter of taste; and
  to always ask before merge, flatten or delete. After an edit the model says what
  changed and where, then offers 1-2 next ideas.
- **Export from the open window.** The window refuses an explicit `format`, so
  exports name the format by file extension. Before this fix every export failed
  while PhotoCraft was open ("bridge mode saves with the app's current settings").
  It writes a copy, and the document's own file is unchanged.
- **Budget.** A reply that calls craft gets 8 tool rounds instead of 5
  (`CRAFT_TOOL_ITERATIONS`, ChatContext.tsx).

Cat-session eval (`src/test/localCraftEval.test.ts`, Qwen3-4B Q6_K): before the fix,
the user's own session on a cloud model needed "try again" on 3 of 4 requests. After
it, 2 of 3 full sessions pass. Every request finished in one reply, adjustments landed
above the cat and below the text, and nothing opened a new tab. The failed session's
model guessed a wrong command for the font change, then said it had worked.

## Flyers and posters in DesignCraft: parts and looks (2026-10-13, looks 2026-10-14)

Why: the user's Cashflow Quadrant flyer session. "Place the image and add a headline
to the top" needed frames, type sizes, moving the picture down, refitting it and a
cut-off check, all by coordinates, and the turn never finished. Also, the app in the
browser was a 14:49 build that predated both PhotoCraft fixes. Rebuild after
changing `src/` (`scripts/local-up.sh` does it when the code changed).

- **`send` with `role`.** The roles are headline, subhead, image, body, caption and footer.
  The model only says what goes in which part. The bridge (`/compose`, `composeDesign` in
  craft-bridge.mjs) names the frames by role and lays the whole page out again after each edit.
- **`look` designs the page** (2026-10-14). It is one of bold, cinematic, editorial (the
  default), swiss, classic, minimal, split or pop. `send {look}` on its own restyles the
  page. Each look is a designer's recipe: font pairing, type scale, a palette taken from
  the picture, a background, fades, rules and attention-based crops. It lives in
  `scripts/local-ai/design-looks.mjs`, with the research and reasoning in
  [DESIGN-LOOKS.md](DESIGN-LOOKS.md). What a look draws is named `Look <name>` (the
  background, which also records the look) and `Deco …`, and is redrawn on every layout.
  Headlines are sized from the font files' own metrics, then checked against DesignCraft's
  line breaks and re-planned until the two agree.
- **Same role again changes that part.** New text replaces it. With no text, the options
  restyle it (`{color:'#hex', size, font, align}`). These hand-set values are kept in the
  frame's name (`Headline · color #E63946`) and every later look respects them. A colour
  is lightened or darkened just enough to read on its background. A font that isn't
  installed is ignored, with a note. An image with `{replace:true}` goes into the
  existing picture frame.
- **No role.** A library picture is an image. Short text becomes the headline, then
  the subhead, then body. Text over 1,200 characters and `chapter_id` still flow
  across threaded pages, as before.
- **Every page edit returns** `look`, `items` (role, id, box, text, top first),
  `other_looks` and `issues`: cut-off text, type off the page, type colliding, type on a
  picture without a fade, and low contrast.
- **`open` with `options.preset`** ('Letter', 'A4', 'Tabloid', 'Poster' 18×24 in,
  'Square', 'Story' 9:16, 'Instagram' 4:5, 'Book' 6×9 in, or `width`+`height`) starts a
  new page in one call.
- The card says to write wording (headlines) from the book in context. "Make it look
  better" is no longer a reason to ask: the model picks a look.
- **Small-model slips handled** (Qwen3-4B, 2026-10-14):
  - a headline role with a picture but no text returns an error asking for the words (it
    acts on an error, not on a hint);
  - `run` on `layer: "headline"` with a colour becomes a restyle of that part;
  - a part named in `layer` instead of `role` is treated as that role;
  - `role: "page"` with a look is a restyle;
  - when a call carries a look, the model's own size, font and align in the same call are
    ignored ("48pt Impact" would undo the design), but its colour still goes through.

Eval (`src/test/localDesignEval.test.ts`): the session is replayed through a real model
on a **private headless bridge** (`CC_CRAFTS_HEADLESS=1 CC_CRAFTS_PORT=8799 CC_DESIGNCRAFT_PORT=7999`),
so the user's window is never driven. Without `CC_CRAFTS_HEADLESS=1`, a model's `open`
starts a visible window. Six turns: page size, picture + headline on top, red headline,
title and author at the bottom, "make it look amazing, like a pro designer made it" (must
act, not ask), and "now try it as a movie poster" (must end up cinematic). After each
turn it checks the page for cut-off text, items off the page, overlaps and colour on a
text frame's box. Looks are excluded from these checks, and so is cinematic type on its
faded photo. Results: `results/2026-10-13-designcraft-flyer.txt` (parts) and
`results/2026-10-14-design-looks.txt` (looks: Qwen3-4B 6/6).

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
# The user's cat session through a real model (close the PhotoCraft window first; runs headless):
CRAFT_EVAL_IMAGE=<a png in crafts/workspace/in> LIVE_CRAFT_EVAL=1 npx vitest run src/test/localCraftEval.test.ts
```

## Troubleshooting

| Symptom | Check |
|---|---|
| "craft bridge isn't running" | `.local-state/logs/crafts.log`, then `scripts/local-up.sh` |
| "isn't installed" | `scripts/local-ai/install-crafts.sh` |
| Edits don't show in the window | The window was opened some other way (e.g. an old AppImage). Close it and open the app from the menu, or let Counsel open it. |
| Two PhotoCraft windows | Close both and open it once from the menu (or let Counsel open it). The launcher and the bridge reuse an open window from then on. |
| "already open, but not in a way Chapter Craft can drive" | That window was started without the control port (an old AppImage or a stale menu entry). Close it and re-run `scripts/local-ai/install-crafts.sh` to rewrite the launchers. |
| Files dropped on PhotoCraft don't open | Wayland has no drag-and-drop in these apps yet. Use File › Open, or send it from the chat. |
