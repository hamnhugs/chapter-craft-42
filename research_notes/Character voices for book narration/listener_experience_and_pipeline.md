# Character voices for book narration: listener experience (A) and live pipeline engineering (B)

Research date: 2026-11-25. Part A is listener experience; Part B is pipeline engineering. They are kept separate; headings are prefixed A or B.

Reading notes for the report writer:
- Many findings below come from search-result summaries of the pages, not a full read of each page. The pages I read in full are marked "(read)". Treat the others as leads whose wording should be checked before being quoted.
- Where I state arithmetic or a design suggestion, it is in "Inferences" and is mine, not a source's.
- Prices were read from the official Google and OpenAI pricing pages on 2026-11-25 through an automated page reader. Model names and figures should be rechecked on the live pages before they go into a budget.

---

# PART A: LISTENER EXPERIENCE

## A1. Is there empirical research comparing single-narrator, duet, and full-cast audiobooks on comprehension, character tracking, immersion, enjoyment, or fatigue?

### Takeaway
I found no peer-reviewed controlled study comparing single-narrator with multi-voice audiobooks on comprehension or character tracking. The only measured comparison is a 2026 vendor-issued survey (about 1,000 listeners, one sci-fi thriller excerpt) in which AI multi-cast beat a human single narrator by 6 to 9 points on favourability, quality and engagement in character-driven scenes, while the human narrator won on plain exposition.

### Cited Findings
- Spoken / Edison Research study (press release dated 15 July 2026) (read): "over 1,000" adult US fiction audiobook listeners, two blinded, randomly assigned cohorts. Each heard excerpts of one sci-fi thriller, either a professional human single-narrator recording or an unedited AI "Multi-Cast" version. Results weighted to Infinite Dial 2026 audiobook listener demographics. — [Podnews press release](https://podnews.net/press-release/edison-spoken)
- Same study, character-driven fiction, multi-cast AI vs human single narrator: overall favourability 61% vs 53%; perceived narration quality 66% vs 60%; overall engagement 58% vs 49%. — [Podnews press release](https://podnews.net/press-release/edison-spoken)
- Same study: for exposition without multiple characters, the human narrator was rated higher (no figures given). — [Podnews press release](https://podnews.net/press-release/edison-spoken)
- Same study: 61% of those who heard the AI version thought it was human; 65% of those who heard the human version thought it was human. Purchase intent after being told it was AI: 46% (multi-cast) vs 49% (human), described as "statistically comparable" with no statistics shown. — [Podnews press release](https://podnews.net/press-release/edison-spoken)
- Same study: 81% of frequent listeners said they are interested in distinct character voices; 51% "very interested". — [Podnews press release](https://podnews.net/press-release/edison-spoken)
- The sample is reported elsewhere as 1,005 fiction audiobook fans surveyed in May 2026, and the study is described as commissioned by Spoken, with critics questioning its independence. — [Digital Trends](https://www.digitaltrends.com/?p=5990163); [Publishers Weekly](https://www.publishersweekly.com/pw/by-topic/digital/content-and-e-books/article/100825-some-favor-ai-narration-for-multi-cast-audiobooks-even-as-interest-in-ai-voices-wanes.html)
- Caveats visible in the release itself (read): no margins of error, no significance tests, no per-cohort sample sizes, one title in one genre, an "unedited one-click" AI version against a professional production, and the release does not say who paid. — [Podnews press release](https://podnews.net/press-release/edison-spoken)
- A vendor blog claims full-cast productions are linked to higher completion rates than single-narrator tracks, and itself labels this "observation rather than proof". — [Narration Box blog](https://narrationbox.com/blog/single-narrator-vs-full-cast-audiobook)
- Adjacent laboratory evidence (speech perception, not audiobooks): listeners are slower to recognise spoken words when the talker varies than when the talker is constant. — [Review: "Why are listeners hindered by talker variability?", 2023](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC10864679/)
- Variation between talkers imposes additional processing cost during speech perception; variation within one talker mainly added effort without hurting accuracy. — [Kapadia, Tin and Perrachione, JASA 2023](https://sites.bu.edu/cnrlab/files/2023/01/Kapadia-Tin-Perrachione-2023-JASA.pdf)
- One account attributes the multi-talker cost mainly to attention switching when the listener reorients to a new talker, and reports that the cost does not grow with the amount of potential variability. — [Cognition, 2020](https://www.sciencedirect.com/science/article/abs/pii/S0010027720302122)
- A 2020 study found a constant cost for talker changes regardless of how familiar the talker was, though familiarity still helped linguistic processing. — [Attention, Perception & Psychophysics, 2020](https://link.springer.com/article/10.3758/s13414-020-02203-y)
- In a conversational turn-taking task, a change in the attended voice produced a cost that persisted even when switches were cued and predictable (older study, 2015). — [Frontiers in Neuroscience, via PMC](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC4403343/)

### Inferences
- The only audiobook-specific measurement points the same way as the craft literature: voice differentiation helps where there is dialogue, and adds nothing (or costs something) in exposition. That supports a default where the narrator voice carries all non-dialogue text.
- The talker-variability literature measures word-level reaction times in the lab, usually with unpredictable switches and no story context. It shows a voice change is not free for the listener, but it does not show that multi-voice narration reduces story comprehension. It is a reason to avoid needless switches (for example a switch for a two-word tag), not a reason to avoid character voices.
- The "does not grow with amount of variability" finding suggests the cost is per switch rather than per additional cast member, so the number of switches per minute probably matters more than cast size. This is an extrapolation from lab tasks.

### Gaps
- No controlled study found on comprehension, character tracking or fatigue for single vs duet vs full-cast audiobooks, human or synthetic. Searches of general web results returned only vendor blogs and forums; I did not search CHI, ASSETS or Interspeech proceedings directly.
- No independent replication of the Spoken/Edison result, and no data on long-form listening (hours rather than excerpts), where fatigue would show.

## A2. What do audiobook listeners say they prefer, and what do they dislike about full-cast or AI narration?

### Takeaway
Stated preference is split and depends on execution: listeners in forums commonly praise a single skilled narrator who voices every character and complain about full-cast productions that feel stagey or that keep redundant attribution lines. Willingness to try AI narration fell in the APA's 2026 survey (70% to 61%), and only 16% of listeners had heard an AI-voiced title.

### Cited Findings
- APA 2026 consumer survey: conducted online by Edison Research in February 2026 with 1,706 spoken-word listeners aged 18+. — [infoDOCKET](https://www.infodocket.com/2026/06/05/audio-publishers-association-reports-audiobook-sales-jump-9-to-2-43-billion/)
- APA 2026: willingness to try AI-narrated titles fell from 70% (2025) to 61% (2026); the survey does not explain why. — [PPC Land](https://ppc.land/audiobook-sales-hit-2-43-billion-in-2025-as-157-million-americans-tune-in/)
- APA 2026: only 16% of audiobook listeners have listened to an AI-voiced title. — [Publishers Weekly](https://www.publishersweekly.com/pw/by-topic/digital/content-and-e-books/article/100825-some-favor-ai-narration-for-multi-cast-audiobooks-even-as-interest-in-ai-voices-wanes.html)
- In the Spoken/Edison study, 31% said they would be likely to listen to an AI audiobook before hearing an excerpt and 65% said they would be likely to listen to a multi-cast audiobook after hearing one (different questions before and after, so not a clean before/after). — [Podnews press release](https://podnews.net/press-release/edison-spoken)
- Goodreads "Audible Addicts" thread: one commenter says a single narrator who voices every character is ideal; another says full cast feels like a play. — [Goodreads thread](https://www.goodreads.com/topic/show/1725092-audiobooks-with-full-cast-or-single-narrator?page=1)
- A Goodreads commenter found the full-cast American Gods awkward mainly because of the constant attribution lines left in alongside distinct voices. Others enjoy full cast for comedy (Monty Python, Douglas Adams). — [Goodreads thread](https://www.goodreads.com/topic/show/17864553-multi-voice-audio-books)
- A mirrored r/books post has a listener saying they dislike full-cast audiobooks and find them difficult to listen to. — [r/books mirror](https://z-kaiyang.hcics.simtech.uni-stuttgart.de/f/books/59498/audiobook-performers-have-set-the-bar-too-high)
- A publisher-side article says many listeners find a skilled single narrator just as engaging, "without the distraction of multiple voices". — [Ooligan Press](https://www.ooliganpress.com/single-narrator-or-full-cast-in-audiobooks-which-is-better/)
- Audible's own guide describes "partially voiced" narration as a middle ground and says "too many distinct character voices can be a little distracting". — [Audible UK blog](https://audible.co.uk/blog/which-audiobook-narrator-will-i-like)

### Inferences
- The recurring complaint about full cast is not the voices themselves but two side effects: redundant "he said" lines that sound odd once the voice already identifies the speaker, and a theatrical feel. Both are controllable by defaults (subtle differentiation; a clear rule for tags).
- Because preference is split, the feature is safer as something the listener can turn down or off than as a fixed behaviour.

### Gaps
- No APA, Audible, Spotify or Edison figure found for single vs full-cast preference as such. The APA's full consumer report is members-only.
- No 2026 survey found that breaks down reasons for disliking AI narration (mispronunciation, flat emotion and so on) with percentages.
- I could not retrieve large Reddit threads directly; the forum evidence here is a handful of comments and is anecdotal.

## A3. Craft conventions: who reads dialogue tags, how thoughts, letters and first-person narrators are handled, and how subtle single-narrator differentiation usually is

### Takeaway
Professional convention is that the narrator reads tags and all narration, character differentiation is light (a slight change of pitch, tone or rhythm), and tags are kept in the audio because they often carry action or emotion. In duet narration each performer reads their own character's lines and that character's first-person narration.

### Cited Findings
- Dual narration splits the book by chapter or point of view, with each narrator voicing all dialogue in their chapters; duet splits by character, each narrator voicing one character's dialogue throughout. — [Karen Commins](https://karencommins.com/2015/02/dual-gender-narrations-in-audiobooks.html) (older, 2015); [AudioForge](https://audioforge.ai/blog/dual-vs-duet-narration/)
- In duet, the narrator who voices a character usually also reads that character's first-person narration; duet is generally done only for first-person books. — [Karen Commins](https://karencommins.com/2015/02/dual-gender-narrations-in-audiobooks.html)
- Duet is more time-consuming and costly for human productions because separately recorded lines must be spliced. — [NarratorList FAQ](https://narratorlist.com/faqs/faqs-authors/)
- ACX author-summit advice: minimise dialogue tags when writing for audio because "he said/she said" becomes repetitive when spoken. — [ACX blog](https://www.acx.com/mp/blog/how-to-write-and-produce-engaging-audiobooks-insights-from-the-acx-author)
- Audible's writing-for-audio guide: there is still a need for the occasional dialogue tag, and their order can be varied to improve listening. — [Audible blog](https://www.audible.com/blog/writing-for-audio)
- Narrator-side guidance: do not drop tags merely because different voices seem to make them redundant; tags may carry emotion or action, and a tag in the manuscript that is missing from the audio should be restored. — [Vocal Copycat](https://www.vocalcopycat.com/articles/dialogue-attribution-audiobooks)
- ACX: the listener always needs to know who is talking, especially where the book has no tags; differentiation "may be more between your ears than in your throat" (performance over doing a voice). — [ACX blog](https://www.acx.com/mp/blog/how-to-act-like-an-audiobook-narrator)
- A slight change in pitch or tone is described as sufficient differentiation. — [Goodreads author blog, "Five Essential Elements for Great Audiobook Narration"](https://www.goodreads.com/author_blog_posts/4515809-five-essential-elements-for-great-audiobook-narration?tab=book)
- A voice coach's view: even in first person, the narrator's voice should differ when that narrator speaks dialogue; a listener adds that spoken vs thought lines of a first-person narrator need differentiation because dialogue is not always tagged (anecdotal). — [Goodreads discussion](https://www.goodreads.com/topic/show/2165059-character-voices-in-first-person-narration?tab=book)
- Open-source multi-voice tool Alexandria's review pass encodes the same convention in software: it removes attribution tags left inside character lines and reassigns narration found inside character entries to the NARRATOR voice. — [Alexandria README](https://github.com/Finrandojin/alexandria-audiobook) (read)
- A builder hit the opposite bug: a tagged paragraph was voiced entirely in the character's voice, including the attribution text, and the fix was to split on quote marks. — [scriptorium PR #15](https://github.com/theraccoonbear/scriptorium/pull/15)

### Inferences
- Default for tags: the narrator voice reads the tag and any narration inside a quoted sentence; the character voice reads only what is between quote marks. This matches human convention and what open-source tools converge on.
- Default strength: subtle. Human single narrators mostly use light shifts, and listeners' complaint about full cast is distraction. A "subtle / distinct" setting with subtle as default fits the evidence.
- First-person books: the narrator voice and the protagonist's dialogue voice should be the same or nearly the same voice, since they are the same person (the duet convention).
- Tags should not be deleted from the audio by default: the book's words stay intact, and tags carry action. An optional "skip plain said-tags" mode would be a departure from the text and is a product decision, not an evidenced default.

### Gaps
- No authoritative convention found for letters, quoted documents, or italicised inner thoughts. Only forum-level opinion on thoughts.
- No measured data on how large the pitch or timbre differences are in professional single-narrator performance.

## A4. How costly is a wrong voice compared with no differentiation? Error tolerance and fallback to narrator when unsure

### Takeaway
No study measures the listener cost of a misattributed voice. What is measurable is how often it would happen: the best published attribution systems reach about 94.5% overall on a literary benchmark and 82% to 89% on untagged ("implicit") quotes, so a fully automatic system will voice a noticeable number of lines wrongly unless low-confidence lines fall back to the narrator.

### Cited Findings
- Best published result on the PDNC benchmark (Project Dialogism Novel Corpus; 5-fold cross-validation): 94.5% overall; 99.3% explicit (tagged), 95.5% anaphoric (pronoun-tagged), 89.3% implicit (untagged). — [Michel, Attali and Epure, "Fast and Accurate Quotation Attribution in Literary Texts", arXiv 2608.02359, Aug 2026](https://arxiv.org/html/2608.02359v1) (read)
- Llama-3-8b LLM baseline in the same paper: 89.8% overall; 94.9% explicit, 93.1% anaphoric, 81.8% implicit. — [arXiv 2608.02359](https://arxiv.org/html/2608.02359v1)
- Older rule/pipeline systems (BookNLP-based, 2023) scored roughly 0.68 to 0.78 on novel-level attribution. — [ACL 2023 short paper](https://aclanthology.org/2023.acl-short.64.pdf)
- LLMs have memorised some well-known novels in the benchmark, and their attribution accuracy varies with degree of memorisation, so benchmark numbers may overstate accuracy on unfamiliar books. — [Michel et al. 2024, arXiv 2406.11380](https://arxiv.org/html/2406.11380v1)
- Coreference errors leave about 2% of quotes with no candidate mention of the true speaker; minor characters are harder. — [arXiv 2608.02359](https://arxiv.org/html/2608.02359v1)
- Lab evidence that any voice change costs attention, even when predictable. — [PMC4403343](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC4403343/)
- Builders treat line-level regeneration as essential ("the difference between usable and I'll never touch it again") and say speaker attribution "is where most of the quality lives". — [DEV Community, fullcastbook](https://dev.to/fullcastbook/turning-a-manuscript-into-a-multi-voice-ai-audiobook-speaker-detection-per-character-voices-and-47f) (read)
- Alexandria adds an optional LLM review pass specifically to catch misattributions. — [Alexandria README](https://github.com/Finrandojin/alexandria-audiobook)

### Inferences
- Arithmetic (mine): at 94.5% accuracy a book with 3,000 quoted lines gets about 165 wrong voices; at 89.8%, about 306. The quote count is an assumption, not a sourced figure.
- Errors concentrate in untagged rapid exchanges (implicit quotes: 11% to 18% wrong), which is exactly where a wrong voice is most confusing because there is no tag to correct the listener.
- A wrong voice is plausibly worse than no differentiation: it asserts something false about who is speaking, whereas the narrator voice asserts nothing and is the long-standing single-narrator norm. This is reasoning, not measurement.
- Suggested fallback rule: use a character voice only when the line has an explicit tag or the model reports high confidence; otherwise read it in the narrator voice. A middle option for two-person exchanges is alternation logic checked against the nearest tagged lines.
- In a two-speaker untagged exchange, one early error can flip every following line. Anchoring on tagged lines limits the run length of such errors.

### Gaps
- No evidence on listener tolerance (what wrong-voice rate people notice or forgive), or on whether narrator fallback is perceived as inconsistent ("why did she just sound like the narrator?").
- No published accuracy for current inexpensive hosted models (Gemini Flash-Lite, GPT nano/mini class) on quotation attribution. The only LLM figure is an 8-bit quantised Llama-3-8b.
- No source found on calibration of LLM self-reported confidence for this task.

## A5. Accessibility: do distinct voices help listeners with dyslexia, ADHD, low vision, or language learners follow dialogue?

### Takeaway
I found no study testing distinct voices per speaker for any of these groups. The nearby evidence is about text-to-speech in general: small-to-moderate comprehension gains for students with reading disabilities, with mixed results for dyslexia specifically.

### Cited Findings
- Meta-analytic effect sizes of TTS on comprehension for students with reading disabilities are reported as 0.35 and g = 0.445 in two meta-analyses (as summarised by a secondary blog source; low reliability for interpretation). — [Readloudly blog](https://readloudly.com/blog/text-to-speech-for-dyslexia/)
- Taiwanese eye-tracking study of junior high students: TTS improved comprehension for students with ADHD-related reading difficulties but not for students with dyslexia, though it lowered reading time and cognitive effort for the dyslexic group. — [Reading and Writing, Springer, 2025](https://link.springer.com/article/10.1007/s11145-025-10738-5)
- Both dyslexic and typical readers comprehended better with TTS and mind-wandered less. — [Bonifacci et al., Journal of Computer Assisted Learning, 2022](https://onlinelibrary.wiley.com/doi/10.1111/jcal.12624)
- Autistic adult listeners' response times did not differ between single- and multi-talker conditions, unlike non-autistic listeners. — [2024 study, via PMC](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC11208580/)

### Inferences
- Any accessibility claim for character voices would currently be unevidenced. It is reasonable to hypothesise that a voice cue helps a listener who cannot see quote marks or paragraph breaks, but that is a hypothesis.
- Since the talker-change cost exists for most listeners and groups differ, an off switch and a "subtle" setting are the defensible accessibility position.

### Gaps
- No screen-reader, low-vision, ADHD or second-language study on multi-voice TTS found. I did not run a dedicated search of ASSETS proceedings or of screen-reader practice (for example whether screen-reader users switch voices for quoted text).

## A6. Speech rate, voice-switch frequency, or gap length between voices that affects comfort

### Takeaway
No measured evidence found. The only numbers are a builder default (500 ms pause at a speaker change, 250 ms between lines of the same speaker) and the lab finding that each talker switch carries a cost.

### Cited Findings
- Alexandria defaults: 500 ms pause on speaker change, 250 ms between same-speaker lines. — [Alexandria README](https://github.com/Finrandojin/alexandria-audiobook) (read)
- Talker-change cost is present even for predictable, cued switches. — [PMC4403343](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC4403343/)
- Open-source tool bookcaster applies listening speed as a separate step that keeps pitch, default 1.25x. — [bookcaster README](https://github.com/routhjim/bookcaster) (read)

### Inferences
- 500 ms at every switch is likely too long where a short tag interrupts a quote ("No," he said, "not yet."): that sentence would contain two switches and a second of added silence. Pauses probably need to depend on punctuation (short at commas, longer at paragraph breaks) rather than on speaker change alone. Untested.
- Speed changes should be applied at playback (pitch-preserving rate) rather than baked into synthesis, so cached audio stays valid at any speed.

### Gaps
- No study on comfortable switch frequency, on inter-voice gap length, or on how faster playback (1.5x to 2x) interacts with voice switching.

---

# PART B: PIPELINE ENGINEERING

## B1. Pipeline designs in existing tools and published systems: whole-book pre-pass, per chapter, or streaming ahead? Trade-offs for time-to-first-audio

### Takeaway
Every tool and paper I found is an offline batch pipeline (whole book or chapter annotated first, then rendered). None documents a "just ahead of the listener" design, so that would be new work, but the pieces (cast pass plus chunked attribution with a carried roster) transfer directly.

### Cited Findings
- Alexandria (Qwen3-TTS, local): LLM script annotation, then an optional LLM review pass, then a separate persona-generation step; output is a JSON array of {speaker, text, instruct}. — [Alexandria README](https://github.com/Finrandojin/alexandria-audiobook) (read)
- Alexandria carries context between chunks as the character roster plus the last 3 script entries. — [Alexandria README](https://github.com/Finrandojin/alexandria-audiobook)
- Alexandria throughput: batch mode 3 to 6x real time on a 24 GB AMD RX 7900 XTX; a 273-chunk book section (about 54 minutes of audio) renders in about 16 minutes; one-time warm-up 30 to 60 s. — [Alexandria README](https://github.com/Finrandojin/alexandria-audiobook)
- Audiobook Creator (Kokoro/Orpheus): saves a speaker-attributed JSONL file mapping each line to a speaker. — [audiobook-creator repo](https://github.com/prakharsr/audiobook-creator)
- bookcaster: attributes speakers passage by passage so the LLM can follow turn-taking, and keeps "one running conversation per chapter, so the language model reads only the new turn each time"; finished steps are cached so a stopped job resumes. — [bookcaster README](https://github.com/routhjim/bookcaster) (read)
- Commercial tool (fullcastbook) mental model: manuscript → chapter segmentation → dialogue extraction and speaker attribution → character-to-voice map stable across the project → per-line render → stitch; the user reviews the detected cast before rendering. — [DEV Community](https://dev.to/fullcastbook/turning-a-manuscript-into-a-multi-voice-ai-audiobook-speaker-detection-per-character-voices-and-47f) (read)
- Deep Dubbing paper: two LLM passes, first identifying characters and writing a timbre description for each, then writing emotion instructions per dialogue segment. — [arXiv 2509.15845](https://arxiv.org/pdf/2509.15845)
- MultiActor-Audiobook paper: the LLM first extracts all speakers including the narrator and writes persona captions, then voices are generated per persona. — [arXiv 2505.13082](https://arxiv.org/pdf/2505.13082)
- Non-LLM option: a ModernBERT-based attribution model processes a whole book in 0.43 s on an A100 GPU against 400 to 2,800 s for Llama-3-8b, at higher accuracy (94.5% vs 89.8%); it depends on an upstream coreference step and peaks at 9.2 GB VRAM. — [arXiv 2608.02359](https://arxiv.org/html/2608.02359v1) (read)

### Inferences
- Three options for a live reading app:
  1. Whole-book pre-pass at import: best consistency (full cast known), but tens of seconds to minutes before the first character voice unless done in the background. Cost is paid for books never listened to.
  2. Per chapter on first open: cost follows actual listening; delay of one LLM call (or a few in parallel) before the chapter's voices are ready.
  3. Just ahead of the listener (a few thousand words): lowest wait, but the cast is incomplete, so a character may be met before being registered.
- A hybrid resolves the trade-off: start playback immediately in the narrator voice (zero added time-to-first-audio), run a cheap cast pass over the whole book in the background, and attribute per chapter, switching to character voices from the next unsynthesised segment once attribution for it is ready. The feature then degrades to today's single-voice behaviour rather than making the listener wait.
- Since attribution output is small and deterministic to store, it should be cached per book (per chapter, keyed by a hash of the chapter text and the prompt version), so each book is paid for once.

### Gaps
- No published system or blog found that does speaker-aware narration live, ahead of a listener. No time-to-first-audio measurements exist for this design.
- bookcaster's attribution chunk size, prompts and output format are not documented in its README.

## B2. Realistic LLM cost and time to annotate a 100,000-word novel with speaker labels (late 2026 prices)

### Takeaway
With an indices-only output format and a two-pass design, annotating a 100,000-word novel costs roughly 4 to 25 US cents on the cheapest current tiers and under 50 cents on mid "Flash/mini" tiers; having the model re-emit the text roughly doubles to quadruples that. Wall-clock time is not documented anywhere I could cite.

### Cited Findings
Official prices per 1M tokens, standard tier, read 2026-11-25:

Google Gemini API — [Gemini API pricing page](https://aistudio.google.com/docs/pricing) (read; redirected from ai.google.dev/gemini-api/docs/pricing)

| Model | Input | Output | Batch input / output |
|---|---|---|---|
| Gemini 2.5 Flash-Lite | $0.10 | $0.40 | $0.05 / $0.20 |
| Gemini 3.1 Flash-Lite | $0.25 | $1.50 | $0.125 / $0.75 |
| Gemini 3.5 Flash-Lite | $0.30 | $2.50 | $0.15 / $1.25 |
| Gemini 3.8 Flash | $0.75 (rising to $1.50 on 1 Jan 2027) | $3.75 (rising to $7.50) | $0.375 / $1.875 |

- Gemini 2.5 Flash is deprecated; from 1 December 2026 requests to it route to Gemini 3.5 Flash-Lite at that model's rates. — [Gemini API pricing page](https://aistudio.google.com/docs/pricing)
- Free tier exists for these models, with content used to improve Google's products; batch is not available on the free tier. — [Gemini API pricing page](https://aistudio.google.com/docs/pricing)
- Cached input is priced at one tenth of input on these models (for example $0.03 for 3.5 Flash-Lite) plus hourly storage. — [Gemini API pricing page](https://aistudio.google.com/docs/pricing)

OpenAI — [OpenAI API pricing](https://developers.openai.com/api/docs/pricing.md) (read)

| Model | Input | Cached input | Output |
|---|---|---|---|
| gpt-5-nano | $0.05 | $0.005 | $0.40 |
| gpt-6-luna | $0.10 | $0.01 | $0.50 |
| gpt-5.6-luna | $0.20 | $0.02 | $1.20 |
| gpt-5.4-nano | $0.20 | $0.02 | $1.25 |
| gpt-5-mini | $0.25 | $0.025 | $2.00 |
| gpt-5.4-mini | $0.75 | $0.075 | $4.50 |

- OpenAI batch prices are exactly 50% of standard for all of these. — [OpenAI API pricing](https://developers.openai.com/api/docs/pricing.md)
- Third-party aggregators disagree with each other on late-2026 OpenAI small-model prices (for example GPT-5.6 Luna listed at $1.00/$6.00 by one and $0.20/$1.20 by another); the official page above shows $0.20/$1.20. — [Finout](https://www.finout.io/blog/openai-pricing-in-2026); [Morph](https://morphllm.com/openai-api-pricing)
- Time reference from research: a local 8-bit Llama-3-8b took 400 to 2,800 s per book for attribution on an A100. — [arXiv 2608.02359](https://arxiv.org/html/2608.02359v1)

### Inferences
Arithmetic (all assumptions mine; none are sourced measurements):

Assumptions
- 100,000 words ≈ 133,000 tokens (using the common 0.75 words per token rule of thumb for English).
- Pass 1 (cast extraction): read the whole book once in chunks: 133k input tokens; about 10k output tokens of cast notes.
- Pass 2 (attribution): 34 chunks of about 3,000 words (4,000 tokens) each, plus per chunk about 500 tokens of overlap, 500 of cast list and 500 of instructions = about 5,500 tokens × 34 ≈ 187k, rounded to 200k input.
- Indices-only output: about 4,000 quotes × about 10 tokens each (for example `{"q":123,"s":4}`) = 40k output tokens. The quote count is an assumption.
- Totals, indices-only: 333k input, 50k output.
- Totals if the model re-emits the text with speaker labels: 333k input, about 180k output (133k of book text plus JSON overhead, plus the cast pass).

Cost = input × price + output × price

| Model | Indices-only | Re-emit text |
|---|---|---|
| gpt-5-nano ($0.05 / $0.40) | 0.333×0.05 + 0.05×0.40 = $0.037 | 0.017 + 0.072 = $0.089 |
| Gemini 2.5 Flash-Lite ($0.10 / $0.40) | 0.033 + 0.020 = $0.053 | 0.033 + 0.072 = $0.105 |
| gpt-6-luna ($0.10 / $0.50) | 0.033 + 0.025 = $0.058 | 0.033 + 0.090 = $0.123 |
| gpt-5.6-luna ($0.20 / $1.20) | 0.067 + 0.060 = $0.127 | 0.067 + 0.216 = $0.283 |
| Gemini 3.1 Flash-Lite ($0.25 / $1.50) | 0.083 + 0.075 = $0.158 | 0.083 + 0.270 = $0.353 |
| gpt-5-mini ($0.25 / $2.00) | 0.083 + 0.100 = $0.183 | 0.083 + 0.360 = $0.443 |
| Gemini 3.5 Flash-Lite ($0.30 / $2.50) | 0.100 + 0.125 = $0.225 | 0.100 + 0.450 = $0.550 |
| Gemini 3.8 Flash ($0.75 / $3.75) | 0.250 + 0.188 = $0.437 | 0.250 + 0.675 = $0.925 |
| gpt-5.4-mini ($0.75 / $4.50) | 0.250 + 0.225 = $0.475 | 0.250 + 0.810 = $1.060 |

- Batch mode halves each figure but is asynchronous, so it suits a background whole-book pass, not live use.
- Biggest uncertainty: reasoning ("thinking") tokens are billed as output on models that think by default and could multiply output cost several times. Thinking should be off or minimal for this task, and real token use measured on one chapter before trusting this table.
- Gemini 3.8 Flash doubles in price on 1 January 2027 according to the pricing page, so its row becomes about $0.87 indices-only.
- Even at the top of this table the LLM cost is small next to speech synthesis for a 100,000-word book (roughly 600,000 characters), so attribution cost should not drive the pipeline choice; latency and accuracy should. The synthesis comparison is my reasoning; I did not collect TTS prices in this task.
- Time: with 34 independent chunk calls run in parallel after the cast pass, total time is bounded by the slowest call plus the cast pass, plausibly well under a few minutes for a whole book and seconds for one chapter. This is an estimate without a source.

### Gaps
- OpenRouter listings for open models were not retrieved, so there is no sourced price for open models. Anthropic's small-model price was not retrieved either.
- No sourced throughput (tokens per second) or rate-limit figures for these models, so time is unmeasured.
- No published accuracy for any of these priced models on speaker attribution, so cost cannot be traded against quality from the literature; a small labelled test on real chapters is needed.
- Model names and prices come from an automated read of the official pages; confirm on the live pages.

## B3. Robust structured-output formats for speaker labelling, preventing text drift, and validating against the source

### Takeaway
Practitioner guidance favours having the model return positions or ids rather than copied text, then resolving them in code and rejecting anything that does not match the source. The open-source audiobook tools mostly do the opposite (the model re-emits text) and need a clean-up pass as a result.

### Cited Findings
- A structured-output guide recommends returning the index of a selected item rather than its text, because copying text back is unreliable, especially on messy text. — [Medium: Structured Output for Beginners](https://medium.com/@zh2408/structured-output-for-beginners-3-must-know-prompting-tips-45a28aa643c6)
- Type validation alone lets invented "verbatim" strings through; the fix is a programmatic substring check against the source, and a repair turn that sends back the invalid output with the validator's error. — [Zorost: Structured output](https://zorost.com/structured-output-llm)
- "Never trust the LLM output directly, even with structured output." — [DEV Community guide, 2026](https://dev.to/pockit_tools/llm-structured-output-in-2026-stop-parsing-json-with-regex-and-do-it-right-34pk)
- Alexandria has the model emit `{speaker, text, instruct}` for every line (re-emitting text), and its review pass exists to fix resulting faults: tags left inside dialogue, narration inside character entries, dialogue inside narrator entries. Its README describes no drift detection. — [Alexandria README](https://github.com/Finrandojin/alexandria-audiobook) (read)
- Thinking models can break JSON output unless thinking is suppressed (Alexandria's note on DeepSeek-R1 and GLM4). — [Alexandria README](https://github.com/Finrandojin/alexandria-audiobook)
- A builder's fix for wrongly voiced tags was deterministic: split on quote position in code instead of trusting the model's paragraph-level label. — [scriptorium PR #15](https://github.com/theraccoonbear/scriptorium/pull/15)
- Research systems frame attribution as choosing among candidate character mentions/aliases for each pre-identified quotation, not as text generation. — [arXiv 2608.02359](https://arxiv.org/html/2608.02359v1)

### Inferences
- Recommended shape (synthesis of the above, not a published recipe):
  1. Code, not the model, finds quoted spans (handling straight, curly and nested quotes, and paragraphs that open a quote without closing it) and numbers them. The numbered text is sent with inline markers such as `[Q17]`.
  2. The model returns only `[{"q": 17, "s": 3, "c": "high"}]`: quote id, speaker id from the supplied cast list (with reserved ids for "unknown" and "new character: name"), and a confidence label.
  3. Validation in code: every quote id present exactly once; every speaker id in the cast list; no extra ids. On failure, one repair call with the error, then fall back to narrator for the unresolved quotes.
- With this shape text drift is impossible by construction, because the audio text always comes from the book, never from the model. It is also the cheapest output (see B2).
- Enforcing a JSON schema (enum of speaker ids) through the provider's structured-output mode removes most format failures; the code check is still needed for missing or duplicated ids.

### Gaps
- No published comparison of index-based vs re-emitted-text labelling accuracy for this task.
- No source found on how reliably small models keep hundreds of ids aligned in one response; chunk size may need to be limited by quote count (for example 100 to 150 quotes per call) rather than word count. Untested.

## B4. Building and carrying a character registry across chunks

### Takeaway
The common pattern is two-stage: first extract the cast (with aliases and a short description), then attribute each chunk with the cast list passed in, plus a little trailing context from the previous chunk. Alias handling is the documented weak spot.

### Cited Findings
- Alexandria passes the character roster plus the last 3 script entries into each chunk call for "name and style continuity". — [Alexandria README](https://github.com/Finrandojin/alexandria-audiobook) (read)
- Alexandria supports speaker aliases mapping one name to another's voice, resolved transitively with cycle detection. — [Alexandria README](https://github.com/Finrandojin/alexandria-audiobook)
- Deep Dubbing and MultiActor-Audiobook both extract characters and a description first, then process dialogue. — [arXiv 2509.15845](https://arxiv.org/pdf/2509.15845); [arXiv 2505.13082](https://arxiv.org/pdf/2505.13082)
- bookcaster keeps one running conversation per chapter so the model has the chapter's earlier turns in context. — [bookcaster README](https://github.com/routhjim/bookcaster) (read)
- Commercial practice: the user reviews the detected cast, and character-to-voice assignments persist across a series. — [DEV Community](https://dev.to/fullcastbook/turning-a-manuscript-into-a-multi-voice-ai-audiobook-speaker-detection-per-character-voices-and-47f) (read)
- Research: restricting candidates to resolved characters raises accuracy; alias-based vs coreference-based candidate lists behave differently for minor characters; context windows of 500 to 2,000 tokens (4,096 for the LLM baseline) were used. — [ACL 2023](https://aclanthology.org/2023.acl-short.64.pdf); [arXiv 2608.02359](https://arxiv.org/html/2608.02359v1)

### Inferences
- Registry record per character: stable id, canonical name, aliases (titles, nicknames, surnames), gender/age hints for voice choice, and the assigned voice. The id-to-voice map must be stored per book so a character keeps one voice across chapters and sessions.
- For a just-ahead design, the model must be allowed to return "new character" with a name; code then merges it into the registry (alias match first) and assigns a voice. Voices are finite, so minor characters should share a small pool of generic voices or the narrator voice, with distinct voices reserved for the most frequent speakers.
- Passing the previous chunk's last few attributed lines (as Alexandria does) keeps alternation in untagged exchanges consistent across a chunk boundary; overlapping chunks by a few hundred tokens does the same job.
- A running conversation per chapter (bookcaster) gives the best context but grows input cost with chapter length; a fixed cast list plus short overlap is cheaper and parallelisable.

### Gaps
- No published measurements comparing rolling summary vs static cast list vs two-pass for attribution consistency.
- No documented method for merging late-discovered aliases (a character revealed to be the same person as another) in an already-voiced book.

## B5. Joining audio from different voices for seamless playback in a browser

### Takeaway
The documented pattern is to decode each segment to an AudioBuffer and schedule it on the AudioContext clock at a running `nextTime`, with a small look-ahead buffer. I found no authoritative source on loudness matching between voices; it is a known practical need but must be treated as engineering judgement.

### Cited Findings
- Scheduling pattern: decode each chunk, call `start(nextTime)`, then advance `nextTime += audioBuffer.duration` for gapless playback. — [Palabra realtime TTS docs](https://docs.palabra.ai/docs/streaming_api/realtime_tts)
- MDN: if `when` is less than `AudioContext.currentTime` (or 0), the sound plays at once, so a segment that arrives late produces a gap, not an error. — [MDN AudioBufferSourceNode.start()](https://developer.mozilla.org/en-US/docs/Web/API/AudioBufferSourceNode/start)
- Playing each chunk immediately gives the lowest latency but risks gaps from network and server variance; the fix is a jitter buffer that queues a small window of audio before starting. — [Luke Oliff: Streaming TTS](https://lukeocodes.dev/streaming-tts-rethinking-audio-pipeline)
- Front-end voice-agent architecture describes the same playback queue scheduled ahead on Web Audio's clock. — [Medium: Frontend Architecture of a Voice Agent Interface](https://ujjwaltiwari2.medium.com/frontend-architecture-of-a-voice-agent-interface-6236bfc393ba)
- MP3 segments carry encoder padding (silence at start and end); Google's Media Source Extensions gapless work removed those silent sections to get seamless joins. — [Google WebFundamentals, MSE gapless playback](https://github.com/google/WebFundamentals/pull/4121/files) (older)
- JavaScript main-thread timers are unreliable for audio timing, which is why scheduling on the audio clock is used. — [W3C public-audio list, 2013](https://lists.w3.org/Archives/Public/public-audio/2013JulSep/1511.html) (older)
- ElevenLabs notes that audio generated in multiple requests "can have pops, unnatural pauses, or tone shifts at the boundaries". — [ElevenLabs skills repo, text-to-speech](https://github.com/elevenlabs/skills/blob/main/text-to-speech/SKILL.md)
- Builders make each line individually regenerable and cached. — [DEV Community](https://dev.to/fullcastbook/turning-a-manuscript-into-a-multi-voice-ai-audiobook-speaker-detection-per-character-voices-and-47f); [bookcaster README](https://github.com/routhjim/bookcaster)

### Inferences
- For per-segment clips of different voices, Web Audio scheduling suits better than a single `<audio>` element or MediaSource: clips can be different voices, formats or sample rates (decodeAudioData resamples to the context rate), and joins are sample-accurate. The costs: playback-rate control needs handling per source node (and pitch preservation is not built in for AudioBufferSourceNode), and background/lock-screen playback on phones is less reliable than with a media element. These trade-offs are from general knowledge, not from the sources above, and need testing on a real phone.
- MP3 padding means MP3 clips joined end to end carry tens of milliseconds of silence per join; between different voices at sentence boundaries this is harmless (a pause is wanted anyway), but it matters if one sentence is split mid-clause. Requesting WAV/PCM or Opus avoids it.
- Clicks: apply a few-millisecond fade in and out per clip with a GainNode; true crossfades are unnecessary between speech segments separated by a natural pause. No source; standard practice.
- Loudness: measure each voice once (for example integrated loudness of a fixed test sentence) and store a per-voice gain, applied by a GainNode, rather than normalising every clip. ffmpeg's `loudnorm` (EBU R128) is the usual server-side tool. No source in this research; flagged as engineering judgement.
- Prefetch: keep a target of buffered audio ahead of the playhead (for example the next 2 to 3 segments or 20 to 30 seconds), synthesising in reading order; dialogue-heavy pages have more, shorter segments, so the target should be in seconds, not segment count.
- Cache key per segment: hash of (text, voice id, model, settings). Changing a character's voice then invalidates only that character's segments, and narrator audio survives.

### Gaps
- No source found on loudness mismatch between TTS voices or on recommended target levels for mixed-voice speech in a browser.
- No source comparing Web Audio vs MediaSource vs chained `<audio>` elements specifically for multi-voice book narration, including behaviour with the screen locked on iOS and Android.

## B6. Segmenting text for per-speaker synthesis so prosody stays natural

### Takeaway
Independent short requests make each clip start with fresh pitch and end with a "finished" falling tone. The documented remedies are to merge consecutive same-speaker lines into larger requests and to pass neighbouring text as context where the provider supports it.

### Cited Findings
- ElevenLabs offers `previous_text` and `next_text` (and `previous_request_ids`, maximum 3) to improve continuity across concatenated generations; if both previous_text and previous_request_ids are sent, previous_text is ignored. — [ElevenLabs API reference](https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps)
- Request stitching is unavailable on ElevenLabs v3; sources conflict on whether it works on the newer v4. — [openclaw issue #183639](https://github.com/openclaw/openclaw/issues/183639); [ElevenLabs skills repo](https://github.com/elevenlabs/skills/blob/main/text-to-speech/SKILL.md); [third-party prompt guide](https://prompt-architects.com/blog/274-elevenlabs-voice-prompt-and-direction-templates)
- With `enable_logging=false` (zero retention), history features including request-id stitching are unavailable. — [ElevenLabs API reference](https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps)
- Builder reports: separately generated clips each end with a finished, falling delivery and start with fresh pitch and energy, so the voice "resets" between messages. — [switchboard issue #94](https://github.com/Kayne19/switchboard/issues/94); [ai-radio-dj issue #363](https://github.com/Rowerguy508/ai-radio-dj/issues/363)
- Alexandria groups consecutive lines by the same speaker into one request, capped at 500 characters, "for natural flow". — [Alexandria README](https://github.com/Finrandojin/alexandria-audiobook) (read)
- Providers now also offer single-call multi-speaker synthesis: ElevenLabs has a text-to-dialogue endpoint, and Gemini TTS has a multi-speaker voice configuration. — [ElevenLabs text-to-dialogue reference](https://elevenlabs.io/docs/api-reference/text-to-dialogue/convert-with-timestamps); [bifrost issue #6423](https://github.com/maximhq/bifrost/issues/6423)

### Inferences
- Segmentation rule that follows from the above: split at quote marks (so the narrator reads the tag), then merge adjacent same-voice pieces up to a cap of a few hundred characters. A sentence such as `"No," he said, "not yet."` becomes three pieces: character, narrator, character.
- Very short pieces ("he said.") are the worst case for prosody and for request count. Options, in order of preference: pass the full sentence as previous/next context where the provider supports it; otherwise attach a short mid-sentence tag to adjoining narration when there is any; for a plain said-tag standing alone, accept the short clip.
- Context text is only valid where the same voice continues; where the neighbour is a different voice, passing the neighbouring words still tells the model the clause is unfinished (comma, not full stop), which is the main thing needed. Whether providers handle this well across different voices is untested.
- The current project's TTS already sends sentence context (per the project's TTS upgrade notes), so the same mechanism could carry cross-voice context. Verify against the provider's current documentation, since support varies by model.
- Single-call dialogue endpoints would solve prosody between speakers, but they hide per-segment boundaries, which complicates per-segment caching, word highlighting and voice swaps. Not evaluated here.

### Gaps
- No measured minimum segment length for acceptable prosody, and no listening test of split-at-tag vs whole-sentence synthesis.
- I did not check the context-passing options of other providers (Inworld, OpenAI, Google) in this research.

## B7. Pitfalls builders have reported

### Takeaway
Reported pitfalls cluster around attribution quality, tags voiced by the wrong voice, prosody resets between short clips, rate limits from many small requests, and JSON breakage from thinking models. I found no first-hand reports on loudness mismatch or on names pronounced differently by different voices.

### Cited Findings
- Attribution is the main determinant of quality; English works best because its dialogue-tag conventions are the most predictable. — [DEV Community](https://dev.to/fullcastbook/turning-a-manuscript-into-a-multi-voice-ai-audiobook-speaker-detection-per-character-voices-and-47f) (read)
- Tag voiced by the character: an entire tagged paragraph, attribution text included, came out in the character's voice. — [scriptorium PR #15](https://github.com/theraccoonbear/scriptorium/pull/15)
- Model output mixes narration into character entries and dialogue into narrator entries often enough that Alexandria ships a dedicated review pass for it. — [Alexandria README](https://github.com/Finrandojin/alexandria-audiobook) (read)
- Rate limits: a 10-speaker, 100-turn dialogue means 100 calls and hits limits if requests cluster within seconds; mitigations are exponential backoff on HTTP 429 and batching small same-speaker segments into larger chunks. — [NeuralBase ElevenLabs multi-speaker guide](https://theneuralbase.com/elevenlabs/learn/advanced/multi-speaker-handling/)
- Prosody resets between separately generated clips. — [switchboard issue #94](https://github.com/Kayne19/switchboard/issues/94)
- Thinking models break JSON output unless thinking is suppressed. — [Alexandria README](https://github.com/Finrandojin/alexandria-audiobook)
- Default prompts are English-oriented and need editing for other languages. — [Alexandria README](https://github.com/Finrandojin/alexandria-audiobook)
- Benchmarks may flatter LLMs on famous novels because of memorisation. — [arXiv 2406.11380](https://arxiv.org/html/2406.11380v1)
- Being able to re-render a single line without redoing the chapter is described as what makes the product usable. — [DEV Community](https://dev.to/fullcastbook/turning-a-manuscript-into-a-multi-voice-ai-audiobook-speaker-detection-per-character-voices-and-47f)
- Local pipelines are slow to warm up (30 to 60 s) and render at 3 to 6x real time on a 24 GB GPU. — [Alexandria README](https://github.com/Finrandojin/alexandria-audiobook)

### Inferences
- Cost multiplication: character voices do not increase the number of characters synthesised, but they reduce cache reuse (a voice change invalidates that character's clips) and increase request count; with per-request minimums or per-request latency, many short clips cost more time than money.
- Latency spikes are most likely in dialogue-heavy passages, where the segment count per minute of audio is highest; prefetch depth should be measured in seconds of audio and requests issued with limited concurrency to stay under rate limits.
- Name pronunciation drift between voices is a plausible problem (each voice may guess an unusual name differently). A per-book pronunciation entry applied to all voices would address it. No source found; flagged as a risk to test.
- Languages with different dialogue punctuation (dashes in Spanish and French, guillemets, no quote marks in some literary fiction) will break quote detection done in code; the feature should detect "no reliable quote marks" and stay single-voice for that book.

### Gaps
- No first-hand builder reports found on loudness mismatch between voices, on name pronunciation differing between voices, or on real cost figures for a shipped multi-voice reading app.
- GitHub issue search through general web search is shallow; a direct search of the issue trackers of the named projects would likely find more.
