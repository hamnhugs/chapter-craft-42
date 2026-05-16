import React, { useEffect, useMemo, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import { useApp } from "@/context/AppContext";
import { useChatSettings } from "@/hooks/useChatSettings";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Chapter } from "@/types/library";
import { toast } from "sonner";
import { Loader2, Sparkles, CheckCircle2, AlertCircle, X } from "lucide-react";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

type Detected = {
  title: string;
  startPage: number;
  endPage: number;
  source: "outline" | "toc-snapped" | "toc-raw" | "heading" | "paper-snapped" | "paper-raw" | "tiny";
  selected: boolean;
};

type Phase = "idle" | "loading-pdf" | "detecting" | "preview" | "saving";
type Mode = "toc" | "paper" | "tiny";

const normalize = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

const looksLikeFrontMatter = (title: string) => {
  const t = normalize(title);
  return /\b(preface|introduction|foreword|acknowledg|dedication|contents|about the author|copyright|prologue)\b/.test(
    t,
  ) && !/chapter\s*1\b/.test(t);
};

const AutoChapterize: React.FC = () => {
  const { books, loadBookFile, addChapter, removeChapter } = useApp();
  const { savedModels, selectedModel, apiKey, loaded } = useChatSettings();

  const [bookId, setBookId] = useState<string>("");
  const [model, setModel] = useState<string>(selectedModel || "google/gemini-3-flash-preview");
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<string>("");
  const [detected, setDetected] = useState<Detected[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("toc");
  // Paper-mode options
  const [fromPage, setFromPage] = useState<number | "">("");
  const [toPage, setToPage] = useState<number | "">("");
  const [granularity, setGranularity] = useState<"top" | "all">("top");
  const [minPages, setMinPages] = useState<number>(2);

  useEffect(() => {
    if (loaded && selectedModel) setModel(selectedModel);
  }, [loaded, selectedModel]);

  const book = useMemo(() => books.find((b) => b.id === bookId), [books, bookId]);

  // Find the existing TOC + Chapter 1 in user's saved chapters
  const { tocChapter, firstChapter } = useMemo(() => {
    if (!book) return { tocChapter: undefined, firstChapter: undefined };
    const sorted = [...book.chapters].sort((a, b) => a.startPage - b.startPage);
    const toc = sorted.find((c) => {
      const n = normalize(c.name);
      return /\bcontents\b/.test(n) || /\btoc\b/.test(n) || /\btable of contents\b/.test(n);
    });
    // Chapter 1 = first chapter that isn't TOC and isn't obvious front-matter
    const ch1 = sorted.find(
      (c) => c.id !== toc?.id && !looksLikeFrontMatter(c.name),
    );
    return { tocChapter: toc, firstChapter: ch1 };
  }, [book]);

  const canRun =
    !!book &&
    phase === "idle" &&
    (mode === "toc" ? !!tocChapter && !!firstChapter : true);

  const reset = () => {
    setDetected([]);
    setError(null);
    setProgress("");
    setPhase("idle");
  };

  const runToc = async () => {
    if (!book || !tocChapter || !firstChapter) return;
    setError(null);
    setDetected([]);

    try {
      // 1. Load PDF
      setPhase("loading-pdf");
      setProgress("Loading book…");
      const fileUrl = await loadBookFile(book.id);
      if (!fileUrl) throw new Error("Could not load this book's file from storage.");

      const loadingTask = pdfjsLib.getDocument({ url: fileUrl });
      const pdf = await loadingTask.promise;
      const totalPages = pdf.numPages;

      // 2. Try the PDF outline first (deterministic)
      setProgress("Reading PDF outline…");
      const outline = await pdf.getOutline();
      let candidates: { title: string; startPage: number; source: Detected["source"] }[] = [];

      if (outline && outline.length > 0) {
        const flat: { title: string; ref: any }[] = [];
        const walk = (items: any[]) => {
          for (const it of items) {
            flat.push({ title: it.title, ref: it.dest });
            if (it.items?.length) walk(it.items);
          }
        };
        walk(outline);

        for (const item of flat) {
          try {
            let dest = item.ref;
            if (typeof dest === "string") dest = await pdf.getDestination(dest);
            if (!dest) continue;
            const pageIndex = await pdf.getPageIndex(dest[0]);
            candidates.push({
              title: item.title.trim(),
              startPage: pageIndex + 1,
              source: "outline",
            });
          } catch {
            // ignore individual outline failures
          }
        }
        // Filter to entries AFTER known Chapter 1
        candidates = candidates.filter(
          (c) => c.startPage > firstChapter.endPage && !looksLikeFrontMatter(c.title),
        );
      }

      // 3. If outline empty/unreliable, fall back to TOC text + AI
      if (candidates.length < 2) {
        setProgress("Asking AI to parse the Table of Contents…");
        setPhase("detecting");

        // Find printed page number of Ch.1 in the TOC text
        const tocText = tocChapter.textContent || "";
        if (!tocText.trim()) {
          throw new Error(
            "TOC chapter has no extracted text. Re-save the TOC chapter from the Reader so its text is captured.",
          );
        }

        // Try to detect Ch.1's printed TOC page from TOC text
        const ch1Norm = normalize(firstChapter.name);
        let printedCh1Page: number | null = null;
        const tocLines = tocText.split(/\r?\n/);
        for (const line of tocLines) {
          if (!normalize(line).includes(ch1Norm.split(" ").slice(0, 4).join(" "))) continue;
          const m = line.match(/(\d{1,4})\s*$/);
          if (m) {
            printedCh1Page = parseInt(m[1], 10);
            break;
          }
        }
        // Fallback: assume printed = real start page
        if (!printedCh1Page) printedCh1Page = firstChapter.startPage;

        const { data, error: fnError } = await supabase.functions.invoke("auto-chapterize-toc", {
          body: {
            tocText,
            knownChapterOneTitle: firstChapter.name,
            knownChapterOnePage: printedCh1Page,
            model,
            openrouterApiKey: apiKey || undefined,
          },
        });

        if (fnError) throw new Error(fnError.message || "AI request failed");
        if ((data as any)?.error) throw new Error((data as any).error);

        const aiChapters: { title: string; page: number }[] = (data as any)?.chapters || [];
        if (aiChapters.length === 0) {
          throw new Error("AI could not find any chapters in the TOC text.");
        }

        // Compute offset from Ch.1 anchor: real - printed
        const offset = firstChapter.startPage - printedCh1Page;

        candidates = aiChapters
          .map((c) => ({
            title: c.title.trim(),
            startPage: c.page + offset,
            source: "toc-raw" as const,
          }))
          .filter((c) => c.startPage > firstChapter.endPage && c.startPage <= totalPages)
          .filter((c) => !looksLikeFrontMatter(c.title));
      }

      if (candidates.length === 0) {
        throw new Error("No further chapters detected after Chapter 1.");
      }

      // 4. Snap each predicted start page to the real heading (±3 pages)
      setPhase("detecting");
      setProgress("Locating chapter starts in the book…");

      const pageTextCache = new Map<number, string>();
      const getPageText = async (pageNum: number) => {
        if (pageTextCache.has(pageNum)) return pageTextCache.get(pageNum)!;
        if (pageNum < 1 || pageNum > totalPages) return "";
        const page = await pdf.getPage(pageNum);
        const tc = await page.getTextContent();
        const text = tc.items.map((it: any) => it.str).join(" ");
        pageTextCache.set(pageNum, text);
        return text;
      };

      const snapped: Detected[] = [];
      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i];
        const titleNorm = normalize(c.title).split(" ").slice(0, 5).join(" ");
        let bestPage = c.startPage;
        let snappedHere: Detected["source"] = c.source;

        if (c.source !== "outline" && titleNorm.length > 2) {
          let foundAt: number | null = null;
          for (let delta = 0; delta <= 3; delta++) {
            for (const sign of delta === 0 ? [0] : [-1, 1]) {
              const p = c.startPage + sign * delta;
              if (p < 1 || p > totalPages) continue;
              const text = normalize(await getPageText(p));
              if (text.includes(titleNorm)) {
                foundAt = p;
                break;
              }
            }
            if (foundAt) break;
          }
          if (foundAt) {
            bestPage = foundAt;
            snappedHere = "toc-snapped";
          }
        }

        snapped.push({
          title: c.title,
          startPage: bestPage,
          endPage: 0,
          source: snappedHere,
          selected: true,
        });
      }

      // Sort by start page, dedupe
      snapped.sort((a, b) => a.startPage - b.startPage);
      const deduped: Detected[] = [];
      for (const c of snapped) {
        if (deduped.length && deduped[deduped.length - 1].startPage === c.startPage) continue;
        deduped.push(c);
      }

      // 5. Compute end pages
      for (let i = 0; i < deduped.length; i++) {
        deduped[i].endPage = i === deduped.length - 1 ? totalPages : deduped[i + 1].startPage - 1;
      }

      setProgress("Extracting chapter text…");
      // pre-warm text cache for any pages we'll save (light pass — full extraction happens on save)

      setDetected(deduped);
      setPhase("preview");
      setProgress("");
      toast.success(`Detected ${deduped.length} chapter${deduped.length === 1 ? "" : "s"}`);
    } catch (e: any) {
      console.error(e);
      setError(e?.message || "Detection failed");
      setPhase("idle");
      setProgress("");
      toast.error(e?.message || "Detection failed");
    }
  };

  const runPaper = async () => {
    if (!book) return;
    setError(null);
    setDetected([]);

    try {
      setPhase("loading-pdf");
      setProgress("Loading book…");
      const fileUrl = await loadBookFile(book.id);
      if (!fileUrl) throw new Error("Could not load this book's file from storage.");

      const pdf = await pdfjsLib.getDocument({ url: fileUrl }).promise;
      const totalPages = pdf.numPages;

      const startP = Math.max(1, typeof fromPage === "number" ? fromPage : 1);
      const endP = Math.min(totalPages, typeof toPage === "number" ? toPage : totalPages);
      if (endP <= startP) throw new Error("Invalid page range.");

      // 1. Try outline
      setProgress("Reading PDF outline…");
      const outline = await pdf.getOutline();
      let candidates: { title: string; startPage: number; level: number; source: Detected["source"] }[] = [];

      if (outline && outline.length > 0) {
        const flat: { title: string; ref: any; level: number }[] = [];
        const walk = (items: any[], lvl: number) => {
          for (const it of items) {
            flat.push({ title: it.title, ref: it.dest, level: lvl });
            if (it.items?.length) walk(it.items, lvl + 1);
          }
        };
        walk(outline, 1);

        for (const item of flat) {
          try {
            let dest = item.ref;
            if (typeof dest === "string") dest = await pdf.getDestination(dest);
            if (!dest) continue;
            const pageIndex = await pdf.getPageIndex(dest[0]);
            candidates.push({
              title: item.title.trim(),
              startPage: pageIndex + 1,
              level: item.level,
              source: "outline",
            });
          } catch {
            // ignore
          }
        }
        candidates = candidates.filter(
          (c) => c.startPage >= startP && c.startPage <= endP &&
            (granularity === "all" || c.level === 1),
        );
      }

      // 2. Heading-regex fallback + AI cleanup
      if (candidates.length < 2) {
        setPhase("detecting");
        setProgress("Scanning pages for section headings…");

        const pageTextCache = new Map<number, string>();
        const getPageText = async (pageNum: number) => {
          if (pageTextCache.has(pageNum)) return pageTextCache.get(pageNum)!;
          if (pageNum < 1 || pageNum > totalPages) return "";
          const page = await pdf.getPage(pageNum);
          const tc = await page.getTextContent();
          // Reconstruct with line breaks where y changes
          let lastY: number | null = null;
          let out = "";
          for (const it of tc.items as any[]) {
            const y = it.transform?.[5];
            if (lastY !== null && Math.abs(y - lastY) > 2) out += "\n";
            out += (it.str || "") + " ";
            lastY = y;
          }
          pageTextCache.set(pageNum, out);
          return out;
        };

        const namedRe = /^\s*(abstract|introduction|background|related work|motivation|methods?|materials and methods|methodology|experiments?|experimental setup|results?|evaluation|analysis|discussion|conclusion|conclusions|future work|limitations|references|bibliography|appendix(?:\s+[a-z])?|acknowledgments?|acknowledgements?)\b[^a-z0-9]*$/i;
        const numericRe = /^\s*(\d+(?:\.\d+){0,3})\s+([A-Z][\w\-:,'’ ]{2,80})\s*$/;

        const candidatePool: { page: number; level: number; text: string }[] = [];
        for (let p = startP; p <= endP; p++) {
          if (p % 25 === 0) setProgress(`Scanning pages… ${p}/${endP}`);
          const txt = await getPageText(p);
          const lines = txt.split(/\r?\n/);
          for (const raw of lines) {
            const line = raw.trim();
            if (line.length < 2 || line.length > 120) continue;
            const numMatch = line.match(numericRe);
            if (numMatch) {
              const num = numMatch[1];
              const level = (num.match(/\./g)?.length ?? 0) + 1;
              if (granularity === "top" && level > 1) continue;
              candidatePool.push({ page: p, level, text: line });
              continue;
            }
            if (namedRe.test(line)) {
              candidatePool.push({ page: p, level: 1, text: line });
            }
          }
        }

        if (candidatePool.length === 0) {
          throw new Error("No section-heading candidates found in the chosen page range.");
        }

        setProgress("Asking AI to pick real sections…");
        const { data, error: fnError } = await supabase.functions.invoke("auto-chapterize-paper", {
          body: {
            candidates: candidatePool,
            granularity,
            fromPage: startP,
            toPage: endP,
            model,
            openrouterApiKey: apiKey || undefined,
          },
        });

        if (fnError) throw new Error(fnError.message || "AI request failed");
        if ((data as any)?.error) throw new Error((data as any).error);

        const aiSections: { title: string; page: number; level: number }[] =
          (data as any)?.sections || [];
        if (aiSections.length === 0) {
          throw new Error("AI did not find any real sections in the candidates.");
        }

        candidates = aiSections
          .filter((s) => s.page >= startP && s.page <= endP)
          .filter((s) => granularity === "all" || s.level === 1)
          .map((s) => ({
            title: s.title.trim(),
            startPage: s.page,
            level: s.level,
            source: "paper-raw" as const,
          }));
      }

      if (candidates.length === 0) {
        throw new Error("No sections detected.");
      }

      // 3. Sort, dedupe, compute end pages
      candidates.sort((a, b) => a.startPage - b.startPage);
      const deduped: Detected[] = [];
      for (const c of candidates) {
        if (deduped.length && deduped[deduped.length - 1].startPage === c.startPage) continue;
        deduped.push({
          title: c.title,
          startPage: c.startPage,
          endPage: 0,
          source: c.source,
          selected: true,
        });
      }
      for (let i = 0; i < deduped.length; i++) {
        deduped[i].endPage = i === deduped.length - 1 ? endP : deduped[i + 1].startPage - 1;
      }

      // 4. Min length filter
      const filtered = deduped.filter(
        (d) => d.endPage - d.startPage + 1 >= Math.max(1, minPages),
      );
      // recompute end pages after filtering
      for (let i = 0; i < filtered.length; i++) {
        filtered[i].endPage = i === filtered.length - 1 ? endP : filtered[i + 1].startPage - 1;
      }

      if (filtered.length === 0) {
        throw new Error("All detected sections were shorter than the minimum page length.");
      }

      setDetected(filtered);
      setPhase("preview");
      setProgress("");
      toast.success(`Detected ${filtered.length} section${filtered.length === 1 ? "" : "s"}`);
    } catch (e: any) {
      console.error(e);
      setError(e?.message || "Detection failed");
      setPhase("idle");
      setProgress("");
      toast.error(e?.message || "Detection failed");
    }
  };

  const run = () => (mode === "toc" ? runToc() : runPaper());

  const updateRow = (i: number, patch: Partial<Detected>) => {
    setDetected((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  };

  const save = async () => {
    if (!book) return;
    if (mode === "toc" && !firstChapter) return;
    const toSave = detected.filter((d) => d.selected);
    if (toSave.length === 0) {
      toast.error("Nothing selected to save");
      return;
    }
    setPhase("saving");
    setProgress("Saving chapters…");

    try {
      if (mode === "toc" && firstChapter) {
        // Preserve TOC + Ch.1; replace anything after
        const cutoff = firstChapter.endPage;
        const existingToReplace = book.chapters.filter((c) => c.startPage > cutoff);
        for (const c of existingToReplace) {
          await removeChapter(book.id, c.id);
        }
      } else if (mode === "paper") {
        // Replace any existing chapters that overlap the user's chosen range
        const lo = toSave[0].startPage;
        const hi = toSave[toSave.length - 1].endPage;
        const existingToReplace = book.chapters.filter(
          (c) => c.endPage >= lo && c.startPage <= hi,
        );
        for (const c of existingToReplace) {
          await removeChapter(book.id, c.id);
        }
      }

      // Reload PDF for text extraction
      const fileUrl = await loadBookFile(book.id);
      const pdf = await pdfjsLib.getDocument({ url: fileUrl }).promise;

      let saved = 0;
      for (const row of toSave) {
        setProgress(`Saving ${++saved}/${toSave.length}: ${row.title.slice(0, 40)}…`);
        let text = "";
        for (let p = row.startPage; p <= row.endPage; p++) {
          try {
            const page = await pdf.getPage(p);
            const tc = await page.getTextContent();
            text += tc.items.map((it: any) => it.str).join(" ") + "\n\n";
          } catch {
            // skip page on extract failure
          }
        }

        const newChapter: Chapter = {
          id: crypto.randomUUID(),
          name: row.title,
          startPage: row.startPage,
          endPage: row.endPage,
          textContent: text.trim(),
        };
        await addChapter(book.id, newChapter);
      }

      toast.success(`Saved ${toSave.length} chapter${toSave.length === 1 ? "" : "s"}`);
      reset();
    } catch (e: any) {
      console.error(e);
      toast.error(e?.message || "Failed to save chapters");
      setPhase("preview");
      setProgress("");
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 space-y-6">
        <header className="space-y-2">
          <div className="flex items-center gap-2">
            <Sparkles className="w-6 h-6 text-accent" />
            <h1 className="font-headline text-3xl font-bold text-primary">Auto-Chapterize</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            Pick a book, choose a model, and let AI detect every chapter after Chapter 1
            using the book's Table of Contents as the anchor.
          </p>
        </header>

        {/* Book picker */}
        <section className="space-y-2">
          <Label htmlFor="book-select">Book</Label>
          <Select
            value={bookId}
            onValueChange={(v) => {
              setBookId(v);
              reset();
            }}
            disabled={phase !== "idle"}
          >
            <SelectTrigger id="book-select" className="bg-card">
              <SelectValue placeholder="Select a book from your library" />
            </SelectTrigger>
            <SelectContent>
              {books.length === 0 ? (
                <div className="px-3 py-2 text-sm text-muted-foreground">
                  No books in your library yet.
                </div>
              ) : (
                books.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.title}
                  </SelectItem>
                ))
              )}
            </SelectContent>
          </Select>
        </section>

        {/* Mode switcher */}
        <section className="space-y-2">
          <Label>Detection mode</Label>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => { setMode("toc"); reset(); }}
              disabled={phase !== "idle"}
              className={`text-left rounded-lg border p-3 text-sm transition-colors ${
                mode === "toc"
                  ? "border-accent bg-accent/10"
                  : "border-border bg-card hover:bg-muted/40"
              }`}
            >
              <div className="font-semibold">Book with Table of Contents</div>
              <div className="text-xs text-muted-foreground mt-1">
                Uses the saved TOC + Chapter 1 to detect every chapter.
              </div>
            </button>
            <button
              type="button"
              onClick={() => { setMode("paper"); reset(); }}
              disabled={phase !== "idle"}
              className={`text-left rounded-lg border p-3 text-sm transition-colors ${
                mode === "paper"
                  ? "border-accent bg-accent/10"
                  : "border-border bg-card hover:bg-muted/40"
              }`}
            >
              <div className="font-semibold">Research paper / no TOC</div>
              <div className="text-xs text-muted-foreground mt-1">
                Detects sections (Abstract, Methods, 2.1, …) when there is no TOC.
              </div>
            </button>
          </div>
        </section>

        {/* Paper-mode options */}
        {book && mode === "paper" && (
          <section className="rounded-lg border border-border bg-card/50 p-4 space-y-3">
            <h3 className="font-semibold text-sm">Paper options</h3>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="space-y-1">
                <Label htmlFor="from-page" className="text-xs">From page</Label>
                <Input
                  id="from-page"
                  type="number"
                  min={1}
                  placeholder="1"
                  value={fromPage}
                  onChange={(e) => setFromPage(e.target.value === "" ? "" : parseInt(e.target.value) || 1)}
                  disabled={phase !== "idle"}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="to-page" className="text-xs">To page</Label>
                <Input
                  id="to-page"
                  type="number"
                  min={1}
                  placeholder="end"
                  value={toPage}
                  onChange={(e) => setToPage(e.target.value === "" ? "" : parseInt(e.target.value) || 1)}
                  disabled={phase !== "idle"}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="granularity" className="text-xs">Granularity</Label>
                <Select
                  value={granularity}
                  onValueChange={(v) => setGranularity(v as "top" | "all")}
                  disabled={phase !== "idle"}
                >
                  <SelectTrigger id="granularity" className="bg-card">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="top">Top-level only</SelectItem>
                    <SelectItem value="all">Include subsections</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="min-pages" className="text-xs">Min length (pages)</Label>
                <Input
                  id="min-pages"
                  type="number"
                  min={1}
                  value={minPages}
                  onChange={(e) => setMinPages(Math.max(1, parseInt(e.target.value) || 1))}
                  disabled={phase !== "idle"}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Trim the page range to skip cover, references, or appendices. Saving will replace any existing chapters that overlap the chosen range.
            </p>
          </section>
        )}

        {/* Pre-flight status */}
        {book && mode === "toc" && (
          <section className="rounded-lg border border-border bg-card/50 p-4 space-y-3">
            <h3 className="font-semibold text-sm">Pre-flight check</h3>
            <ul className="space-y-2 text-sm">
              <li className="flex items-center gap-2">
                {tocChapter ? (
                  <CheckCircle2 className="w-4 h-4 text-accent shrink-0" />
                ) : (
                  <AlertCircle className="w-4 h-4 text-destructive shrink-0" />
                )}
                <span>
                  Table of Contents:{" "}
                  {tocChapter ? (
                    <span className="text-muted-foreground">
                      "{tocChapter.name}" (pages {tocChapter.startPage}–{tocChapter.endPage})
                    </span>
                  ) : (
                    <span className="text-destructive">
                      Not found. Open the book in Reader and save a chapter named "Table of Contents" or "Contents".
                    </span>
                  )}
                </span>
              </li>
              <li className="flex items-center gap-2">
                {firstChapter ? (
                  <CheckCircle2 className="w-4 h-4 text-accent shrink-0" />
                ) : (
                  <AlertCircle className="w-4 h-4 text-destructive shrink-0" />
                )}
                <span>
                  Chapter 1:{" "}
                  {firstChapter ? (
                    <span className="text-muted-foreground">
                      "{firstChapter.name}" (pages {firstChapter.startPage}–{firstChapter.endPage})
                    </span>
                  ) : (
                    <span className="text-destructive">
                      Not found. Save the first real chapter from the Reader so we have an anchor.
                    </span>
                  )}
                </span>
              </li>
            </ul>
          </section>
        )}

        {/* Model picker */}
        <section className="space-y-2">
          <Label htmlFor="model-select">Model</Label>
          <Select value={model} onValueChange={setModel} disabled={phase !== "idle"}>
            <SelectTrigger id="model-select" className="bg-card">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <div className="px-2 py-1 text-[11px] uppercase tracking-wider text-muted-foreground">
                Lovable AI (no key needed)
              </div>
              <SelectItem value="google/gemini-3-flash-preview">Gemini 3 Flash (fast, default)</SelectItem>
              <SelectItem value="google/gemini-2.5-flash">Gemini 2.5 Flash</SelectItem>
              <SelectItem value="google/gemini-2.5-pro">Gemini 2.5 Pro (best for noisy TOCs)</SelectItem>
              <SelectItem value="openai/gpt-5-mini">GPT-5 Mini</SelectItem>
              <SelectItem value="openai/gpt-5">GPT-5</SelectItem>
              {savedModels.filter((m) => m && !m.startsWith("google/") && !m.startsWith("openai/gpt-5")).length > 0 && (
                <>
                  <div className="px-2 py-1 mt-1 text-[11px] uppercase tracking-wider text-muted-foreground">
                    Your OpenRouter models
                  </div>
                  {savedModels
                    .filter((m) => m && !m.startsWith("google/") && !m.startsWith("openai/gpt-5"))
                    .map((m) => (
                      <SelectItem key={m} value={m}>
                        {m}
                      </SelectItem>
                    ))}
                </>
              )}
            </SelectContent>
          </Select>
          {!model.startsWith("google/") && !model.startsWith("openai/gpt-5") && !apiKey && (
            <p className="text-xs text-primary">
              This model needs your OpenRouter API key. Add it in the Chat tab settings.
            </p>
          )}
        </section>

        {/* Run button */}
        <div className="flex flex-wrap gap-3">
          <Button onClick={run} disabled={!canRun} size="lg">
            {phase === "idle" ? (
              <>
                <Sparkles className="w-4 h-4 mr-1" />
                {mode === "toc" ? "Detect remaining chapters" : "Detect sections"}
              </>
            ) : (
              <>
                <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                Working…
              </>
            )}
          </Button>
          {phase !== "idle" && phase !== "saving" && (
            <Button variant="outline" onClick={reset}>
              <X className="w-4 h-4 mr-1" />
              Cancel
            </Button>
          )}
        </div>

        {progress && (
          <p className="text-sm text-muted-foreground flex items-center gap-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            {progress}
          </p>
        )}

        {error && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
            {error}
          </div>
        )}

        {/* Preview */}
        {detected.length > 0 && phase === "preview" && (
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold">
                Preview ({detected.filter((d) => d.selected).length}/{detected.length} selected)
              </h3>
              <Button onClick={save} disabled={detected.every((d) => !d.selected)}>
                Save selected chapters
              </Button>
            </div>

            <div className="rounded-lg border border-border divide-y divide-border bg-card">
              {detected.map((row, i) => (
                <div key={i} className="p-3 flex items-start gap-3">
                  <input
                    type="checkbox"
                    checked={row.selected}
                    onChange={(e) => updateRow(i, { selected: e.target.checked })}
                    className="mt-1.5 w-4 h-4 accent-accent"
                  />
                  <div className="flex-1 min-w-0 space-y-2">
                    <Input
                      value={row.title}
                      onChange={(e) => updateRow(i, { title: e.target.value })}
                      className="text-sm"
                    />
                    <div className="flex items-center gap-2 text-xs">
                      <span className="text-muted-foreground">Pages</span>
                      <Input
                        type="number"
                        value={row.startPage}
                        onChange={(e) => updateRow(i, { startPage: parseInt(e.target.value) || 1 })}
                        className="w-20 h-7 text-xs"
                      />
                      <span className="text-muted-foreground">–</span>
                      <Input
                        type="number"
                        value={row.endPage}
                        onChange={(e) => updateRow(i, { endPage: parseInt(e.target.value) || 1 })}
                        className="w-20 h-7 text-xs"
                      />
                      <span
                        className={`ml-auto px-2 py-0.5 rounded-full text-[10px] uppercase tracking-wider ${
                          row.source === "outline"
                            ? "bg-accent/20 text-accent"
                            : row.source === "toc-snapped"
                              ? "bg-primary/20 text-primary"
                              : "bg-muted text-muted-foreground"
                        }`}
                      >
                        {row.source.replace("-", " ")}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <p className="text-xs text-muted-foreground">
              {mode === "toc"
                ? "Existing TOC and Chapter 1 will be preserved. Any other chapters that start after Chapter 1 will be replaced."
                : "Any existing chapters overlapping the chosen page range will be replaced."}
            </p>
          </section>
        )}
      </div>
    </div>
  );
};

export default AutoChapterize;
