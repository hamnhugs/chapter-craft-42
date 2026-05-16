# Add "Tiny papers" mode to Auto Chapterizer

Add a third detection mode for PDFs that are collections of one-page papers/articles. Each page in the chosen range becomes its own chapter, with the title taken from the top of the page (first non-empty line, cleaned up).

## Changes (all in `src/components/AutoChapterize.tsx`)

1. **Mode type** — expand `type Mode = "toc" | "paper"` → `"toc" | "paper" | "tiny"`. Add `"tiny"` to the `Detected.source` union.

2. **Mode switcher UI** — add a third card next to "TOC" and "Research paper":
   - Title: "Tiny papers (1 page each)"
   - Subtitle: "Every page becomes its own chapter. Title is read from the top of the page."

3. **Tiny-mode options panel** (mirrors paper-mode panel, simpler):
   - From page / To page (defaults: 1 → last page)
   - "Pages per chapter" (default 1, min 1, max 5) — lets the user group e.g. 2-page papers
   - Optional title prefix (e.g. "Paper")

4. **Detection logic — `runTiny()`**:
   - Load the PDF, iterate `fromPage … toPage` in steps of `pagesPerChapter`.
   - For each chunk, extract text of the first page, take the first meaningful line (skip page numbers, headers shorter than 3 chars, all-caps running headers if repeated), truncate to ~100 chars → chapter title.
   - Fallback title: `"{prefix} {n} (p. {startPage})"`.
   - No AI call needed (fast, deterministic, cheap). Show progress per page.
   - Build `Detected[]` with `source: "tiny"`, `selected: true`.

5. **Wire `run()`** — extend dispatcher: `mode === "toc" ? runToc() : mode === "paper" ? runPaper() : runTiny()`.

6. **Save path** — tiny mode reuses paper-mode save branch (no TOC/Ch.1 preservation; replaces overlapping chapters in the chosen range). Update the `mode === "paper"` guards to `mode !== "toc"` where appropriate.

7. **Pre-flight** — no anchors required for tiny mode (same as paper). Update the `canRun` check.

## Notes
- No backend/edge function changes — runs fully client-side via pdfjs.
- No DB migration.
- Existing TOC and Paper modes remain untouched.
