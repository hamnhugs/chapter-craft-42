# Character voices

Built 2026-11-25 on `new1`. In the Read tab's Listen player, each character
speaks in their own Inworld voice; the narrator reads everything else,
"she said" included.

Research behind it: `reports/Character voices for book narration.md` (notes
in `research_notes/Character voices for book narration/`).

## Using it

On by default since 2026-11-25 (Listen → ⋯ → **Character voices** switches it
off). Needs an Inworld voice (it does nothing with the device voice) and a
chat model key.

The first time a character speaks, reading pauses and a prompt asks which
voice they should have (`CastVoicePrompt.tsx`): tap any voice to hear it read
that character's own line, then "Use …". "Pick for me" keeps the suggestion;
"Stop asking, pick them all" (or ⋯ → **Ask me for each voice**) casts
everyone silently. **Cast** in the same menu lists who has spoken, shows
what the casting is doing or why it failed, and lets you change any voice.
"Start the cast over" forgets the book's cast.

It spends one background-model call per page of dialogue and makes more,
shorter voice requests.

## How it works

Worked out just ahead of the voice, not as a batch over the whole book.

1. `castVoices/quotes.ts` finds the quoted spans in the page text, in code.
   Curly, straight, guillemets, German, and British single quotes. Anything
   it cannot pair is left to the narrator.
2. `castVoices/attribute.ts` asks the background model who says each quote.
   The quotes are numbered and the model answers with numbers and names, so
   it never re-emits the book's words. It is given the cast so far and who
   was just talking. "Don't know" is a valid answer and means the narrator.
3. `castVoices/casting.ts` gives each new character a voice from the Inworld
   catalog: gender first, age band second, a voice nobody else has before a
   shared one. No accents. A voice once given is kept.
4. `castVoices/director.ts` runs it live: the page is cut into windows of
   about a page, the window being read and the next are analysed, and the
   player asks for a quote's speaker only when it fetches that line's audio.
   It waits up to 45 seconds for the answer (the reading shows "loading"),
   then the narrator reads the line. Progress is logged as `[cast]` in the
   browser console.
5. `readAlong.ts` `buildVoicedChunks` cuts the reading at every change of
   speaker; `readAlongPlayer.ts` sends each chunk with its voice. A line the
   book says is whispered or shouted carries that as its direction.

The cast and each analysed page's answers are kept per book in this
browser (`bw_cast_<user>_<book>`), so a page heard twice is analysed once
and sounds the same. No server change, no migration, no function redeploy.

## Not verified

Checked live on 2026-11-25 in a signed-in session (Coraline, PDF, British
single quotes): speakers were found in about 2 seconds by
google/gemini-2.5-flash-lite and the mother's lines went to Inworld under a
different voice from the narration. Nobody has yet judged how it sounds, and
the voice prompt has only been tested in code. Also checked: the detection, against local models on
the opening of Pride and Prejudice (16 quotes, mostly untagged): an 8B model
got 16 of 16, a 4B model 11 to 12. Worth listening for:

- the join between narrator and character within one sentence;
- whether a page that opens on dialogue waits noticeably for its first line;
- voices for a large cast once the catalog's distinct ones are used up.

## Not built

- Only the Read tab's Listen player. Counsel's read-aloud, hands-free and
  paper books still use one voice.
- The cast lives in one browser; it does not follow you to another device.
- Dialogue dashes and books with no quotation marks read in one voice.
- Inworld's multi-speaker "script" request (several voices in one call,
  with audio carried between them) would smooth the joins; it needs the
  edge function changed and redeployed.
- Designed voices for main characters, and fixing a single wrong line.
