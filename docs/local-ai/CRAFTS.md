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
  run, inspect, preview, send, pages, export, transfer, save_template, use_template, app_tools and call. The apps
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
  `looks` and `issues`: cut-off text, type off the page, type colliding, type on a
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

## Templates, and selecting for the AI (2026-10-14)

**Templates.** "Save this design as a template called Movie Night" stores one page in
`crafts/workspace/templates/<slug>/` (`scripts/local-ai/design-templates.mjs`):
- `template.designcraft` is DesignCraft's own file (`file.serialize`). Its pictures are
  embedded, so it reopens exactly: fonts, gradients, effects, positions.
- `thumb.png` is a screenshot of the page (`render_page`). It is shown in the chat when
  the template is saved.
- `manifest.json` lists the slots (which frame is the headline, picture, body…), the
  type size each was designed at, and the page size. Frames the bridge named keep their
  role. On a hand-made page the roles are guessed the way a reader takes the page in:
  the biggest short type is the headline, small type on the bottom strip is the footer,
  short italic type under a picture is the caption, the next-biggest short line is the
  subhead, and the rest is body.

`use_template` opens that file as a new document (a new tab in the window) and keeps
only the template's page. It names the slots by role, marked `· template` while they
still hold the template's own words or picture, and adds a hidden `Template <slug>`
marker. New parts then go into the slots (`fitTemplate` in craft-bridge.mjs). Frames
stay where the designer put them. Text starts at the size the template designed it at
and steps down only when it wouldn't fit. A new picture fills the first slot still
holding the template's picture, cropped toward the subject. A part the template has no
frame for goes into the free band its role belongs in, styled like the template's
nearest text. A `look` on a template page replaces the template's design. Craft
actions: `save_template` (title) and `use_template` (title; none lists them and shows the picker;
`options.delete` deletes one). Bridge: `/template/save|use|list|delete`,
`GET /template/thumb?slug=`.

**Selecting for the AI** (replaced the design studio panel, 2026-10-14; the user found
a panel too limiting). Click an item in the DesignCraft window, shift-click several, or
highlight words inside a frame, then ask in the chat ("make this bigger and blue",
"make these red", "change this to …").
- `designSelectionNote` (craftApps.ts) reads the window's selection through
  `/design/selection`. It has a 1.5 s cap and only reads an open window; it never starts
  a headless session (test bridges with `CC_CRAFTS_HEADLESS=1` read theirs).
- ChatPanel appends the note visibly to the message, like an @mention note:
  `[Selected in DesignCraft — the user clicked this; …: headline (id 11) "Plan to Win".
  To change it: craft send with ids [11] and text, image_id or options (…).]`
- The bridge acts on the selection (`editSelection`) when a send carries `ids`, or has
  only style options and no role, text, picture or look. It also does so when a send has
  text but no role and exactly one text frame is selected.
- What it does:
  - new words go into a selected text frame and a picture into a selected picture frame;
  - colour, size, font and alignment go onto each item; size understands
    'bigger'/'smaller'/'+20%' (`resolveSize`);
  - on a page part the change is kept in its name, so looks keep it;
  - highlighted words get the change on just those words.
- `ids` is deliberately not a declared tool parameter. Declaring it, even as the last
  property, flipped Qwen3-4B from "send picture + headline" to "open picture only" in 7
  of 7 runs. The note teaches it instead, and composePart honours `ids` when sent.

**"Done!" with nothing done** (ChatContext, `claimsUnmadeDesignEdit` in chatHistory.ts).
This is the user's main complaint: a reply that says the page changed, says "let me…"
and stops, or says nothing at all, with no craft call this turn, for a request to change
a DesignCraft page. Such a reply gets one app note ("nothing changed in DesignCraft … call
the craft tool now", with the selection's ids) and one more round, with craft added to a
local roster if it was missing. Questions back to the user and requests for ideas or
advice are left alone. If it still doesn't call, the reply carries a failed "Nothing was
changed in DesignCraft" event. It works the same way as the fabricated-picture check.

Eval (`localDesignEval.test.ts`, now 8 turns, including "save this design as a
template called Movie Night" and "use the Movie Night template to make a poster for
our book club's film night"): Qwen3-4B passed 5/6. In every session that reached them,
the template turns saved the template, opened a new document from it and wrote a new
headline into it. After opening, the result carries a spelled-out `next` call. Without
it, 4/4 sessions left the template's old words on the page. The model usually replaces
only the headline. The other placeholders stay listed in each page result. The
one failure was "movie poster" answered with bold on a page that was already cinematic.

## Save as Template from the DesignCraft window, pick from the chat (2026-10-14)

**In DesignCraft.** Every page in the Pages panel has a small bookmark button beside it
(and "Save Page as Template…" in its right-click menu). It asks for a name, with the
suggestion selected so typing replaces it, then says "Saved" or what went wrong. The same
name again updates that template.
- The button is a patch on DesignCraft, not part of its release. The source is
  `~/Work/designcraft`, branch `bookworm-templates`: one commit on the release tag,
  `crates/ui-egui/src/panels/save_template.rs`. To build it and put it in place of the
  released binary, run `scripts/local-ai/build-designcraft.sh` (~2–3 min warm, cargo target
  in `~/.cache/designcraft-target`). It keeps the released binary as `designcraft.release`
  and writes `crafts/designcraft/PATCHED` (tag + commit). When `install-crafts.sh` installs
  a new DesignCraft release, it re-runs the build, which rebases the commit onto the new
  tag. If the patch doesn't apply, the app still works, just without the button.
- How the click reaches us: DesignCraft shows the button only when
  `DESIGNCRAFT_TEMPLATE_INBOX` is set. The menu launcher and the bridge's own launch both
  set it to `crafts/.state/template-inbox`. The click writes `<id>.json` `{page, name,
  document}` there. The bridge (`drainTemplateInbox`, polled every 0.6 s) saves it exactly
  like `save_template` and answers with `<id>.result.json` (`{ok, name, replaced}` or
  `{ok:false, error}`). The dialog shows that answer. After 25 s with no answer it says
  Bookworm Studio didn't answer. Test bridges (`CC_CRAFTS_HEADLESS=1`) don't watch the
  inbox; `CC_TEMPLATE_INBOX` moves it.

**In the chat: the template picker** (`TemplatePickerCard.tsx`). A card in the reply shows
each saved template as its screenshot, with its name, size and parts (newest first, a
search box past 6, delete on a second click). Clicking one sends `Use my "<name>"
template.` as the user's next message, and the model then runs `use_template` and fills
the parts as before. The card reads the list live from the bridge. It appears:
- when `craft use_template` is called with no name (the result carries `__templatePicker`
  and tells the model to ask the user to pick there, in one line);
- or when the user's message asks for their saved templates (`wantsTemplatePicker` in
  `src/lib/templatePicker.ts`: "my/saved/our … templates", or templates together with
  DesignCraft/layout) and the reply neither listed nor opened one. A bare "template" (as
  in "a query letter template"), a save request, or a quoted template name doesn't
  trigger it.

Tests: `src/test/templatePicker.test.ts` (trigger + inbox), `templatePickerCard.test.tsx`,
and `cargo test -p designcraft-ui-egui --lib save_template` in the DesignCraft checkout.
To see the button headless, use DesignCraft's `ui_shot` example with
`DESIGNCRAFT_TEMPLATE_INBOX` set (a hidden Hyprland window doesn't present frames, so
`ui.screenshot` goes stale there).

## Copy like the masters, and the `direct` look (2026-10-14)

On a copy or DesignCraft turn, two or three cards from the user's **"Copy & Design
Masters"** neuron ride in the turn context. They cover Whitman, Schwartz, Ogilvy, Hopkins,
Caples, Sugarman, Halbert, Bencivenga, Vögele's dialogue method, Ogilvy's layout and
playbooks for flyers, ads, blurbs and sales letters. A master named in the request comes first. The
neuron is created and seeded on first use. The user can edit any card or add their own,
and edited cards are never overwritten. How it works, who's in it and the sources:
[COPY-CRAFT.md](COPY-CRAFT.md).

DesignCraft gained a ninth look, `direct`: Ogilvy's direct-response ad (picture, selling
caption, serif headline below the picture, body in columns, boxed call to action).
`pickLook` maps "ogilvy", "ad", "advert", "sales", "offer", "coupon" and "response" to it. This changed
the craft tool's `look` enum, so the design eval gained a turn ("turn it into an ad that
sells, like an Ogilvy direct response ad" → look `direct`) and was re-run:
`results/2026-10-14-design-looks.txt`, section "direct look".

## Front and back, many pages, print (2026-10-14)

Why: the user asked for full control of DesignCraft's layout from the chat, "including a
page with front and back printing and multiple pages". DesignCraft already had every page
command (insert, move, duplicate, parents, Document Setup, Print Booklet). The chat couldn't
say which page, had no idea of a front or a back, and exported screen PDFs only.

- **Two-sided documents.** `open {options: {preset, sides: 2}}` makes a document whose pages
  pair into sheets: page 0 is the front, page 1 the back (then front/back of sheet 2…). A
  hidden, locked `Sides 2` item on the first page records it. Two-sided documents get a
  0.125 in (9 pt) bleed. `pages`, `numbers: true`, `landscape` and the sizes Letter, Legal,
  Tabloid, A3–A6, Half Letter, Postcard, Business Card, Card, Tri-fold, Poster, Square,
  Story, Instagram and Book all work on open (`pageSize` in craft-bridge.mjs).
- **`page` on every page edit.** `send` takes `page`: a 0-based index, or the bridge reads
  "front", "back", "last", "next", "page 3" (1-based). One past the end adds that page;
  "back" on a one-page flyer adds the back and makes it two-sided. With no page named, the
  edit goes to the page shown in the window (`ui_inspect` currentPage), else the page the
  chat last worked on. After an edit the window turns to that page.
- **Every page keeps its own design.** Before this, a look always drew its background and
  decorations on the first spread, so designing page 2 wiped page 1 (`applyPlan` now
  creates on, and clears from, the page's own spread). A page with no look of its own takes
  the look of the document's other pages. A page with no picture (the back) takes its
  colours from the document's picture, so both sides look like one piece.
- **Bleed.** On a document with a bleed, what touches the trim (the look's background,
  edge-to-edge bands, pictures) runs out into it after every layout (`bleedSteps`). Text
  never moves, and the spine side of a facing page doesn't bleed.
- **The `pages` action** (DesignCraft only; `/pages` → `pagesOp`). Options: `add` (whole
  sheets on a two-sided document), `delete` (list, or `true` + `page`), `move {from,to}`,
  `duplicate` (the whole sheet when two-sided), `sides`, `preset`/`width`+`height`,
  `landscape`, `facing`, `bleed`, `margins`, `columns`, `gutter`, `numbers`. No options
  gives the overview. A size change re-lays out every designed page. Invented actions
  (`add_page`, `delete_pages`, `duplicate_page`) map to it.
- **Page numbers** are a small frame named `Page number` at the foot of each page holding
  DesignCraft's page-number character (U+E000), so each one counts itself. They aren't on
  the parent page, because a look's full-page background would cover a parent's items.
  They take the font and colour of the page's smallest type, are redrawn after every
  layout, and are added to pages added later.
- **Print export.** `export {format: "pdf", options: {print: true}}` adds the bleed and
  crop marks. A document with a bleed exports that way unless `print: false`.
  `options.pages` (["back"], [0, 1], "1-3") picks pages. `booklet: true` imposes a folded
  saddle-stitch booklet (`file.printBooklet`). The result carries `print_note`: duplex,
  flip on the long edge (short edge for landscape and booklets), trim at the marks. The
  chat passes it on.
- **Templates** of a two-sided page keep both sides; a short multi-page document (≤ 12
  pages, saved from the chat with no page named) keeps all its pages. Slots carry their
  page, `use_template` marks every page, and its `next` names the page of each placeholder.
  The picker card says "front & back" or "N pages".
- **What every page edit returns** on a document of more than one page: `side` ("front",
  "back of sheet 2", "page 3") and `pages`, the overview (side, parts, look, or `empty`).
- **Small-model help** (Qwen3-4B):
  - a send whose options carry `sides`/a size/`pages` sets the document up first. With a
    document open it only makes it two-sided, unless the page count differs ("a 4-page
    newsletter" while a flyer is open), which opens a new document in a new tab;
  - several parts in one call (`pages: [{page, role, text, options:{image_id}}]`, with
    `open: {…}` as the setup) run as one send each, picture first (`partBatch`);
  - a page edit that leaves a page empty, or the front without a picture, returns a
    spelled-out `next` ("Now do it: … send with page 1, role body …"). ChatContext and the
    eval keep that `next` when a later call in the same round fails (an invented action
    used to wipe it). It waits while the first page still has no headline: before that,
    "the image and a headline at the top" sent the headline to the empty back;
  - `{format: "pdf"}` (or `options.print`) with no action is an export.
- The options description is wording-sensitive:
  - "open = new document: {…}" in place of "open: {…} = new document" flipped Qwen3-4B into
    inventing that batch shape in 3 of 3 runs;
  - "sides:2 (front and back)" made it open every flyer two-sided (3 of 3, "open the
    appropriate page size to create a flyer"). It fills in every key the description
    shows, sending {pages:1, sides:2, numbers:true} whether or not two sides were asked
    for. So `sides` and `numbers` now count only when the user's message asks for them
    (`askedOptions`: "both sides", "front and back", "the back", "duplex"… / "page
    numbers"). ChatContext passes the message as `userText` (ToolDeps → CraftDeps). The
    description also now reads "sides:2 only if asked to print both sides".

Eval: `localDesignEval.test.ts`, new session "DesignCraft front and back". Four turns: a
flyer printed on both sides (picture + headline on the front, details on the back), the
website at the bottom of the back, a print-ready PDF, then a 4-page A4 newsletter with page
numbers. `DESIGN_EVAL_FLYER=0` runs only this session and `DESIGN_EVAL_PAGES=0` only the
original one. Results are in `results/2026-10-14-design-pages.txt`. Final run on Qwen3-4B:
front and back passed 3/4 full sessions, and the original flyer session 2/4. Picture + headline
was 4/4; the failures were the selection and Ogilvy turns, which were already flaky.

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
# DesignCraft sessions (flyer, then front-and-back) through a real model on a PRIVATE headless bridge:
CC_CRAFTS_HEADLESS=1 CC_CRAFTS_PORT=8799 CC_DESIGNCRAFT_PORT=7999 CC_TEMPLATES_DIR=$(mktemp -d) node scripts/local-ai/craft-bridge.mjs &
DESIGN_EVAL_IMAGE=<png in crafts/workspace/in> LIVE_DESIGN_EVAL=1 npx vitest run src/test/localDesignEval.test.ts
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
