# Existing products and open-source projects for multi-voice ("full cast") AI book narration — state as of 25 Nov 2026

Reading guide for the report writer:
- "Primary" = vendor docs, help pages, repo READMEs, GitHub API. "Marketing" = store listings, launch posts, press releases. "Secondary" = blogs, directories, search-result summaries I could not open.
- Where a fact came only from a search-result summary and I did not open the page, it is marked "(snippet only)".
- Repo stars and last-push dates were read from the GitHub API on 2026-11-25.
- I could not get any Reddit or Hacker News thread to load through search; user-complaint evidence is therefore thinner than the brief wanted (see Gaps in the complaints section).

## Commercial products: does each one give characters distinct voices, is detection automatic, is it live or pre-rendered, and when did it ship?

### Takeaway
By late 2026 automatic character detection plus per-character casting is a shipped feature in production studios (ElevenLabs Audiobooks, Google Play Books' publisher tool, Spoken, Hume Projects), but in every one of them it is an offline, author-side render with a human review step. The big listening apps (ElevenReader, Speechify reader, Kindle Assistive Reader, Apple Books, Storytel VoiceSwitcher, Audible virtual voice) still read a book in one narrator voice at a time; I found no primary source showing any of them voicing characters separately.

### Cited Findings

**ElevenLabs — Audiobooks / Studio "Character Casting"**
- ElevenLabs published "Introducing Character Casting in Audiobooks" on 30 Jul 2026 (updated 1 Oct 2026): "Audiobooks detects the characters in your book and proposes a voice for each one," with previews on real dialogue from the manuscript; "when you change a character's voice, every line they speak updates across the entire book." Detection method and model are not disclosed. (Primary, marketing tone) — [ElevenLabs blog](https://elevenlabs.io/blog/introducing-character-casting-in-audiobooks)
- The product docs describe two narration styles, "Single cast" and "Multi cast" (narrator plus assigned character voices), from EPUB or PDF upload. Detection and voice proposals are automatic; the user reviews structure, adds/changes/removes voice assignments. (Primary) — [ElevenLabs Audiobooks docs](https://elevenlabs.io/docs/eleven-creative/products/audiobooks/llms.txt)
- The docs state the caveat directly: "Character detection is AI-generated and should be treated as a starting point"; it may miss minor or unnamed characters and speakers "difficult to distinguish from the surrounding narration." Limit: "up to 150 detected voices per book." (Primary) — [ElevenLabs Audiobooks docs](https://elevenlabs.io/docs/eleven-creative/products/audiobooks/llms.txt)
- Changing a character's voice clears that character's generated audio and the affected paragraphs must be regenerated, which costs credits. Per-paragraph speaker overrides exist in the editor sidebar. "Very large or complex manuscripts may fail during processing." (Primary) — [ElevenLabs Audiobooks docs](https://elevenlabs.io/docs/eleven-creative/products/audiobooks/llms.txt)
- Models offered inside Audiobooks: Eleven v4, Eleven v3, Multilingual v2 (the default recommended for long-form), and Flash. (Primary) — [ElevenLabs Audiobooks docs](https://elevenlabs.io/docs/eleven-creative/products/audiobooks/llms.txt)
- It is a pre-render production flow: paragraphs are generated, then exported (MP3/WAV, chapter ZIP) or published to ElevenReader, Spotify, InAudio. A separate "Dynamic narration" mode lets the listener choose the narrator voice at playback, but music/SFX are excluded in that mode; the docs do not say dynamic narration preserves a multi-cast. (Primary) — [ElevenLabs Audiobooks docs](https://elevenlabs.io/docs/eleven-creative/products/audiobooks/llms.txt)
- The docs do not say how attribution tags ("she said") are treated. (Primary, absence) — [ElevenLabs Audiobooks docs](https://elevenlabs.io/docs/eleven-creative/products/audiobooks/llms.txt)
- An older Reedsy review (pre-dates Character Casting) found multi-voice processing slow enough that it was "best suited for short stories or novellas rather than full-length novels." (Secondary, dated, snippet only) — [Reedsy](https://reedsy.com/blog/elevenlabs-review/)

**ElevenLabs — ElevenReader app (consumer)**
- ElevenReader is described as turning any text into narration with a chosen voice; recent release notes mention "auto select voice created with Voice Design" and voice names shown in the player. No store listing, help page or release note I found describes per-character voices for books a user imports. (Marketing, absence; snippet only for release notes) — [ElevenReader App Store](https://apps.apple.com/gb/app/id6479373050); [ElevenLabs help: What is ElevenReader](https://elevenlabs.io/docs/help-center/product/distribution-publishing/eleven-reader/what-is-eleven-reader)
- User reviews say the single narrator changes delivery with the text ("reads the conversations like the character saying them"; raises its voice when a character yells) — expressive single voice, not separate voices. (User reviews, snippet only) — [ElevenReader App Store](https://apps.apple.com/gb/app/id6479373050)
- Multi-cast titles reach ElevenReader only when an author produced them in Audiobooks and published them there, after review. (Primary) — [ElevenLabs Audiobooks docs](https://elevenlabs.io/docs/eleven-creative/products/audiobooks/llms.txt)
- Reviews mention ElevenReader moved from free to subscription-required; a developer reply says "a subscription is now needed." (User reviews / developer reply, snippet only) — [ElevenReader App Store](https://apps.apple.com/gb/app/id6479373050)

**ElevenLabs — Text to Dialogue API (Eleven v3 / v4)**
- The Text to Dialogue endpoint takes a list of `{text, voice}` inputs; the FAQ says "there is no limit to the number of speakers in a dialogue," but total input text should stay at or below about 2,000 characters per request. Newer docs list it on Eleven v4 and v3; older pages said v3 only. The caller must supply who says what — it does no attribution. (Primary, snippet only) — [ElevenLabs Text to Dialogue docs](https://elevenlabs.io/docs/overview/capabilities/text-to-dialogue.md)

**Google Play Books — auto-narrated audiobooks (publisher tool)**
- The publisher editor has a "Characters" pane with a "Detect characters" button ("This process can take a few minutes"). Detection is "currently only available for English audiobooks" and "You can't undo character detection." Characters can also be added by hand with a voice and speed. (Primary) — [Google Play Books Partner help: Sound adjustments](https://support.google.com/books/partner/answer/14183080?hl=en)
- Assigning lines is described as a manual action: highlight the dialogue, right-click the character, "Change Narrator"; keyboard shortcuts cover only the first 10 characters; unassigned text uses the default narrator. The help page does not make clear how much line assignment the detection step does on its own. (Primary) — [Google Play Books Partner help](https://support.google.com/books/partner/answer/14183080?hl=en)
- Publishers must supply an EPUB (English, Spanish, German, French, Hindi or Brazilian Portuguese) that is also sold on Google Play. Output is a pre-rendered audiobook for sale, not a reader feature. (Primary, snippet only) — [Google auto-narrated audiobooks](https://play.google.com/books/publish/autonarrated/)

**Audible / Amazon KDP "virtual voice"**
- KDP's virtual voice is still an invite-only beta for US-marketplace eBooks, free to participants; authors edit in "Virtual Voice Studio" (pauses, pronunciation, speed). The help pages describe picking one virtual voice, changeable, with an option to choose a voice by chapter — no per-character casting is documented. Terms page last updated 21 Oct 2026. (Primary, snippet only) — [KDP help: virtual voice](https://kdp.amazon.com/en_US/help/topic/G3QRL9HQNF273Q2H); [KDP beta terms](https://kdp.amazon.com/en_US/help/topic/GFAQU3LUEHCRB8KD)
- Audible opened AI narration to select publishers on 13 May 2025 with 100+ voices in English, Spanish, French, Italian, in self-service or Audible-managed form. (Secondary) — [TechCrunch](https://techcrunch.com/2025/05/13/audible-is-expanding-its-ai-narrated-audiobook-library/); [Publishers Weekly](https://www.publishersweekly.com/pw/print/20250519/97756-audible-expands-catalog-with-ai-narration-and-translation-services.html)
- The only mention of multi-voice for Audible's publisher tool I found is a TechRadar opinion piece saying a "multi-voice performance" is possible in the self-service version; no official description. (Secondary, weak, snippet only) — [TechRadar](https://www.techradar.com/computing/artificial-intelligence/audibles-ai-narration-sounds-impressive-but-id-rather-hear-the-story-told-by-a-human)
- Scale reference: over 40,000 virtual-voice titles by May 2024. (Secondary) — [Publishers Lunch](https://lunch.publishersmarketplace.com/2024/05/kdp-virtual-voice-beta-has-produced-over-40000-audible-titles/)

**Kindle "Assistive Reader"**
- Assistive Reader "uses your device's OS-level Text-to-Speech engines"; it is single-voice and limited to books with Enhanced Typesetting. Reviewers call the voice generic/robotic. (Primary + secondary, snippet only) — [Amazon help](https://digprjsurvey.amazon.com/csad/help/node/TdHCSXXqsdhaVKt3Tc); [The eBook Reader blog](https://blog.the-ebook-reader.com/2025/08/27/kindles-new-assistive-reader-text-to-speech-video-demo)

**Apple Books digital narration**
- Launched Jan 2023 for romance/fiction with two voices (Madison, Jackson), publisher-side and pre-rendered. No Apple documentation of per-character voices found. (Secondary, dated) — [MacRumors](https://www.macrumors.com/2023/01/05/ai-narrated-audiobooks-now-available/); [Apple authors support](https://authors.apple.com/support/4519-digital-narration-audiobooks)
- An author who used it reported the voice "adjusts a bit with a conversation between two people," not enough to feel like distinct characters. (User blog, snippet only) — [Goodreads author blog](https://www.goodreads.com/author_blog_posts/24675278-using-apple-books-ai-based-digital-narration-tool-for-audiobooks)

**Storytel VoiceSwitcher**
- VoiceSwitcher lets a listener switch the narrator of a whole title between voices ("AI voices and human voices"); it is not per-character. Pilot in English summer 2023, then Polish, Swedish, Danish, Finnish. Built with ElevenLabs. (Primary) — [Storytel support](https://support.storytel.com/hc/en-in/articles/9489386226204-Voice-Switcher); [ElevenLabs case study](https://elevenlabs.io/blog/storytel-rethinks-audiobook-narration-with-voice-switcher-built-on-elevenlabs)

**Spoken (author studio, "Multi-Cast")**
- Spoken is an author-side platform: upload manuscript, assign "unique, lifelike voices to every character," from AI-designed voices or clones of professional narrators; described as using "proprietary agentic AI" and a "patent-pending approach to layering multi-character scenes." Studio workflow: Project Manager → Voices → Passages → Publishing. (Marketing/secondary, snippet only) — [Speech Technology Magazine](https://www.speechtechmag.com/Articles/News/Speech-Technology-News/Spoken-Launches-Multi-Voice-Audiobook-Creation-Platform-171283.aspx); [Apex Authors](https://apexauthors.com/?p=10596)
- Spoken's voices run on Hume's TTS API (and it also partners with ElevenLabs); Hume's case study claims 80% of usage is multi-cast. (Vendor case study) — [Hume case study](https://www.hume.ai/blog/case-study-spoken)
- Spoken-commissioned Edison Research study (Jul 2026, 1,000+ US fiction listeners): Multi-Cast rated favourably by 61% vs 53% for human narration; purchase intent 46% vs 49%. Company-funded. (Marketing) — [Podnews press release](https://podnews.net/press-release/edison-spoken)

**Hume (Octave / Projects)**
- Hume's Projects interface targets long-form audiobooks, chunking text while "preserving character consistency and context across chapters"; Octave 2 is described as generating multiple character voices in one click. Coverage is vendor marketing or third-party summaries; Projects was described as preview. (Marketing/secondary, snippet only) — [Hume blog](https://hume.ai/blog/octave-the-first-text-to-speech-model-that-understands-what-its-saying); [VentureBeat](https://venturebeat.com/ai/hume-launches-text-to-speech-model-octave)

**Speechify**
- A July 2025 Speechify news post on its Voice Changer pitches "a different voice for each character" in Speechify Studio (creator tool); a third-party guide lists "multi-voice support" in the premium studio tier. No documentation of automatic character detection, and nothing for the consumer reader app. The news URL returned 404 when I tried to open it. (Marketing, snippet only) — [Speechify news](https://speechify.com/news/speechify-launches-voice-changer/); [ScribeCount](https://scribecount.com/author-resource/artificial-intelligence/speechify-for-indie-authors)

**Pocket FM**
- Pocket FM partnered with ElevenLabs in June 2024 so writers can turn scripts into AI audio series (about 50 voices); claimed 30,000+ hours produced in pilot at up to 90% lower cost. TechCrunch reported multi-voice in one output was still "being worked on" at that time. (Secondary/marketing; 2024, may have changed) — [TechCrunch](https://techcrunch.com/2024/06/20/pocket-fm-partners-with-elevenlabs-to-convert-scripts-into-audio-content-quickly/); [ElevenLabs blog](https://elevenlabs.io/blog/pocket-fm)

**Google Gemini TTS (building block)**
- Gemini TTS multi-speaker output is capped at two configured speakers per request ("each speaker (up to 2)"); scenes with three or more characters need multiple generations. (Primary + secondary, snippet only) — [Gemini API speech generation docs](https://ai.google.dev/gemini-api/docs/speech-generation); [invideo guide](https://invideo.io/blog/gemini-tts-ai-voice/)

**Small consumer apps that do claim per-character voices** (detailed in the consumer-app section below): BookNPC, Tambr, Audora, AudiFlo.

### Inferences
- The market splits cleanly: **studios** (ElevenLabs Audiobooks, Google Play Books, Spoken, Hume Projects) do detect characters automatically but expect a human to check casting before a paid render; **readers** (ElevenReader, Speechify, Kindle, Apple Books) do instant playback but single-voice. Nothing from a major vendor sits in both boxes.
- ElevenLabs is the closest large player to crossing over: it owns detection (Audiobooks), dialogue models (v3/v4), and a consumer reader (ElevenReader). The absence of per-character voices in ElevenReader for imported books as of Nov 2026 is an observed gap, not a technical impossibility — treat it as the most likely thing to change.
- Every vendor that documents detection calls it a "starting point" or keeps a manual correction path, which implies none of them trusts attribution enough to ship it unreviewed.

### Gaps
- **Play.ht, Murf, WellSaid, Inworld, DeepZen, Microsoft/Azure multi-talker voices, NotebookLM audio**: my searches returned nothing usable on per-character book narration for any of these. From background knowledge only (unverified here): these are generally multi-voice editors or APIs where a human assigns a voice per block; Azure's multi-talker voices and NotebookLM's audio overviews are two-host conversational formats, not book character casting. Needs a targeted check before being stated in the report.
- **Audible multi-voice**: no official statement found either way for the publisher-side tool.
- **Apple Books**: no current (2026) source; findings are from 2023.
- **Google Play Books**: unclear whether "Detect characters" also auto-assigns lines to characters, or only builds the character list.
- **ElevenLabs Audiobooks**: required plan, max manuscript size and exact credit cost per book are not in the docs I read.
- **Speechify**: the primary page 404'd; claim rests on search summary.

## Open-source projects: how each attributes speakers, casts voices, reported quality, and activity

### Takeaway
The popular open-source converters (ebook2audiobook, audiblez, abogen, epub2tts) are single-narrator; multi-voice lives in smaller projects that have moved from BookNLP (VoxNovel, stale) to LLM annotation into a speaker-tagged script (Alexandria, audiobook-creator, Castwright). All are offline batch pipelines needing a local GPU or an LLM endpoint, and none publishes attribution accuracy.

### Cited Findings

**Single-narrator converters (no per-character voices)**
- ebook2audiobook: 20.7k stars, pushed 24 Nov 2026, Apache-2.0, "50+ TTS engines with voice cloning and 1696 languages"; headless mode takes a single voice or custom model. No per-speaker option surfaced. (Primary for stats; snippet for feature) — [GitHub](https://github.com/DrewThomasson/ebook2audiobook)
- audiblez: 8.9k stars, last push 27 Feb 2026, MIT, Kokoro-based; voice chosen once by flag. (Primary for stats; snippet for feature) — [GitHub](https://github.com/santinic/audiblez)
- abogen: 6.3k stars, pushed 1 Nov 2026, MIT; has a "voice formula" for blending voices, which mixes timbres rather than assigning one per speaker. (Primary for stats; snippet for feature) — [GitHub](https://github.com/denizsafak/abogen)
- epub2tts: 959 stars, last push 8 Feb 2026, Apache-2.0, "Turn an epub or text file into an audiobook." (Primary) — [GitHub](https://github.com/aedocw/epub2tts)
- Storyteller (smoores-dev, mirror of GitLab): 149 stars on the mirror, pushed 25 Nov 2026, MIT. (Primary for stats) — [GitHub mirror](https://github.com/smoores-dev/storyteller)
- autiobooks (Kokoro GUI): 265 stars, last push Mar 2025. In its r/LocalLLaMA thread a commenter suggested a tiny (~1.5B) LLM could label speakers "extremely accurately" — a suggestion, not a measurement. (Primary stats; forum claim, snippet only) — [GitHub](https://github.com/plusuncold/autiobooks); [r/LocalLLaMA mirror](https://cal1.lr.ggtyler.dev/r/LocalLLaMA/comments/1ij1xge/autiobooks_automatically_convert_epubs_to)

**BookNLP-based**
- VoxNovel: 379 stars, last push 8 Jun 2025 (stale), MIT. Uses BookNLP to "attribute quotations to specific characters"; attribution "won't correctly identify for anything thats not English." "Autoselects a starting estimated voice by pronouns per character" (F/M/Other), with a GUI to tick lines and reassign speakers because BookNLP misassigns quotes. TTS: Coqui XTTS (clone) or StyleTTS2. BookNLP forces WSL on Windows. No accuracy figure. (Primary) — [GitHub](https://github.com/DrewThomasson/VoxNovel)
- BookNLP itself: 951 stars, last push 31 Jul 2024 — effectively unmaintained. (Primary) — [GitHub](https://github.com/booknlp/booknlp)
- audiobooker (mcp-tool-shop): 3 stars, active Nov 2026, MIT; BookNLP optional (`--booknlp on`), falls back to heuristics. (Primary stats; snippet for feature) — [GitHub](https://github.com/mcp-tool-shop-org/audiobooker)

**LLM-annotation-based**
- Alexandria Audiobook: 1.1k stars, created Feb 2026, last push 2 Aug 2026, MIT, built on Qwen3-TTS. An LLM converts text into JSON entries of speaker ("NARRATOR" or a name), text and an "instruct" delivery direction. Between chunks it passes a "character roster and last 3 script entries" for continuity. An optional second LLM pass strips attribution tags ("said he") out of dialogue, moves narration that got stuck inside a character's entry back to NARRATOR, reassigns dialogue found inside narrator entries, and merges over-split narrator lines. (Primary) — [GitHub](https://github.com/Finrandojin/alexandria-audiobook)
- Alexandria casting: nine preset voices, clone from a 5–15 s sample, LoRA voices, or "Generate Personas" — the LLM writes a voice description per character, VoiceDesign makes reference audio, and clones are auto-assigned. Speaker aliases ("YOUNG ELENA") can share a voice. Instruct directions are ignored for cloned voices. (Primary) — [GitHub](https://github.com/Finrandojin/alexandria-audiobook)
- Alexandria speed: on a 24 GB AMD RX 7900 XTX, about 1x real-time standard, 3–6x with batching and codec compile; a ~54-minute book took ~16 minutes. Needs 8 GB VRAM minimum; Apple Silicon is CPU-only, "functional but slow." Prompts are tuned for English conventions; thinking models can break the JSON. (Primary) — [GitHub](https://github.com/Finrandojin/alexandria-audiobook)
- audiobook-creator (prakharsr): 535 stars, last push 17 Nov 2025, GPL-3.0, Kokoro/Orpheus. Two LLM steps via any OpenAI-compatible API: (1) identify unique characters with age and gender, run sequentially "for maximum accuracy"; (2) attribute a speaker to each line using that list. Outputs `speaker_attributed_book.jsonl` and `character_gender_map.json`; voices are assigned by gender score. It dropped an earlier GLiNER NLP pipeline in favour of the LLM. A roadmap item delivered: "Read out only the dialogue in a different voice instead of the entire line in that voice." Needs ≥20,000 tokens of context for character identification; author found gpt-oss-20B weaker than Qwen3 30B A3B for this. (Primary) — [GitHub](https://github.com/prakharsr/audiobook-creator)
- Castwright: 31 stars, created May 2026, very active (pushed 25–26 Nov 2026), source-available FSL-1.1 (not OSI). An analyzer "extracts characters, chapters, and per-sentence speaker tags"; "a character keeps the same voice across every book in a series, even when an author renames someone mid-series"; voices designed from persona with Qwen3-TTS or picked from Kokoro. Quality gates: acoustic checks, optional ASR transcript verification, and an "opt-in speaker-fingerprint check," with flagged takes re-recorded. Generation is per chapter. No accuracy figures. (Primary; the "no other tool does this" line is the project's own claim) — [GitHub](https://github.com/dudarenok-maker/Castwright)
- gutenberg-reader: 1 star; LLM labels each sentence narration vs dialogue with speaker, output JSON for a separate TTS step. (Primary stats; snippet for feature) — [GitHub](https://github.com/anders94/gutenberg-reader)

**Script-driven studios (attribution done upstream by the user)**
- TTS-Story: 365 stars, created Nov 2025, active Nov 2026; a web studio that turns already speaker-tagged scripts into audiobooks across Kokoro, Chatterbox, IndexTTS-2, Qwen3-TTS and others; Kokoro on a local GPU about 2 s per 500-word chunk (project summary). (Primary stats; snippet for speed) — [GitHub](https://github.com/Xerophayze/TTS-Story)
- Kokoro-FastAPI supports inline `[voice:...]` switching, so attribution must be supplied by the caller. (Snippet only) — [GitHub](https://github.com/remsky/Kokoro-FastAPI)
- BookForge Studio: 116 stars, last push Dec 2025, MIT; multi-speaker generation through models such as Dia. (Primary stats; snippet for feature) — [GitHub](https://github.com/kenning/bookforge-studio)

**Dialogue TTS models (building blocks)**
- Dia (Nari Labs): 19.4k stars, last push 19 Nov 2025, Apache-2.0, "generating ultra-realistic dialogue in one pass." (Primary) — [GitHub](https://github.com/nari-labs/dia)
- Sesame CSM: 14.8k stars, last push 27 May 2025, Apache-2.0, "A Conversational Speech Generation Model." (Primary) — [GitHub](https://github.com/SesameAILabs/csm)
- Microsoft VibeVoice: 57.6k stars, last push 8 Oct 2026, MIT; docs state up to 90 minutes of speech with up to 4 distinct speakers (an earlier research summary said 30 minutes). (Primary; snippet for limits) — [VibeVoice docs](https://raw.githubusercontent.com/microsoft/VibeVoice/refs/heads/main/docs/vibevoice-tts.md); [GitHub](https://github.com/microsoft/VibeVoice)
- A 2026 paper reports open-weights models such as Qwen3-TTS and VoxCPM2 "significantly deteriorate" on long-form prompts. (Research, snippet only) — [Taming Long-form TTS](https://huggingface.co/papers/2609.16989.md)

**Research**
- MultiActor-Audiobook (arXiv 2505.13082, May 2025): an LLM reads the full story and assigns each sentence a speaker; narration is assigned to the main character; GPT-4o writes a per-sentence delivery instruction; a face image + caption per character seeds the voice. On 12 short stories (avg ~4.3 speakers) human MOS was low for its own system (quality 2.4, character-voice consistency 2.9) while the ElevenLabs baseline scored 4.6 quality / 4.2 consistency. No attribution-accuracy numbers. (Primary) — [arXiv](https://arxiv.org/html/2505.13082v1)
- Deezer Research found Llama-3 70B "reaches an almost perfect accuracy" on quotation attribution in novels and that memorisation of the books was not the main cause. (Research, snippet only) — [arXiv 2406.11380](https://arxiv.org/html/2406.11380v3)
- A later Deezer paper notes LLM attribution's "computational cost limits their use" at scale and reports a non-LLM model at 94.5% overall attribution accuracy, released as a BookNLP fork. (Research, snippet only) — [arXiv 2608.02359](https://arxiv.org/pdf/2608.02359)

### Inferences
- The field has converged on one architecture: LLM pass 1 builds a character roster (name, gender, age, aliases); LLM pass 2 walks the text in chunks emitting `{speaker, text, direction}` with the roster and the last few lines carried forward; an optional review pass fixes tags; voices are mapped per roster entry and stored. BookNLP is being abandoned (stale repo, English-only, install pain).
- Voice casting in open source is crude: gender (sometimes age) to a small preset pool, or LLM-written persona → designed voice. Nothing uses a larger notion of fit.
- Because all of these batch-process a whole book before playback and need a GPU, none competes with a web reading app on immediacy; they are relevant as a source of pipeline design, not as competition.
- The research suggests attribution itself is close to solved for large models on well-formed novels (near-perfect with a 70B model; 94.5% without an LLM), so the differentiator is latency, cost, and what happens on the remaining errors — not raw accuracy.

### Gaps
- No project publishes a measured attribution error rate on a full novel; "reported quality" is anecdotal.
- I did not open the issue trackers, so the list of real-world failure reports per project is missing.
- Whether ebook2audiobook has added any per-character mode in a recent release is unconfirmed (search-level evidence only that it is single-voice).
- Dia and Sesame CSM speaker limits were not retrieved; from background knowledge (unverified here) Dia uses two speaker tags ([S1]/[S2]) and both are short-clip dialogue models rather than book-length engines.

## Is there a consumer reading app that automatically voices each character differently for any uploaded book, in real time, with no manual tagging?

### Takeaway
Yes, but only from very small, new players, and none is clearly "real time": BookNPC (iOS/Android) and Audora (launched 10 Nov 2026) are the closest, both doing automatic detection and casting on the user's own files with cloud rendering ahead of or progressively during listening; Tambr (iPhone) does the same for pasted text and fanfiction. No major reading app does it, and none of the small ones has independent reviews confirming quality.

### Cited Findings

**BookNPC (iOS 18+ and Android)**
- Store listing: make "a full-cast audiobook, where AI works out who is speaking and gives each character its own voice," or use a single narrator. (Marketing, snippet only) — [Google Play](https://play.google.com/store/apps/details?id=com.booknpc)
- Website: the app "analyzes each page to find who's speaking"; it "picks one [voice] for each character by gender and age," and the user can swap any character's voice from a cast roster (a 63-character cast list is shown). Formats: EPUB, MOBI, AZW, FB2, TXT. (Marketing) — [BookNPC site](https://booknpc-website.pages.dev)
- Not live: studio audio is "rendered ahead of time on cloud GPUs," then replayable offline; on-device voices "read instantly." Studio cloud audio covers 10 languages. (Marketing) — [BookNPC site](https://booknpc-website.pages.dev)
- Pricing is inconsistent across its own pages: site says 25¢ per finished audio-hour ("a short book costs cents; a long novel a few dollars") and elsewhere prices full-cast per page (a 40-page Alice in Wonderland ≈ US$0.25); Play listing uses a credit currency ("G") for full cast, translation and cloud voices, with cost shown before a cloud cast starts. A reviewer complained the app is marketed as free but needs paid credits for the real features. Voice counts conflict too (300+ vs 900+). (Marketing, snippet only for pricing page) — [BookNPC pricing](https://booknpc-website.pages.dev/pricing); [Google Play](https://play.google.com/store/apps/details?id=com.booknpc)

**Audora (Y Combinator launch, 10 Nov 2026)**
- "Audiobooks where every character has their own voice": takes a story link or uploaded file, "starts by determining who is speaking," assigns voices, and stresses keeping them consistent across a story. Fanfiction readers first. (Secondary article on a launch post) — [Fondo blog](https://fondo.com/blog/audora-audiobook-character-voices); [YC launch post](https://www.ycombinator.com/launches/WyP-audora-audiobooks-where-every-character-has-their-own-voice)
- Progressive rather than instant: the reader can "begin listening while the remaining audio is still being generated." Free first preview without an account; no full-book price published. Claimed waitlist of 10,000. (Secondary) — [Fondo blog](https://fondo.com/blog/audora-audiobook-character-voices)
- The same article flags that the claim "hasn't been tested on full books" and names correct line assignment, stable recurring voices and implied speakers as the open challenges, plus unresolved rights questions. (Secondary) — [Fondo blog](https://fondo.com/blog/audora-audiobook-character-voices)

**Tambr (iPhone)**
- "Turns any text into a multi-voice audiobook where every character has their own voice," with "tone, age, and style inferred from the story"; paste, upload or link, with Archive of Our Own and Fanfiction.net import. Version 1.0 on 22 Apr (2026 by context); one rating. In-app purchases "Tambr Pro $19.99" and "Tambr Max $39.99." Detection method, TTS provider and streaming behaviour not stated. (Marketing) — [App Store](https://apps.apple.com/app/id6759809866)
- Maker on Product Hunt: "we infer things like age, gender, and region"; a commenter "didn't understand how to change the voices," and the maker replied "Voice selection coming in the next update" — i.e. at launch casting was fully automatic with no override. (Marketing/user comment) — [Product Hunt](https://www.producthunt.com/p/tambr/tambr)

**AudiFlo (Android, free)**
- Lists a "character voice player" with "smart character name detection & auto-switching," narrator separation and per-book voice profiles; the user assigns voices to characters. Works offline with device TTS. No independent review; it reads as name-triggered switching with user-chosen voices, not full attribution. (Marketing, snippet only) — [AudiFlo features](https://audiflo.netlify.app/features); [Product Hunt](https://www.producthunt.com/products/audiflo)

**CastReader — not a per-character reader despite the name**
- Current App Store listing and Product Hunt page describe read-aloud with highlighting plus "AI Explain" for PDFs, EPUBs, web and Kindle; nothing about characters. Pro $9.99/month. 4.8 from 44 ratings. (Marketing) — [App Store](https://apps.apple.com/us/app/id6757636395); [Product Hunt](https://www.producthunt.com/products/castreader)
- Directory listings and an older release note describe AI that "automatically identifies all characters and their dialogues" with voices chosen from character profiles — this conflicts with the current listing and may describe an earlier or different product; treat as unconfirmed. (Secondary, snippet only) — [There's An AI For That](https://theresanaiforthat.com/ai/castreader/)

**Major readers**
- ElevenReader, Speechify, Kindle Assistive Reader, Apple Books: no per-character voices for user-supplied books found (see commercial section). — [ElevenReader App Store](https://apps.apple.com/gb/app/id6479373050); [Amazon help](https://digprjsurvey.amazon.com/csad/help/node/TdHCSXXqsdhaVKt3Tc)

### Inferences
- The honest answer is "a few tiny apps claim it; none is proven, and none is truly live." BookNPC pre-renders in the cloud; Audora streams as it generates; Tambr is undocumented. "Press play on any page and hear the cast immediately" does not appear to exist.
- None of these is a web app that sits inside a reading/study tool; they are standalone mobile audiobook makers. A web reader with instant multi-voice playback from any point in the book would be a distinct position.
- The complaint on Tambr (can't change a voice) and the override roster on BookNPC both point the same way: users want automatic casting *and* an easy way to correct it.
- Audora's YC backing and 10 Nov 2026 launch mean this exact niche has fresh, funded competition; expect fast movement.
- Fanfiction is where two of the three (Tambr, Audora) started — dialogue-heavy, rights-light, no existing audiobook.

### Gaps
- I could not test any of these apps; every capability claim is the vendor's own.
- How BookNPC, Audora and Tambr detect speakers (LLM, which one, per page or whole book) is not disclosed.
- Time-to-first-audio for each is unknown.
- CastReader's actual character-voice capability is unresolved (conflicting listings).
- Other store apps surfaced but not examined: Book 2 Life, Narrable, Lyric Winter fanfiction reader.

## What do users and reviewers complain about in existing multi-voice AI narration?

### Takeaway
The best-evidenced complaints are about attribution leftovers around dialogue tags, incomplete character detection, the cost of fixing a wrong cast (regeneration), and paywalls; evidence for "voices changing between chapters" comes from vendors and papers naming it as a risk rather than from user reports I could retrieve. Reddit and Hacker News threads did not surface, so this section leans on docs, project READMEs and a few blogs.

### Cited Findings
- ElevenLabs' own docs: detection "may miss minor or unnamed characters" and speakers "difficult to distinguish from the surrounding narration"; treat as "a starting point." (Primary) — [ElevenLabs Audiobooks docs](https://elevenlabs.io/docs/eleven-creative/products/audiobooks/llms.txt)
- A 2026 guide says "dialogue tags and subheadings are where most users report leftover errors" in ElevenLabs output, calls multi-character fiction a higher consistency risk, and recommends reviewing paragraph by paragraph. Single blog. (Secondary, snippet only) — [cognitivefuture.ai](https://cognitivefuture.ai/elevenlabs-for-audiobooks/)
- Fixing a cast costs money and time: changing a character's voice in ElevenLabs clears that character's audio and regenerating uses credits. (Primary) — [ElevenLabs Audiobooks docs](https://elevenlabs.io/docs/eleven-creative/products/audiobooks/llms.txt)
- "He said" in the wrong voice is a known enough failure that open-source tools built specific fixes: Alexandria's review pass strips attribution tags and splits misattributed narration/dialogue; audiobook-creator added "Read out only the dialogue in a different voice instead of the entire line in that voice." (Primary) — [Alexandria](https://github.com/Finrandojin/alexandria-audiobook); [audiobook-creator](https://github.com/prakharsr/audiobook-creator)
- BookNLP-based attribution is wrong often enough that VoxNovel ships a GUI just to correct speakers, and it fails outright on non-English text. (Primary) — [VoxNovel](https://github.com/DrewThomasson/VoxNovel)
- Audio drift and artefacts: VoxNovel's roadmap lists removing hallucinations from generated audio; Castwright adds ASR and speaker-fingerprint checks and re-records flagged takes; a 2026 benchmark notes "speaker confusion," timbre drift and quality variation persist in multi-speaker generation over long dialogues. (Primary / research, snippet only for the benchmark) — [VoxNovel](https://github.com/DrewThomasson/VoxNovel); [Castwright](https://github.com/dudarenok-maker/Castwright); [arXiv 2603.19798](https://arxiv.org/html/2603.19798)
- Slowness: older Reedsy review called ElevenLabs multi-voice best for short works because of processing time; Google's character detection "can take a few minutes"; Alexandria is ~1x real-time without batching on a 24 GB GPU. (Secondary / primary) — [Reedsy](https://reedsy.com/blog/elevenlabs-review/); [Google help](https://support.google.com/books/partner/answer/14183080?hl=en); [Alexandria](https://github.com/Finrandojin/alexandria-audiobook)
- No override: a Tambr user could not work out how to change a character's voice. (User comment) — [Product Hunt](https://www.producthunt.com/p/tambr/tambr)
- Pricing resentment: a BookNPC reviewer objected that it is marketed as free but real features need paid credits; ElevenReader reviewers object to the move to a required subscription. (User reviews, snippet only) — [Google Play](https://play.google.com/store/apps/details?id=com.booknpc); [ElevenReader App Store](https://apps.apple.com/gb/app/id6479373050)
- Pronunciation: an Apple digital narration user said heteronyms were handled "based on a coin toss" and character names were pronounced inconsistently; a CastReader reviewer said it "stumbles over contractions and place names" and "pauses at the end of pages." (User blog / review) — [Goodreads author blog](https://www.goodreads.com/author_blog_posts/24675278-using-apple-books-ai-based-digital-narration-tool-for-audiobooks); [CastReader App Store](https://apps.apple.com/us/app/id6757636395)
- Demand is contested: a Publishers Weekly piece quotes an industry figure doubting customers want automated multi-voice productions; APA-cited willingness to try AI-narrated titles fell from 77% (2023) to 70% (2025) to 61% (2026). Against that, Spoken's commissioned study found multi-cast AI rated above human narration (61% vs 53%). (Secondary, snippet only / marketing) — [Publishers Weekly](https://www.publishersweekly.com/pw/by-topic/digital/content-and-e-books/article/97387-the-audiobook-business-learns-to-embrace-ai.html); [Podnews](https://podnews.net/press-release/edison-spoken)
- A Goodreads commenter said they would want to know how different characters are voiced before choosing AI narration at all. (User comment, snippet only) — [Goodreads](https://www.goodreads.com/comment/index/286016193)

### Inferences
- The recurring failure classes, ranked by evidence: (1) tag/narration bleed around quotes, (2) missed minor or unnamed speakers, (3) expensive correction, (4) long-range voice drift or model artefacts, (5) name pronunciation inconsistency, (6) no easy user override.
- A reader feature that splits a sentence so the quote is in the character's voice and "he said" returns to the narrator, keeps a persistent per-book cast, and lets the user fix one line or one character without re-rendering the book would address the top four directly.
- Listener openness to AI narration is falling year on year in the APA numbers, so a multi-voice mode should be optional and switchable to a single narrator.

### Gaps
- No Reddit (r/audiobooks, r/ElevenLabs, r/LocalLLaMA, r/selfpublish) or Hacker News threads could be retrieved; first-hand listener complaints about wrong speakers, uncanny switching or chapter-to-chapter voice changes are not directly evidenced here.
- No measured error rates for any commercial product.
- "Voices changing between chapters" is named as a risk by vendors and papers but I found no specific user report of it.

## What techniques have vendors disclosed for dialogue detection and voice consistency across a long book?

### Takeaway
Commercial vendors disclose almost nothing; the concrete techniques come from open-source READMEs, papers and a handful of older patents. The disclosed pattern is: build a character roster once, attribute line by line with rolling context, pin one voice identity per character for the whole book (or series), and verify after synthesis.

### Cited Findings
- ElevenLabs discloses only the behaviour (detect → propose voices → global per-character reassignment, auto-filled pronunciation dictionary) and that detection is "AI-generated"; no method. (Primary) — [ElevenLabs blog](https://elevenlabs.io/blog/introducing-character-casting-in-audiobooks); [docs](https://elevenlabs.io/docs/eleven-creative/products/audiobooks/llms.txt)
- Spoken describes "proprietary agentic AI" and a "patent-pending approach to layering multi-character scenes," without detail. (Marketing, snippet only) — [Speech Technology Magazine](https://www.speechtechmag.com/Articles/News/Speech-Technology-News/Spoken-Launches-Multi-Voice-Audiobook-Creation-Platform-171283.aspx)
- Hume says Projects chunks long text while preserving character consistency and context across chapters, and that Octave conditions delivery on the meaning of the text. (Marketing, snippet only) — [Hume blog](https://hume.ai/blog/octave-the-first-text-to-speech-model-that-understands-what-its-saying)
- Storytel/ElevenLabs: scaling to the whole catalogue requires "reducing manual editing through API-driven automated production" — an admission that manual editing is still in the loop. (Vendor case study, snippet only) — [ElevenLabs case study](https://elevenlabs.io/blog/storytel-rethinks-audiobook-narration-with-voice-switcher-built-on-elevenlabs)
- Rolling-context annotation: Alexandria passes the "character roster and last 3 script entries" between chunks, then runs a review pass with explicit repair rules; aliases map variant names to one voice. (Primary) — [Alexandria](https://github.com/Finrandojin/alexandria-audiobook)
- Two-stage roster-then-attribute: audiobook-creator identifies characters (with age, gender) sequentially first, then attributes each line against that fixed list. (Primary) — [audiobook-creator](https://github.com/prakharsr/audiobook-creator)
- Series-level identity and post-synthesis verification: Castwright keeps a character's voice across books even after renames, and gates output with ASR transcript checks and a speaker-fingerprint check, re-recording failures. (Primary) — [Castwright](https://github.com/dudarenok-maker/Castwright)
- Persona-to-voice: MultiActor-Audiobook fixes persona inputs (caption, face, voice sample) per character and varies only the per-sentence instruction and text; an LLM writes the instruction with the whole story as context and is told to smooth emotional transitions. (Research) — [arXiv 2505.13082](https://arxiv.org/html/2505.13082v1)
- Patents (older, none found from Apple or Storytel, none audiobook-synthesis-specific from Google): Audible US 8,972,265 "Multiple voices in audio content" maps identified speakers in a text to different voice actors' recordings and synchronises text with narration (recorded human audio, not synthesis); Nuance/Cerence US 8,326,629 assigns a voice configuration to each story character and to non-spoken passages, driven by speaker identity and gender; US 11,600,259 determines each character's attributes from text and picks a matching pre-stored speaker. (Primary, snippet only) — [US 8,972,265](https://patents.google.com/patent/US8972265); [US 8,326,629](https://patents.google.com/patent/US8326629); [US 11,600,259](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/11600259)
- Dialogue-model limits that shape design: ElevenLabs Text to Dialogue ~2,000 characters per request with unlimited speakers; Gemini TTS two speakers; VibeVoice four speakers up to 90 minutes. (Primary, snippet only) — [ElevenLabs](https://elevenlabs.io/docs/overview/capabilities/text-to-dialogue.md); [Gemini](https://ai.google.dev/gemini-api/docs/speech-generation); [VibeVoice](https://raw.githubusercontent.com/microsoft/VibeVoice/refs/heads/main/docs/vibevoice-tts.md)

### Inferences
- Consistency across a long book is achieved everywhere by the same simple device: a stored character→voice-ID map applied to every line, not by the TTS model "remembering." Per-line synthesis with a fixed voice ID avoids the drift that single-pass multi-speaker models show.
- Multi-speaker dialogue models (v3 dialogue, Dia, VibeVoice, Gemini) are constrained by speaker count or request size, so book pipelines mostly synthesise line by line and stitch; the dialogue models' benefit (natural turn-taking) is traded for control.
- The idea of per-character voices from text is old in the patent record (2012–2015); what is new is LLM-quality attribution and expressive TTS, so differentiation is unlikely to come from the concept itself.

### Gaps
- No vendor blog, talk or patent from ElevenLabs, Google, Amazon/Audible (for synthesis), Apple or Storytel describing their attribution method was found; a direct patent search by assignee was not done.
- Spoken's patent application was not located.

## Pricing and limits of the main options

### Takeaway
Published prices put a rendered multi-voice novel anywhere from a few dollars (BookNPC) to a few hundred (Spoken), with ElevenLabs in between on monthly credits; free options are either invite-only publisher tools or local open source that needs a GPU. Several figures conflict between sources and should be re-checked on the vendors' own pricing pages.

### Cited Findings
- ElevenLabs plans (third-party summaries, conflicting): Creator $22/month with 100,000 characters or 121,000 credits; Pro $99/month with 500,000 characters or 600,000 credits; Starter $5; Scale $299 or $330; Business $990. Multilingual v2 is cited at 1 credit per character and Turbo/Flash at 0.5; up to two months of unused credits roll over; usage-based overage can be enabled. (Secondary, conflicting, snippet only) — [dev.to summary](https://dev.to/techsifted/elevenlabs-pricing-2026-plans-credits-and-api-costs-explained-1549); [bigvu summary](https://bigvu.tv/blog/elevenlabs-pricing-2026-plans-credits-commercial-rights-api-costs/); [ElevenLabs billing docs](https://elevenlabs.io/docs/overview/administration/billing.mdx)
- ElevenLabs Audiobooks: generation, custom previews, regeneration after a voice/model change, and export of ungenerated sections all consume credits; playback of generated audio does not. Up to 150 detected voices per book. Exact rates not stated. (Primary) — [ElevenLabs Audiobooks docs](https://elevenlabs.io/docs/eleven-creative/products/audiobooks/llms.txt)
- Eleven v3 Text to Dialogue via a reseller: $0.10 per 1,000 characters (fal.ai). ElevenLabs' own per-character rate for dialogue not found. (Third-party, snippet only) — [fal.ai](https://fal.ai/models/fal-ai/elevenlabs/text-to-dialogue/eleven-v3/llms.txt)
- Spoken: per project, no subscription, $20 per 5,000 words rounded up — a 46,000-word novel bills as 50,000 words = $200. Library of nearly 200 compensated voice actors or custom AI voices. Whether multi-cast costs more is not stated. (Secondary, snippet only) — [AI Apps for Authors](https://aiappsforauthors-com.pages.dev/apps/spoken)
- BookNPC: studio audio 25¢ per finished audio-hour per its site; per-page full-cast pricing and a credit currency on other pages; optional ad-free upgrade US$29.99/year; narrator-only mode free. (Marketing, internally inconsistent) — [BookNPC site](https://booknpc-website.pages.dev); [BookNPC pricing](https://booknpc-website.pages.dev/pricing)
- Tambr: Pro $19.99 and Max $39.99 in-app purchases (period not shown). (Marketing) — [App Store](https://apps.apple.com/app/id6759809866)
- CastReader (single-voice reader, for price reference): Pro $9.99/month or $59.99/year, 120 clone-voice minutes $2.99. (Marketing) — [App Store](https://apps.apple.com/us/app/id6757636395)
- KDP virtual voice: free for invited beta participants, US only. A third-party site reports a 40% royalty on virtual-voice titles (not confirmed on KDP pages). (Primary / secondary, snippet only) — [KDP help](https://kdp.amazon.com/en_US/help/topic/G3QRL9HQNF273Q2H)
- Google Play Books auto-narration: help page gives no price; requires the ebook to be sold on Google Play. (Primary) — [Google help](https://support.google.com/books/partner/answer/14183080?hl=en)
- Audora: free first preview, no full-book price published. (Secondary) — [Fondo blog](https://fondo.com/blog/audora-audiobook-character-voices)
- Open source: free; Alexandria needs 8 GB VRAM minimum (16 GB+ recommended), ~20 GB disk, plus an LLM server; audiobook-creator needs an OpenAI-compatible LLM with ≥20k context. (Primary) — [Alexandria](https://github.com/Finrandojin/alexandria-audiobook); [audiobook-creator](https://github.com/prakharsr/audiobook-creator)
- Reference points: experienced human narrators run roughly $200–$400+ per finished hour; one single-voice AI service charged $69 per hour of narration. (Secondary, snippet only) — [dev.to](https://dev.to/stanlymt/ai-audiobook-pricing-what-to-charge-in-2026-27pp)

### Inferences
- My own arithmetic, not sourced: an 80–100k-word novel is roughly 450–550k characters, so at 1 credit per character a full ElevenLabs render is about one Pro month ($99) and at 0.5 credits per character fits a Creator month ($22) on the lower character figure — before any regeneration from casting fixes.
- BookNPC's 25¢ per audio-hour (if accurate) would make a 10-hour novel about $2.50, roughly two orders of magnitude under Spoken and well under ElevenLabs, implying it uses a cheap or self-hosted TTS model. This sets a low price anchor for consumer multi-voice.
- Because existing products charge per render, a live reader that only synthesises what the listener actually plays has a structural cost advantage for people who sample or abandon books.

### Gaps
- ElevenLabs' current official plan table was not read directly; figures above conflict between secondary sources.
- No published prices found for Hume Projects, Speechify Studio multi-voice, Audible's publisher AI narration, or Audora.
- ElevenReader's current subscription price was not retrieved.
- Spoken's price is from a third-party directory, not its own pricing page.
