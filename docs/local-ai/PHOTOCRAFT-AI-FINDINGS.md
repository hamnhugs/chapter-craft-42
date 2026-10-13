# PhotoCraft chat AI: why it paints over work, needs retries, and never asks (2026-10-13)

**Status: fixed 2026-10-13.** What changed and how it was measured: docs/local-ai/CRAFTS.md ›
"Working in PhotoCraft without painting over things". There was one more cause, found while
fixing Bug 1: the open window refuses Place Embedded from automation, so a picture
couldn't come in as a layer at all. Pictures are now copied across with
layer.copyToDocument. Duplicate windows came from unguarded launches: concurrent opens,
a menu launch while the window was open, and a window started without the control port.

Evidence: the user's real Counsel chat (chat_messages, 2026-10-13 22:22–22:30 UTC, the purple cat
session) plus the live PhotoCraft window, read through the bridge (`/call session_list`, read-only).

## What went wrong in that session

| User asked | What happened | Cause |
|---|---|---|
| "place the purple cat image … to layer 1" | Cat opened as a **new document tab** (3rd copy; 4 tabs now open). Out of steps, asked user to say "continue". | Bug 1 + Bug 3 |
| "add a funny headline to layer 1" | Spent all 5 rounds on find_commands/app_tools/command_list; nothing done. "try again" worked. | Bug 3 |
| "adjust the image settings to make it look better" | 1st try: out of steps. 2nd try: Brightness/Contrast + Vibrance created **above the Headline and clipped to the Headline**, so they change the text, not the cat. Ran out of steps before fixing. | Bug 2 + Bug 3 |
| (all) | Never asked "which layer?" / "what kind of better?"; only "asked" when it had run out of steps. | Bug 4 |

Live stack after the session (top→bottom): Vibrance 1 (clipped) · Brightness/Contrast 1 (clipped) ·
Headline (Type) · Layer 1 (empty) · Layer 0 (cat).

## Root causes

1. **Image always opens as a new document when the window is open.**
   `scripts/local-ai/craft-bridge.mjs` `photoDocs()` reads `r.json.documents`, but in live mode
   PhotoCraft's `session_list` returns `ui.inspect`, where the list is at `session.documents`.
   So it always counts 0 → `doc_open` (new tab) instead of `doc_place` (new layer).
   Fix: read `json.documents ?? json.session?.documents`; add a bridge test with the live shape.

2. **New things are stacked on top of whatever is active, never targeted.**
   PhotoCraft (like Photoshop) inserts new layers above the *active* layer, and clipping clips to
   the layer directly below. The tool gives the model no "target layer" notion, so adjustments meant
   for the photo land above (and clip to) the last thing it made. Text is always placed in the same
   padded box at the top-left (`importText`), so repeated text overlaps.
   Fix: a `layer` option (name or id) on send/run that the bridge resolves to `layer.select` before the
   steps, and for adjustments selects the target pixel layer first so the new layer sits directly above
   it. Return a compact layer stack (id, name, kind, clipped, bounds) after every change so the model
   sees where things went.

3. **5 tool rounds per reply, and 3–4 go to discovery.**
   `TOOL_ROUNDS_PER_REPLY = 5` (src/lib/deepResearchPrompt.ts, used by ChatContext). A typical PhotoCraft
   edit costs status → inspect → find_commands (often 2–3 phrasings) → app_tools → run. The model also
   re-discovers the same commands every turn.
   Fixes, cheapest first:
   - Built-in recipes in the tool card for the top ~10 asks with exact ids/params (new layer, text,
     font change, place image as layer, brightness/contrast, vibrance, auto tone, crop, blur, remove bg),
     so common asks are 1 round: `run`.
   - `find_commands` returns the params schema of the top hits (it already ranks), so no `app_tools`/
     `command_list` round is needed; let `run` accept a `query` + params and resolve the best id itself.
   - Every successful `run`/`send` returns the updated layer stack, removing the separate `inspect` round.
   - Optionally give craft turns 8 rounds instead of 5.

4. **The tool card tells it not to ask.**
   `CRAFT_TOOL_DEFINITION.description` (src/lib/craftApps.ts) says "Act on sensible defaults; don't ask
   first." That line was added for the cold-start evals ("Add a title in FilmCraft" asked half the time),
   and it also suppresses the questions that matter.
   Research says models already lean toward guessing rather than asking; the fix is a *rule for when* to
   ask, not "always" or "never" (Clarify When Necessary, NAACL 2025 Findings; Bayesian experimental
   design for task ambiguity, arXiv 2502.04485; CRAC 2025: LLMs ask about *which thing* more readily
   than about *what outcome*).
   Proposed rule, in the card:
   - **Just do it** when the ask is reversible and has one obvious reading (blur, crop to square,
     new layer, change font).
   - **Ask one short question with 2–4 choices** when it's ambiguous about *which layer/object* (more
     than one plausible target) or *taste* ("make it look better", "funny headline") — and offer the
     options as concrete suggestions, e.g. "Brighter & punchier / warmer / moody / black & white?",
     with a recommended default the user can accept with one word.
   - **Always ask first** before anything that changes or merges existing pixels (rasterize, merge,
     delete, flatten, destructive filters on a non-empty layer). Prefer adjustment/new layers.
   - After every change, one line saying what changed and on which layer, plus 1–2 next suggestions.
   Adobe's Photoshop AI Assistant (beta) follows the same "suggest, then apply" shape and puts
   generated edits on separate layers, leaving the original untouched.

## Suggested order of work

1. Bug 1 (`photoDocs`): one-line fix + test. Stops the duplicate tabs.
2. Tool-card rewrite (ask rule + top recipes), re-run `localCraftLive` evals and the 4-request cat
   session as a new eval case (expected: each ask done in one reply, adjustments clipped to the cat).
3. Layer targeting + layer stack in results (bridge).
4. `find_commands` returns params / `run` by query; consider 8 rounds for craft turns.

## Sources
- Clarify When Necessary (NAACL 2025 Findings): https://papers.cool/venue/2025.findings-naacl.306@ACL
- Task-ambiguity clarification as Bayesian experimental design: https://arxiv.org/abs/2502.04485
- Modeling future turns to teach clarifying questions: https://arxiv.org/html/2410.13788v2
- Referential ambiguity, humans vs. LLMs (CRAC 2025): https://aclanthology.org/2025.crac-1.1.pdf
- Adobe: Edit images with AI Assistant: https://helpx.adobe.com/photoshop/desktop/get-started/set-up-toolbars-panels/edit-images-with-ai-assistant.html
- Over-tooled agents / tool filtering: https://tianpan.co/blog/2026/04/19/over-tooled-agent-problem
