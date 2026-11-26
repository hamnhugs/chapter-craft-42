# Quotation / speaker attribution in fiction: state of the art as of late 2026

Reading notes on scope and reliability:

- Research done 2026-11-25. Numbers marked "read in paper" were extracted from the paper text or its HTML; numbers marked "search snippet" came only from a search result summary and were not checked against the full paper.
- Almost every published accuracy number is for **classic English novels (19th to early 20th century) with standard quotation marks, gold quote spans, and a gold character/alias list**. None of them is an end-to-end number for a modern EPUB.
- I found **no published PDNC benchmark of GPT-4o / GPT-5-class, Claude, Gemini, or Qwen** models. The only LLMs with published PDNC numbers are gpt-3.5-turbo (2023) and Llama-3 8B / 70B (2024-25).

## 1. Main datasets and benchmarks, and the best reported accuracy on each

### Takeaway
PDNC is the benchmark that matters; the best published result on it is 94.5% accuracy (encoder model "Joint scoring" / ModernBookNLP, August 2026), ahead of the best published LLM result (Llama-3 8B zero-shot, about 90%). Both assume gold quote spans and a gold character list, so they are upper bounds for a real pipeline.

### Cited Findings

**PDNC (Project Dialogism Novel Corpus)**
- Original release (2022): 22 full-length English novels, 35,978 quotations, 62,587 mention annotations, 992 characters, 1,754,409 tokens (average 79,745 tokens per novel), 1.79 aliases per character on average. 655 characters speak at least once; 321 of them are "minor" (10 or fewer quotations). Read in paper. — [Vishnubhotla, Hammond, Hirst 2022, PDNC paper](https://ar5iv.labs.arxiv.org/html/2204.05836)
- Quote-type mix in PDNC: about 37% implicit, 33% explicit, 29% anaphoric. It varies widely by book: *Alice in Wonderland* is about 84% explicit, Dostoevsky's *The Gambler* about 12%. — [PDNC paper](https://ar5iv.labs.arxiv.org/html/2204.05836)
- Annotated per quote: speaker, addressees, quote type, referring expression, mentions inside the quote; plus a per-novel character list with aliases. Special speaker labels: `_narr` (first-person narrator), `_group` (unison speech), `_unknowable`. — [PDNC paper](https://ar5iv.labs.arxiv.org/html/2204.05836)
- Later extension: 28 novels, 37,131 quotes. "PDNC1" = first 22 novels (released July 2022), "PDNC2" = 6 more (released June 2023). — [Michel et al., NAACL 2025](https://arxiv.org/html/2406.11380v3)
- Scale versus older corpora: CQSA (Columbia Quoted Speech) 3,176 quotations across 6 texts; QuoteLi 3,103 quotations from three novels; LitBank 1,765 quotations across 100 novels (only the first ~2,000 tokens of each). — [PDNC paper](https://ar5iv.labs.arxiv.org/html/2204.05836)

**PDNC leaderboard, oldest to newest (accuracy, gold quotes; all read in paper unless noted)**

| Year | System | Overall | Explicit | Anaphoric | Implicit | Source |
|---|---|---|---|---|---|---|
| 2022 | Muzny et al. sieves (rule-based) | 0.62 | 0.96 | 0.48 | 0.41 | [PDNC paper](https://ar5iv.labs.arxiv.org/html/2204.05836) |
| 2022 | BookNLP off the shelf | 0.63 | 0.94 | 0.46 | 0.46 | [PDNC paper](https://ar5iv.labs.arxiv.org/html/2204.05836) |
| 2023 | BookNLP-OG (re-evaluated, coref clusters must resolve to a character) | 0.40 | 0.64 | rest 0.28 | (combined) | [Vishnubhotla et al., ACL 2023](https://arxiv.org/html/2307.03734v1) |
| 2023 | BookNLP+ fine-tuned on PDNC, random quote split | 0.78 | 0.98 | rest 0.70 | (combined) | [Vishnubhotla et al., ACL 2023](https://arxiv.org/html/2307.03734v1) |
| 2023 | BookNLP+ fine-tuned on PDNC, held-out novels | 0.68 | 0.97 | rest 0.53 | (combined) | [Vishnubhotla et al., ACL 2023](https://arxiv.org/html/2307.03734v1) |
| 2023 | SIG (BART, prompt-based generation), cross-domain | 0.72 | n/a | non-explicit 0.70 | (combined) | [Su et al., AAAI 2024 / arXiv 2312.14590](https://ar5iv.labs.arxiv.org/html/2312.14590) |
| 2023 | ChatGPT gpt-3.5-turbo-0613, zero-shot CoT, one quote at a time, lenient substring match | 0.71 | n/a | non-explicit 0.70 | (combined) | [Su et al.](https://ar5iv.labs.arxiv.org/html/2312.14590) |
| 2024 | BookNLP+ reimplementation (5-fold CV) | 78.5 ± 4.0 | 98.6 | 70.2 | 66.4 | [Michel et al., character embeddings paper](https://arxiv.org/html/2406.11368v2) |
| 2024 | BookNLP+ with UAR_Scene character embeddings | 80.2 ± 3.8 | 98.7 | 71.7 | 69.6 | [Michel et al., character embeddings paper](https://arxiv.org/html/2406.11368v2) |
| 2024-25 | Llama-3 8B Instruct, zero-shot, whole chunk at once, gold alias list | PDNC1 90.6 ± 5.2; PDNC2 88.5 ± 4.0 | 94.7; 92.8 | other 89.1; 85.7 | (combined) | [Michel et al., NAACL 2025](https://arxiv.org/html/2406.11380v3) |
| 2026 | CEQA (T=1000) | 82.6 | 98.5 | 75.3 | 73.1 | as cited in [Michel, Attali, Epure, arXiv 2608.02359](https://arxiv.org/html/2608.02359v1) |
| 2026 | GraphLit (T=500) | 86.5 ± 1.7 | 93.0 | 85.9 | 80.4 | as cited in [arXiv 2608.02359](https://arxiv.org/html/2608.02359v1) |
| 2026 | Llama-3 8B (as re-tabulated, 5-fold CV) | 89.8 ± 2.7 | 94.9 | 93.1 | 81.8 | [arXiv 2608.02359](https://arxiv.org/html/2608.02359v1) |
| 2026 | **Joint scoring, ModernBERT-large, T=2000 tokens, stride 512, coref mentions (current best)** | **94.5 ± 2.4** | **99.3** | **95.5** | **89.3** | [arXiv 2608.02359](https://arxiv.org/html/2608.02359v1) |

- The 2026 paper ("Fast and Accurate Quotation Attribution in Literary Texts", Michel, Attali, Epure; arXiv 3 Aug 2026) names the Llama-3 8B approach as the prior state of the art on PDNC and reports its own joint model at 94.5% overall and 92.4% on non-explicit quotes. — [arXiv 2608.02359](https://arxiv.org/html/2608.02359v1)
- On minor characters the same joint model scores 92.3 ± 2.3. — [arXiv 2608.02359](https://arxiv.org/html/2608.02359v1)
- Context window size matters for the encoder models: Joint scoring goes 92.7 (500 tokens) → 93.5 (1000) → 94.5 (2000). — [arXiv 2608.02359](https://arxiv.org/html/2608.02359v1)
- Truly unseen novel (published 2024, 1,530 quotes annotated by the authors, kappa 97%): Llama-3 8B 97.9, BookNLP+ 98.5, Llama-3 70B 3 errors out of 1,442 quotes (about 99.8%). The authors note this single novel is clearly easier than the PDNC average. — [Michel et al., NAACL 2025](https://arxiv.org/html/2406.11380v3)

**LitBank**
- 100 English novels written before 1923, only about 2,000 tokens each; 1,765 annotated quotations; also the standard literary coreference set. — [PDNC paper](https://ar5iv.labs.arxiv.org/html/2204.05836); [Hicke & Mimno 2024](https://arxiv.org/pdf/2401.17922)
- End-to-end quotation attribution on LitBank (no predefined character list, CoNLL-F1 over quote-to-entity clusters): BookNLP 68.1, ModernBookNLP direct 72.6, ModernBookNLP joint 77.5. With oracle coreference: 77.74 / 77.49 / 81.25. — [arXiv 2608.02359](https://arxiv.org/html/2608.02359v1)
- BookNLP's own README reports speaker attribution B3 of 86.4 (small model) and 89.9 (big model), trained and evaluated on LitBank. — [BookNLP repository](https://github.com/booknlp/booknlp)

**QuoteLi3 (Muzny et al., EACL 2017)**
- More than 6,000 annotations linking quotes to speaker mentions and speaker entities across three novels; the two-stage sieve system reaches average F-score 87.5 on the three novels and can be tuned to precision 90.4 at recall 65.1. Search snippet, older result. — [Muzny et al. 2017](https://aclanthology.org/E17-1044/)
- The same sieve system drops to 0.62 overall on PDNC (0.96 explicit, 0.48 anaphoric, 0.41 implicit). — [PDNC paper](https://ar5iv.labs.arxiv.org/html/2204.05836)

**RiQuA (Papay & Padó, LREC 2020)**
- 11 nineteenth-century English works; direct and indirect quotations, each with span, speaker, addressee and cue. Search snippet. — [RiQuA paper](https://aclanthology.org/2020.lrec-1.104)

**Other**
- WP (a Chinese web-novel speaker-identification set, one novel): SIG 86.15 test accuracy versus CSN 82.50 and E2E-SI 80.90. — [Su et al.](https://ar5iv.labs.arxiv.org/html/2312.14590)
- BookCoref (ACL 2025): book-scale character coreference, 50 silver + 3 gold books (*Animal Farm*, *Siddhartha*, *Pride and Prejudice*), average over 200,000 tokens per document. See section 5. — [BookCoref](https://arxiv.org/html/2507.12075v1)

### Inferences
- Explicit quotes ("said Alice") are solved by everything (94 to 99%). All real differences between systems are on the roughly two thirds of quotes that are anaphoric or implicit.
- The headline 94.5% and 90% figures are **not** what an app will see: they assume the quotes are already found, the character list with aliases is already known, and (for the encoder) fine-tuning on PDNC itself. The end-to-end LitBank number (77.5 CoNLL-F1) is the closest thing to a realistic full-pipeline figure and it is much lower.
- Because quote-type mix swings from 12% to 84% explicit between books, per-book accuracy will vary a lot; the ± 2 to 7 point standard deviations across novels show this.

### Gaps
- No published RiQuA or CQSA attribution numbers from 2023 onward were found; these corpora appear to have been superseded by PDNC.
- No inter-annotator agreement figure is reported in the PDNC paper (consensus rounds only), so the human ceiling is unknown.
- I could not confirm whether any 2026 paper beats 94.5% on PDNC after August 2026.

## 2. How well LLMs do, zero-shot and few-shot, and which prompt formats work

### Takeaway
A small open model (Llama-3 8B) reaches about 90% on PDNC zero-shot when it is given a whole 4,096-token chunk with numbered quotes, a character/alias list, chain-of-thought, and JSON output; one-quote-at-a-time prompting of gpt-3.5 only reached about 71%. There is no published benchmark for frontier models, though Llama-3 70B made 3 errors in 1,442 quotes on one unseen novel.

### Cited Findings

**The best-documented LLM recipe (Michel et al., NAACL 2025)**
- Chapters are cut into chunks of 4,096 tokens with a 1,024-token stride; chapters shorter than 4,096 tokens are processed whole. — [Michel et al., NAACL 2025](https://arxiv.org/html/2406.11380v3)
- Every quote in the chunk gets a numeric identifier 1..n; the model predicts all quotes in the chunk together rather than one at a time. — [Michel et al., NAACL 2025](https://arxiv.org/html/2406.11380v3)
- The prompt includes the character list with each character's aliases. Without it the model often predicted names outside the list. The authors state this makes their numbers an upper bound for an end-to-end workflow. — [Michel et al., NAACL 2025](https://arxiv.org/html/2406.11380v3)
- Output is a JSON object mapping quote id → name, after chain-of-thought reasoning. A name not in the alias list is scored wrong (no fuzzy matching). — [Michel et al., NAACL 2025](https://arxiv.org/html/2406.11380v3)
- Overlap handling, measured on PDNC2: keeping only the first prediction for each quote gives 87.6 overall (84.7 on non-explicit); feeding the previous chunk's predictions into the next chunk as context gives 88.5 (85.7). The second is what they used. — [Michel et al., NAACL 2025](https://arxiv.org/html/2406.11380v3)
- Results: 90.6 on PDNC1, 88.5 on PDNC2, 97.9 on the unseen 2024 novel; +12 points over fine-tuned BookNLP+ on PDNC1 and about +9 on PDNC2, almost all of it on non-explicit quotes (89.1 versus 68.9). On explicit quotes the LLM is actually *worse* than BookNLP+ (94.7 versus 98.6). — [Michel et al., NAACL 2025](https://arxiv.org/html/2406.11380v3)
- Llama-3 70B (4-bit quantized) on the unseen novel: 3 wrong out of 1,442 quotes. — [Michel et al., NAACL 2025](https://arxiv.org/html/2406.11380v3)
- Models were quantized (8B at 8-bit; 70B at 4-bit GGUF), so these are not full-precision numbers. — [Michel et al., NAACL 2025](https://arxiv.org/html/2406.11380v3)

**Memorization is not what drives the result**
- Name-cloze accuracy for Llama-3 8B on PDNC novels averages 4%, with 13 novels at 0%. Attribution accuracy correlates with a "reasoning from context" probe (Spearman 0.52 overall) and not with memorization probes (0.09 to 0.15 overall; memorization only correlates on explicit quotes, 0.27 to 0.34). No significant difference was found between novels released before and after the model's cutoff. — [Michel et al., NAACL 2025](https://arxiv.org/html/2406.11380v3)
- Caveat from the authors: larger models may memorize more, which was not tested; they cite GPT-4 scoring 42% name-cloze on *Dorian Gray* where Llama-3 8B scored 0%. — [Michel et al., NAACL 2025](https://arxiv.org/html/2406.11380v3)

**Older single-quote prompting (2023)**
- gpt-3.5-turbo-0613, zero-shot chain-of-thought, one target quote plus surrounding context: 0.71 overall and 0.70 non-explicit on PDNC, scored leniently with substring match and run only once because of API cost. — [Su et al., SIG paper](https://ar5iv.labs.arxiv.org/html/2312.14590)
- SIG (fine-tuned BART that generates "Speaker: X" after a "replied by: <mask>" template): 0.72 overall. Template choice mattered by 12 points (56.34% with no template versus 68.43% with the best). Adding addressee prediction as an auxiliary task raised accuracy from 68.43 to 71.59; adding gender prediction gave 69.51. — [Su et al.](https://ar5iv.labs.arxiv.org/html/2312.14590)
- The SIG paper's text claims a 9-point gain over ChatGPT, but its own table shows 0.72 versus 0.71. Treat the text claim as an error. — [Su et al.](https://ar5iv.labs.arxiv.org/html/2312.14590)
- Free-form generation can produce ambiguous names (the paper's example: Mrs. versus Mr. Beaver). — [Su et al.](https://ar5iv.labs.arxiv.org/html/2312.14590)

**LLM versus the newest encoder**
- The August 2026 joint-scoring encoder beats Llama-3 8B by about 4.7 points overall (94.5 versus 89.8) and by 7.5 points on implicit quotes (89.3 versus 81.8), while tying it on anaphoric quotes at short windows and beating it at 2,000 tokens (95.5 versus 93.1). It is trained on PDNC and depends on BookNLP mention detection and coreference. — [arXiv 2608.02359](https://arxiv.org/html/2608.02359v1)
- The key idea that transfers to prompting: scoring **all quotes in a shared window jointly** beats scoring each quote separately (94.5 versus 92.6 at the same window size). — [arXiv 2608.02359](https://arxiv.org/html/2608.02359v1)

**What open-source audiobook tools actually do (no accuracy numbers published by any of them)**
- Alexandria Audiobook: sends text to any OpenAI-compatible endpoint and gets back a JSON array of `{speaker, text, instruct}` entries with narration labeled NARRATOR; each request carries the character roster plus the last 3 script entries for continuity; an optional second "review" LLM pass strips attribution tags out of dialogue, splits narration out of character lines, and pulls dialogue out of narrator lines. It recommends non-thinking models (Qwen3, Gemma 3 27B, Qwen2.5, Llama 3.1/3.2, Mistral) and reports that thinking models and some small models break the JSON. — [Alexandria Audiobook README](https://github.com/Finrandojin/alexandria-audiobook)
- MultiActor-Audiobook (arXiv, May 2025): gpt-4o-2024-08-06 is given the full story plus one sentence and must pick a speaker from a provided character list, using cues such as "said Alice"; sentences that look like narration default to a narrator/main character. No attribution accuracy is reported; listeners' "speaker identified correctly" MOS was 2.6 (human raters) and 3.4 (multimodal-LLM rater), on only 12 short stories. — [MultiActor-Audiobook](https://arxiv.org/html/2505.13082v1)
- AudiobookAI (Brno University of Technology student project, 2026): classifies each paragraph as narration or dialogue, splits mixed paragraphs, then for each dialogue segment asks an LLM for the speaker using a sliding window of surrounding paragraphs and a running list of known characters; a second pass builds per-character profiles (name, gender, age, traits, voice description). No accuracy numbers. — [AudiobookAI poster paper](https://excel.fit.vutbr.cz/submissions/2026/056/56.pdf)
- audiobook-creator v2.0 replaced its earlier NLP step with a two-pass LLM approach for character identification, and its release notes claim better attribution. Search snippet, unverified. — [audiobook-creator v2.0 release](https://newreleases.io/project/github/prakharsr/audiobook-creator/release/v2.0)
- audiobooker (PyPI) keeps BookNLP as an optional adapter and adds a human review/export step before rendering. Search snippet. — [audiobooker](https://pypi.org/project/audiobooker-ai/)
- AudioProducer.ai (vendor blog, self-reported, AI-drafted): describes its auto-assign as "good but not perfect", names three failure cases (missing quotation marks or speech embedded in narration; characters with similar names; free indirect speech), and relies on one-click manual correction per line. — [AudioProducer.ai on DEV](https://dev.to/audioproducer-ai/how-audioproducerais-auto-assign-pipeline-turns-a-chapter-into-a-multi-voice-audio-drama-3daa)

### Inferences
- The prompt design with evidence behind it is: pre-detect the quotes yourself, number them inline, give the model a chunk of a few thousand tokens containing many quotes, give it the closed character list with aliases, ask for brief reasoning, and take a JSON map of id → canonical name. Each of these choices has a measured or reported effect: batch over single (about 71% → about 90%, confounded by model change), closed list (prevents out-of-list names), carrying previous predictions across the overlap (+0.9 overall, +1.0 on non-explicit).
- Validating that every returned name is in the roster, and re-asking when it is not, is cheap and directly addresses the failure the Llama-3 authors saw.
- A deterministic rule for explicit quotes ("said X" adjacent to the quote) is still worth having: fine-tuned BookNLP+ gets 98.6% there versus 94.7% for the LLM, so the LLM loses about 4 points on the easiest third of quotes.
- Since an 8B model at 8-bit reaches about 90% and a 70B model made 3 errors in 1,442 on one book, current hosted frontier or mid-size models (Gemini, Qwen, Llama 3.3/4-class on NVIDIA or OpenRouter) should plausibly land in the low-to-mid 90s on books of PDNC difficulty with the same recipe. This is extrapolation; nobody has published it.
- Asking for the addressee alongside the speaker may help (it did for a fine-tuned BART), and it costs few tokens; untested for zero-shot LLMs.
- Reasoning ("thinking") models can break strict JSON in practice; using a provider's structured-output mode or a non-thinking setting is the practical fix reported by tool authors.

### Gaps
- No peer-reviewed numbers for GPT-4o/GPT-5, Claude, Gemini, Qwen, or DeepSeek on PDNC or any quotation-attribution benchmark were found. Two searches specifically for this returned only the Llama-3 work.
- No controlled comparison of prompt formats on the same model (numbered quotes versus inline speaker tags versus rewriting the passage as a script; JSON versus plain lines; few-shot versus zero-shot; whole chapter versus 4k chunk). The only controlled ablations are the overlap strategy (LLM) and window size / joint versus direct (encoder).
- No few-shot LLM results at all were found; all published LLM results are zero-shot.
- No published test of what happens to LLM accuracy when the character list is LLM-generated rather than gold.

## 3. BookNLP: how it works, how accurate it is, known failures, and successors

### Takeaway
BookNLP is still the default open pipeline, but off the shelf it attributes only 40 to 63% of PDNC quotes correctly and its book-scale coreference scores 42 CoNLL-F1; its direct successor is ModernBookNLP (August 2026), which keeps the pipeline but swaps in a jointly scoring ModernBERT attribution model.

### Cited Findings
- Pipeline: entity tagging, name clustering, pronominal coreference, quote detection, and a speaker-attribution model that links each quote to a mention. Names are clustered so that "Tom", "Tom Sawyer" and "Mr. Sawyer" become one character. By default pronouns can link to names or common nouns, but common-noun phrases are **not** linked to named characters. — [BookNLP repository](https://github.com/booknlp/booknlp)
- Self-reported accuracy (LitBank): speaker attribution B3 86.4 small / 89.9 big; coreference average F1 76.4 small / 79.0 big; entity tagging F1 88.2 / 90.0. — [BookNLP repository](https://github.com/booknlp/booknlp)
- Speed: a 99K-token novel takes 2.1 to 2.2 minutes on a Titan RTX GPU, 3.6 minutes (small) or 15.4 minutes (big) on a 2019 MacBook Pro. — [BookNLP repository](https://github.com/booknlp/booknlp)
- The README itself calls book-scale coreference "still an open research problem" and says full coreference tends to merge distinct entities, which is why it is off by default. — [BookNLP repository](https://github.com/booknlp/booknlp)
- On PDNC, BookNLP off the shelf: 0.63 overall (0.94 explicit, 0.46 anaphoric, 0.46 implicit). — [PDNC paper](https://ar5iv.labs.arxiv.org/html/2204.05836)
- When a prediction only counts if the predicted mention cluster resolves to a real character, off-the-shelf BookNLP falls to 0.40 (0.64 explicit, 0.28 on the rest). On average 47.7% of quotes were assigned to a mention cluster that could not be resolved to a character, ranging from 12.5% (*The Invisible Man*) to 78.7% (*Northanger Abbey*); 76.2% of those unresolved cases were implicit or anaphoric quotes. — [Vishnubhotla et al., ACL 2023](https://arxiv.org/html/2307.03734v1)
- About 90% of BookNLP mention clusters remain unresolved to a named character; the most common error is conflating characters who share a surname (Miss Woodhouse / Mr. Woodhouse). — [Vishnubhotla et al., ACL 2023](https://arxiv.org/html/2307.03734v1)
- Character identification: BookNLP recognizes 0.85 of annotated characters on average, cluster homogeneity 0.86, and about 1.18 clusters per true character (it splits characters). GutenTag: 0.60 recognized, homogeneity 0.98, 1.33 clusters per character. — [Vishnubhotla et al., ACL 2023](https://arxiv.org/html/2307.03734v1)
- BookNLP's quote detector found PDNC quotations with 0.94 accuracy. — [Vishnubhotla et al., ACL 2023](https://arxiv.org/html/2307.03734v1)
- Fine-tuned on PDNC and restricted to resolved characters ("BookNLP+"): 0.78 on random quote split but 0.68 on unseen novels, with only 0.53 on non-explicit quotes in unseen novels. A later reimplementation with cross-validation gets 78.5 overall and 68.9 non-explicit. — [Vishnubhotla et al., ACL 2023](https://arxiv.org/html/2307.03734v1); [Michel et al. 2024](https://arxiv.org/html/2406.11368v2)
- "Unanswerable" quotes, where the true speaker has no candidate mention inside BookNLP+'s context window: 14.1% of all quotes on average, 24.5% of anaphoric, 19.8% of implicit, and from 0 to 56% depending on the novel. — [Michel et al. 2024](https://arxiv.org/html/2406.11368v2)
- Adding speaker-style character embeddings (trained on drama scripts) lifts BookNLP+ only to 80.2 overall, with the gain concentrated in implicit quotes (66.4 → 69.6). — [Michel et al. 2024](https://arxiv.org/html/2406.11368v2)
- Book-scale coreference: BookNLP scores 42.2 CoNLL-F1 on full books and 50.6 on split windows in BookCoref gold. — [BookCoref](https://arxiv.org/html/2507.12075v1)

**Successors**
- ModernBookNLP (a BookNLP fork with a ModernBERT-large joint attribution model): 94.5% on PDNC with gold characters; 77.5 end-to-end CoNLL-F1 on LitBank versus BookNLP's 68.1, at about the same speed (5.5 s versus 5.2 s per LitBank excerpt). About 2% of quotes still have no candidate mention for the true speaker at a 2,000-token window. — [arXiv 2608.02359](https://arxiv.org/html/2608.02359v1)
- The joint model picks named mentions far more often than BookNLP does (64% proper names and 13% pronouns, versus BookNLP's 23% proper names and 60% pronouns), which reduces dependence on later pronoun resolution. — [arXiv 2608.02359](https://arxiv.org/html/2608.02359v1)
- Deezer's LLM attribution code (the Llama-3 recipe) is public at github.com/deezer/llms_quotation_attribution. Search snippet. — [Michel et al., NAACL 2025](https://aclanthology.org/2025.naacl-short.62)
- For coreference specifically, Maverick_xl, Longdoc and Dual-cache are the stronger open models (see section 5). — [BookCoref](https://arxiv.org/html/2507.12075v1)

### Inferences
- BookNLP's attribution weakness is mostly a **linking** weakness: it picks a nearby mention, often a pronoun, and then the pronoun fails to resolve to a named character. A design that makes the model answer with a canonical name from a roster sidesteps this, which is exactly what the LLM recipe and the 2026 joint model do.
- BookNLP's README numbers (B3 near 90) and its PDNC numbers (0.40 to 0.63) are not contradictory; they measure different things on very different data (2,000-token openings versus whole novels). The PDNC figures are the relevant ones for a whole-book feature.
- BookNLP and its successors are Python/GPU tools; they are not usable inside a browser-side or edge-function web app without a separate service.

### Gaps
- I did not read BookNLP's source to confirm how its quote detector works or which quotation-mark styles it accepts; the README does not say.
- ModernBookNLP's repository URL, license and maturity were not verified.

## 4. Hard cases and their measured error rates

### Takeaway
The measured difficulty ordering is explicit (1 to 6% error) < anaphoric (5 to 30%) < implicit (11 to 34%), and implicit quotes in long untagged exchanges remain the largest error source for every system; most other hard cases (nested quotes, letters, thoughts, free indirect speech) are excluded from the benchmarks and have no published error rates at all.

### Cited Findings

**Error rate by quote type on PDNC (100 minus accuracy)**
- Explicit ("said Elizabeth"): rules/BookNLP 4 to 6%; fine-tuned BookNLP+ 1.4%; Llama-3 8B 5.1 to 7.2%; 2026 joint encoder 0.7%. — [PDNC paper](https://ar5iv.labs.arxiv.org/html/2204.05836); [Michel et al. 2024](https://arxiv.org/html/2406.11368v2); [Michel et al., NAACL 2025](https://arxiv.org/html/2406.11380v3); [arXiv 2608.02359](https://arxiv.org/html/2608.02359v1)
- Anaphoric ("he said", "said the old man"): rules/BookNLP 52 to 54%; BookNLP+ 29.8%; Llama-3 8B 6.9%; joint encoder 4.5%. — same sources as above
- Implicit (no tag at all): rules/BookNLP 54 to 59%; BookNLP+ 33.6%; Llama-3 8B 18.2%; joint encoder 10.7%. — same sources as above
- Share of all quotes: implicit about 37%, anaphoric about 29%, explicit about 33%. — [PDNC paper](https://ar5iv.labs.arxiv.org/html/2204.05836)

**Long untagged back-and-forth**
- In the rule-based sieve system, the "conversational pattern" sieve (alternate speakers A, B, A, B) handles 7,208 implicit quotes at only 0.52 accuracy; the final fallback sieve handles 2,380 implicit quotes at 0.30. — [PDNC paper](https://ar5iv.labs.arxiv.org/html/2204.05836)
- A simple sequence model using only the five preceding character mentions and one following mention reaches 0.65 on non-explicit quotes (random split) and 0.57 on unseen novels, i.e. turn-taking patterns alone get roughly 60%. — [Vishnubhotla et al., ACL 2023](https://arxiv.org/html/2307.03734v1)
- Carrying earlier predictions forward helps an LLM on exactly these quotes (+1.0 point on non-explicit). — [Michel et al., NAACL 2025](https://arxiv.org/html/2406.11380v3)
- Pure style (who "sounds like" whom, with no context) gets 0.67 on anaphoric and 0.54 on implicit quotes for major characters. — [PDNC paper](https://ar5iv.labs.arxiv.org/html/2204.05836)

**Speaker not mentioned nearby**
- With a 200-token window, 14.1% of quotes have no mention of the true speaker in view (up to 56% in some novels); with a 2,000-token window this falls to about 2%. — [Michel et al. 2024](https://arxiv.org/html/2406.11368v2); [arXiv 2608.02359](https://arxiv.org/html/2608.02359v1)

**Similar names**
- Shared surnames are the most common character-clustering error (Miss Woodhouse versus Woodhouse). Generative models confuse near-identical names (Mrs. versus Mr. Beaver). A commercial tool lists "characters with similar names" as a known failure. — [Vishnubhotla et al., ACL 2023](https://arxiv.org/html/2307.03734v1); [Su et al.](https://ar5iv.labs.arxiv.org/html/2312.14590); [AudioProducer.ai](https://dev.to/audioproducer-ai/how-audioproducerais-auto-assign-pipeline-turns-a-chapter-into-a-multi-voice-audio-drama-3daa)

**Minor and unnamed characters**
- PDNC evaluations normally keep only characters with at least 10 quotes; 321 of 655 speaking characters are below that line. When minor characters are included, the best 2026 model drops from 94.5 to 92.3. — [PDNC paper](https://ar5iv.labs.arxiv.org/html/2204.05836); [arXiv 2608.02359](https://arxiv.org/html/2608.02359v1)
- BookNLP by default does not link common-noun descriptions ("the old man") to named characters. — [BookNLP repository](https://github.com/booknlp/booknlp)

**First-person narrators, group speech, unknowable speakers**
- PDNC gives these dedicated labels (`_narr`, `_group`, `_unknowable`) rather than character names. — [PDNC paper](https://ar5iv.labs.arxiv.org/html/2204.05836)

**Explicitly excluded from the benchmarks (so no error rates exist)**
- The PDNC evaluation setup excludes free indirect discourse, stream of consciousness, letters, diary entries, and nested quotations. — [Vishnubhotla et al., ACL 2023](https://arxiv.org/html/2307.03734v1)
- Free indirect speech is named as a failure case by a commercial vendor. — [AudioProducer.ai](https://dev.to/audioproducer-ai/how-audioproducerais-auto-assign-pipeline-turns-a-chapter-into-a-multi-voice-audio-drama-3daa)

**Mixed narration and speech in one paragraph**
- Open-source tools treat this as its own step: AudiobookAI splits mixed paragraphs into separate narration and speech segments before attribution; Alexandria's review pass exists largely to strip "said he" tags out of character lines and to move dialogue out of narrator lines, which indicates single-pass LLM script generation makes these segmentation errors often enough to need a fix-up pass. — [AudiobookAI](https://excel.fit.vutbr.cz/submissions/2026/056/56.pdf); [Alexandria Audiobook README](https://github.com/Finrandojin/alexandria-audiobook)

### Inferences
- Interrupted quotes ('"I think," she said, "that..."') should be handled structurally, before any model call: the two quote spans in one paragraph around a speech verb share a speaker. They are explicit quotes, which rule-based sieves already get right 96 to 98% of the time.
- The practical rule "a new paragraph means a new speaker; alternate between the two people in the scene" is right only about half the time on implicit quotes when used alone (0.52), so alternation should be a hint to the LLM, not a deterministic fallback.
- A window of about 2,000 or more tokens of preceding text removes nearly all "speaker never mentioned in view" cases (14% → 2%), which is a concrete argument against per-paragraph or tiny-window prompting.
- For a read-aloud feature, a wrong voice on a quote by a one-line unnamed character is low-harm if such speakers fall back to a generic or narrator voice. Allowing explicit `NARRATOR`, `UNKNOWN` and `GROUP` answers, as PDNC does, gives the model a safe exit instead of forcing a wrong named guess.
- Quoted thoughts, letters read aloud, and nested quotes (a character quoting another) have no benchmark coverage; any handling will have to be validated on the app's own sample books.

### Gaps
- No published error rates for: interrupted quotes specifically, nested quotes, quoted thoughts versus speech, letters/diaries, first-person narrators quoting themselves, or group speech.
- No published breakdown of error rate by length of an untagged dialogue run (e.g. accuracy at turn 2 versus turn 12), for LLMs or encoders. The 2026 paper explicitly does not analyze long conversation chains.
- No published error taxonomy for the Llama-3 results.

## 5. Aliases and coreference across a whole novel

### Takeaway
Whole-book coreference is still unsolved by dedicated models (best about 67 CoNLL-F1 on full books versus about 80 on short documents), and the approaches that work are registry-style: build a character list with aliases first, then link mentions or quotes to that list, optionally keeping short per-character descriptions in memory as the book is read.

### Cited Findings
- BookCoref gold (3 full books, 229k tokens, 24k mentions): off-the-shelf systems score 41 to 47 CoNLL-F1 on full books (BookNLP 42.2, Longdoc 46.6, Dual-cache 42.5, Maverick_xl 41.2) versus 50.6 to 66.5 when the book is cut into windows. After training on BookCoref silver data: Longdoc 67.0 full-book / 77.1 windowed; Maverick_xl 61.0 / 82.2. — [BookCoref, ACL 2025](https://arxiv.org/html/2507.12075v1)
- Every system loses 10 to 30 points going from 1,500-token windows to the full book. — [BookCoref](https://arxiv.org/html/2507.12075v1)
- The BookCoref annotation pipeline itself is a registry approach and scores 80.5 CoNLL-F1 against gold: (1) take a character name list from Wikidata/LiSCU, (2) link mentions to those characters with an entity linker (ReLiK fine-tuned on LitBank, F1 83.1), (3) have a small LLM (Qwen2 7B Instruct, zero-shot) answer Yes/No on whether each linked mention really refers to that character given 400 words of context, which raised precision by about 5.2 points, (4) expand to pronouns with a windowed coreference model. — [BookCoref](https://arxiv.org/html/2507.12075v1)
- BookCoref's authors did not benchmark LLMs for coreference, citing prior work that LLMs do not beat bespoke models on medium-length documents and that whole books need more than 300,000 tokens of context. — [BookCoref](https://arxiv.org/html/2507.12075v1)
- LLMLink (COLING 2025): two instruction-tuned LLMs (Mixtral-8x7B-Instruct), one extracting entities per chapter and one resolving them against a **memory of characters and short descriptions** (for example "Pew: the blind man character in the narrative") carried from earlier chapters. Chapters are found by regex, otherwise 8,192-token chunks; maximum context 16,384 tokens. Coreference F1 on LitBank 81.5 versus 77.4 for plain Mixtral and 75.3 for gpt-3.5-turbo; on WhoLink 78.2 versus 75.6 and 74.8. The resolver outputs a JSON map of mention → canonical name or null, e.g. `{"Tom": "Tom Sawyer", "he": "Tom Sawyer", "they": null}`. — [LLMLink, COLING 2025](https://aclanthology.org/2025.coling-main.751.pdf)
- LLMLink ablation: storing a compact character cache gives +2.4 F1 over no memory at roughly 32M cumulative tokens for the LitBank test set, whereas keeping raw previous conversation as memory costs 69M tokens for similar accuracy. — [LLMLink](https://aclanthology.org/2025.coling-main.751.pdf)
- LLMLink failure noted by its authors: free-form output invents or alters strings (it rewrote "'em" to "them"), so exact-match to source text cannot be assumed. — [LLMLink](https://aclanthology.org/2025.coling-main.751.pdf)
- Marked-up output format for LLM coreference ("[Lions: 1] and [Tigers: 2]"): a fine-tuned T5-3b reaches 88.5 CoNLL-F1 on LitBank **sentences** with 70.7% of outputs reproducing the input text exactly; smaller or decoder-only models frequently altered or failed to reproduce the text. Sentence-level only. — [Hicke & Mimno 2024](https://arxiv.org/pdf/2401.17922)
- Multiple-choice mention resolution in long literary context (benchmark built from LitBank and FantasyCoref): GPT-4o was top at 81.9% accuracy. Search snippet, not read in full. — [Manikantan et al., arXiv 2411.07466](https://arxiv.org/html/2411.07466v2)
- CRAC 2025 shared task LLM track: an entry using Gemini 2.5 Pro with few-shot prompting reports CoNLL-F1 61.74 on a multilingual mini-test set, and another team reports zero-shot prompting gave poor results; LLM entries trailed the best encoder systems in the previous edition. Search snippet. — [CRAC 2025 paper](https://aclanthology.org/2025.crac-1.14.pdf); [CorefUD shared task findings](https://arxiv.org/pdf/2605.21369)
- PDNC characters have only 1.79 aliases on average, and about 45 characters per novel. — [PDNC paper](https://ar5iv.labs.arxiv.org/html/2204.05836)
- Automatic character-list builders split or merge: BookNLP finds 85% of characters but produces about 1.18 clusters per real character; shared surnames get merged. — [Vishnubhotla et al., ACL 2023](https://arxiv.org/html/2307.03734v1)
- A three-novel French study (over 285,000 tokens) also examines how document length degrades coreference and names quote attribution as a downstream consumer. Search snippet. — [The Elephant in the Coreference Room, CRAC 2025](https://arxiv.org/html/2510.15594v1)
- In audiobook tools, identity is kept by a roster that is re-sent with every request, plus an alias table mapping variants to one voice that is resolved transitively with cycle detection (example: "YOUNG ELENA" → "ELENA"). — [Alexandria Audiobook README](https://github.com/Finrandojin/alexandria-audiobook)

### Inferences
- For a voice-per-character feature the system does not need full coreference (every "he" in narration resolved). It needs one thing: each **quote** mapped to a roster entry. The published evidence says to solve that directly (quote → canonical name) rather than through general coreference, which is far weaker at book scale.
- The registry pattern is the common thread across BookCoref's pipeline, LLMLink, the Llama-3 recipe, and the hobby tools: a canonical character list with aliases and a one-line description, built once or grown chapter by chapter, and included in every attribution prompt.
- Typical rosters are small (about 45 characters, under 2 aliases each), so the full roster with aliases and one-line descriptions costs on the order of a thousand tokens or two per request and is very cacheable.
- Title and marriage name changes ("Miss Bennet" → "Mrs. Darcy") and shared surnames (several "Miss Bennet"s) are exactly where string-similarity merging fails; the alias table needs a description and gender per entry, and ambiguous aliases should be allowed to map to more than one character and be settled by scene context.
- A cheap Yes/No LLM check per uncertain link (BookCoref's refinement step, +5 points precision with a 7B model) is a proven pattern for cleaning up a registry.
- Growing the registry chapter by chapter means early chapters may be attributed before a character's real name is revealed ("the stranger"); a merge operation that re-points an existing roster id to a new canonical name (keeping the voice) is needed, rather than re-running attribution.

### Gaps
- I found no 2025-26 paper that specifically measures alias / name-variant merging accuracy (nicknames, titles, epithets, name changes) on novels.
- No published measurement of an LLM building a character list from a full novel in one long-context call (for example with a 1M-token Gemini context) against PDNC's gold lists.
- LLMLink and Hicke & Mimno are evaluated on LitBank's 2,000-token excerpts, not whole books, so their "long narrative" claims are weaker than they sound.

## 6. Quote detection across quotation conventions

### Takeaway
With standard quotation marks, detection is the easy step (BookNLP finds 94% of PDNC quotes); for dash-marked or unmarked dialogue there are only pre-LLM encoder studies (F-score about 0.81 without quotation marks on German novels) and no published LLM benchmark, so this part of the design will rest on the app's own testing.

### Cited Findings
- BookNLP's pipeline identified PDNC quotations with 0.94 accuracy; PDNC novels are conventionally punctuated classic English novels. — [Vishnubhotla et al., ACL 2023](https://arxiv.org/html/2307.03734v1)
- BookNLP's README examples show curly double quotes, curly single quotes and dash-marked speech; it does not document which conventions are supported. — [BookNLP repository](https://github.com/booknlp/booknlp)
- Older tools rely purely on quotation marks (GutenTag is described this way), and a German-novel study reports a model still reaching F-score 0.81 when quotation marks are ignored entirely in training and evaluation. Search snippet. — [Analysing Direct Speech in German Novels](https://dh-abstracts.library.virginia.edu/works/10756)
- Kurfalı & Wirén (2020) removed quotation marks from the training text and trained a multilingual-BERT token classifier to label narration versus speech, so that the model learns linguistic cues rather than typography; they report zero-shot cross-lingual results comparable to supervised baselines. Search snippet. — [Kurfalı & Wirén, LaTeCH-CLfL 2020](https://aclanthology.org/2020.latechclfl-1.12)
- A dash is ambiguous: it can open a line of dialogue or mark a pause, and many historical novels have inconsistent or missing quotation marks. Search snippet from multilingual 19th-century fiction work (9 European languages). — [Byszuk et al., LT4HALA 2020](https://aclanthology.org/2020.lt4hala-1.15)
- French typographic tradition usually does not mark direct speech with opening and closing quotation marks, which is why French direct-speech annotation is treated as a separate sequence-labelling problem. Search snippet. — [Automatic Annotation of Direct Speech in Written French Narratives](https://arxiv.org/pdf/2306.15634)
- Inconsistent typographic conventions also complicate detection in 19th-century Danish and Norwegian novels; a 2025 study found a Danish foundation encoder model best for classifying direct speech there. Search snippet. — [NoDaLiDa 2025 paper](https://preview.aclanthology.org/landing_page/2025.nodalida-1.1.pdf)
- A commercial audiobook vendor lists "missing quotation marks or speech embedded in narration" as the first known failure of its automatic assignment, and advises users to standardize punctuation in the source and re-run. — [AudioProducer.ai](https://dev.to/audioproducer-ai/how-audioproducerais-auto-assign-pipeline-turns-a-chapter-into-a-multi-voice-audio-drama-3daa)
- LLM-generated scripts mis-segment even conventionally quoted text often enough that one open tool ships a second review pass to pull dialogue out of narrator lines and narration out of character lines. — [Alexandria Audiobook README](https://github.com/Finrandojin/alexandria-audiobook)
- LLMs that re-emit text can silently change it ("'em" → "them"; only 70.7% exact reproduction for the best fine-tuned model in one study). — [LLMLink](https://aclanthology.org/2025.coling-main.751.pdf); [Hicke & Mimno 2024](https://arxiv.org/pdf/2401.17922)

### Inferences
- A two-tier design fits the evidence: (1) deterministic detection when the book uses a consistent mark style, after normalizing straight/curly, single/double, guillemets and leading dashes, and detecting the book's dominant convention once per book; (2) an LLM span-labelling fallback only for books or chapters where the deterministic pass finds almost no dialogue (the McCarthy / Rooney / dash-only case).
- Because LLMs alter text when asked to reproduce it, the LLM should return **references** (paragraph index plus sentence index or character offsets, or the numeric ids of pre-split sentences) rather than the quote text itself, so audio always comes from the original text.
- British single-quote style collides with apostrophes and with nested double quotes; a per-book convention detector (count candidate opening marks at paragraph start) is safer than a single regex for all books.
- A quote left open at the end of a paragraph (continuing speech across paragraphs, with no closing mark) is a standard convention the detector must treat as "same speaker continues".
- OCR text (missing or mismatched quote marks) will behave like the "no quotation marks" case; an unbalanced-quote count per chapter is a cheap trigger for the fallback path.

### Gaps
- No published benchmark of LLMs detecting direct speech in unmarked English fiction (McCarthy, Rooney, Saramago-style) was found; one targeted search returned none.
- No published numbers on quote detection under OCR noise for fiction.
- No verified English-fiction F1 for quote detection beyond BookNLP's 0.94 on PDNC; the 0.81 figure is German and was seen only as a search snippet.
- Claims about specific authors' conventions (Joyce's dashes, McCarthy, Rooney) are common knowledge and were not sourced here.

## 7. Cost, latency, token usage, and chunking

### Takeaway
Published evidence is thin and all from local GPUs: the Llama-3 8B recipe takes 400 to 2,800 seconds per novel versus under a second for the 2026 encoder, and the only chunking setup with accuracy evidence is 4,096-token chunks with overlap and predictions carried forward; no paper reports dollar cost or hosted-API latency.

### Cited Findings
- Llama-3 8B (8-bit) on one RTX A5000: 10 minutes to an hour per novel, about 14 GB peak memory; BookNLP+ takes a few minutes per novel. — [Michel et al., NAACL 2025](https://arxiv.org/html/2406.11380v3)
- Average attribution time per PDNC novel on an A100: joint encoder 0.43 ± 0.2 s, direct (one-quote-at-a-time) encoder 10.81 ± 5.4 s, Llama-3 8B 400 to 2,800 s; the paper summarizes the joint model as more than 1,000 times faster than the LLM. These encoder times exclude upstream BookNLP entity and coreference processing. — [arXiv 2608.02359](https://arxiv.org/html/2608.02359v1)
- BookNLP full pipeline: about 2 minutes on GPU for a 99K-token novel. — [BookNLP repository](https://github.com/booknlp/booknlp)
- An average PDNC novel is 79,745 tokens (word-level) with about 1,600 quotes (35,978 / 22). — [PDNC paper](https://ar5iv.labs.arxiv.org/html/2204.05836)
- Chunking with accuracy evidence: 4,096-token chunks, 1,024-token stride, previous predictions injected as context (88.5 versus 87.6 without). — [Michel et al., NAACL 2025](https://arxiv.org/html/2406.11380v3)
- Larger shared windows help encoders monotonically up to 2,000 tokens (92.7 → 93.5 → 94.5), and a 200-token window leaves 14.1% of quotes without their speaker in view. — [arXiv 2608.02359](https://arxiv.org/html/2608.02359v1); [Michel et al. 2024](https://arxiv.org/html/2406.11368v2)
- Memory strategy cost: for chapter-by-chapter LLM coreference, a compact character cache used about 32M cumulative tokens on the test set versus 69M when raw prior conversation was kept, for similar or better accuracy (80.3 versus 80.6 F1 before prompt optimization). The authors note cost grows quadratically if accumulated context is simply prepended. — [LLMLink](https://aclanthology.org/2025.coling-main.751.pdf)
- gpt-3.5 one-quote-at-a-time evaluation on PDNC was run only once "due to API cost" in 2023. — [Su et al.](https://ar5iv.labs.arxiv.org/html/2312.14590)
- MultiActor-Audiobook passes the full story with every sentence and its authors limited evaluation to 12 short stories because generation was costly. — [MultiActor-Audiobook](https://arxiv.org/html/2505.13082v1)
- Alexandria's reported performance figure (a 273-chunk book in about 16 minutes) is for speech rendering, not for LLM annotation. — [Alexandria Audiobook README](https://github.com/Finrandojin/alexandria-audiobook)

### Inferences
- Rough token budget for the chunked recipe on an average novel (my arithmetic, not a published figure): about 80k words is roughly 105k to 110k model tokens of book text. With overlapping 4k chunks plus a roster of one to two thousand tokens per request, input lands in the range of roughly 150k to 250k tokens per book, and output (short reasoning plus about 1,600 id → name pairs) in the low tens of thousands. Per chapter this is a few thousand to about ten thousand input tokens. At late-2026 prices for small hosted models this is cents per book, but no source confirms a dollar figure.
- One-quote-per-call designs multiply cost by the number of quotes (about 1,600 calls per novel, each re-sending context) and were also the least accurate published LLM setup; per-sentence-with-full-story designs are worse still. Batch-per-chunk is both cheaper and more accurate.
- Because the app reads aloud progressively, attribution can be done lazily per chapter (a few seconds for a hosted model on a 4k to 8k token chunk) just ahead of playback, with the roster and the last chunk's assignments as carried state, instead of processing the whole book up front.
- The stable part of the prompt (instructions plus roster) is identical across a book's requests, so provider prompt caching should cut input cost substantially; untested in the literature.
- Reasoning/"thinking" mode adds latency and has been reported to break JSON in tooling; the published 90% result used ordinary chain-of-thought text from an 8B model, so heavy reasoning is not required for the bulk of quotes. A cheap-model first pass with a stronger-model retry only on low-confidence or invalid answers is a reasonable cost design, but unmeasured.

### Gaps
- No published per-chapter or per-book dollar cost, token count, or latency for hosted LLM attribution (OpenRouter, Gemini, NVIDIA endpoints).
- No published comparison of whole-chapter or whole-book single-call attribution (long-context models) against 4k-chunk attribution.
- No published study of how accuracy changes with chunk size for LLMs (only for encoders), nor of output-length failures when one call must return hundreds of quote ids.
- No engineering write-ups with real numbers from large audiobook/TTS companies were found; the only vendor post located is qualitative and self-promotional.
