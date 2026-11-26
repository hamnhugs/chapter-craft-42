# Automatic voice casting for fiction (state as of November 2026)

Reading notes on source quality, used throughout:
- **[read]** = I opened the paper or documentation page and took the details from it.
- **[snippet]** = taken from a search-result summary only; the page itself was not opened or could not be opened. Check before relying on exact numbers.
- Papers marked "preprint" are arXiv preprints with no peer-reviewed venue confirmed.

---

## 1. What research exists on automatic voice casting / character-to-voice matching (2020 to 2026)?

### Takeaway
The research converged in 2025 to 2026 on one pipeline: an LLM reads the text, builds a per-character profile (gender, age, personality, identity), and then either (a) retrieves a voice from a described voice library by embedding similarity followed by an LLM pick, or (b) generates a new voice from the profile text. Evidence that any of this matches voices to characters *well* is thin: evaluations are small, mostly use LLM judges, and the one head-to-head with a commercial product had the commercial product winning on human ratings.

### Cited Findings

**Retrieval from a fixed voice library (most relevant to a fixed catalog)**
- AuDirector (Ren et al., Shanghai AI Laboratory and Tsinghua; arXiv v2 dated 20 May 2026, preprint) [read]. A "Director Agent" LLM turns the input into a dialogue script plus character profiles; a "Casting Agent" picks voices. The voice library is 320 speech samples "curated to cover a broad spectrum of vocal identities, including diverse ages, genders, and a wide array of acoustic profiles (e.g., varying dialects and speaking styles)". Each sample gets a text description written by Gemini-3-Pro and "subsequently verified by manual inspection". — [AuDirector](https://arxiv.org/pdf/2605.11866)
- AuDirector's selection is two-step "coarse-to-fine": (1) *Semantic filtering*: a text embedding model (EmbeddingGemma) maps the character profile and every voice description into one space and keeps the top-K candidates; (2) *Director decision*: the LLM picks the final voice from those candidates "by considering the dialogue script", so the voice fits "the emotional and character requirements of the script". The value of K is not stated in the pages read. — [AuDirector](https://arxiv.org/pdf/2605.11866)
- AuDirector results (100 scenarios: 40 podcast topics, 60 ROCStories radio dramas). Voice-Role Matching (VRM, Gemini-3-Pro judge, 1 to 5 scale on "gender, age, timbre, and delivery style"): AuDirector 4.23, PodAgent 3.59, WavJourney 2.61. Human MOS-Matching (10 raters): AuDirector 4.00 ± 0.32, PodAgent 3.48 ± 0.59, WavJourney 3.09 ± 0.67. — [AuDirector](https://arxiv.org/pdf/2605.11866)
- The AuDirector authors' explanation for the baselines' weaker matching: "baselines rely on coarse metadata and exhaustive prompt-based selection by the LLM, which degrades both precision and scalability as the audio library expands." — [AuDirector](https://arxiv.org/pdf/2605.11866)

**Generating a voice from the character profile**
- DeepDubbing (Dai et al., Tencent Music Lyra Lab and others; arXiv 19 Sep 2025, preprint) [read]. An LLM "identifies all characters and generates a structured timbre description for each", covering gender, age (child, youth, middle-aged, elderly), identity and personality. A "Text-to-Timbre" flow-matching model turns that description into a speaker embedding. Evaluated on 80 samples with a Character Matching Score (4-point scale) plus gender and age accuracy; exact values were not in the text read. Stated limitation: "the TTT model shows limitations in generating child-like voices", attributed to scarce real child speech in training data; child gender accuracy was "significantly lower". — [DeepDubbing](https://arxiv.org/html/2509.15845v1)
- MultiActor-Audiobook (Park, Joo, Jung, Seoul National University; arXiv May 2025; an Interspeech 2025 archive copy exists) [read]. GPT-4o reads the whole story, lists every speaking character plus the narrator, and writes an appearance-and-personality caption for each; a face image is generated from the caption; a voice sample is generated from face plus caption. Consistency rule: "The face images, face captions, and audio samples remain fixed for each character within a single story sample generation." — [MultiActor-Audiobook](https://arxiv.org/html/2505.13082v1); [Interspeech copy](https://www.isca-archive.org/interspeech_2025/park25e_interspeech.pdf)
- MultiActor-Audiobook results (12 stories, average 4.3 speakers and 175 sentences each, 5 human raters). Human character-consistency score: ElevenLabs 4.2, FakeYou 3.2, MultiActor 2.9, F5-TTS 2.6. The commercial baseline beat the research system on every human-rated metric; the research system only led on LLM-judge scores (3.9 vs 3.7 for character consistency). — [MultiActor-Audiobook](https://arxiv.org/html/2505.13082v1)
- "From Script to Drama" (Xia et al., Northwestern Polytechnical University; arXiv 27 Sep 2026, preprint) [read]. Not a casting paper, but its setup shows current practice: "For each character, we create a global description and use Qwen3-TTS-12Hz-1.7B-VoiceDesign to generate the reference voice", and that reference voice then conditions every line of that character. Speaker preservation is measured as cosine similarity between speaker embeddings of each utterance and the character's reference voice (0.776 Chinese, 0.791 English for the full system). — [From Script to Drama](https://arxiv.org/pdf/2609.33362)
- The same paper lists other 2025 to 2026 multi-speaker and agentic audio systems: SoulX-Podcast, VibeVoice, Fish Audio S2, Any2Speech, PodAgent, Dopamine Audiobook, Audio-Oscar, WavJourney. — [From Script to Drama](https://arxiv.org/pdf/2609.33362)

**Character attributes for voice (dataset)**
- S-VoCAL (Berthe-Pardo, Michel, Epure, Cerisara; LORIA, Deezer Research, Idiap; arXiv 1 Mar 2026, preprint) [read] is the first dataset built specifically for "speaking voice character attributes in literature". It calls the lack of character differentiation "a critical limitation of current synthetic Audiobooks". Details in section 2. — [S-VoCAL](https://arxiv.org/html/2603.00958)

**Who-says-what (the step casting depends on)**
- "Fast and Accurate Quotation Attribution in Literary Texts" (Michel, Attali, Epure; arXiv 3 Aug 2026, preprint) [read abstract page]: an encoder model with "joint scoring" reaches 94.5% attribution accuracy on PDNC (more than 35,000 annotated quotations from 22 English novels), about 20 times faster than standard methods and more than 1,000 times faster than LLM approaches on an A100 GPU. Released as ModernBookNLP. — [arXiv 2608.02359](https://arxiv.org/abs/2608.02359)
- Older (2024, revised Jan 2025): zero-shot Llama-3 8B beat earlier ChatGPT and encoder baselines on PDNC by 12 points on the first 22 novels and 9 on the rest; book memorization affected some predictions [snippet]. — [Michel et al. 2406.11380](https://arxiv.org/html/2406.11380v3)
- Older (2023): roughly two-thirds of PDNC quotations are non-explicit (no "X said" tag) [snippet]. — [SIG, 2312.14590](https://ar5iv.labs.arxiv.org/html/2312.14590)

**Shipping products and open-source tools**
- ElevenLabs "Character Casting" in Audiobooks (blog published 30 Jul 2026, updated 1 Oct 2026) [read]: "Audiobooks detects the characters in your manuscript and proposes a voice for each one", each "previewed on real dialogue from the manuscript". The post does not say which attributes drive the match. — [ElevenLabs blog](https://elevenlabs.io/blog/introducing-character-casting-in-audiobooks)
- ElevenLabs help page [read]: detection is AI-generated and "should be treated as a starting point"; it "may not identify every character", especially minor or unnamed ones. — [ElevenLabs help](https://elevenlabs.io/docs/help-center/product/studio/audiobooks/what-is-character-casting.md)
- Google Play Books auto-narration [read]: a "Detect characters" button (English only: "This feature is currently only available for English audiobooks"); "You can't undo character detection"; the publisher can add, delete and merge characters and change each one's voice and speed; text not assigned to a character is read by the default narrator. No accuracy claim is made. — [Google Play Books partner help](https://support.google.com/books/partner/answer/14183080?hl=en)
- Castbook (open source) [read README]: pipeline "parse → analyze → cast → generate → export"; self-reported attribution accuracy with a small local model (Qwen3-4B on CPU) of 95% on an Alice excerpt and 85% on a Pride and Prejudice excerpt; unresolved lines are marked `ambiguous` and sent to `needs_review` rather than guessed. — [Castbook](https://github.com/preferedev/castbook)
- Alexandria (open source, Qwen3-TTS) [read README]: the LLM returns one entry per line with `speaker`, `text`, `instruct`; a "Generate Personas" step has the LLM write a voice description and sample text per speaker, renders it with voice design, then saves that audio and reuses it as a clone reference. — [Alexandria](https://github.com/Finrandojin/alexandria-audiobook)

**Listener evidence for multi-voice AI narration**
- Edison Research at SSRS, fielded May 2026, 1,005 US fiction audiobook listeners, each randomly given a human-narrated or an AI multi-cast excerpt [snippet]: multi-cast scored higher on favorability (61% vs 53%), narration quality (66% vs 60%) and engagement (58% vs 49%) for character-driven stories; the human narrator was rated higher for exposition without multiple characters; purchase intent 46% (AI) vs 49% (human). **The study was paid for by Spoken, the multi-cast vendor.** — [Podnews press release](https://podnews.net/press-release/edison-spoken); [RAIN News](https://rainnews.com/57060-2/)

### Inferences
- For a fixed catalog, AuDirector is the closest published recipe: write a text description for every catalog voice once, embed descriptions, shortlist by similarity to the character profile, and let the LLM choose from the shortlist with the character's actual lines in view. Asking the LLM to pick from the whole catalog in one prompt is the pattern the authors report as weaker.
- Catalog voice descriptions need a human check. AuDirector's authors verified theirs by hand, and vendor catalog labels are "coarse metadata" in their terms.
- No paper shows that listeners can tell a well-cast synthetic voice from a merely plausible one beyond gender and broad age. The measured attributes are gender, age, timbre and delivery style; nothing finer has evidence behind it.
- Quotation attribution is now good enough (94.5% on classic novels) that casting quality, not attribution, is likely the visible weak point, but a 5% error rate still means roughly one wrong-voice line in twenty, which a reader hears immediately.

### Gaps
- I found no paper from 2020 to 2024 specifically on casting for audiobooks; I did not search game-studio or dubbing engineering write-ups in enough depth to say none exist. No game-studio casting write-up was found.
- No published accuracy figures for ElevenLabs Character Casting or Google Play Books character detection.
- DeepDubbing's numeric Character Matching Score, gender accuracy and age accuracy were not recovered.
- No independent (non-vendor) listener study comparing multi-voice and single-voice synthetic narration, and none measuring comprehension.

---

## 2. How do LLMs perform at extracting character profiles, and what are the known biases and failure modes?

### Takeaway
Gender is close to solved on classic novels (weighted F1 above 0.99 with small local models); coarse age is decent (about 0.80, with errors mostly between neighbouring age bands); origin, accent-relevant attributes and health are poor. Profiles built from a whole book are static and can carry late-book revelations, and the models get confused by perspective shifts.

### Cited Findings

**Accuracy by attribute (S-VoCAL, 2026, preprint) [read]**
- Data: 952 character-book pairs across 192 Project Gutenberg novels, mostly pre-1940; 8 attributes: Age (Child, Teenager, Adult, Senior), Gender (2 values), Type (human vs non-human), Spoken languages, Origin, Residence, Occupation, Physical health. — [S-VoCAL](https://arxiv.org/html/2603.00958)
- Method: find name and alias mentions by regex, take 200-word windows, embed, keep the top 10 passages per attribute query, then one LLM prompt per character covering all attributes. Models: Qwen3-8B and Phi-4 14B, both 4-bit quantized. — [S-VoCAL](https://arxiv.org/html/2603.00958)
- Gender weighted F1: 0.993 (Qwen3-8B), 0.997 (Phi-4); majority baseline 0.561. — [S-VoCAL](https://arxiv.org/html/2603.00958)
- Age weighted F1: 0.783 and 0.800 (majority baseline 0.660); "soft" F1 that gives 0.8 credit for an adjacent band: 0.927 and 0.941 (baseline 0.908). Most age errors are between adjacent classes. — [S-VoCAL](https://arxiv.org/html/2603.00958)
- Human vs non-human: 0.969 and 0.971 (baseline 0.910). For non-human characters the kind is often imprecise (for example "bird" for "crow"). — [S-VoCAL](https://arxiv.org/html/2603.00958)
- Spoken languages micro F1: 0.712 and 0.749. — [S-VoCAL](https://arxiv.org/html/2603.00958)
- Open attributes, human-aligned score on a 0 to 1 scale: Occupation 0.522 / 0.486; Residence 0.498 / 0.502; **Origin 0.420 / 0.422**; Physical health 0.141 / 0.165. Origin errors are typically "right country, wrong region" or omissions. — [S-VoCAL](https://arxiv.org/html/2603.00958)
- Even humans disagree on age: two annotators on 293 characters reached Cohen's kappa 0.56 (0.74 soft); Teenager was the hardest class (F1 0.44, n=10). — [S-VoCAL](https://arxiv.org/html/2603.00958)
- Caveats stated by the authors: the dataset is skewed toward adult, male, human characters; the books are canonical and probably memorized by LLMs, so results "may not generalize to unseen recent books"; attributes are treated as static although age, health and languages change during a story; the ethics section warns of "unintended stereotypical associations between character traits and speaking styles". — [S-VoCAL](https://arxiv.org/html/2603.00958)

**Whole-profile quality (CroSS, 2024, older) [read]**
- 126 novels published 2022 to 2023, one main character each; profiles cover attributes, relationships, events, personality. Three ways to build a profile from a long book: hierarchical merging of chunk summaries, incremental updating of a running summary, and one pass over the whole book (only for books under 120k tokens). GPT-4-Turbo consistency (1 to 5): one pass 3.95, hierarchical 3.72, incremental 3.60. Models scored higher on personality than on events. — [Yuan et al. 2404.12726](https://arxiv.org/html/2404.12726v2)
- Failure modes listed: character and relationship misidentification, "especially when narrative perspective shifts"; omission of key information; failure to revise earlier interpretations after later revelations; motives or traits summarized wrongly. Quote: "the model often becomes confused and generates illusions when faced with complex narrative structures". — [Yuan et al. 2404.12726](https://arxiv.org/html/2404.12726v2)

**Bias evidence**
- When gender is not given, LLMs writing animal stories left the character ungendered 19% of the time on average, used "it/its" 38.2% of the time, and when they did assign a gender it skewed masculine (Finkley, Li and Walsh, 2026) [snippet]. — [arXiv 2606.07969](https://arxiv.org/html/2606.07969)
- The direction is not uniform: across 106 occupations and 10 LLMs, 35 occupations were female-dominated (80% or more female characters) and only 5 male-dominated in generated stories; the authors suggest providers may have tuned for more female representation [snippet]. — [arXiv 2503.15904](https://arxiv.org/html/2503.15904v3)
- A safety-probe paper handles demographic extraction disagreement by having two models extract age and gender and setting the value to "unknown" where they disagree [snippet]. — [Phare, 2505.11365](https://arxiv.org/pdf/2505.11365)
- S-VoCAL found Qwen3 and Phi-4 errors were not linearly related per instance (the authors guess different book memorization), which is what makes a two-model agreement check informative. — [S-VoCAL](https://arxiv.org/html/2603.00958)

**Spoilers**
- A late-2025 paper on character agents says earlier systems lack story-timeline awareness, "which leads to spoiler leakage", and proposes tying what the agent knows to a point in the story [snippet]. — [arXiv 2512.07474](https://arxiv.org/html/2512.07474)
- Reading apps handle this by limiting the model to text up to the reader's position; one developer write-up says spoiler safety has to be enforced in the prompt layer because the model does not know where the reader is [snippet, product pages, low authority]. — [BookLore AI on Devpost](https://devpost.com/software/booklore-ai)

### Inferences
- Trust gender and human/non-human; treat age as a four-band estimate with a confidence value; treat origin/accent as low confidence by default (about 0.42 on a 0 to 1 scale) and do not cast an accent on it without an explicit textual statement.
- The S-VoCAL numbers are an upper bound for modern or obscure books, because the test books are ones the models have probably seen.
- An "unknown" value is a legitimate output. Forcing a binary gender on an undetermined character is where a masculine default is most likely to appear.
- A profile built from the whole book knows the ending. Any profile text shown in a cast list (for example "secretly the king's daughter", or a gender or species that is a late reveal) is a spoiler; the voice itself can be one too. Building the profile only from text up to a cut-off, or keeping a visible profile separate from the casting profile, follows directly from the timeline-awareness work.
- Retrieval of passages around name mentions (S-VoCAL's method) is cheap and works with small models; it misses characters referred to mostly by pronoun or by a changing alias.

### Gaps
- No study measures LLM gender or age extraction on post-2023 or non-English fiction specifically for voice casting.
- No paper found that measures "defaulting to male" in *extraction* from novels (as opposed to generation). The masculine-default evidence above is from story generation.
- No paper found on stereotyped accent assignment by LLM casters (for example giving a villain a particular foreign accent).
- No paper found that measures how often an extracted profile leaks a plot twist.

---

## 3. Text-described voice generation ("voice design"): who offers it, how controllable, how consistent, and can a designed voice be saved and reused?

### Takeaway
Every major vendor now follows the same two-step pattern: a design call that is *not* repeatable from the description alone, then a save/publish call that returns a permanent voice ID which *is* stable for later synthesis. Consistency therefore comes from storing the voice ID, never from re-sending the description. Stored voices are capped per account (for example 200 per project on Gemini), which limits one-designed-voice-per-character at scale.

### Cited Findings

**Inworld** [read]
- Two inputs: a voice description and a script; "the script shapes the generated voice". Descriptions up to 1,000 characters in the Portal; under 30 characters "rarely produce a useful voice". Each generation yields up to 3 previews, which are then named and saved. — [Inworld voice design](https://docs.inworld.ai/tts/voice-design.md)
- A "Structured" mode exposes the voice profile one attribute per line: dialect (language and accent), gender, age, emotion, tone, pitch, volume, speed, clarity, fluency, personality, texture, environment. — [Inworld voice design](https://docs.inworld.ai/tts/voice-design.md)
- Ad-hoc design (preview feature): pass `voiceDesign.designPrompt` (7 to 1,024 characters) instead of `voiceId` on `inworld-tts-2`; not supported on WebSocket or OpenAI-compatible endpoints. — [Inworld voice design](https://docs.inworld.ai/tts/voice-design.md)
- Determinism, exact wording: "Each request designs its own voice. Repeating the same description does not guarantee the same voice across requests." To reuse a voice: design and publish through the Voices API (`designVoice()` then `publishVoice()`), then synthesize with its `voiceId`. — [Inworld voice design](https://docs.inworld.ai/tts/voice-design.md)
- Saved designed voices count toward the plan's custom voice limit, shared with instant clones; the number is not on the page. — [Inworld voice design](https://docs.inworld.ai/tts/voice-design.md)

**ElevenLabs** [read]
- Design endpoint `POST /v1/text-to-voice/design`: `voice_description` (required), `model_id` (`eleven_multilingual_ttv_v2` default, or `eleven_ttv_v3`), `text` 100 to 1,000 characters or `auto_generate_text`, `loudness`, `guidance_scale` (default 5; "High numbers can cause voice to sound artificial or robotic"), `quality` ("Higher quality results in better voice output but less variety"), optional reference audio with `prompt_strength` on v3. Returns a list of previews, each with a `generated_voice_id`. — [ElevenLabs design endpoint](https://elevenlabs.io/docs/api-reference/text-to-voice/design.md)
- `seed`: "Same seed with same inputs produces same voice." The docs do not say this holds across model versions. — [ElevenLabs design endpoint](https://elevenlabs.io/docs/api-reference/text-to-voice/design.md)
- Save endpoint `POST /v1/text-to-voice`: "Create a voice from previously generated voice preview"; needs `voice_name`, `voice_description`, `generated_voice_id`; returns a permanent `voice_id`. — [ElevenLabs create endpoint](https://elevenlabs.io/docs/api-reference/text-to-voice/create.md)

**Google Gemini** [read]
- `POST /v1beta/voices` with `type="prompted"` and `store=True` creates "a brand-new, persistent vocal persona from a natural-language description"; the API "generates the vocal identity, stores it in your project, and returns a permanent ID". Models: `gemini-3.8-flash-tts`, `gemini-3.8-flash-lite-tts`. — [Gemini voice design](https://aistudio.google.com/docs/voice-design.md.txt)
- Limits: 200 stored voices per project (shared between prompted and replicated voices); stored voices have a one-year time-to-live. — [Gemini voice design](https://aistudio.google.com/docs/voice-design.md.txt)
- Guidance: put permanent traits (age, gender, timbre, accent) in the voice definition ("Define immutable characteristics") and use the per-turn `style` field for situational emotion "without changing the speaker's core identity". — [Gemini voice design](https://aistudio.google.com/docs/voice-design.md.txt)

**MiniMax** [read]
- `POST /v1/voice_design` takes `prompt`, `preview_text` (max 500 characters) and an optional caller-chosen `voice_id`; returns a `voice_id` "which can be used for speech synthesis" plus trial audio. Preview audio costs "$30 per 1M characters". The page states no expiry rule. — [MiniMax voice design](https://platform.minimax.io/docs/api-reference/voice-design-design.md)

**Hume Octave** [snippet; the docs page could not be read directly]
- Voice design needs Octave 1; voices designed with Octave 1 work in Octave 2 requests. A TTS call without a predefined voice returns generations with a `generation_id`; posting that ID and a name to `/v0/tts/voices` saves a reusable voice, referenced later by `id` or name. A per-utterance `description` alongside a saved voice acts as delivery direction. — [Hume voice design](https://dev.hume.ai/docs/voice/voice-design); [Hume create voice reference](https://dev.hume.ai/reference/text-to-speech-tts/voices/create)

**OpenAI gpt-4o-mini-tts** [snippet]
- No voice design: a fixed set of voices plus an `instructions` parameter that steers accent, emotional range, intonation, speed, tone, whispering. `instructions` does not work with `tts-1` or `tts-1-hd`. Dated snapshots exist (`gpt-4o-mini-tts-2025-03-20`, `gpt-4o-mini-tts-2025-12-15`). The docs list `tts-1`, `tts-1-hd` and `gpt-4o-mini-tts` as deprecated with shutdown on 6 January 2027. — [OpenAI text-to-speech guide](https://developers.openai.com/api/docs/guides/text-to-speech); [model page](https://developers.openai.com/api/docs/models/gpt-4o-mini-tts.md)

**Open models**
- Qwen3-TTS has a VoiceDesign checkpoint used in 2026 research to make one reference voice per character from a "global description" [read]. — [From Script to Drama](https://arxiv.org/pdf/2609.33362)
- Alexandria's pattern for stability with an open model: design once, save the audio to `designed_voices/`, then reuse it as a clone reference; it also stores an optional per-voice `seed`. It notes "Instruct directions are ignored for cloned voices", so locking a voice by cloning costs per-line acting control in that stack [read]. — [Alexandria](https://github.com/Finrandojin/alexandria-audiobook)
- Parler-TTS (description-conditioned open model) showed significant gender bias on occupation prompts in a NAACL 2025 Findings study [snippet]. — [Kuan and Lee, NAACL Findings 2025](https://aclanthology.org/2025.findings-naacl.298)

**Controllability and bias of designed voices**
- Thirty voices generated with ElevenLabs Voice Design (TTS v2) from the prompt "a voice that sounds [adjective]": the three "kind" voices and one "friendly" voice had very high pitch (up to 464 Hz); the other 26 sat "around the norm for the average English-speaking man"; "competent" voices were especially low; "professional" voices were all fast and "warm" voices all slow. Conclusion: "the 'default' voice indexes male gender, despite an equal balance of 'status' and 'solidarity' adjectives." (Ross, Hall-Lew, Lai, Markl; BAAP 2026 abstract) [read]. — [BAAP 2026 abstract](https://warwick.ac.uk/fac/soc/al/research/baap2026/programme/kind-is-the-opposite-of-competent-phonetic-variation-in-english-tts-voices.pdf)
- The same abstract summarizes Michel et al. (FAccT 2025): "English TTS systems are biased towards US and UK accents, even when explicitly prompted to produce African, Indian, and Australian accents". — [BAAP 2026 abstract](https://warwick.ac.uk/fac/soc/al/research/baap2026/programme/kind-is-the-opposite-of-competent-phonetic-variation-in-english-tts-voices.pdf); [Michel et al. 2504.09346](https://arxiv.org/abs/2504.09346v1)

### Inferences
- A designed voice is reproducible only through its saved ID. The cast list must store the ID returned at save time; the description is kept for explanation and for re-design if the voice is deleted, not as the source of truth.
- A personality-only description produces a male-sounding voice by default and encodes "kind = high and slow, competent = low and fast". Design prompts should always state gender and age explicitly and describe timbre and pace in neutral acoustic terms, rather than passing the LLM's personality summary straight through.
- Requested non-US/UK accents may simply not be produced, so an accent in a design prompt needs a listen-check or should be avoided.
- Account-wide caps (Inworld plan limit; Gemini 200 per project, one-year expiry) make "design a new voice for every character of every book for every user" infeasible. Designed voices are a scarce resource to spend on leads or on gaps the catalog cannot fill (child, elderly, non-human), and expiry must be handled.
- Vendors agree on separating identity (voice) from delivery (per-line style/instruction). Casting decides the first once; per-line direction can vary freely without breaking consistency.
- Model retirement breaks consistency from outside: a voice ID tied to a deprecated model (OpenAI's January 2027 shutdown is an example) cannot be kept. Storing the model/version alongside the voice ID makes this detectable.

### Gaps
- Inworld's actual custom-voice limits per plan and voice-design pricing were not on the page read.
- Hume details come from search summaries only; the fetched page returned unrelated content.
- No vendor documents how much a saved designed voice drifts between requests, model updates or long passages. No independent measurement found.
- Not confirmed whether MiniMax designed voices expire if unused.
- No published restrictions found on designing child voices in the Inworld, ElevenLabs, Gemini or MiniMax pages read.

---

## 4. How should voices be assigned when there are more characters than voices? Tiers and perceptual distinctness.

### Takeaway
There is no research that directly studies casting a cast larger than the voice pool; the tiering practice comes from tools and from human narration craft. What is supported: differences in pitch alone do not keep voices apart, embedding distance is the standard measure of voice separation, and the cheapest reliable fallback is the narrator voice.

### Cited Findings
- Human craft source (ACX, 2016, older): "voices will soon start sounding alike if you only make changes to pitch". Pat Fraley's list of differentiators beyond pitch: pitch characteristic, tempo, rhythm, placement, mouth work. — [ACX blog](https://www.acx.com/mp/blog/how-to-act-like-an-audiobook-narrator)
- The same source on accents by tier: main characters with accents are usually cast with native speakers; for secondary characters use "a light touch of the accent"; "It's better not to do the accent than to do it poorly." — [ACX blog](https://www.acx.com/mp/blog/how-to-act-like-an-audiobook-narrator)
- Synthetic voices drawn at random are much closer to one another than real speakers are: average cosine similarity between two sampled synthetic speakers was almost 0.5, against about 0.185 for real voices, so the authors ran a greedy selection step to keep only voices far apart from each other (Synth2Aug, 2020, older) [snippet]. — [Synth2Aug](https://arxiv.org/pdf/2011.11818)
- Cosine similarity between speaker embeddings (Res2Net, ECAPA-TDNN, x-vector) is the standard automatic measure of same-versus-different voice; 2026 work uses it to check that each line stays close to the character's reference voice. — [From Script to Drama](https://arxiv.org/pdf/2609.33362); [ECAPA vs x-vector study](https://arxiv.org/pdf/2506.20190) [snippet]
- Tool practice, fallback for unassigned or unresolved text: Google Play Books reads anything not assigned to a character with the default narrator; Castbook leaves unresolved lines as `ambiguous` for review instead of guessing a speaker. — [Google Play Books](https://support.google.com/books/partner/answer/14183080?hl=en); [Castbook](https://github.com/preferedev/castbook)
- Tool practice, minor characters: Alexandria calls description-only voice design "ideal for minor characters" (no saved voice needed), and uses speaker aliases to fold name variants into one voice "to reduce the number of voices to configure". — [Alexandria](https://github.com/Finrandojin/alexandria-audiobook)
- Tool practice, mixing: Castbook's cast command accepts weighted blends of catalog voices (`a:0.7+b:0.3`) and a per-character speed, which creates extra distinct voices from a small catalog on engines that support blending. — [Castbook](https://github.com/preferedev/castbook)
- Scale reference: ElevenLabs' audiobook casting supports up to 150 detected voices per book against a library of "over 10,000 voices" [150 figure is snippet; 10,000 is read]. — [ElevenLabs audiobooks docs](https://elevenlabs.io/docs/eleven-creative/products/audiobooks); [ElevenLabs blog](https://elevenlabs.io/blog/introducing-character-casting-in-audiobooks)
- Human "partially voiced" narration (subtle differentiation instead of a distinct voice per character) is described by Audible as "a happy medium" because "too many distinct character voices can be a little distracting". — [Audible UK blog](https://audible.co.uk/blog/which-audiobook-narrator-will-i-like)
- Listener data (vendor-funded, see section 1): multi-voice beat a human narrator on character-driven passages but lost on exposition without multiple characters [snippet]. — [Podnews](https://podnews.net/press-release/edison-spoken)

### Inferences
- A tiered scheme is the defensible default, though it rests on practice, not experiment:
  1. Narrator: one fixed voice for all narration and dialogue tags.
  2. Leads (ranked by number of spoken lines): one unique voice each.
  3. Recurring secondary characters: unique voice while the pool lasts, chosen to be far from the leads they share scenes with.
  4. Minor and one-line characters: a small shared pool reused across characters who never speak in the same scene, or the narrator voice with a per-line style direction.
  5. Unattributed or low-confidence lines: narrator voice.
- Reuse should be constrained by co-occurrence, not by global count: two characters can share a voice if they never appear in the same conversation. Scene-level co-occurrence comes for free from quotation attribution.
- Distinctness should be enforced among voices that co-occur, on more than pitch. With a fixed catalog this can be precomputed once: a speaker embedding per catalog voice, then a greedy farthest-first pick within each gender/age bucket. Synth2Aug's 0.5 figure is a warning that two catalog voices with the same labels can sound nearly identical.
- "Narrator voice with a pitch shift" for minor characters has no supporting evidence, and the ACX guidance argues pitch-only change blurs. Tempo and delivery instruction are better levers where the provider supports per-line style.
- Gender balance in the pool matters only relative to the cast: assign from the bucket that matches the character and widen (age band first) when a bucket runs out, since age is the least reliable extracted attribute.

### Gaps
- No study found on how many distinct synthetic voices a listener can keep apart in one book, or on confusion rates when voices are shared.
- No published threshold for "distinct enough" in speaker-embedding distance that has been validated against listener confusion.
- No research found on tiered casting or voice sharing rules; the tier scheme above is inference from tools and narrator craft.
- No evidence found for or against the narrator-with-pitch-shift approach in synthetic narration.

---

## 5. How do professional narrators and full-cast productions handle character voices?

### Takeaway
The craft consensus is restraint: differentiate by attitude, tempo and placement more than by pitch or accent, keep written notes per character from a full read-through, and skip an accent sooner than do it badly. Industry style labels (fully voiced, partially voiced, unvoiced, full cast) give a ready vocabulary for a user setting.

### Cited Findings
- ACX blog, "How to Act Like an Audiobook Narrator", by narrator Karen Commins, posted 7 April 2016 (older) [read]:
  - "The most important way to distinguish characters, though, is by playing their attitude and personality." — [ACX blog](https://www.acx.com/mp/blog/how-to-act-like-an-audiobook-narrator)
  - Dan Musselman: "A little bit of characterization goes a long way. If the character is in your head, we will hear them." The common mistake is "doing a voice rather than being the character". — [ACX blog](https://www.acx.com/mp/blog/how-to-act-like-an-audiobook-narrator)
  - Opposite-gender voices: Christina Rooney, "pitch is not the biggest discriminator in voices"; Scott Brick warns that an exaggerated voice far from one's own sounds false: "We can't share falsehood in an audiobook." — [ACX blog](https://www.acx.com/mp/blog/how-to-act-like-an-audiobook-narrator)
  - Preparation: read the whole book before developing any voice; take notes on each character's descriptions, "what the character says about himself and what others say about him"; keep a separate note page per character. — [ACX blog](https://www.acx.com/mp/blog/how-to-act-like-an-audiobook-narrator)
  - Listeners must always know who is speaking, "especially when the book doesn't include the dialogue tags". — [ACX blog](https://www.acx.com/mp/blog/how-to-act-like-an-audiobook-narrator)
- Audible's style definitions [read]: *fully voiced*, "only one voice actor is present and they supply all the different characters", "Perfect for novels needing dramatic or playful reading with lots of distinct characters"; *partially voiced*, subtle differentiation; *unvoiced*, "an absence of role-playing", generally for "novels with serious themes or ones with a strong central character"; *full cast*, "two or more actors are involved, each playing different characters", "Fantasy and children's books work particularly well for this style", but it is "tricky to get it right". — [Audible UK blog](https://audible.co.uk/blog/which-audiobook-narrator-will-i-like)
- Audible on taste: "The most important aspect when it comes to audiobooks is that the voice matches the tone and genre of the book." — [Audible UK blog](https://audible.co.uk/blog/which-audiobook-narrator-will-i-like)
- ACX's review checklist tells producers to listen for places where character voices get confused or inconsistent [snippet]. — [ACX review guide](https://www.acx.com/mp/blog/all-ears-a-comprehensive-guide-to-reviewing-your-audio)
- Publishers Weekly (2014, older): listeners need to know whether a line is dialogue or narration, and even a first-person narrator should sound different when speaking dialogue [snippet]. — [Publishers Weekly](https://publishersweekly.com/pw/print/20140609/62772-finding-your-voice.html)
- Audible's writing-for-audio guide: adverb-heavy dialogue tags are redundant in audio because the performance carries them [snippet]. — [Audible blog](https://www.audible.com/blog/writing-for-audio)
- Casting practice: the Audio Publishers Association site carries a piece by Deyan Audio's casting director (date shown as 10 June, probably 2022): "Casting the right narrator for a project then is easily the most important decision in the audiobook production process"; "It is essential to find someone who can authentically represent the events and characters who appear in it." — [APA industry news](https://www.audiopub.org/industry-news/authentic-casting)
- How automated tools treat dialogue tags: Alexandria labels narration with a `NARRATOR` speaker; its review pass strips attribution tags left inside dialogue entries and moves narration mixed into character lines back to NARRATOR. — [Alexandria](https://github.com/Finrandojin/alexandria-audiobook)

### Inferences
- The tag ("she said") belongs to the narrator voice and only the quoted words go to the character. This is how the multi-voice tools split text, and it matches the craft rule that listeners must know dialogue from narration. Rapid switching between narrator and character inside one sentence is the audible cost; a "partially voiced" mode (narrator voice with a light per-character delivery change) avoids it.
- The Audible labels map onto a three-way user setting: unvoiced (one voice), partially voiced (one voice, per-character delivery direction), full cast (a voice per character). The Edison result that single narration wins on exposition supports keeping a single-voice option.
- The narrator's per-character note page is the human version of the cast list: what the text says about the character, kept across the whole book, written before recording.
- For a first-person book the narrator *is* a character, so the narration voice and that character's dialogue voice should be the same voice, with at most a delivery difference.

### Gaps
- No source found stating how many distinct voices a single narrator can sustain.
- No formal APA or ACX rule found on dialogue tags or on character-voice differentiation; ACX's published requirements are technical (audio specs). The guidance above is blog and interview material.
- No narrator handbook was read directly; the ACX article quotes several coaches second-hand.

---

## 6. Ethical and practical pitfalls

### Takeaway
The documented risks are that voice systems fall back on male, US/UK-accented, stereotype-shaped voices, that listeners carry accent stereotypes over to synthetic voices, that child voices are technically weak, and that automated detection is admitted by vendors to be a starting point. Every shipping tool therefore lets the user change any casting, and applies the change book-wide.

### Cited Findings
- Accent: synthetic voice services are "biased towards US and UK accents, even when explicitly prompted to produce African, Indian, and Australian accents", leaving users feeling "frustrated, annoyed, and excluded" (summary of Michel et al., FAccT 2025, in the BAAP 2026 abstract). A participant in that study said a clone gave a typical Indian accent that was "not a representation of me" [paper itself is snippet]. — [BAAP 2026 abstract](https://warwick.ac.uk/fac/soc/al/research/baap2026/programme/kind-is-the-opposite-of-competent-phonetic-variation-in-english-tts-voices.pdf); [Michel et al.](https://arxiv.org/abs/2504.09346v1)
- Listeners apply traditional accent stereotypes to synthetic voices: a 2026 work-in-progress study with 16 ElevenLabs voices across Yorkshire, Southern Standard British, General American and Southern American accents found "traditional accent stereotypes persist within evaluations of synthetic speech" [snippet; PDF returned 403]. — [IAFPA 2026 WiP, Liu et al.](https://www.uni-trier.de/fileadmin/fb2/PHO/IAFPA_2026/WiP/IAFPA2026_WiP_Liu_etal.pdf)
- Gender stereotype from non-gender cues: instruction-guided TTS models pick stereotyped genders for occupation-only prompts such as "Act like a nurse"; prompt-based mitigation sometimes overcompensates (Kuan and Lee, NAACL Findings 2025) [snippet]. — [ACL Anthology](https://aclanthology.org/2025.findings-naacl.298)
- Personality-only prompts yield male-default voices, with "kind" rendered as slow, high, "almost Child-Directed Speech" and "competent" as fast and low. — [BAAP 2026 abstract](https://warwick.ac.uk/fac/soc/al/research/baap2026/programme/kind-is-the-opposite-of-competent-phonetic-variation-in-english-tts-voices.pdf)
- Non-binary or unknown gender: a gender-ambiguous neural TTS voice has been built and was judged ambiguous by listeners (Székely, Gustafson, Torre, Interspeech 2023, older); the same paper notes that "only modifying pitch is not enough to achieve a 'gender-neutral' voice quality" and that listeners may still sort such voices into binary categories [snippet]. — [Székely et al. 2023](https://www.speech.kth.se/tts-demos/szekely23_interspeech.pdf)
- In human production, non-binary characters have been cast with non-binary narrators (for example Avi Roque for *Cemetery Boys*) [snippet]. — [AudioFile Magazine](https://audiofilemagazine.com/articles/opening-doors-beyond-the-binary)
- The S-VoCAL schema has only two gender values, and the authors warn of "unintended stereotypical associations between character traits and speaking styles". — [S-VoCAL](https://arxiv.org/html/2603.00958)
- Children: text-to-timbre generation "shows limitations in generating child-like voices" because training data is mostly adults imitating children; child gender accuracy was "significantly lower". — [DeepDubbing](https://arxiv.org/html/2509.15845v1)
- Twists and changing identity: profile models fail to revise earlier interpretations after later revelations, and attribute datasets treat age and health as static though they change in the story. — [Yuan et al.](https://arxiv.org/html/2404.12726v2); [S-VoCAL](https://arxiv.org/html/2603.00958)
- Spoiler leakage from timeline-unaware character systems is a named problem [snippet]. — [arXiv 2512.07474](https://arxiv.org/html/2512.07474)
- User override is universal in shipping tools: ElevenLabs, "Swap voices until every character sounds right" and "when you change a character's voice, every line they speak updates across the entire book"; Google Play Books lets the publisher change voice and speed per character, merge characters, and delete them; Castbook has `--map name=voice`, `merge`, `rename` and per-line `review --set unit=speaker`. — [ElevenLabs blog](https://elevenlabs.io/blog/introducing-character-casting-in-audiobooks); [Google Play Books](https://support.google.com/books/partner/answer/14183080?hl=en); [Castbook](https://github.com/preferedev/castbook)
- Vendors disclaim accuracy: detection "should be treated as a starting point". — [ElevenLabs help](https://elevenlabs.io/docs/help-center/product/studio/audiobooks/what-is-character-casting.md)
- Narrator craft rule on accents: "It's better not to do the accent than to do it poorly." — [ACX blog](https://www.acx.com/mp/blog/how-to-act-like-an-audiobook-narrator)

### Inferences
- Accent should be opt-in and evidence-gated: cast an accent only when the text states where the character is from, the catalog has a voice natively in that accent, and the user has not turned accents off. Never derive accent from a name, an ethnicity guess or a role such as "villain". Origin extraction is too weak (about 0.42) and synthesized accents too unreliable to do otherwise.
- The gender field needs at least four values: female, male, non-binary/other, unknown. "Unknown" should fall back to the narrator voice or a deliberately neutral catalog voice, and must not silently become male. A gender-ambiguous voice has to be chosen by ear from the catalog, since pitch-shifting a gendered voice does not produce one.
- Child characters are the weakest case for designed voices; a young-sounding adult catalog voice is the safer cast, and vendor policy on child voices should be checked before designing any.
- For twist characters, the safe rule is to cast from what the text has revealed up to the point the character first speaks, and never display profile text in the cast list that the reader has not reached. A character who is two people under one name, or one person under two names, needs a manual merge/split control; automatic merging at the reveal would itself announce the twist if it changed a voice mid-book.
- Because detection is admittedly imperfect, the override has to be cheap, apply to every line of that character, survive re-analysis (a lock), and cover three operations: change voice, merge two characters, reassign a line.

### Gaps
- No research found on listener reactions to stereotyped accent casting in synthetic audiobooks specifically.
- No formal industry guideline (APA, ACX, narrator associations) found on voicing non-binary characters or on synthetic accent casting.
- No vendor policy text found on generating child voices.
- The Trier study's listener numbers and effect sizes were not recovered (403).
- No documented method found for handling plot-twist identities in any casting system; the handling above is inference.

---

## 7. What should a per-book cast list store so casting is stable?

### Takeaway
No paper or product publishes a full cast-list schema. Pieced together from what the systems do, the stable unit is a character record with aliases, extracted attributes with confidence, one fixed voice reference (catalog ID or saved designed-voice ID) plus a separate always-appended delivery style, and user controls (override, merge, rename-with-alias) that take priority over re-analysis.

### Cited Findings
- Fixed-per-character anchoring is the consistency mechanism in research: the persona and audio sample "remain fixed for each character within a single story sample generation"; only the line text and per-line direction change. — [MultiActor-Audiobook](https://arxiv.org/html/2505.13082v1)
- One global description plus one reference voice per character, with every line conditioned on that reference, and consistency checked by speaker-embedding similarity to it. — [From Script to Drama](https://arxiv.org/pdf/2609.33362)
- Per-line plan fields in that system: utterance text, speaker identity, expressive instruction, and context summarizing "character and scene states". — [From Script to Drama](https://arxiv.org/pdf/2609.33362)
- Alexandria's per-line fields: `speaker`, `text`, `instruct` (a "2-3 sentence TTS voice direction"). Per-voice fields seen in its API examples: `type` (built-in, clone, design, LoRA), `voice`, `character_style`, optional `seed`; stored in `voice_config.json` (schema undocumented). `character_style` is appended to every line's instruct. — [Alexandria](https://github.com/Finrandojin/alexandria-audiobook)
- Alexandria aliases: an "Alias of" mapping, resolved transitively with cycle detection. Between chunks it passes the character roster and the last 3 script entries so names stay consistent. — [Alexandria](https://github.com/Finrandojin/alexandria-audiobook)
- Castbook: `attribution.json` with `ambiguous` / `needs_review` states; `data/voice-memory.json` so "a character keeps their voice everywhere they appear", including across books; `castbook rename` keeps the old name "as an alias"; `merge` joins two characters; voice packs export and import castings; generation is resumable, and after a casting change "only un-rendered units are synthesized". — [Castbook](https://github.com/preferedev/castbook)
- Attribute schema with evidence behind it: Age in four bands, Gender, Type (human or non-human kind), Spoken languages, Origin, Residence, Occupation, Physical health. — [S-VoCAL](https://arxiv.org/html/2603.00958)
- Timbre description slots used for voice generation: age (child, youth, middle-aged, elderly), gender, identity, personality. — [DeepDubbing](https://arxiv.org/html/2509.15845v1)
- Structured voice profile attributes on the provider side: dialect, gender, age, emotion, tone, pitch, volume, speed, clarity, fluency, personality, texture, environment. — [Inworld voice design](https://docs.inworld.ai/tts/voice-design.md)
- Book-wide propagation of a change is the product norm: "when you change a character's voice, every line they speak updates across the entire book". — [ElevenLabs blog](https://elevenlabs.io/blog/introducing-character-casting-in-audiobooks)
- Google Play Books exposes per-character voice and speed, character occurrences, merge, and a separate per-chapter narrator override. — [Google Play Books](https://support.google.com/books/partner/answer/14183080?hl=en)
- Designed voices are stable only by saved ID, are capped per account, and on Gemini expire after one year. — [Inworld voice design](https://docs.inworld.ai/tts/voice-design.md); [Gemini voice design](https://aistudio.google.com/docs/voice-design.md.txt)
- A disagreement between two extraction models can be recorded as "unknown". — [Phare](https://arxiv.org/pdf/2505.11365)

### Inferences
A cast list assembled from the above (field names are suggestions; none is a published standard):

| Field | Why (source of the idea) |
|---|---|
| `book_id`, `cast_version`, `analyzed_through` (how far into the book the analysis has read) | resumable, spoiler-bounded analysis (Castbook resumability; timeline-awareness work) |
| `character_id` (stable, never reused) | anchor that survives renames (Castbook rename-as-alias) |
| `display_name`, `aliases[]` | alias mapping with transitive resolution (Alexandria, Castbook) |
| `merged_into` | merge operation (Google Play Books, Castbook) |
| `role_tier` (narrator / lead / secondary / minor), `line_count`, `first_appearance` | tiering and reuse decisions (section 4) |
| `co_speakers[]` | lets voices be shared only between characters who never talk together (section 4) |
| `attributes`: `gender` (female / male / non-binary / unknown), `age_band` (child / teen / adult / senior), `type` (human or kind), `origin`, `personality` | S-VoCAL and DeepDubbing schemas, widened for unknown and non-binary |
| per-attribute `confidence` and `evidence` (short quote or location) | extraction is unreliable for age and origin; evidence lets the user see why |
| `voice`: `provider`, `kind` (catalog / designed / narrator-shared), `voice_id`, `model` | the ID is the only repeatable handle; model recorded because models get retired |
| `design_prompt`, `design_seed` (for designed voices) | to re-create or explain a voice; seed is honoured by ElevenLabs only |
| `base_style` (text appended to every line's direction), `speed` | Alexandria `character_style`; Google Play per-character speed; Gemini identity/style split |
| `cast_reason` | explanation shown to the user |
| `locked` (user chose this), `locked_fields[]` | override must outlive re-analysis; no tool documents a lock, so this is new |
| `spoiler_safe_summary` vs internal profile | keeps reveal information out of the visible cast list |
| per-line records elsewhere: `speaker_id`, `attribution_confidence`, `needs_review`, `instruct` | Alexandria and Castbook per-line fields |

- Consistency rules that follow: voice assignment is written once and read on every synthesis call; re-analysis may add characters and fill unknown attributes but may not change a voice that has already been heard unless the user asks; a locked record is never touched; merging keeps the voice of the character with more spoken lines.
- Cached audio should be keyed by line text, voice ID, model and style, so a casting change invalidates only that character's lines, as Castbook does.
- A cross-book memory (Castbook's `voice-memory.json`) suits series: the same character in book two keeps the voice from book one. It needs a series or character key beyond the name, since names collide across unrelated books.

### Gaps
- No published cast-list schema from ElevenLabs, Google or any paper; Alexandria's and Castbook's files are only partly documented in their READMEs, and their source was not read.
- No source describes a user-lock flag or a confidence field in a casting record; both are inferred from the documented unreliability of detection.
- No source addresses what to do with a saved voice when its model is retired or its stored voice expires.
