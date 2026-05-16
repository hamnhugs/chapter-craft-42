# Three small UX fixes

## 1. Easier to close the Chat settings panel

**File:** `src/components/ChatPanel.tsx`

Today the settings panel only has a close (X) button on mobile (inside a `md:hidden` header). On desktop you must scroll back to the "Settings" toggle button in the input bar.

Changes:
- Make the sticky header (with the X close button) visible on all screen sizes — remove `md:hidden`, keep the "Settings" label.
- Add an Escape-key listener while the panel is open that calls `setShowSettings(false)`.
- Add a click-outside handler on the panel container that closes it when the user taps anywhere outside.

No behavior change for the Voice page panel — its existing controls are fine.

## 2. Replay button on bot bubbles in the Voice tab

**File:** `src/components/VoiceChat.tsx`

The Chat tab already has a circular speaker button on each assistant bubble (uses the shared `speak` helper from `src/lib/speak.ts`). The Voice tab has only "Save to voice notes" and long-press, no replay.

Changes:
- Import `speak`, `stopSpeaking`, `subscribeSpeaking`, `getSpeakingId` from `@/lib/speak`.
- Track `speakingId` in local state (mirroring `ChatPanel`).
- On every message bubble (both user and assistant, matching Chat), render a small floating "volume_up / stop_circle" button positioned beside the bubble. Clicking replays via `speak(msg.content, { id, rate: ttsRate })`; clicking again on the same id stops.
- The replay button respects the user's existing `ttsRate` slider. It works even when `ttsEnabled` (auto-speak) is OFF — replay is an explicit user action.
- Keep the existing long-press / "Save to voice notes" affordance unchanged.

## 3. Custom system prompt for the chat (Voice + Chat settings)

The user wants to inject a personal instruction (persona, tone, focus) into every Librarian reply.

### Database

Add a nullable text column to `user_settings`:

```sql
alter table public.user_settings
  add column if not exists custom_system_prompt text;
```

### Settings hook

**File:** `src/hooks/useChatSettings.ts`
- Add `customSystemPrompt: string` to `ChatSettings` (default `""`).
- Load from `data.custom_system_prompt`.
- Save under `custom_system_prompt` in the upsert payload.
- Export `setCustomSystemPrompt`.

### System-prompt builder

**File:** `src/lib/buildChatSystemPrompt.ts`
- Accept `customSystemPrompt?: string` in `BuildOpts`.
- When non-empty, prepend a clearly fenced block at the very top of the system prompt:
  `## User Custom Instructions\n<value>\n` so the model treats it as a primary directive but our tool / memory sections still apply.

### ChatContext

**File:** `src/context/ChatContext.tsx`
- Read `customSystemPrompt` from `useChatSettings()` and pass it through to `buildChatSystemPrompt(...)` everywhere it's called (regular send + voice send).

### UI: Voice settings

**File:** `src/components/VoiceChat.tsx`
- In the existing `{showSettings && (...)}` block, add a full-width section "Custom Instructions" with a `<Textarea>` (3–5 rows), placeholder like *"e.g. Always answer as a no-nonsense literary critic. Reference page numbers."* and a Save button that calls `setCustomSystemPrompt`.

### UI: Chat settings

**File:** `src/components/ChatPanel.tsx`
- Add the same "Custom Instructions" section as a new full-width row inside the existing settings panel (below the voice-playback grid).

## Technical notes

- No edge-function changes — the system prompt is composed client-side.
- `customSystemPrompt` is treated as plain text; we never execute it, we just prepend it to the system message.
- Migration is additive and nullable; existing rows continue to work.
- Replay button reuses the global `speak` singleton so starting one cancels any in-flight playback (consistent with Chat tab).

## Out of scope

- No changes to embedding-model handling, Wiki, or the API-key flow.
- No new model selectors.
