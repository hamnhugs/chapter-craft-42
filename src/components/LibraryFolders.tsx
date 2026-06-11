import React, { useMemo, useState } from "react";
import { BookDocument } from "@/types/library";
import { categoryColor, UNCATEGORIZED } from "@/lib/categoryColors";

// Folder view: books grouped into colored virtual folders by category, with
// tag filter chips inside each folder. Folders are computed views over the
// category metadata, never physical moves — the Calibre "virtual library"
// model — so a book always also appears under every tag it carries. Tags are
// chips (facets) rather than nested folders: tags overlap and combine, which
// is filter behavior, not hierarchy.

interface FolderInfo {
  category: string;
  count: number;
  color: string;
  covers: (string | undefined)[];
}

const LibraryFolders: React.FC<{
  books: BookDocument[];
  renderBook: (book: BookDocument, index: number) => React.ReactNode;
}> = ({ books, renderBook }) => {
  const [openCategory, setOpenCategory] = useState<string | null>(null);
  const [activeTags, setActiveTags] = useState<string[]>([]);

  const folders = useMemo<FolderInfo[]>(() => {
    const byCat = new Map<string, BookDocument[]>();
    for (const b of books) {
      const cat = b.category || UNCATEGORIZED;
      const list = byCat.get(cat) || [];
      list.push(b);
      byCat.set(cat, list);
    }
    return [...byCat.entries()]
      .map(([category, list]) => ({
        category,
        count: list.length,
        color: categoryColor(category),
        covers: list.slice(0, 3).map((b) => b.coverImageUrl),
      }))
      .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
  }, [books]);

  const openBooks = useMemo(() => {
    if (!openCategory) return [];
    return books.filter((b) => (b.category || UNCATEGORIZED) === openCategory);
  }, [books, openCategory]);

  // Tag chips with counts, scoped to the open folder; most-used first.
  const tagChips = useMemo(() => {
    const counts = new Map<string, number>();
    for (const b of openBooks) {
      for (const t of b.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 24);
  }, [openBooks]);

  const visibleBooks = useMemo(() => {
    if (activeTags.length === 0) return openBooks;
    return openBooks.filter((b) => activeTags.every((t) => (b.tags || []).includes(t)));
  }, [openBooks, activeTags]);

  const openFolder = (category: string) => {
    setOpenCategory(category);
    setActiveTags([]);
  };

  const closeFolder = () => {
    setOpenCategory(null);
    setActiveTags([]);
  };

  const toggleTag = (tag: string) => {
    setActiveTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag],
    );
  };

  // The folder the user opened can disappear when search filters change.
  if (openCategory && openBooks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-on-surface-variant">
        <span className="material-symbols-outlined text-5xl mb-3 opacity-30">folder_off</span>
        <p className="font-headline text-lg">No books here anymore</p>
        <button
          onClick={closeFolder}
          className="mt-4 px-5 py-2 bg-primary/10 text-primary font-bold rounded-lg hover:bg-primary hover:text-on-primary-container transition-all active:scale-95"
        >
          Back to all folders
        </button>
      </div>
    );
  }

  if (!openCategory) {
    return (
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
        {folders.map((f) => (
          <button
            key={f.category}
            onClick={() => openFolder(f.category)}
            className="group relative flex flex-col items-start gap-3 rounded-2xl p-5 text-left border transition-all hover:-translate-y-0.5 hover:shadow-xl hover:shadow-black/30 bg-surface-container-high border-outline-variant/10"
            style={{ borderColor: `${f.color}30` }}
          >
            <div className="flex items-center justify-between w-full">
              <span
                className="material-symbols-outlined text-4xl transition-transform group-hover:scale-110"
                style={{ color: f.color, fontVariationSettings: "'FILL' 1" }}
                aria-hidden
              >
                folder
              </span>
              {/* Cover peeks — covers are the highest-recognition cue for books */}
              <div className="flex -space-x-2">
                {f.covers.filter(Boolean).slice(0, 3).map((url, i) => (
                  <img
                    key={i}
                    src={url}
                    alt=""
                    className="w-7 h-10 object-cover rounded-sm border border-black/40 shadow-sm"
                    style={{ transform: `rotate(${(i - 1) * 6}deg)` }}
                  />
                ))}
              </div>
            </div>
            <div className="min-w-0">
              <p className="font-headline font-bold text-base text-foreground capitalize truncate w-full">
                {f.category}
              </p>
              <p className="text-xs text-on-surface-variant mt-0.5">
                {f.count} book{f.count === 1 ? "" : "s"}
              </p>
            </div>
            <span
              className="absolute inset-x-0 bottom-0 h-1 rounded-b-2xl opacity-60"
              style={{ backgroundColor: f.color }}
              aria-hidden
            />
          </button>
        ))}
      </div>
    );
  }

  const color = categoryColor(openCategory);
  return (
    <div className="flex flex-col gap-5">
      {/* Breadcrumb */}
      <nav aria-label="Folder navigation" className="flex items-center gap-1.5 text-sm">
        <button
          onClick={closeFolder}
          className="flex items-center gap-1 px-2 py-1 rounded-lg text-on-surface-variant hover:text-primary hover:bg-surface-container-high transition-colors"
        >
          <span className="material-symbols-outlined text-base" aria-hidden>folder_copy</span>
          All folders
        </button>
        <span className="text-on-surface-variant/50" aria-hidden>/</span>
        <span className="flex items-center gap-1.5 px-2 py-1 font-semibold text-foreground capitalize">
          <span
            className="material-symbols-outlined text-base"
            style={{ color, fontVariationSettings: "'FILL' 1" }}
            aria-hidden
          >
            folder_open
          </span>
          {openCategory}
          <span className="text-on-surface-variant font-normal">({visibleBooks.length})</span>
        </span>
      </nav>

      {/* Tag facet chips */}
      {tagChips.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {tagChips.map(([tag, count]) => {
            const active = activeTags.includes(tag);
            return (
              <button
                key={tag}
                onClick={() => toggleTag(tag)}
                aria-pressed={active}
                className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-[12px] border transition-all ${
                  active
                    ? "bg-primary/15 text-primary border-primary/40 font-semibold"
                    : "bg-surface-container-high text-on-surface-variant border-outline-variant/10 hover:text-primary"
                }`}
              >
                #{tag}
                <span className="opacity-60">{count}</span>
                {active && (
                  <span className="material-symbols-outlined text-sm" aria-hidden>close</span>
                )}
              </button>
            );
          })}
          {activeTags.length > 0 && (
            <button
              onClick={() => setActiveTags([])}
              className="px-2.5 py-1 rounded-full text-[12px] text-on-surface-variant hover:text-primary underline underline-offset-2"
            >
              Clear filters
            </button>
          )}
        </div>
      )}

      {visibleBooks.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-on-surface-variant">
          <span className="material-symbols-outlined text-5xl mb-3 opacity-30">filter_alt_off</span>
          <p className="text-sm">No books match every selected tag</p>
        </div>
      ) : (
        <div className="book-grid">
          {visibleBooks.map((book, i) => renderBook(book, i))}
        </div>
      )}
    </div>
  );
};

export default LibraryFolders;
