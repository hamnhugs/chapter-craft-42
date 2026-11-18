# Book figures: saved with the chapters, shown in chat

2026-11-18 · branch `new1`

A book's diagrams, charts and photos are pulled out when its chapters are
detected, filed under the chapter each sits in, and shown inside a Counsel
reply at the sentence that talks about them.

## What was already there

`figureExtraction.ts` found raster images in a PDF and `figureJobs.ts` had a
vision model describe each one and store it as an `image_attachments` row
(`kind = 'figure'`, `book_id`, `page`). Two things kept that from being useful:

- It only ran from a button on the book card.
- Chat could reach a figure only through a note it was paired with. Notes
  stopped being generated from books in the memory redesign, so in practice
  no figure ever reached a reply.

## What changed

| Part | Where | What it does |
| --- | --- | --- |
| Automatic extraction | `Library.tsx` → `enqueueFigures` | Queues the figure job when chapter detection finishes on a new upload. Switch: Settings → Library → "Pull figures from new books" (`user_settings.auto_extract_figures`, on by default). Skipped silently without an OpenRouter key unless the user is an admin. |
| Vector figures | `figureExtraction.ts` → `clusterPathRects`, `pickVectorFigures` | Charts and diagrams drawn with path operators carry no image, so the old scan missed them. Painted-path bounding boxes are clustered on a 6 pt grid; a cluster is kept when a "Figure 3.2"-style caption sits beside it, or when it is large, has 12–1500 paths and under 400 characters of text inside. Short text runs next to a kept cluster (axis ticks, node names) are pulled into the crop. |
| Read side | `bookFigures.ts` | Loads a book's figures (cached, invalidated by `image-attachments-changed`), places each in a chapter **by page number at read time**, keyword-searches descriptions, resolves handles, parses reply markers. |
| Chat tools | `chatTools.ts` | `get_book`: a `figures` count per chapter. `get_chapter_text`: up to 8 figures nearest the text returned, each `{ fig, page, shows }`. `search_book_text`: figures whose description contains the query's words, plus figures on a matched page. `show_image` accepts a `fig` handle. No new tool. |
| Placement | system prompt + `figures_note` | The model writes `[[fig:<handle>]]` on its own line after the paragraph about the figure. |
| Rendering | `ChatPanel.tsx`, `BookFigureInline.tsx` | The marker is swapped for the picture with its label and a "Book, p. N" link that opens the reader at that page. |
| Book profile | `BookFiguresSection.tsx` | The book card's profile lists the saved figures under each chapter. |

No migration and no edge-function change: the columns and `describe-figures`
are the ones already deployed.

## Decisions, and what they rest on

**Chapter is derived, not stored.** A re-detect replaces every chapter id, but
a page number is a fact about the file. Deriving the chapter from the page at
read time means figures follow a re-detect with nothing to repair.

**Descriptions, not image embeddings.** Each figure is described once by a
vision model and retrieved through that text afterwards — the "summarise the
image, retrieve the summary, return the raw image" pattern
([LangChain multi-vector retriever](https://blog.langchain.com/semi-structured-multi-modal-rag),
[Docling picture description](https://docling-project.github.io/docling/_generated/examples/pictures_description/)).
In the ColPali paper's baselines, captioned figures searched as text scored on
par with OCR (65.1 vs 65.5 NDCG@5); page-image retrieval scored higher (81.3)
but needs an embedding model and index this app does not have
([arXiv 2407.01449](https://arxiv.org/html/2407.01449v5)).

**The model picks from a short list that arrives with the text.** Text-only
models choose figures well from captions plus surrounding text
([MRAMG-Bench](https://arxiv.org/html/2502.04176v2),
[M2RAG](https://arxiv.org/html/2411.16365v1)); M2RAG capped candidates at ten.
The list is capped at 8 and sorted by distance from the passage being read.

**An inline marker rather than a tool call for placement.** A marker puts the
picture at the sentence in one pass and costs a cheap model nothing extra;
marker-then-parser is the established shape
([LLM-I](https://arxiv.org/html/2509.13642v1)). No study compares the two
head to head — this is a judgement. `show_image` still works for "show me
that diagram".

**Short handles.** `fig` is the first 8 hex characters of the row id. A model
copies 8 characters into prose far more reliably than 36. Row-level security
scopes the lookup to the signed-in user, an ambiguous handle resolves to
nothing, and an unknown one renders nothing.

**A ceiling the app enforces.** At most 3 figures per reply, each once, none
repeated from `show_image` in the same turn; the prompt asks for at most 2.
Relevant pictures beside the text help learning (Mayer: multimedia d = 1.35,
spatial contiguity d = 0.82) and extraneous ones hurt it (coherence d = 0.86)
([Mayer 2023](https://www.unh.edu/teaching-learning-resource-hub/sites/default/files/media/2023-06/itow-research-based-principles-for-designing-multimedia-instruction-mayer.pdf)).
The specific numbers 2 and 3 are judgement, not measured.

**Vector detection follows pdffigures2 and PyMuPDF.** Bounding box per drawing
operator, merge nearby boxes, anchor on captions
([pdffigures2](https://ai2-website.s3.amazonaws.com/publications/pdf2.0.pdf),
[PyMuPDF `cluster_drawings`](https://github.com/pymupdf/PyMuPDF/blob/main/src/__init__.py)).
pdf.js 4.8 hands over each path's `minMax` box on `constructPath`; the walk
already tracked the transform and clip stacks. The thresholds are this
project's own, tuned on the test files below.

**Descriptions are untrusted.** They are a vision model's reading of book
content, so every tool door sanitizes and fences them like chapter gists.

## Considered and left out

- **A layout model in the browser** (PP-DocLayoutV3 is 74 MB, DocLayout-YOLO
  75 MB as ONNX). The download is too heavy for what the heuristics already
  get; revisit if they underperform on real books.
- **Scanned books**, where every page is one image. Needs a vision model to
  return bounding boxes per page — a `describe-figures` change and a redeploy.
- **Reading images straight from the EPUB zip.** EPUBs are still converted to
  PDF first, so their images arrive as rasters and are found; alt text and
  `<figcaption>` are lost.
- **A second "which figure, if any?" pass** for models that under-select
  (M2RAG: image recall 0.51 → 0.96 for over twice the tokens).
- **A dedicated `find_figures` tool.** The roster budget test exists to make
  that a deliberate cost; `search_book_text` carries figure matches instead.

## Tested

- `src/test/bookFigures.test.ts`, `src/test/bookFiguresTools.test.ts` — chapter
  placement, caption search, markers, vector clustering, the three tool doors,
  the "no figures → unchanged result" law. Full suite: 2,715 passing.
- The extractor, in headless Chromium against real files: a 67-page working
  paper whose charts are all vector drawings returned 19 crops (its charts,
  two tables, a logo); the old scan was not run on it for comparison. A
  303-page trade
  book returned 16 crops with no page furniture beyond what the vision step
  discards.

Not yet run: a signed-in upload → extraction → chat reply showing a figure,
on desktop or a phone.

## Existing books

Books uploaded before this change have no figures until extracted: open the
book's card → **Extract figures**. Re-running replaces that book's figures.
