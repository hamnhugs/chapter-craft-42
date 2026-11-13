import React, { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { BookDocument } from "@/types/library";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useApp } from "@/context/AppContext";
import { bookProfile } from "@/lib/bookProfile";
import { CardEntry, CardSort, MAX_LEVEL, readTimeLabel, readingNow, sortCards, toCard } from "@/lib/bookCard";
import { ART_H, ART_W, coverArt } from "@/lib/coverArt";
import { categoryColor } from "@/lib/categoryColors";
import { seedOf } from "@/lib/bookProfile";
import { loadLastPage } from "@/hooks/useReaderPrefs";
import type { BookFolder } from "@/lib/bookFolders";

/**
 * The library as a card collection.
 *
 * Every book is a card: its cover (page one, captured at upload), a frame in
 * its tier's colour, a level that climbs as you read, and a corner badge with
 * the hours it takes. Books in progress sit in a "Reading now" deck at the
 * top; the rest is the collection underneath.
 *
 * Tapping a card opens its PROFILE — the one place that gathers everything
 * the app knows about a book and everything you can do with it. The grid
 * itself carries no menus: a card does one thing when tapped.
 */

/** Cards mounted at once. The grid grows by this much as you near the end —
 *  a thousand-book library must not mount a thousand covers up front. */
const PAGE = 60;
const SORT_KEY = "vault_deck_sort";

const SORTS: { id: CardSort; label: string; icon: string }[] = [
  { id: "recent", label: "Newest", icon: "schedule" },
  { id: "level", label: "Level", icon: "trending_up" },
  { id: "tier", label: "Size", icon: "layers" },
  { id: "name", label: "A–Z", icon: "sort_by_alpha" },
];

/** Page-one cover when the book has one; otherwise generated art in the
 *  book's category colour, the same every time for the same book. */
const CardArt: React.FC<{ book: BookDocument; className?: string }> = ({ book, className = "" }) => {
  const art = useMemo(() => (book.coverImageUrl ? null : coverArt(seedOf(book.id))), [book.coverImageUrl, book.id]);
  // A signed URL can expire or a file can go missing; the generated art is
  // always available as the stand-in.
  const [broken, setBroken] = useState(false);
  useEffect(() => { setBroken(false); }, [book.coverImageUrl]);
  const c = categoryColor(book.category);
  if (book.coverImageUrl && !broken) {
    return (
      <img
        src={book.coverImageUrl}
        alt=""
        loading="lazy"
        decoding="async"
        draggable={false}
        onError={() => setBroken(true)}
        className={`absolute inset-0 w-full h-full object-cover object-top ${className}`}
      />
    );
  }
  const shapes = art ?? coverArt(seedOf(book.id));
  const tone = {
    ground: `color-mix(in srgb, ${c} 26%, hsl(var(--surface-container-highest)))`,
    figure: `color-mix(in srgb, ${c} 62%, hsl(var(--background)))`,
    accent: c,
  };
  return (
    <svg
      viewBox={`0 0 ${ART_W} ${ART_H}`}
      preserveAspectRatio="xMidYMid slice"
      className={`absolute inset-0 w-full h-full ${className}`}
      style={{ background: tone.ground }}
      aria-hidden
    >
      {shapes.shapes.map((sh, i) =>
        sh.k === "circle" ? <circle key={i} cx={sh.cx} cy={sh.cy} r={sh.r} fill={tone[sh.tone]} />
        : sh.k === "rect" ? <rect key={i} x={sh.x} y={sh.y} width={sh.w} height={sh.h} fill={tone[sh.tone]} />
        : <path key={i} d={sh.d} fill={tone[sh.tone]} />,
      )}
    </svg>
  );
};

const LevelMeter: React.FC<{ card: CardEntry; className?: string }> = ({ card, className = "" }) => (
  <span className={`cc-meter ${className}`} data-full={card.level.maxed || undefined} aria-hidden>
    <span style={{ width: `${Math.round(card.level.fill * 100)}%` }} />
  </span>
);

const BookCardTile: React.FC<{
  card: CardEntry;
  busy?: string | null;
  onOpen: (id: string) => void;
  highlight?: (text: string) => React.ReactNode;
}> = React.memo(({ card, busy, onOpen, highlight }) => {
  const { book, tier, level } = card;
  const time = readTimeLabel(book.pageCount);
  const fresh = level.pct === 0 && Date.now() - book.addedAt < 3 * 86_400_000;
  return (
    <button
      type="button"
      data-deck-card
      data-tier={tier.id}
      onClick={() => onOpen(book.id)}
      className="cc-card w-full"
      aria-label={`${book.title} — ${tier.label}, level ${level.level}${level.maxed ? " (finished)" : ""}. Open profile.`}
    >
      {time && <span className="cc-card-cost" title={`About ${time} to read`}>{time}</span>}
      <span className="cc-card-face">
        <span className="cc-card-art">
          <CardArt book={book} />
          {fresh && <span className="cc-ribbon">New</span>}
          {busy && (
            <span className="absolute inset-x-0 bottom-0 px-1.5 py-1 text-[10px] font-bold text-center text-white bg-black/65 backdrop-blur-sm">
              {busy}
            </span>
          )}
        </span>
        <span className="cc-card-name">{highlight ? highlight(book.title) : book.title}</span>
        <span className="cc-card-level">
          <span className="shrink-0">{level.maxed ? "MAX" : `Lv ${level.level}`}</span>
          <LevelMeter card={card} />
        </span>
      </span>
    </button>
  );
});
BookCardTile.displayName = "BookCardTile";

/** Downscale a picked image to a cover-sized JPEG. */
async function imageToCover(file: File): Promise<Blob | null> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 420 / bitmap.width);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    return await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
  } catch {
    return null;
  }
}

export interface DeckHandlers {
  onRead: (book: BookDocument) => void;
  onDetect: (book: BookDocument) => void;
  onExtractFigures: (book: BookDocument) => void;
  onRemove: (book: BookDocument) => void;
  onRename: (book: BookDocument, title: string) => void;
}

const BookProfileDialog: React.FC<{
  card: CardEntry | null;
  shelves: BookFolder[];
  softDelete: boolean;
  busy?: string | null;
  handlers: DeckHandlers;
  onClose: () => void;
}> = ({ card, shelves, softDelete, busy, handlers, onClose }) => {
  const { toggleBookShelf, setBookCover, setActiveBookSilent, setActiveTab } = useApp();
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const coverInput = useRef<HTMLInputElement>(null);
  const book = card?.book ?? null;

  useEffect(() => { setRenaming(false); }, [book?.id]);

  const profile = useMemo(() => {
    if (!book) return null;
    return bookProfile({
      book,
      shelfNames: new Map(shelves.map((s) => [s.id, s.name])),
      lastPage: loadLastPage(book.id),
    });
  }, [book, shelves]);

  if (!card || !book || !profile) {
    return <Dialog open={false} onOpenChange={() => onClose()}><DialogContent /></Dialog>;
  }
  const { tier, level } = card;
  const isPdf = book.fileName.toLowerCase().endsWith(".pdf");
  const time = readTimeLabel(book.pageCount);

  const commitRename = () => {
    const next = draft.trim();
    if (next && next !== book.title) handlers.onRename(book, next);
    setRenaming(false);
  };

  const pickCover = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const blob = await imageToCover(file);
    if (!blob) { toast.error("That image couldn't be read."); return; }
    const ok = await setBookCover(book.id, blob);
    if (ok) toast.success("Cover updated");
    else toast.error("Couldn't save the cover — try again in a moment.");
  };

  const askCounsel = () => {
    setActiveBookSilent(book.id);
    onClose();
    setActiveTab("chat");
  };

  const stats: { label: string; value: string; icon: string }[] = [
    ...profile.stats,
    ...(time ? [{ label: "to read", value: time, icon: "hourglass_top" }] : []),
  ];

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent
        className="max-w-2xl max-h-[92vh] overflow-y-auto p-0 gap-0"
        // Opening must not drop focus (and a focus ring) on the rename pencil.
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)] gap-5 p-5">
          {/* The card itself, large. */}
          <div className="mx-auto w-40 sm:w-full">
            <div className="cc-card pointer-events-none" data-tier={tier.id}>
              {time && <span className="cc-card-cost">{time}</span>}
              <span className="cc-card-face">
                <span className="cc-card-art"><CardArt book={book} /></span>
                <span className="cc-card-level !pt-2">
                  <span className="shrink-0">{level.maxed ? "MAX" : `Lv ${level.level}`}</span>
                  <LevelMeter card={card} />
                </span>
              </span>
            </div>
          </div>

          <div className="min-w-0 flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest">
              <span className="px-2 py-0.5 rounded-full bg-accent/15 text-accent">{tier.label}</span>
              {profile.category && (
                <span className="px-2 py-0.5 rounded-full bg-surface-container-highest text-on-surface-variant inline-flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full" style={{ background: categoryColor(profile.category) }} aria-hidden />
                  {profile.category}
                </span>
              )}
              {profile.provenance && (
                <span className="px-2 py-0.5 rounded-full bg-surface-container-highest text-on-surface-variant normal-case tracking-normal font-medium">
                  {profile.provenance}
                </span>
              )}
            </div>

            {renaming ? (
              <form onSubmit={(e) => { e.preventDefault(); commitRename(); }} className="flex gap-2">
                <input
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); setRenaming(false); } }}
                  aria-label="Book title"
                  className="flex-1 min-w-0 rounded-lg bg-surface-container-high border border-outline-variant/30 px-3 py-1.5 text-lg font-bold text-foreground"
                />
              </form>
            ) : (
              <DialogTitle className="font-headline text-2xl leading-tight text-foreground">
                {book.title}
                <button
                  type="button"
                  onClick={() => { setDraft(book.title); setRenaming(true); }}
                  className="ml-2 align-middle text-on-surface-variant hover:text-primary"
                  aria-label="Rename this book"
                  title="Rename"
                >
                  <span className="material-symbols-outlined text-[18px]">edit</span>
                </button>
              </DialogTitle>
            )}
            <DialogDescription className="sr-only">
              Profile for {book.title}: level, stats, summary and actions.
            </DialogDescription>

            {/* The two things people open a profile to do, before anything
                that needs scrolling to on a short screen. */}
            <div className="flex flex-wrap gap-2 pb-1">
              <button type="button" className="cc-btn3d flex-1 min-w-[8rem]" data-size="lg" onClick={() => { onClose(); handlers.onRead(book); }}>
                <span className="material-symbols-outlined" aria-hidden>auto_stories</span>
                {profile.progress ? "Continue" : "Read"}
              </button>
              <button type="button" className="cc-btn3d" data-tone="accent" data-size="lg" onClick={askCounsel}>
                <span className="material-symbols-outlined" aria-hidden>psychology</span>
                Ask Counsel
              </button>
            </div>
            {/* Level: what it is, and what gets you the next one. */}
            <div className="rounded-xl bg-surface-container-high p-3">
              <div className="flex items-center justify-between text-xs font-bold text-foreground">
                <span>{level.maxed ? "Finished — max level" : `Level ${level.level} of ${MAX_LEVEL}`}</span>
                <span className="text-on-surface-variant font-medium">
                  {profile.progress ? `page ${profile.progress.page} of ${profile.progress.pages}` : "not started"}
                </span>
              </div>
              <LevelMeter card={card} className="mt-2 !h-3 block" />
              {!level.maxed && level.pagesToNext > 0 && (
                <p className="mt-1.5 text-[11px] text-on-surface-variant">
                  {level.pagesToNext} more page{level.pagesToNext === 1 ? "" : "s"} to level {level.level + 1}.
                </p>
              )}
            </div>

            <div className="grid grid-cols-3 gap-2">
              {stats.slice(0, 6).map((s) => (
                <div key={s.label} className="rounded-xl bg-surface-container-high px-2 py-2 text-center">
                  <span className="material-symbols-outlined text-[18px] text-primary" aria-hidden>{s.icon}</span>
                  <div className="text-sm font-bold text-foreground leading-tight truncate">{s.value}</div>
                  <div className="text-[10px] uppercase tracking-widest text-on-surface-variant truncate">{s.label}</div>
                </div>
              ))}
            </div>

          </div>
        </div>

        <div className="px-5 pb-5 flex flex-col gap-4">
          {busy && (
            <div className="rounded-lg bg-surface-container-high px-3 py-2 text-xs text-on-surface-variant flex items-center gap-2">
              <span className="material-symbols-outlined text-[16px] animate-spin" aria-hidden>progress_activity</span>
              {busy}
            </div>
          )}

          {profile.summary && (
            <section>
              <h3 className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant mb-1">About</h3>
              <p className="text-sm text-foreground/90 leading-relaxed">{profile.summary}</p>
              {profile.summaryModel && (
                <p className="mt-1 text-[10px] text-on-surface-variant">Summary written by {profile.summaryModel}</p>
              )}
            </section>
          )}

          {profile.highlights.length > 0 && (
            <section>
              <h3 className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant mb-1">Inside</h3>
              <ul className="space-y-1.5">
                {profile.highlights.map((h, i) => (
                  <li key={i} className="text-sm">
                    <span className="font-semibold text-foreground">{h.name}</span>
                    {h.gist && <span className="text-on-surface-variant"> — {h.gist}</span>}
                  </li>
                ))}
                {book.chapters.length > profile.highlights.length && (
                  <li className="text-xs text-on-surface-variant">
                    …and {book.chapters.length - profile.highlights.length} more chapter{book.chapters.length - profile.highlights.length === 1 ? "" : "s"}
                  </li>
                )}
              </ul>
            </section>
          )}

          {profile.tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {profile.tags.map((t) => (
                <span key={t} className="px-2 py-0.5 rounded-full text-[11px] bg-surface-container-high text-on-surface-variant">{t}</span>
              ))}
            </div>
          )}

          {shelves.length > 0 && (
            <section>
              <h3 className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant mb-1.5">Shelves</h3>
              <div className="flex flex-wrap gap-1.5">
                {shelves.map((s) => {
                  const on = book.folderIds.includes(s.id);
                  return (
                    <button
                      key={s.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() => toggleBookShelf(book.id, s.id).catch(() => toast.error("Couldn't change that shelf"))}
                      className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                        on
                          ? "bg-accent/15 border-accent/50 text-accent"
                          : "bg-surface-container-high border-outline-variant/25 text-on-surface-variant hover:text-foreground"
                      }`}
                    >
                      {on && <span className="material-symbols-outlined text-[13px] align-[-2px] mr-0.5" aria-hidden>check</span>}
                      {s.name}
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          <div className="flex flex-wrap gap-2 border-t border-outline-variant/15 pt-4">
            <input ref={coverInput} type="file" accept="image/*" className="hidden" onChange={pickCover} />
            <button type="button" className="cc-btn3d" data-tone="quiet" data-size="sm" onClick={() => coverInput.current?.click()}>
              <span className="material-symbols-outlined text-[16px]" aria-hidden>image</span> Change cover
            </button>
            {isPdf && (
              <button type="button" className="cc-btn3d" data-tone="quiet" data-size="sm" onClick={() => handlers.onDetect(book)}>
                <span className="material-symbols-outlined text-[16px]" aria-hidden>account_tree</span>
                {book.chapters.length > 0 ? "Re-detect chapters" : "Detect chapters"}
              </button>
            )}
            {isPdf && (
              <button type="button" className="cc-btn3d" data-tone="quiet" data-size="sm" onClick={() => handlers.onExtractFigures(book)}>
                <span className="material-symbols-outlined text-[16px]" aria-hidden>imagesmode</span> Extract figures
              </button>
            )}
            <button
              type="button"
              className="cc-btn3d ml-auto"
              data-tone="danger"
              data-size="sm"
              onClick={() => { onClose(); handlers.onRemove(book); }}
            >
              <span className="material-symbols-outlined text-[16px]" aria-hidden>delete</span>
              {softDelete ? "Move to Trash" : "Delete"}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

const LibraryDeck: React.FC<{
  books: BookDocument[];
  shelves: BookFolder[];
  /** True while a search is narrowing the list — the Reading-now deck steps
   *  aside so results are the first thing on screen. */
  filtered: boolean;
  softDelete: boolean;
  /** Book id → a short line about a job running on it ("Finding chapters…"). */
  busyByBook: Map<string, string>;
  handlers: DeckHandlers;
  highlight?: (text: string) => React.ReactNode;
}> = ({ books, shelves, filtered, softDelete, busyByBook, handlers, highlight }) => {
  const [sort, setSort] = useState<CardSort>(() => {
    try {
      const v = localStorage.getItem(SORT_KEY) as CardSort | null;
      return v && SORTS.some((s) => s.id === v) ? v : "recent";
    } catch { return "recent"; }
  });
  useEffect(() => { try { localStorage.setItem(SORT_KEY, sort); } catch { /* private mode */ } }, [sort]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [shown, setShown] = useState(PAGE);
  const sentinel = useRef<HTMLDivElement>(null);

  // Reading positions live in localStorage per book; read them once per list
  // rather than once per card per render.
  const cards = useMemo(() => books.map((b) => toCard(b, loadLastPage(b.id))), [books]);
  const sorted = useMemo(() => sortCards(cards, sort), [cards, sort]);
  const now = useMemo(() => (filtered ? [] : readingNow(cards)), [cards, filtered]);
  const openCard = useMemo(() => cards.find((c) => c.book.id === openId) ?? null, [cards, openId]);

  useEffect(() => { setShown(PAGE); }, [sort, books.length]);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setShown((n) => n + PAGE);
    }, { rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
  }, [sorted.length]);

  const finished = cards.filter((c) => c.level.maxed).length;
  const grid = "grid gap-x-3 gap-y-5 grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7";

  return (
    <div className="flex flex-col gap-5">
      {now.length > 0 && (
        <section aria-label="Reading now">
          <div className="cc-banner mb-4">
            <span className="material-symbols-outlined text-accent" aria-hidden>local_fire_department</span>
            <span>Reading now</span>
            <span className="ml-auto text-xs font-semibold text-on-surface-variant">{now.length} in play</span>
          </div>
          {/* One row that scrolls sideways: a hand of cards, not a second
              grid that pushes the collection off the first screen. */}
          <div className="flex gap-3 overflow-x-auto hide-scrollbar px-3 pt-2 pb-3 -mx-3 snap-x scroll-px-3">
            {now.map((c) => (
              <div key={c.book.id} className="flex w-[7.25rem] sm:w-36 shrink-0 snap-start">
                <BookCardTile card={c} busy={busyByBook.get(c.book.id)} onOpen={setOpenId} highlight={highlight} />
              </div>
            ))}
          </div>
        </section>
      )}

      <section aria-label="Collection">
        <div className="cc-banner mb-4 flex-wrap">
          <span className="material-symbols-outlined text-primary" aria-hidden>style</span>
          <span>{filtered ? "Matches" : "Collection"}</span>
          <span className="text-xs font-semibold text-on-surface-variant">
            {cards.length} card{cards.length === 1 ? "" : "s"}
            {!filtered && finished > 0 ? ` · ${finished} finished` : ""}
          </span>
          <div className="ml-auto flex items-center gap-1" role="group" aria-label="Sort cards">
            {SORTS.map((s) => (
              <button
                key={s.id}
                type="button"
                aria-pressed={sort === s.id}
                onClick={() => setSort(s.id)}
                title={`Sort by ${s.label}`}
                className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-bold transition-colors ${
                  sort === s.id ? "bg-accent/20 text-accent" : "text-on-surface-variant hover:text-foreground hover:bg-surface-container-highest"
                }`}
              >
                <span className="material-symbols-outlined text-[15px]" aria-hidden>{s.icon}</span>
                <span className="hidden sm:inline">{s.label}</span>
              </button>
            ))}
          </div>
        </div>
        {sorted.length === 0 ? (
          <p className="py-10 text-center text-sm text-on-surface-variant">No cards match.</p>
        ) : (
          <div className={grid}>
            {sorted.slice(0, shown).map((c) => (
              <BookCardTile key={c.book.id} card={c} busy={busyByBook.get(c.book.id)} onOpen={setOpenId} highlight={highlight} />
            ))}
          </div>
        )}
        {shown < sorted.length && <div ref={sentinel} className="h-8" aria-hidden />}
      </section>

      <BookProfileDialog
        card={openCard}
        shelves={shelves}
        softDelete={softDelete}
        busy={openCard ? busyByBook.get(openCard.book.id) : null}
        handlers={handlers}
        onClose={() => setOpenId(null)}
      />
    </div>
  );
};

export default LibraryDeck;
