# Multiple Images Per Chat Turn

## What's already in place
The chat already supports rendering multiple images per assistant message — `ChatPanel` maps over `msg.images` in a flex-wrap grid, and `ChatContext` accumulates `turnImages` across every tool call in a turn. The plumbing works; what's missing is that the model almost never produces more than one image because (a) the system prompt frames `generate_image` as a single-image action and (b) there's no first-class way to ask for a batch in one call.

## What's actually limiting it
- `buildChatSystemPrompt.ts` describes `generate_image` as creating "an AI image" — no mention of parallel calls or batches, and a cost warning that discourages multiples.
- `generate_image` tool schema (in `chatTools.ts`) accepts a single prompt, no `count`/`variations` field.
- The UI grid works but hasn't been tuned for 3–6 images (sizing can get awkward on mobile).

## Changes (frontend + prompt only, no backend/schema changes)

### 1. `src/lib/chatTools.ts` — extend `generate_image`
- Add two optional parameters to the tool schema:
  - `count` (integer, 1–4, default 1) — number of variations to produce from the same prompt.
  - `prompts` (string[], max 4) — alternative to `prompt` for generating a *set* of distinct images in one call (e.g. "logo in red", "logo in blue", "logo in green").
- In the executor (`case "generate_image"`):
  - Normalize inputs into a list of prompts (`prompts` wins; else repeat `prompt` × `count`; cap at 4).
  - Run `generateImage(...)` calls in parallel with `Promise.allSettled`.
  - Store/save each result the same way the single-image path does today.
  - Return `__images: ChatImageRef[]` with all successful results (current code already accumulates these into `turnImages`).
  - Return a model-visible result summarizing successes/failures so the assistant can describe what it made.
- `edit_image` stays single-image (variations of an edit aren't a common ask; can revisit).

### 2. `src/lib/buildChatSystemPrompt.ts` — guidance update
Update the Images section to:
- State that `generate_image` may be called with `count` (1–4) for variations of the same prompt, or with `prompts: [...]` for a distinct set in one call.
- Clarify that the model may also issue several `generate_image` tool calls in parallel within a single turn when the user asks for a varied series (e.g. "show me 3 different cover concepts", "draw the main character in 4 outfits").
- Keep the cost reminder, but reframe: "each image costs a few cents, so match the count to what the user asked for — don't pad."

### 3. `src/components/ChatPanel.tsx` — multi-image layout polish
Current grid: `flex flex-wrap gap-3 mb-2` with each `GeneratedImage` sized by `max-h-80`.
- Switch to a responsive CSS grid that scales nicely from 1 to 6 images:
  - 1 image → single column, full width.
  - 2 → 2-up.
  - 3–4 → 2 columns on mobile, up to 2–3 on desktop.
  - Use `grid-cols-1 sm:grid-cols-2` with `auto-rows-fr` and let `GeneratedImage` fill its cell.
- Update `GeneratedImage` to accept an optional `fill` mode so grid cells render uniformly (object-cover, fixed aspect) without breaking the existing single-image use elsewhere (neuron detail gallery).

### 4. No changes needed
- `ChatContext` turn-image accumulation already handles N tool calls per turn.
- `image_attachments` table, storage bucket, and signed-URL caching already scale.
- `chat_messages.images` already stores an array.

## Technical notes
- Parallelizing `generateImage` calls hits the user's OpenRouter key concurrently — Nano Banana's rate limits are generous, but we cap `count`/`prompts` at 4 to stay safe and to keep cost predictable.
- `Promise.allSettled` ensures one failed variation doesn't lose the others; failures are reported back to the model so it can apologize or retry just the missing ones.
- All image storage/RLS/signed-URL paths are unchanged — each variation is just another row in `image_attachments` exactly like today.

## Out of scope
- Server-side `n=4` via a single Nano Banana call (the gateway helper currently returns one image per request; parallel client calls are simpler and equivalent).
- Image-grid lightbox / carousel viewer (can be a follow-up if the user wants it).
