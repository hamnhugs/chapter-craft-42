# Voice mode overhaul + hard sentence cap

Shipped 2026-07-29 on `new1`. Fixes the two hands-free defects (mic opening
over live TTS; TTS restarting when hands-free is toggled off) and adds a
user-configurable hard cap on sentences per assistant reply.

## Applying the migration

One idempotent, additive migration persists the new setting across devices:

> Please run the repo migration `supabase/migrations/20260729000000_response_length.sql`
> exactly as written, without modifications. It is idempotent and additive
> (one `ADD COLUMN IF NOT EXISTS` on `user_settings`).

Paste that into Lovable's chat (or run the file in the SQL editor). Until it
is applied, the cap still works — it just resets on reload instead of
persisting (the `optionalColumns` retry in `useChatSettings` keeps settings
saves working either way).

## What changed and why

### Hands-free never hears itself (useReadAloud + useHandsFree)

The old design resolved "done speaking" from a text-length estimate,
`min(90s, 4s + chars×90ms)` — any reply needing more than 90 seconds of audio
flipped the FSM to listening mid-playback, and the mic transcribed the
assistant (Chrome's echo cancellation does not cover the page's own playback;
Web Speech recognition has none we control).

New contract — **every `speak()` session settles `onDone` exactly once** with
a reason: `ended` (natural), `stopped` (stop()), `superseded` (newer speak),
`error` (autoplay-blocked / stalled). Real playout events are the signals
(final chunk `ended`, final utterance `onend`, plus an idle-engine poll for
Chrome's dropped-onend bug, Chromium 41346274). A heartbeat watchdog
(`timeupdate`/`onboundary`/chunk events; 12s no-progress) reaps only genuinely
stuck sessions — it measures progress, never total duration, so audio may play
arbitrarily long.

The FSM transitions out of `speaking` ONLY on `onDone`, and the recognizer
refuses to open while `isAudioActive()` (live session, busy speechSynthesis —
including the PDF reader — or an unpaused audio element), deferring in 300ms
steps with a 20s valve. Transcripts arriving outside `listening` are dropped.

### Toggle-off never replays (ChatPanel)

The auto-read effect now records `lastId` unconditionally — before the
hands-free guard — so a reply spoken by hands-free is marked consumed and can
never be re-spoken when `handsFree.active` flips. Toggling hands-free OFF
closes the mic but lets the current reply finish (the Gemini/ChatGPT
convention); the per-message speaker button and Read Aloud toggle still stop
audio on demand.

### Barge-in: detect → verify → recover (useHandsFree)

On a VAD trigger the TTS is PAUSED in place (not killed) and the mic opens to
verify: a real utterance commits the interruption and becomes the next turn;
silence/a cough RESUMES from the pause point. The VAD stream requests Chrome
141's `echoCancellationMode: "all"` (ignored by older browsers) so speaker
output stops self-triggering it. Chrome 139+ on-device recognition
(`processLocally`) is used when the language pack is already available.

### Hard sentence cap (Settings → Prompts)

`user_settings.max_reply_sentences` (0 = off, presets Off/2/4/8, custom 1–12).
Three enforcement layers, each covering the others' failure modes:

1. **Steer** — "Respond in at most N sentences." injected at the very END of
   the system prompt (recency position), re-sent every request.
2. **Enforce** — `src/lib/sentenceCap.ts` counts sentences on the cumulative
   streamed text (Intl.Segmenter, markdown-aware: code fences count zero, a
   list item counts one; streaming mode ignores the growing tail).
3. **Freeze & drain** — at the boundary the prose is frozen (beyond-cap
   deltas discarded) but the stream keeps draining, because models narrate
   BEFORE emitting tool calls — cancelling at the cut would silently kill the
   action the narration promised. If ~40 prose deltas arrive after the cut
   with zero tool activity, the stream is cancelled (provably prose-only —
   stop paying). Everything flows through the NORMAL completion path (never
   `abort()`, which skips persistence and the rolling summary), so the capped
   text is what gets persisted, synced, summarized, and spoken. The cap
   applies per prose segment (per tool round), so a capped pre-tool narration
   never swallows the post-tool answer. Digest passes `capExempt`; Deep
   Research turns are exempt.

Also: the previously dead `hands_free_tts_rate` column is now live — a
separate "Hands-Free Speech Speed" slider in Settings → Voice & Speech
(read-aloud buttons keep using `tts_rate`).

## Adversarial review

A multi-agent review (3 hunters × 2 skeptics per finding) ran before ship and
surfaced 8 real defects, all fixed pre-commit: a dead 20s mic-deferral valve;
a tab-switch deadlock during barge-in verification; stale-turn revival after
toggling hands-free off→on while thinking (fixed with a generation token);
the cap cancelling pending tool calls (fixed with freeze-and-drain); a
mid-sentence cut on colon-terminated deltas; missing CJK terminals; a
speechSynthesis engine left permanently paused after a barge-in commit; and
a blob-URL leak on mid-chunk termination.

## Known limitations

- Sentence counts can differ ±1 across engines (ICU suppression data varies —
  "Dr. Smith" may split on some); cuts always land on real boundaries.
- speechSynthesis pause/resume (browser-voice barge-in verification) is
  unreliable on Android; barge-in remains desktop-oriented and off by default.
- The deployed knowledge edge functions and realtime are untouched — nothing
  in this change needs a Lovable function redeploy.
