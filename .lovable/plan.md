## What you'll get

1. **Multiple saved system prompts** (a "Prompt Library") usable in both Chat and Voice — keeps the current single-prompt feature working.
2. **Independent Deep Research toggles** for Chat and Voice (today they share one switch — toggling in Voice also flips Chat).
3. **Mic button in the Chat tab** — same browser speech recognition the Voice tab uses, so you can dictate messages in regular Chat too.
4. **Cleaner Voice mobile controls** — current expanded panel wraps awkwardly on phones; we'll group buttons into a tidy 2-row layout with the mic as a clear primary action.

Nothing existing is removed — the current custom prompt, current Deep Research, current Voice features all stay.

---

## 1. Prompt Library (multiple system prompts)

**Behavior**
- New "Prompts" section in both Chat and Voice settings drawers.
- Save any number of named presets (e.g. *Literary Critic*, *Study Buddy*, *Plain Summary*).
- One preset can be marked **Active** — it's what gets prepended to every reply (replaces today's single `customSystemPrompt` slot).
- "Active" can also be set to *None* (no custom prompt) — same as clearing today.
- Each preset: name + body + optional "use in Voice / use in Chat" scope toggles (default both).
- Quick "Active prompt: …" chip near the Deep Research toggle, so you can switch presets without opening settings.

**Migration of your existing prompt**
- On first load, if `custom_system_prompt` is non-empty, we auto-create a preset named "My Prompt" containing it and mark it active. Zero data loss.

**Where it's stored**
- New table `prompt_presets` (per-user, RLS scoped to `auth.uid()`), columns: `id, user_id, name, body, scope ('both'|'chat'|'voice'), is_active, created_at, updated_at`.
- Only one row per user has `is_active = true` (enforced by a partial unique index).
- `buildChatSystemPrompt.ts` reads the active preset (filtered by current scope) instead of the single string.

## 2. Independent Deep Research per tab

- `ChatContext` currently exposes one `deepResearch` boolean used by both Chat and Voice.
- Split into `chatDeepResearch` and `voiceDeepResearch`, each persisted to `localStorage` so they survive reloads.
- `sendMessage` takes a `source: 'chat' | 'voice'` (or reads from a small context flag set by whichever panel is mounted) and picks the right flag → no more cross-tab flip.
- Both UIs keep their existing Deep Research button; the wiring just stops sharing state.

## 3. Mic button in Chat

- Add a mic button inside the Chat input bar (left of Send).
- Uses the same `window.SpeechRecognition` / `webkitSpeechRecognition` flow already in `VoiceChat.tsx`, extracted into a small shared hook `useSpeechDictation` so both tabs use one implementation.
- Tap to start (red pulsing while listening), tap again to stop. Interim transcript fills the textarea live; final transcript stays editable before you press Send.
- Unsupported browser (e.g. iOS Safari for some cases) → button is hidden with a tooltip "Voice input not supported in this browser" — does not break Chat.
- No auto-send; Chat stays text-first. (Voice tab's auto-send-on-silence behavior is unchanged.)

## 4. Voice tab mobile controls cleanup

Today the expanded panel renders 7 buttons via `flex-wrap` which on a 484px viewport scrambles into 3 messy rows with the big mic in the middle.

New layout (mobile-first, ≥640px keeps current single-row feel):

```text
┌──────────────────────────────────────────┐
│              ●  Big Mic  ●               │   ← primary action, centered, 88px
├──────────────────────────────────────────┤
│  [Hands-free]   [Deep Research]   [TTS]  │   ← row of toggles
├──────────────────────────────────────────┤
│  [Notes]  [Save Wiki]  [Clear]  [Tune]   │   ← row of secondary actions
└──────────────────────────────────────────┘
```

- Uses a 3-column grid on mobile (`grid-cols-3 gap-2`) so buttons line up instead of wrapping mid-row.
- Mic gets its own full-width row above the toggles — easier thumb target, no longer crowded by chips.
- Toggle buttons get short labels on mobile (icon + 1-word label), full labels on `sm:` up.
- Settings ("Tune") and Clear move into the secondary row so they don't compete with the mic.
- Existing collapsed-state mini-mic on the right stays exactly as-is.

## Out of scope

- No change to how Deep Research picks its model (still `deepResearchModel` from settings).
- No change to Burplexity `web_search` tool.
- No new backend functions; prompt presets are a plain table.

## Technical notes

- **Migration**: create `public.prompt_presets` with RLS (`select/insert/update/delete using auth.uid() = user_id`), `updated_at` trigger, partial unique index `where is_active`. Backfill from `user_settings.custom_system_prompt` for each user on first read in `useChatSettings` (client-side, idempotent).
- **`useChatSettings.ts`**: add `prompts: PromptPreset[]`, `activePromptId`, `savePrompt`, `deletePrompt`, `setActivePrompt`. Keep `customSystemPrompt` getter as a derived value (active preset body filtered by scope) so `buildChatSystemPrompt` keeps working with one-line change.
- **`ChatContext.tsx`**: split state into `chatDeepResearch` / `voiceDeepResearch`; expose both plus setters. `sendMessage(text, { source })` reads the matching flag.
- **New hook `src/hooks/useSpeechDictation.ts`**: extracts `buildRecognition` + start/stop from `VoiceChat.tsx`. Voice tab refactored to use it (no behavior change). Chat tab consumes it for the mic button.
- **`ChatPanel.tsx`**: add mic button + Prompt Library section in settings (preset list, Add/Edit/Delete, active radio, scope checkboxes).
- **`VoiceChat.tsx`**: refactor controls panel to grid layout described above, add Prompt Library section in settings drawer (same component as Chat).
