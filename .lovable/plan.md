Fix the Voice page hands-free transcription without removing any existing functionality.

Plan:
1. Replace the current cumulative transcript handling with an idempotent buffer that overwrites corrected speech chunks instead of appending them.
2. Reset that buffer cleanly on every hands-free recognition session boundary so auto-restarts do not carry stale text forward.
3. Submit only the current stable phrase once, with a duplicate-send guard to prevent repeated submissions.
4. Keep interim text visible while speaking, but make it display the latest corrected transcript instead of stacked duplicates.
5. Leave all existing Voice features intact: hands-free mode, push-to-talk, TTS, collapsed controls, chat history, Deep Research, notes, wiki/save behavior, settings, and mobile layout.
6. Validate the edited flow by checking the relevant code path so the fix is applied only to transcription behavior.