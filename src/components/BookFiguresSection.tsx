import React, { useEffect, useMemo, useState } from "react";
import GeneratedImage from "@/components/GeneratedImage";
import { chapterIndexForPage, loadBookFigures, onBookFiguresChanged, type BookFigure } from "@/lib/bookFigures";
import type { BookDocument } from "@/types/library";

/** How many thumbnails a book profile opens with — each one is a signed-URL
 *  fetch, and a profile is opened far more often than its figures are browsed. */
const FIRST_SHOWN = 8;

/**
 * The figures saved with a book, filed under the chapter each sits in — the
 * picture half of the book's summary. Renders nothing for a book with no
 * extracted figures.
 */
const BookFiguresSection: React.FC<{ book: BookDocument }> = ({ book }) => {
  const [figures, setFigures] = useState<BookFigure[]>([]);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = () => { void loadBookFigures(book.id).then((f) => { if (!cancelled) setFigures(f); }); };
    setShowAll(false);
    load();
    const off = onBookFiguresChanged(load);
    return () => { cancelled = true; off(); };
  }, [book.id]);

  const groups = useMemo(() => {
    const shown = showAll ? figures : figures.slice(0, FIRST_SHOWN);
    const out: { key: string; name: string; figures: BookFigure[] }[] = [];
    for (const f of shown) {
      const idx = chapterIndexForPage(book.chapters, f.page);
      const key = idx >= 0 ? book.chapters[idx].id : "none";
      const name = idx >= 0 ? book.chapters[idx].name || `Chapter ${idx + 1}` : "Outside the chapters";
      const last = out[out.length - 1];
      if (last && last.key === key) last.figures.push(f);
      else out.push({ key, name, figures: [f] });
    }
    return out;
  }, [figures, showAll, book.chapters]);

  if (figures.length === 0) return null;

  return (
    <section>
      <h3 className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant mb-1">
        Figures · {figures.length}
      </h3>
      <div className="space-y-3">
        {groups.map((g, gi) => (
          <div key={`${g.key}-${gi}`}>
            <div className="text-xs font-semibold text-foreground mb-1 truncate">{g.name}</div>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {g.figures.map((f) => (
                <div key={f.id} className="shrink-0 w-32" title={f.caption || f.label}>
                  <GeneratedImage
                    storagePath={f.storagePath}
                    alt={f.label}
                    className="[&_img]:h-24 [&_img]:w-32 [&_img]:object-contain [&_img]:bg-white [&_img]:rounded-lg"
                  />
                  <div className="mt-1 text-[10px] leading-tight text-on-surface-variant line-clamp-2">
                    <span className="font-semibold text-foreground/80">p. {f.page}</span> · {f.label}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      {!showAll && figures.length > FIRST_SHOWN && (
        <button type="button" onClick={() => setShowAll(true)} className="mt-2 text-xs font-medium text-primary hover:underline">
          Show all {figures.length} figures
        </button>
      )}
    </section>
  );
};

export default BookFiguresSection;
