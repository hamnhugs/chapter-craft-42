import React from "react";
import { BookDocument } from "@/types/library";
import { categoryColor } from "@/lib/categoryColors";

// List view with details. Desktop: cover · title · category · tags · pages ·
// chapters · added, with sortable Title/Added headers (the two sorts the app
// already supports). Mobile: columns collapse progressively until each row is
// a two-line card — thumb + title, then a single meta line — rather than a
// horizontally scrolling table.

const relativeDate = (ts: number): string => {
  const diff = Date.now() - ts;
  const day = 86_400_000;
  if (diff < day) return "today";
  if (diff < 2 * day) return "yesterday";
  if (diff < 30 * day) return `${Math.floor(diff / day)}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
};

const LibraryList: React.FC<{
  books: BookDocument[];
  sortBy: "date" | "name";
  onSortBy: (s: "date" | "name") => void;
  onOpenBook: (bookId: string) => void;
  onRemove: (bookId: string) => void;
  highlight: (text: string) => React.ReactNode;
}> = ({ books, sortBy, onSortBy, onOpenBook, onRemove, highlight }) => {
  const Header: React.FC<{
    label: string;
    sortKey?: "date" | "name";
    className?: string;
  }> = ({ label, sortKey, className = "" }) => {
    const active = sortKey && sortBy === sortKey;
    return (
      <div
        className={`text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant ${className}`}
        aria-sort={active ? "descending" : undefined}
        role={sortKey ? "columnheader" : undefined}
      >
        {sortKey ? (
          <button
            onClick={() => onSortBy(sortKey)}
            className={`flex items-center gap-0.5 hover:text-primary transition-colors ${active ? "text-primary" : ""}`}
          >
            {label}
            {active && (
              <span className="material-symbols-outlined text-sm" aria-hidden>arrow_drop_down</span>
            )}
          </button>
        ) : (
          label
        )}
      </div>
    );
  };

  return (
    <div className="rounded-2xl border border-outline-variant/10 bg-surface-container-low overflow-hidden">
      {/* Header row (hidden on mobile where rows become 2-line cards).
          The grid template grows with the breakpoints that reveal the Tags
          (lg) and Chapters (md) cells, so columns always line up. */}
      <div className="hidden sm:grid grid-cols-[3rem_minmax(10rem,2fr)_minmax(7rem,1fr)_4rem_6rem_2.5rem] md:grid-cols-[3rem_minmax(10rem,2fr)_minmax(7rem,1fr)_4rem_4rem_6rem_2.5rem] lg:grid-cols-[3rem_minmax(10rem,2fr)_minmax(7rem,1fr)_minmax(8rem,1.4fr)_4rem_4rem_6rem_2.5rem] items-center gap-3 px-4 py-2.5 border-b border-outline-variant/10 bg-surface-container-high/50">
        <span aria-hidden />
        <Header label="Title" sortKey="name" />
        <Header label="Category" />
        <Header label="Tags" className="hidden lg:block" />
        <Header label="Pages" className="text-right" />
        <Header label="Chapters" className="text-right hidden md:block" />
        <Header label="Added" sortKey="date" className="text-right" />
        <span aria-hidden />
      </div>

      <ul className="divide-y divide-outline-variant/10">
        {books.map((book) => {
          const color = categoryColor(book.category);
          const isPdf = book.fileName.toLowerCase().endsWith(".pdf");
          return (
            <li key={book.id}>
              <div
                role="button"
                tabIndex={0}
                onClick={() => onOpenBook(book.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onOpenBook(book.id);
                  }
                }}
                className="grid grid-cols-[3rem_1fr_2.5rem] sm:grid-cols-[3rem_minmax(10rem,2fr)_minmax(7rem,1fr)_4rem_6rem_2.5rem] md:grid-cols-[3rem_minmax(10rem,2fr)_minmax(7rem,1fr)_4rem_4rem_6rem_2.5rem] lg:grid-cols-[3rem_minmax(10rem,2fr)_minmax(7rem,1fr)_minmax(8rem,1.4fr)_4rem_4rem_6rem_2.5rem] items-center gap-3 px-4 py-2.5 cursor-pointer hover:bg-surface-container-high/60 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                {/* Cover thumb */}
                <div className="w-10 h-14 rounded-sm overflow-hidden bg-surface-container-highest flex items-center justify-center shrink-0">
                  {book.coverImageUrl ? (
                    <img src={book.coverImageUrl} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <span className="material-symbols-outlined text-xl text-primary/30" aria-hidden>
                      {isPdf ? "auto_stories" : "description"}
                    </span>
                  )}
                </div>

                {/* Title (+ mobile meta line) */}
                <div className="min-w-0">
                  <p className="font-headline font-bold text-sm text-foreground truncate">
                    {highlight(book.title)}
                  </p>
                  <p className="sm:hidden text-[11px] text-on-surface-variant truncate mt-0.5">
                    {book.category && (
                      <span className="capitalize" style={{ color }}>{book.category} · </span>
                    )}
                    {book.pageCount > 0 ? `${book.pageCount} p · ` : ""}
                    {book.chapters.length} ch · {relativeDate(book.addedAt)}
                  </p>
                </div>

                {/* Category */}
                <div className="hidden sm:flex items-center gap-1.5 min-w-0">
                  <span
                    className="w-2.5 h-2.5 rounded-full shrink-0"
                    style={{ backgroundColor: color }}
                    aria-hidden
                  />
                  <span className="text-xs text-on-surface-variant capitalize truncate">
                    {book.category || "—"}
                  </span>
                </div>

                {/* Tags */}
                <div className="hidden lg:flex items-center gap-1 min-w-0">
                  {(book.tags || []).slice(0, 2).map((t) => (
                    <span
                      key={t}
                      className="px-1.5 py-0.5 rounded-full bg-surface-container-highest text-on-surface-variant text-[10px] truncate max-w-[7rem]"
                    >
                      #{t}
                    </span>
                  ))}
                  {(book.tags?.length ?? 0) > 2 && (
                    <span className="text-[10px] text-on-surface-variant/60">+{book.tags!.length - 2}</span>
                  )}
                </div>

                {/* Pages / Chapters / Added */}
                <span className="hidden sm:block text-xs text-on-surface-variant text-right tabular-nums">
                  {book.pageCount > 0 ? book.pageCount : "—"}
                </span>
                <span className="hidden md:block text-xs text-on-surface-variant text-right tabular-nums">
                  {book.chapters.length}
                </span>
                <span
                  className="hidden sm:block text-xs text-on-surface-variant text-right whitespace-nowrap"
                  title={new Date(book.addedAt).toLocaleString()}
                >
                  {relativeDate(book.addedAt)}
                </span>

                {/* Delete */}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemove(book.id);
                  }}
                  title={`Delete "${book.title}"`}
                  aria-label={`Delete "${book.title}"`}
                  className="w-8 h-8 rounded-lg flex items-center justify-center text-on-surface-variant hover:text-destructive hover:bg-error-container/20 transition-colors"
                >
                  <span className="material-symbols-outlined text-lg" aria-hidden>delete</span>
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

export default LibraryList;
