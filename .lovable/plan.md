# Fix repeating words in Chat dictation

## Problem
The mic in the Chat tab transcribes like:
> "please please do please do some please do some deep…"

Each new word causes the entire phrase so far to be re-appended.

## Root cause
`useDictation` accumulates final results incrementally:
```
for (let i = e.resultIndex; i < e.results.length; i++) { ... finalStr += t }
```
On Chrome (especially Android/mobile), `SpeechRecognition` often re-emits the full results array with `resultIndex = 0` and previously-finalized segments included again. Appending from `resultIndex` then double-counts every finalized chunk, producing the staircase repetition seen above.

## Fix
Rebuild the final + interim strings from scratch on every `onresult` event by scanning all `e.results` (not from `resultIndex`), so the transcript always reflects the engine's current truth instead of an ever-growing append log.

## Files to change
- `src/hooks/useDictation.ts` — replace the incremental accumulator in `rec.onresult` with a full-scan rebuild; keep `finalRef` as the snapshot used by `onend` / `onFinal`.

## Out of scope
No UI changes, no changes to Voice tab, prompt library, or deep-research wiring.
