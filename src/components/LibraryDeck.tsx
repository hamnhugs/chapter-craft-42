import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import * as MenuPrimitive from "@radix-ui/react-dropdown-menu";
import { toast } from "sonner";
import { BookDocument } from "@/types/library";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { useApp } from "@/context/AppContext";
import { useAuth } from "@/hooks/useAuth";
import { useChatSettings } from "@/hooks/useChatSettings";
import { bookProfile } from "@/lib/bookProfile";
import { CardEntry, CardSort, MAX_LEVEL, readTimeLabel, readingNow, sortCards, toCard } from "@/lib/bookCard";
import { ART_H, ART_W, coverArt } from "@/lib/coverArt";
import { categoryColor } from "@/lib/categoryColors";
import { seedOf } from "@/lib/bookProfile";
import { loadLastPage } from "@/hooks/useReaderPrefs";
import type { BookFolder } from "@/lib/bookFolders";
import { BOOK_CONTEXT_MAX_BOOKS, bookContextStore, bookHasCatalog } from "@/lib/chatBooks";
import { catalogJobs } from "@/lib/catalogJobs";
import { acquireDigestRun, generateShelfDigest, releaseDigestRun } from "@/lib/shelfDigest";
import { useShelfMarks, type ShelfMark } from "@/lib/shelfMarks";
import { OPEN_NEURON_SWITCHER_EVENT } from "@/components/WikiQuickSwitcher";

/**
 * The library as a deck builder.
 *
 * Three things used to live on three screens: books (the card grid), shelves
 * (their own view) and the notebook Counsel writes to (a dialog that
 * interrupted every load). Here they are one panel, laid out the way a card
 * game lays out a deck:
 *
 *   - SHELVES are the deck tabs. One is open at a time; "Reading now" is a
 *     tab the app fills by itself.
 *   - The open shelf's BOOKS sit in slots — eight, because Counsel takes
 *     eight books at a time.
 *   - The NOTEBOOK Counsel is using sits beside the slots, and "Ask Counsel"
 *     takes the shelf and that notebook to the chat. Nothing is asked on the
 *     way.
 *   - Underneath is the collection: every book.
 *
 * Tapping a card lifts it and offers what you can do with it: Info (the
 * book's profile), Read, and add to / take off the open shelf. Opening a tab
 * only looks at a shelf — it never changes what Counsel has loaded.
 *
 * The tab row is a shortcut, not the only way in: "New shelf" and "All
 * shelves" are pinned beside it, outside the part that scrolls, so neither is
 * ever at the far end of a long row.
 */

/** Cards mounted at once. The grid grows by this much as you near the end —
 *  a thousand-book library must not mount a thousand covers up front. */
const PAGE = 60;
const SORT_KEY = "vault_deck_sort";
const DECK_KEY = "vault_deck_tab";
/** The automatic tab: books in progress. Not a book_folders row. */
const NOW_ID = "__reading_now__";
const SLOTS = BOOK_CONTEXT_MAX_BOOKS;
/** Past this many shelves the "All shelves" list gets a filter box. */
const FILTER_SHELVES_FROM = 8;

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

const MENU_CLEARANCE = { top: 56, bottom: 72, left: 10, right: 10 };

/** The shelf a card can be put on or taken off from its menu. */
interface OpenShelf { id: string; name: string; mark?: ShelfMark }

interface CardActions {
  onInfo: (id: string) => void;
  onRead: (book: BookDocument) => void;
  onToggleShelf: (book: BookDocument, shelf: OpenShelf) => void;
}

const BookCardTile: React.FC<{
  card: CardEntry;
  busy?: string | null;
  /** A card in a shelf slot: art and title only. */
  compact?: boolean;
  /** The open shelf, when it is one you fill by hand. */
  shelf?: OpenShelf | null;
  actions: CardActions;
  highlight?: (text: string) => React.ReactNode;
}> = React.memo(({ card, busy, compact, shelf, actions, highlight }) => {
  const { book, tier, level } = card;
  const time = readTimeLabel(book.pageCount);
  const fresh = !compact && level.pct === 0 && Date.now() - book.addedAt < 3 * 86_400_000;
  const onShelf = !!shelf && book.folderIds.includes(shelf.id);
  // OPEN ON TAP, NOT ON TOUCH-DOWN — the same fix as PromptSwitcher, for the
  // same reason: Radix opens a DropdownMenu from `onPointerDown`, so on a
  // phone the finger that lands on a card to SCROLL THE LIBRARY had already
  // opened its menu. `preventDefault()` there skips Radix's toggle and the
  // menu is driven from `onClick`, which the browser withholds when the touch
  // turned into a scroll.
  //
  // And it is not modal: a modal menu locks scrolling and swallows the next
  // tap anywhere, which made one stray menu stop the whole Library. Open, it
  // now gets out of the way of a scroll or a tap elsewhere.
  const [menuOpen, setMenuOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: Event) => {
      if (e.target instanceof Element && e.target.closest(".cc-card-menu")) return;
      setMenuOpen(false);
    };
    window.addEventListener("scroll", close, { capture: true, passive: true });
    return () => window.removeEventListener("scroll", close, { capture: true });
  }, [menuOpen]);
  return (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen} modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          ref={trigger}
          type="button"
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => setMenuOpen((v) => !v)}
          data-deck-card
          data-tier={tier.id}
          data-compact={compact || undefined}
          className="cc-card w-full"
          aria-label={`${book.title} — ${tier.label}, level ${level.level}${level.maxed ? " (finished)" : ""}${onShelf ? `, on ${shelf!.name}` : ""}`}
        >
          {time && <span className="cc-card-cost" title={`About ${time} to read`}>{time}</span>}
          {onShelf && !compact && (
            <span
              className="cc-card-onshelf"
              style={shelf!.mark ? { background: shelf!.mark.color, color: shelf!.mark.ink } : undefined}
              title={`On ${shelf!.name}`}
            >
              <span className="material-symbols-outlined" aria-hidden>check</span>
            </span>
          )}
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
            {!compact && (
              <span className="cc-card-level">
                <span className="shrink-0">{level.maxed ? "MAX" : `Lv ${level.level}`}</span>
                <LevelMeter card={card} />
              </span>
            )}
          </span>
        </button>
      </DropdownMenuTrigger>
      {/* Beside the card where there is width for it, under it on a phone —
          and never under the app bar or the dock. */}
      <DropdownMenuContent
        side={typeof window !== "undefined" && window.innerWidth >= 640 ? "right" : "bottom"}
        align="center"
        sideOffset={10}
        collisionPadding={MENU_CLEARANCE}
        className="cc-card-menu"
        aria-label={`Actions for ${book.title}`}
        // A tap on the card that owns the menu is the card's own toggle; left
        // to dismiss as well, it would close and immediately reopen.
        onInteractOutside={(e) => {
          const target = e.detail.originalEvent.target;
          if (target instanceof Node && trigger.current?.contains(target)) e.preventDefault();
        }}
      >
        <MenuPrimitive.Item asChild onSelect={() => actions.onInfo(book.id)}>
          <button type="button" className="cc-btn3d" data-tone="quiet">
            <span className="material-symbols-outlined" aria-hidden>info</span> Info
          </button>
        </MenuPrimitive.Item>
        <MenuPrimitive.Item asChild onSelect={() => actions.onRead(book)}>
          <button type="button" className="cc-btn3d">
            <span className="material-symbols-outlined" aria-hidden>auto_stories</span>
            {level.pct > 0 && !level.maxed ? "Continue" : "Read"}
          </button>
        </MenuPrimitive.Item>
        {shelf && (
          <MenuPrimitive.Item asChild onSelect={() => actions.onToggleShelf(book, shelf)}>
            <button type="button" className="cc-btn3d" data-tone={onShelf ? "quiet" : "accent"}>
              <span className="material-symbols-outlined" aria-hidden>{onShelf ? "remove" : "add"}</span>
              <span className="truncate">{onShelf ? `Take off ${shelf.name}` : `Add to ${shelf.name}`}</span>
            </button>
          </MenuPrimitive.Item>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
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
  const { toggleBookShelf, setBookCover, loadFocus } = useApp();
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

  // "Ask Counsel" means the same on a book as on a shelf: take this to the
  // chat. It used to point the reader at the book and switch tabs, which left
  // Counsel discussing whatever shelf was loaded instead.
  const askCounsel = () => {
    onClose();
    void loadFocus({ kind: "books", bookIds: [book.id], neurons: { kind: "keep" } });
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
  /** What search leaves on screen — the collection. */
  books: BookDocument[];
  /** The whole library — what a shelf really holds, whatever is being searched. */
  allBooks: BookDocument[];
  shelves: BookFolder[];
  /** True while a search is narrowing the list — the slots step aside so
   *  results are the first thing on screen. */
  filtered: boolean;
  softDelete: boolean;
  /** Book id → a short line about a job running on it ("Finding chapters…"). */
  busyByBook: Map<string, string>;
  handlers: DeckHandlers;
  highlight?: (text: string) => React.ReactNode;
}> = ({ books, allBooks, shelves, filtered, softDelete, busyByBook, handlers, highlight }) => {
  const {
    toggleBookShelf, createShelf, renameShelf, deleteShelf, loadFocus, activeWikis, membershipLoaded,
    applyChapterGists, applyBookSummary, applyShelfDigest,
  } = useApp();
  const { user } = useAuth();
  const { selectedModel, apiKey, geminiApiKey, nvidiaKeyLast4 } = useChatSettings();
  const marks = useShelfMarks();
  // "Ask Counsel" writes the book-context store; on a cold start straight to
  // the Library nothing else has initialised it yet.
  useEffect(() => { bookContextStore.init(user?.id ?? null); }, [user?.id]);
  const loaded = useSyncExternalStore(bookContextStore.subscribe, bookContextStore.get);

  const [sort, setSort] = useState<CardSort>(() => {
    try {
      const v = localStorage.getItem(SORT_KEY) as CardSort | null;
      return v && SORTS.some((s) => s.id === v) ? v : "recent";
    } catch { return "recent"; }
  });
  useEffect(() => { try { localStorage.setItem(SORT_KEY, sort); } catch { /* private mode */ } }, [sort]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [shown, setShown] = useState(PAGE);
  const [looseOnly, setLooseOnly] = useState(false);
  const sentinel = useRef<HTMLDivElement>(null);
  const collectionRef = useRef<HTMLElement>(null);

  // Reading positions live in localStorage per book; read them once per list
  // rather than once per card per render.
  const allCards = useMemo(() => allBooks.map((b) => toCard(b, loadLastPage(b.id))), [allBooks]);
  const cardById = useMemo(() => new Map(allCards.map((c) => [c.book.id, c])), [allCards]);
  const cards = useMemo(
    () => books.map((b) => cardById.get(b.id) ?? toCard(b, loadLastPage(b.id))),
    [books, cardById],
  );
  const loose = useMemo(() => cards.filter((c) => c.book.folderIds.length === 0), [cards]);
  const showLoose = looseOnly && shelves.length > 0 && loose.length > 0;
  const sorted = useMemo(() => sortCards(showLoose ? loose : cards, sort), [cards, loose, showLoose, sort]);
  const now = useMemo(() => readingNow(allCards, SLOTS), [allCards]);
  const openCard = openId ? cardById.get(openId) ?? null : null;

  // Which tab is open. Remembered; a shelf that has since been deleted falls
  // back to the shelf Counsel has loaded, then to whatever has books in it.
  const [tab, setTab] = useState<string>(() => {
    try { return localStorage.getItem(DECK_KEY) || ""; } catch { return ""; }
  });
  const deckId = useMemo(() => {
    if (tab === NOW_ID || shelves.some((s) => s.id === tab)) return tab;
    if (loaded.shelfId && shelves.some((s) => s.id === loaded.shelfId)) return loaded.shelfId;
    return now.length > 0 || shelves.length === 0 ? NOW_ID : shelves[0].id;
  }, [tab, shelves, loaded.shelfId, now.length]);
  const pickTab = (id: string) => {
    setTab(id);
    try { localStorage.setItem(DECK_KEY, id); } catch { /* private mode */ }
  };
  const shelf = deckId === NOW_ID ? null : shelves.find((s) => s.id === deckId) ?? null;
  const openShelf = useMemo<OpenShelf | null>(
    () => (shelf ? { id: shelf.id, name: shelf.name, mark: marks.get(shelf.id) } : null),
    [shelf, marks],
  );
  const countByShelf = useMemo(() => {
    const m = new Map<string, number>();
    for (const b of allBooks) for (const id of b.folderIds) m.set(id, (m.get(id) || 0) + 1);
    return m;
  }, [allBooks]);
  const deckCards = useMemo(
    () => (shelf ? sortCards(allCards.filter((c) => c.book.folderIds.includes(shelf.id)), "recent") : now),
    [shelf, allCards, now],
  );
  const inCounsel = shelf ? loaded.shelfId === shelf.id : false;

  useEffect(() => { setShown(PAGE); }, [sort, books.length, showLoose]);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setShown((n) => n + PAGE);
    }, { rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
  }, [sorted.length]);

  // One stable set of card actions, so a memoised tile does not re-render
  // (and close its open menu) every time this component does.
  const latest = useRef({ handlers, toggleBookShelf });
  latest.current = { handlers, toggleBookShelf };
  const actions = useMemo<CardActions>(() => ({
    onInfo: setOpenId,
    onRead: (book) => latest.current.handlers.onRead(book),
    onToggleShelf: (book, target) => {
      const adding = !book.folderIds.includes(target.id);
      latest.current.toggleBookShelf(book.id, target.id).then(
        () => toast(adding ? `Added to ${target.name}` : `Taken off ${target.name}`, {
          action: { label: "Undo", onClick: () => { void latest.current.toggleBookShelf(book.id, target.id); } },
        }),
        (e) => toast.error(e instanceof Error ? e.message : "Couldn't change that shelf"),
      );
    },
  }), []);

  // ── Shelf housekeeping ───────────────────────────────────────────────
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [digesting, setDigesting] = useState(false);
  useEffect(() => { setRenaming(false); }, [deckId]);

  // Every shelf as a list, for when the row is too long to swipe through.
  const [listOpen, setListOpen] = useState(false);
  const [shelfQuery, setShelfQuery] = useState("");
  const filterShelves = shelves.length > FILTER_SHELVES_FROM;
  const listedShelves = useMemo(() => {
    const q = shelfQuery.trim().toLowerCase();
    return q ? shelves.filter((s) => s.name.toLowerCase().includes(q)) : shelves;
  }, [shelves, shelfQuery]);
  const pickFromList = (id: string) => {
    pickTab(id);
    setListOpen(false);
    setShelfQuery("");
  };

  // Keep the open tab in view — it may have been picked from the list, or
  // remembered from last time, and be well off the end of the row. The row is
  // moved only as far as it takes (never the page, which `scrollIntoView`
  // would move too), and again once the icon font is in: until then every
  // icon is its name spelled out and the tabs are several times too wide.
  const tabRow = useRef<HTMLDivElement>(null);
  const tabRowSeen = useRef(false);
  useEffect(() => {
    const reveal = (behavior: ScrollBehavior) => {
      const row = tabRow.current;
      const el = row?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
      if (!row || !el || typeof row.scrollTo !== "function") return;
      const r = row.getBoundingClientRect();
      const t = el.getBoundingClientRect();
      const lead = t.left - (r.left + 8);
      // 28px: clear of the fade the row ends in.
      const trail = t.right - (r.right - 28);
      const by = lead < 0 ? lead : trail > 0 ? Math.min(trail, lead) : 0;
      if (by !== 0) row.scrollTo({ left: row.scrollLeft + by, behavior });
    };
    reveal(tabRowSeen.current ? "smooth" : "auto");
    tabRowSeen.current = true;
    let live = true;
    void document.fonts?.ready.then(() => { if (live) reveal("auto"); });
    return () => { live = false; };
  }, [deckId, shelves.length]);

  const commitCreate = async () => {
    const name = newName.trim();
    if (!name) { setCreating(false); return; }
    try {
      const made = await createShelf(name);
      setNewName("");
      setCreating(false);
      pickTab(made.id);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not create the shelf");
    }
  };
  const commitRename = async () => {
    const name = renameDraft.trim();
    setRenaming(false);
    if (!shelf || !name || name === shelf.name) return;
    try { await renameShelf(shelf.id, name); } catch (e) { toast.error(e instanceof Error ? e.message : "Rename failed"); }
  };
  const removeShelf = async () => {
    if (!shelf) return;
    if (!window.confirm(`Delete shelf "${shelf.name}"? Its books stay in your library.`)) return;
    try {
      await deleteShelf(shelf.id);
      toast.success("Shelf deleted");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Delete failed");
    }
  };
  const keys = { apiKey: apiKey || undefined, geminiApiKey: geminiApiKey || undefined, nvidiaKeyLast4: nvidiaKeyLast4 || undefined };
  const allBooksRef = useRef(allBooks);
  useEffect(() => { allBooksRef.current = allBooks; }, [allBooks]);
  /** Chapter and book summaries for the books here that have none — what
   *  lets Counsel carry a shelf as a map instead of its full text. */
  const summarizeBooks = () => {
    const missing = deckCards.map((c) => c.book).filter((b) => !bookHasCatalog(b) && b.chapters.length > 0);
    if (missing.length === 0) { toast("Every book here that has chapters already has summaries."); return; }
    for (const b of missing) {
      catalogJobs.enqueue({
        bookId: b.id,
        getBook: () => allBooksRef.current.find((x) => x.id === b.id),
        settings: { model: selectedModel, keys },
        onGists: applyChapterGists,
        onSummary: applyBookSummary,
      });
    }
    toast.success(`Summarizing ${missing.length} book${missing.length === 1 ? "" : "s"} — one at a time; progress shows on each card.`);
  };
  const summarizeShelf = async () => {
    if (!shelf || digesting) return;
    if (!acquireDigestRun()) { toast("Another shelf summary is still being written."); return; }
    setDigesting(true);
    try {
      const result = await generateShelfDigest(shelf, deckCards.map((c) => c.book), { model: selectedModel, keys });
      applyShelfDigest(shelf.id, result.summary, result.model);
      toast.success(`Summary written for “${shelf.name}”`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't write the summary");
    } finally {
      releaseDigestRun();
      setDigesting(false);
    }
  };

  const askCounsel = () => {
    if (shelf) void loadFocus({ kind: "shelf", shelfId: shelf.id, neurons: { kind: "keep" } });
  };
  const toCollection = () => collectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });

  // Empty slots fill the row out to eight. A phone shows four to a row, so
  // there the empties stop at the end of the row the last book is on.
  const empties = shelf ? Math.max(0, SLOTS - deckCards.length) : 0;
  const phoneEmpties = shelf ? Math.min(empties, (4 - (deckCards.length % 4)) % 4 || 4) : 0;
  const finished = cards.filter((c) => c.level.maxed).length;
  const notebookNames = activeWikis.map((w) => w.name);
  const grid = "grid gap-x-3 gap-y-5 grid-cols-3 sm:grid-cols-5 md:grid-cols-6 lg:grid-cols-7 xl:grid-cols-8";

  return (
    <div className="flex flex-col gap-4">
      <section aria-label="Shelves" className="cc-deck">
        {/* Deck tabs: one per shelf. Only the tabs scroll; the two buttons
            after them stay put. */}
        <div className="cc-deck-bar">
          <div ref={tabRow} className="cc-deck-tabs hide-scrollbar" role="tablist" aria-label="Shelves">
            <button type="button" role="tab" aria-selected={deckId === NOW_ID} className="cc-deck-tab" onClick={() => pickTab(NOW_ID)}>
              <span className="material-symbols-outlined text-[18px] text-accent" aria-hidden>local_fire_department</span>
              Reading now
              <span className="cc-deck-count">{now.length}</span>
            </button>
            {shelves.map((s) => {
              const mark = marks.get(s.id);
              return (
                <button key={s.id} type="button" role="tab" aria-selected={deckId === s.id} className="cc-deck-tab" onClick={() => pickTab(s.id)}>
                  <span className="cc-deck-mark" style={mark ? { background: mark.color, color: mark.ink } : undefined} aria-hidden>
                    <span className="material-symbols-outlined">{mark?.glyph ?? "shelves"}</span>
                  </span>
                  <span className="truncate max-w-[10rem]">{s.name}</span>
                  {/* No count until membership has loaded: "0" would be a guess. */}
                  {membershipLoaded && <span className="cc-deck-count">{countByShelf.get(s.id) || 0}</span>}
                  {loaded.shelfId === s.id && (
                    <span className="material-symbols-outlined text-[16px] text-accent" title="Counsel has this shelf" aria-label="Counsel has this shelf">psychology</span>
                  )}
                </button>
              );
            })}
          </div>
          {creating ? (
            <form onSubmit={(e) => { e.preventDefault(); void commitCreate(); }} className="shrink-0 flex">
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onBlur={() => void commitCreate()}
                onKeyDown={(e) => { if (e.key === "Escape") { setNewName(""); setCreating(false); } }}
                placeholder="Shelf name"
                aria-label="New shelf name"
                className="h-11 w-40 rounded-xl bg-surface-container-high border border-outline-variant/40 px-3 text-sm text-foreground"
              />
            </form>
          ) : (
            <>
              {shelves.length > 0 && (
                <button type="button" className="cc-deck-pin" onClick={() => setListOpen(true)} aria-label="All shelves" title="All shelves">
                  <span className="material-symbols-outlined text-[20px]" aria-hidden>format_list_bulleted</span>
                </button>
              )}
              <button type="button" className="cc-deck-pin" data-new onClick={() => setCreating(true)} title="New shelf">
                <span className="material-symbols-outlined text-[20px]" aria-hidden>add</span>
                <span className="sr-only sm:not-sr-only">New shelf</span>
              </button>
            </>
          )}
        </div>

        {!filtered && (
          <div className="cc-deck-body" role="tabpanel">
            <div className="min-w-0 flex-1 flex flex-col gap-2">
              <div className="flex items-center gap-2 min-h-[2rem]">
                {renaming && shelf ? (
                  <form onSubmit={(e) => { e.preventDefault(); void commitRename(); }} className="flex-1 min-w-0">
                    <input
                      autoFocus
                      value={renameDraft}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onBlur={() => void commitRename()}
                      onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); setRenaming(false); } }}
                      aria-label="Shelf name"
                      className="w-full max-w-xs rounded-lg bg-surface-container-high border border-outline-variant/40 px-2 py-1 text-sm font-bold text-foreground"
                    />
                  </form>
                ) : (
                  <p className="flex-1 min-w-0 truncate text-xs text-on-surface-variant">
                    {shelf
                      ? deckCards.length === 0
                        ? "Empty shelf. Tap a book below, then “Add to " + shelf.name + "”."
                        : deckCards.length > SLOTS
                          ? `${deckCards.length} books. Counsel reads ${SLOTS} at a time — pick which in the chat.`
                          : `${deckCards.length} of ${SLOTS} — the books Counsel reads together.`
                      : now.length === 0
                        ? "Books you have started show up here by themselves."
                        : "Filled in for you: the books you are part-way through."}
                  </p>
                )}
                {shelf && !renaming && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button type="button" className="cc-tap-44 shrink-0 w-9 h-9 grid place-items-center rounded-lg text-on-surface-variant hover:text-foreground hover:bg-surface-container-highest" aria-label={`More for shelf ${shelf.name}`} title="Shelf options">
                        <span className={`material-symbols-outlined text-[20px] ${digesting ? "animate-spin" : ""}`} aria-hidden>{digesting ? "progress_activity" : "more_horiz"}</span>
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="min-w-60">
                      <DropdownMenuItem onSelect={() => { setRenameDraft(shelf.name); setRenaming(true); }}>
                        <span className="material-symbols-outlined text-base mr-2" aria-hidden>edit</span> Rename
                      </DropdownMenuItem>
                      <DropdownMenuItem disabled={deckCards.length === 0} onSelect={summarizeBooks}>
                        <span className="material-symbols-outlined text-base mr-2" aria-hidden>summarize</span>
                        <span className="flex flex-col">
                          <span>Summarize its books</span>
                          <span className="text-[11px] text-on-surface-variant">Helps Counsel find the right chapter. Uses your AI key.</span>
                        </span>
                      </DropdownMenuItem>
                      <DropdownMenuItem disabled={deckCards.length === 0 || digesting} onSelect={() => void summarizeShelf()}>
                        <span className="material-symbols-outlined text-base mr-2" aria-hidden>notes</span>
                        <span className="flex flex-col">
                          <span>{shelf.summary ? "Rewrite the shelf summary" : "Write a shelf summary"}</span>
                          <span className="text-[11px] text-on-surface-variant">What this shelf is about, in a paragraph.</span>
                        </span>
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => void removeShelf()} className="text-destructive focus:text-destructive">
                        <span className="material-symbols-outlined text-base mr-2" aria-hidden>delete</span> Delete shelf
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>
              {(deckCards.length > 0 || empties > 0) && (
                <div className="grid grid-cols-4 sm:grid-cols-8 gap-x-2.5 gap-y-4 pt-1.5 pl-1.5">
                  {deckCards.map((c) => (
                    <BookCardTile key={c.book.id} card={c} compact busy={busyByBook.get(c.book.id)} shelf={openShelf} actions={actions} />
                  ))}
                  {Array.from({ length: empties }, (_, i) => (
                    <button
                      key={`empty-${i}`}
                      type="button"
                      onClick={toCollection}
                      className="cc-slot"
                      data-wide={i >= phoneEmpties || undefined}
                      aria-label={`Empty slot — choose a book to add to ${shelf?.name}`}
                    >
                      <span className="material-symbols-outlined" aria-hidden>add</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* What goes to Counsel with these books, and the one button that takes it there.
                A shelf only: "Reading now" is a view of what's in progress, not
                something to hand to Counsel. */}
            {shelf && (
            <div className="cc-deck-go">
              <button
                type="button"
                className="cc-notebook-slot"
                onClick={() => window.dispatchEvent(new CustomEvent(OPEN_NEURON_SWITCHER_EVENT))}
                title="Change the notebook Counsel uses"
              >
                <span className="material-symbols-outlined text-[22px] text-primary" aria-hidden>menu_book</span>
                <span className="min-w-0 flex flex-col text-left leading-tight">
                  <span className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">Notebook</span>
                  <span className="truncate text-sm font-bold text-foreground">
                    {notebookNames.length === 0 ? "None — just chat" : notebookNames.length === 1 ? notebookNames[0] : `${notebookNames[0]} +${notebookNames.length - 1}`}
                  </span>
                </span>
                <span className="material-symbols-outlined text-[18px] text-on-surface-variant ml-auto" aria-hidden>swap_horiz</span>
              </button>
              <button type="button" className="cc-btn3d w-full" data-tone="accent" data-size="lg" disabled={deckCards.length === 0} onClick={askCounsel}>
                <span className="material-symbols-outlined" aria-hidden>psychology</span>
                {inCounsel ? "Open Counsel" : "Ask Counsel"}
              </button>
              <p className="text-[11px] text-center text-on-surface-variant leading-snug">
                {deckCards.length === 0
                  ? "Add a book first."
                  : inCounsel
                    ? "Counsel has this shelf."
                    : `Takes this shelf${notebookNames.length ? " and the notebook" : ""} to the chat.`}
              </p>
            </div>
            )}
          </div>
        )}
      </section>

      <section aria-label="Collection" ref={collectionRef} className="scroll-mt-3">
        <div className="cc-banner mb-4 flex-wrap">
          <span className="material-symbols-outlined text-primary" aria-hidden>style</span>
          <span>{filtered ? "Matches" : "All books"}</span>
          <span className="text-xs font-semibold text-on-surface-variant">
            {sorted.length}
            <span className="hidden sm:inline">{!filtered && !showLoose && finished > 0 ? ` · ${finished} finished` : ""}</span>
          </span>
          <div className="w-full sm:w-auto sm:ml-auto flex items-center gap-1">
          {shelves.length > 0 && loose.length > 0 && (
            <button
              type="button"
              aria-pressed={showLoose}
              onClick={() => setLooseOnly((v) => !v)}
              className={`cc-tap-44 px-2 py-1 rounded-lg text-[11px] font-bold transition-colors ${
                showLoose ? "bg-accent/20 text-accent" : "text-on-surface-variant hover:text-foreground hover:bg-surface-container-highest"
              }`}
            >
              Not on a shelf · {loose.length}
            </button>
          )}
          <div className="ml-auto flex items-center gap-1" role="group" aria-label="Sort books">
            {SORTS.map((s) => (
              <button
                key={s.id}
                type="button"
                aria-pressed={sort === s.id}
                onClick={() => setSort(s.id)}
                title={`Sort by ${s.label}`}
                aria-label={`Sort by ${s.label}`}
                className={`cc-tap-44 inline-flex items-center justify-center gap-1 px-2 py-1 rounded-lg text-[11px] font-bold transition-colors ${
                  sort === s.id ? "bg-accent/20 text-accent" : "text-on-surface-variant hover:text-foreground hover:bg-surface-container-highest"
                }`}
              >
                <span className="material-symbols-outlined text-[15px]" aria-hidden>{s.icon}</span>
                <span className="hidden sm:inline">{s.label}</span>
              </button>
            ))}
          </div>
          </div>
        </div>
        {sorted.length === 0 ? (
          <p className="py-10 text-center text-sm text-on-surface-variant">No books match.</p>
        ) : (
          <div className={`${grid} pl-1.5 pt-1.5`}>
            {sorted.slice(0, shown).map((c) => (
              <BookCardTile key={c.book.id} card={c} busy={busyByBook.get(c.book.id)} shelf={openShelf} actions={actions} highlight={highlight} />
            ))}
          </div>
        )}
        {shown < sorted.length && <div ref={sentinel} className="h-8" aria-hidden />}
      </section>

      <Sheet open={listOpen} onOpenChange={(o) => { setListOpen(o); if (!o) setShelfQuery(""); }}>
        <SheetContent
          side="bottom"
          // A filtered list must not shrink the sheet: it is anchored to the
          // bottom, so a short one would drop the filter box behind the keyboard.
          className={`cc-shelf-sheet ${filterShelves ? "h-[80dvh]" : "max-h-[80dvh]"}`}
          // Opening must not raise the keyboard over the list.
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <SheetTitle className="font-headline text-lg text-foreground">Shelves</SheetTitle>
          <SheetDescription className="sr-only">Every shelf. Choose one to open it.</SheetDescription>
          {filterShelves && (
            <input
              type="search"
              value={shelfQuery}
              onChange={(e) => setShelfQuery(e.target.value)}
              placeholder="Find a shelf"
              aria-label="Find a shelf"
              className="h-11 w-full rounded-xl bg-surface-container-high border border-outline-variant/40 px-3 text-sm text-foreground"
            />
          )}
          <ul className="min-h-0 flex-1 overflow-y-auto overscroll-contain -mx-2">
            {!shelfQuery.trim() && (
              <li>
                <button type="button" className="cc-shelf-row" aria-current={deckId === NOW_ID || undefined} onClick={() => pickFromList(NOW_ID)}>
                  <span className="cc-deck-mark" aria-hidden>
                    <span className="material-symbols-outlined text-accent">local_fire_department</span>
                  </span>
                  <span className="min-w-0 flex-1 truncate text-left">Reading now</span>
                  <span className="cc-deck-count">{now.length}</span>
                </button>
              </li>
            )}
            {listedShelves.map((s) => {
              const mark = marks.get(s.id);
              return (
                <li key={s.id}>
                  <button type="button" className="cc-shelf-row" aria-current={deckId === s.id || undefined} onClick={() => pickFromList(s.id)}>
                    <span className="cc-deck-mark" style={mark ? { background: mark.color, color: mark.ink } : undefined} aria-hidden>
                      <span className="material-symbols-outlined">{mark?.glyph ?? "shelves"}</span>
                    </span>
                    <span className="min-w-0 flex-1 truncate text-left">{s.name}</span>
                    {loaded.shelfId === s.id && (
                      <span className="material-symbols-outlined text-[16px] text-accent" title="Counsel has this shelf" aria-label="Counsel has this shelf">psychology</span>
                    )}
                    {membershipLoaded && <span className="cc-deck-count">{countByShelf.get(s.id) || 0}</span>}
                  </button>
                </li>
              );
            })}
            {listedShelves.length === 0 && (
              <li className="px-3 py-6 text-center text-sm text-on-surface-variant">No shelf matches “{shelfQuery.trim()}”.</li>
            )}
          </ul>
        </SheetContent>
      </Sheet>

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
