import React, { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useApp } from "@/context/AppContext";
import { useAuth } from "@/hooks/useAuth";
import { useChatSettings } from "@/hooks/useChatSettings";
import {
  bookContextStore, selectContextBooks, isEmptySelection, resolveBookContextMode, bookHasCatalog,
  BOOK_CONTEXT_MAX_BOOKS, type BookContextMode,
} from "@/lib/chatBooks";
import { acquireGistRun, generateBookGists, releaseGistRun } from "@/lib/chapterGists";
import { Sheet, SheetContent, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { toast } from "sonner";

// Book-context picker: load a shelf (membership resolves fresh every turn —
// books added to the shelf later appear automatically) or hand-pick books.
// The NotebookLM interaction contract: cheap per-conversation sub-selection
// via checkboxes, never a reorganization of the library itself.

const BookContextPicker: React.FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
}> = ({ open, onOpenChange }) => {
  // Shelves come from AppContext — the app's ONE roster. This dialog used to
  // fetch its own on open, so a shelf created in the Vault while the picker
  // was mounted never appeared, and a deleted one lingered as a phantom.
  const { books, activeBookId, applyChapterGists, shelves, loadFocus } = useApp();
  const { user } = useAuth();
  const { selectedModel, apiKey, geminiApiKey, nvidiaKeyLast4 } = useChatSettings();
  const [gistProgress, setGistProgress] = useState<string | null>(null);
  const selection = useSyncExternalStore(bookContextStore.subscribe, bookContextStore.get);
  // The ONE mode resolution (chatBooks) — the picker must show what will
  // actually ride. `true` = preference view; the send path applies the
  // provider-capability gate on top.
  // Named for what it is: the RESOLVED mode from the one authority, read
  // for display. The source lint forbids a bare `mode ===` comparison so a
  // second, drifting coercion cannot be introduced here (review finding).
  const effectiveMode: BookContextMode = resolveBookContextMode(selection, true);

  useEffect(() => {
    bookContextStore.init(user?.id ?? null);
  }, [user?.id]);

  const shelfMembers = useMemo(
    () => (selection.shelfId ? books.filter((b) => b.folderIds.includes(selection.shelfId!)) : []),
    [books, selection.shelfId],
  );
  // One O(memberships) pass for the dropdown's per-shelf counts, not a filter
  // per option per render (store emits re-render the open dialog on every toggle).
  const countByShelf = useMemo(() => {
    const map = new Map<string, number>();
    for (const b of books) {
      for (const folderId of b.folderIds) map.set(folderId, (map.get(folderId) || 0) + 1);
    }
    return map;
  }, [books]);
  // Hand-pick mode lists the whole library; shelf mode lists its members.
  const listed = selection.shelfId ? shelfMembers : books;

  /**
   * Title search over the listed set.
   *
   * The list used to be the whole library with no way to narrow it — fine at
   * ten books, unusable at two hundred, which is where this library actually
   * is. The field only appears once the list is long enough to be worth
   * searching, so a small library keeps the vertical space instead.
   *
   * It never autofocuses: this opens as a sheet on a phone, and programmatic
   * focus there pops the soft keyboard over the very list you came to read.
   */
  const [query, setQuery] = useState("");
  const SEARCHABLE_FROM = 7;
  const searchable = listed.length >= SEARCHABLE_FROM;
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return listed;
    return listed.filter((b) => (b.title || "").toLowerCase().includes(q));
  }, [listed, query]);

  // Reset the query whenever the pool changes under it — a search left over
  // from the previous shelf silently hides books the user just switched to.
  useEffect(() => { setQuery(""); }, [selection.shelfId]);
  useEffect(() => { if (!open) setQuery(""); }, [open]);

  /**
   * O(1) membership instead of an `Array.includes` per row.
   *
   * `isChecked` ran a linear scan of `bookIds`/`excludedIds` for every book
   * rendered, so drawing the list was O(books x selection) — and the store
   * emits on every single toggle, so that quadratic redraw ran again on each
   * tap. At this library's size that is the difference between the checkbox
   * responding and the sheet feeling stuck.
   */
  const checkedSet = useMemo(
    () => new Set(selection.shelfId ? selection.excludedIds : selection.bookIds),
    [selection.shelfId, selection.excludedIds, selection.bookIds],
  );
  const effective = useMemo(
    () => selectContextBooks(books, selection, activeBookId ?? null),
    [books, selection, activeBookId],
  );

  /** Selected books that would ride full text under catalog mode because
   *  they have no catalog yet — the gist-nudge's actual subject. */
  const uncatalogued = useMemo(
    () => effective.filter((b) => b.chapters.length > 0 && !bookHasCatalog(b)),
    [effective],
  );

  const gistCoverage = useMemo(() => {
    let have = 0;
    let total = 0;
    for (const b of effective) {
      for (const c of b.chapters) {
        total++;
        if ((c.gist || "").trim()) have++;
      }
    }
    return { have, total };
  }, [effective]);

  // Generates with the user's own selected chat model + key — an explicit,
  // user-initiated spend (a few cents per book), never automatic.
  const runGists = async () => {
    if (gistProgress) return;
    // Chapterless books have nothing to summarize — and "every chapter
    // already has a summary" would be a lie about zero chapters.
    if (gistCoverage.total === 0) {
      toast.info("No chapters isolated yet — open a book and isolate its chapters first");
      return;
    }
    const targets = effective.filter((b) => b.chapters.some((c) => !(c.gist || "").trim()));
    if (targets.length === 0) {
      toast.info("Every chapter already has a summary");
      return;
    }
    // Module-scope lock: component state dies on a tab switch while the run
    // keeps going — without this, a remounted picker's button double-spends.
    if (!acquireGistRun()) {
      toast.info("Summaries are already being generated — hang on");
      return;
    }
    setGistProgress("Starting…");
    try {
      let written = 0;
      let failed = 0;
      for (const b of targets) {
        const res = await generateBookGists(
          b,
          { model: selectedModel, keys: { apiKey, geminiApiKey, nvidiaKeyLast4 } },
          (msg) => setGistProgress(`${(b.title || "Untitled").slice(0, 24)}: ${msg}`),
        );
        // Apply BEFORE surfacing any stop error: everything in res.written is
        // already in the DB, and state must mirror it or they diverge.
        applyChapterGists(res.written);
        written += Object.keys(res.written).length;
        failed += res.failed;
        if (res.stopError) {
          toast.error(res.stopError);
          if (written > 0) toast.info(`${written} summar${written === 1 ? "y" : "ies"} were saved before the stop.`);
          return;
        }
      }
      if (written > 0) {
        toast.success(
          `Catalog updated — ${written} chapter summar${written === 1 ? "y" : "ies"}` +
          (failed ? `, ${failed} failed (run again to retry)` : ""),
        );
      } else {
        toast.error(failed ? "The model returned no usable summaries — try again or switch models" : "Nothing to summarize");
      }
    } catch (e: unknown) {
      toast.error(e instanceof Error && e.message ? e.message : "Couldn't generate summaries");
    } finally {
      releaseGistRun();
      setGistProgress(null);
    }
  };

  /**
   * "How books ride" is setup, not steering.
   *
   * Everything above the shelf picker — the blurb, the full-vs-catalog toggle,
   * the summary-coverage strip — answers a question you settle once and then
   * stop asking. It was costing ~200px at the top of a sheet capped at 85vh,
   * which on a 360x780 phone left the book list about five rows tall: the one
   * part of this sheet you came here to work in was the smallest thing in it.
   *
   * So it collapses, and starts collapsed. Progressive disclosure only pays if
   * the collapsed state still tells you where you stand, so the header carries
   * the resolved mode, the number of books riding as full text against your
   * wishes, and any summary run in progress — no bare chevron with the state
   * hidden behind it.
   */
  const SETUP_KEY = "counsel_books_setup_open";
  const [setupOpen, setSetupOpen] = useState(() => {
    try {
      return localStorage.getItem(SETUP_KEY) === "1";
    } catch {
      return false;
    }
  });
  const toggleSetup = () =>
    setSetupOpen((v) => {
      const next = !v;
      try {
        localStorage.setItem(SETUP_KEY, next ? "1" : "0");
      } catch {
        // Private mode, or storage disabled — the toggle still works for
        // this session, it just won't be remembered.
      }
      return next;
    });

  /** What the header says while the setup block is shut. A running summary
   *  job outranks everything: collapsing must never hide work in flight. */
  const setupSummary =
    gistProgress ??
    (effectiveMode === "full"
      ? "Full text — everything, every message"
      : uncatalogued.length > 0
        ? `Catalog — ${uncatalogued.length} without one ride as full text`
        : "Catalog — summaries + fetch on demand");

  // In shelf mode the set holds EXCLUSIONS, so membership inverts.
  const isChecked = (id: string) => (selection.shelfId ? !checkedSet.has(id) : checkedSet.has(id));

  /** Check or clear everything currently VISIBLE — which, mid-search, means
   *  only the matches. Acting on hidden rows would be a surprise. */
  const setAllVisible = (checked: boolean) => {
    const ids = visible.map((b) => b.id);
    if (selection.shelfId) {
      const excluded = new Set(selection.excludedIds);
      for (const id of ids) {
        if (checked) excluded.delete(id);
        else excluded.add(id);
      }
      bookContextStore.set({ ...selection, excludedIds: [...excluded] });
    } else {
      const picked = new Set(selection.bookIds);
      for (const id of ids) {
        if (checked) picked.add(id);
        else picked.delete(id);
      }
      bookContextStore.set({ ...selection, bookIds: [...picked] });
    }
  };
  const visibleAllChecked = visible.length > 0 && visible.every((b) => isChecked(b.id));

  // Membership comes from the same Set the rows render from, so "is it in
  // there" is asked exactly one way in this file.
  const toggleBook = (id: string) => {
    if (selection.shelfId) {
      const excluded = checkedSet.has(id)
        ? selection.excludedIds.filter((x) => x !== id)
        : [...selection.excludedIds, id];
      bookContextStore.set({ ...selection, excludedIds: excluded });
    } else {
      const bookIds = checkedSet.has(id)
        ? selection.bookIds.filter((x) => x !== id)
        : [...selection.bookIds, id];
      bookContextStore.set({ ...selection, bookIds });
    }
  };

  // Switching shelves here IS a load — the same act as the Vault's "Chat
  // with this shelf" — so it goes through the one focus writer (undo toast
  // included; the neuron step is skipped because the picker is already a
  // dialog). Leaving shelf mode keeps the currently effective books as a
  // hand-picked FIXED set, so switching modes never silently empties context.
  const pickShelf = (shelfId: string) => {
    void loadFocus(
      shelfId
        ? { kind: "shelf", shelfId, neurons: { kind: "keep" } }
        : { kind: "books", bookIds: effective.map((b) => b.id), neurons: { kind: "keep" } },
      { navigate: false },
    );
  };

  return (
    /* A bottom sheet, not a centred dialog. This is opened FROM the composer's
       tool sheet, so a modal that flies to the middle of the screen was a
       change of idiom mid-task; and on a phone the controls now sit under the
       thumb instead of above the reach arc. Same primitive underneath —
       shadcn's Sheet is Radix Dialog — so focus trapping and Escape are
       unchanged. */
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        // Android rule, as everywhere else: nothing takes focus on open, or
        // the soft keyboard covers the sheet the moment it appears.
        onOpenAutoFocus={(e) => e.preventDefault()}
        className="max-h-[85vh] p-0 flex flex-col rounded-t-2xl bg-surface-container-low border-outline-variant/20 sm:max-w-lg sm:mx-auto pb-[calc(env(safe-area-inset-bottom)+0.5rem)]"
      >
        {/* HEADER — fixed, and the disclosure control for everything above the
            shelf picker. The whole row is the target (48px tall, full width)
            rather than a lone chevron in the corner, which on a phone is a
            24px tap surrounded by dead space.

            `asChild` on the title and description matters: Radix renders them
            as <h2> and <p>, and neither is phrasing content, so nesting them
            inside a <button> would be invalid HTML. Rendered as spans they
            still carry the aria-labelledby / aria-describedby wiring the
            dialog needs. */}
        <div className="border-b border-outline-variant/10 shrink-0">
          <button
            type="button"
            onClick={toggleSetup}
            aria-expanded={setupOpen}
            aria-controls="book-context-setup"
            className="w-full min-h-[48px] flex items-center gap-3 px-4 py-2.5 text-left hover:bg-surface-container-high transition-colors"
            style={{ touchAction: "manipulation" }}
          >
            <span className="flex-1 min-w-0">
              <SheetTitle asChild>
                <span className="block font-headline text-base text-primary truncate">Books in context</span>
              </SheetTitle>
              <SheetDescription asChild>
                <span className={setupOpen ? "block text-xs mt-0.5 text-on-surface-variant" : "sr-only"}>
                  What rides with every message. Load a shelf to keep it in sync.
                </span>
              </SheetDescription>
              {!setupOpen && (
                <span className="block text-[11px] text-on-surface-variant truncate">{setupSummary}</span>
              )}
            </span>
            <span
              className="material-symbols-outlined shrink-0 text-on-surface-variant transition-transform"
              style={setupOpen ? { transform: "rotate(180deg)" } : undefined}
              aria-hidden
            >
              expand_more
            </span>
          </button>
        </div>

        {/* SETUP — collapsible. Stays mounted when shut so `aria-controls`
            always resolves, and so the mode buttons keep their identity. */}
        <div
          id="book-context-setup"
          className={setupOpen ? "flex flex-col gap-3 px-4 pt-3 shrink-0" : "hidden"}
        >
          <div className="flex flex-col gap-1.5">
            <label className="text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant">How books ride</label>
            <div className="grid grid-cols-2 gap-1 rounded-lg bg-surface-container-high p-1">
              {(
                [
                  ["full", "Full text", "everything, every message"],
                  ["catalog", "Catalog", "summaries + fetch on demand"],
                ] as const
              ).map(([value, label, hint]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => bookContextStore.set({ ...selection, mode: value })}
                  aria-pressed={effectiveMode === value}
                  className={`min-h-[44px] rounded-md px-2 py-1.5 text-left transition-colors ${
                    effectiveMode === value ? "bg-primary-container/60 text-foreground" : "text-on-surface-variant hover:bg-surface-container-highest"
                  }`}
                >
                  <span className="block text-xs font-semibold">{label}</span>
                  <span className="block text-[10px] opacity-80">{hint}</span>
                </button>
              ))}
            </div>
          </div>

          {effectiveMode === "catalog" && (
            <div className="flex items-center justify-between gap-3 rounded-lg bg-surface-container-high px-3 py-2">
              <span className="min-w-0 truncate text-[11px] text-on-surface-variant">
                {gistProgress ??
                  (gistCoverage.total === 0
                    ? "The loaded books have no chapters yet."
                    : uncatalogued.length > 0
                      // The flip is gist-aware: a book with no catalog rides
                      // as full text, because a bare title map measurably
                      // loses exact-quote retrieval. Say which books that is.
                      ? `${uncatalogued.length} book${uncatalogued.length === 1 ? "" : "s"} without a catalog ride as full text — ${gistCoverage.have}/${gistCoverage.total} chapters summarized.`
                      : `${gistCoverage.have}/${gistCoverage.total} chapters have summaries.`)}
              </span>
              <button
                type="button"
                onClick={runGists}
                disabled={!!gistProgress || effective.length === 0}
                className="shrink-0 min-h-[44px] px-2 -mr-2 text-[11px] font-bold uppercase tracking-widest text-primary disabled:opacity-50"
              >
                {gistProgress ? "Working…" : "Generate summaries"}
              </button>
            </div>
          )}
        </div>

        {/* STEERING — always visible. Which shelf, and which books in it, is
            what you change from message to message. */}
        <div className="flex flex-col gap-3 px-4 pt-3 shrink-0">
          <div className="flex flex-col gap-1.5">
            <label className="text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant">Shelf</label>
            <select
              value={selection.shelfId || ""}
              onChange={(e) => pickShelf(e.target.value)}
              className="w-full min-h-[44px] bg-surface-container-high border-none rounded-lg text-sm py-2 px-3"
            >
              {/* Was a 70-character sentence that truncated to nonsense in a
                  native picker on a phone. The caveat it carried now sits
                  under the control, where it has room. */}
              <option value="">Hand-picked books</option>
              {shelves.map((f) => {
                const n = countByShelf.get(f.id) || 0;
                return <option key={f.id} value={f.id}>{f.name} ({n} book{n === 1 ? "" : "s"})</option>;
              })}
            </select>
            <p className="text-[10px] text-on-surface-variant">
              {selection.shelfId
                ? "Books added to this shelf later join automatically."
                : "A fixed set — books added to a shelf later won't join."}
            </p>
          </div>

          {searchable && (
            <div className="flex items-center gap-2">
              <div className="relative flex-1 min-w-0">
                <span className="material-symbols-outlined text-base absolute left-2.5 top-1/2 -translate-y-1/2 text-on-surface-variant pointer-events-none" aria-hidden>search</span>
                <input
                  type="text"
                  inputMode="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={`Search ${listed.length} books…`}
                  aria-label="Search books by title"
                  className="w-full min-h-[44px] bg-surface-container-high border-none rounded-lg text-sm py-2 pl-9 pr-9"
                />
                {query && (
                  <button
                    type="button"
                    onClick={() => setQuery("")}
                    aria-label="Clear search"
                    className="absolute right-1 top-1/2 -translate-y-1/2 h-9 w-9 flex items-center justify-center rounded-lg text-on-surface-variant hover:text-primary"
                  >
                    <span className="material-symbols-outlined text-base">close</span>
                  </button>
                )}
              </div>
              <button
                type="button"
                onClick={() => setAllVisible(!visibleAllChecked)}
                disabled={visible.length === 0}
                className="shrink-0 min-h-[44px] px-2 text-[10px] font-bold uppercase tracking-widest text-primary disabled:opacity-40"
              >
                {visibleAllChecked ? "None" : "All"}
              </button>
            </div>
          )}
        </div>

        {/* THE LIST — the ONLY scroller in the sheet. It used to be a
            `max-h-72` scroller nested inside a scrolling dialog, which on a
            phone is the trap where a flick moves whichever container the
            browser guesses. One scroll region, and it is this one. */}
        {visible.length === 0 ? (
          <p className="text-sm text-on-surface-variant py-8 px-4 text-center flex-1">
            {listed.length === 0
              ? (selection.shelfId ? "This shelf has no books yet." : "Your library is empty.")
              : `No book matches “${query}”.`}
          </p>
        ) : (
          <div className="flex-1 min-h-0 overflow-y-auto px-4 py-2 flex flex-col gap-0.5">
            {visible.map((b) => (
              <label
                key={b.id}
                className="flex items-center gap-3 min-h-[48px] text-sm px-2 py-1.5 rounded-lg hover:bg-surface-container-high cursor-pointer"
                style={{ touchAction: "manipulation" }}
              >
                <input
                  type="checkbox"
                  checked={isChecked(b.id)}
                  onChange={() => toggleBook(b.id)}
                  className="h-5 w-5 shrink-0 accent-primary"
                />
                <span className="min-w-0">
                  <span className="block truncate font-medium text-foreground">
                    {b.title}
                    {b.id === activeBookId ? <span className="ml-1.5 text-[10px] font-bold uppercase tracking-widest text-primary">reading</span> : null}
                  </span>
                  <span className="block text-[11px] text-on-surface-variant">
                    {b.chapters.length > 0
                      ? `${b.chapters.length} chapter${b.chapters.length === 1 ? "" : "s"}`
                      : "no chapters isolated — its text can't be sent yet"}
                  </span>
                </span>
              </label>
            ))}
          </div>
        )}

        {/* FOOTER — fixed. The running total was previously below the list and
            below the fold; it is the one line that answers "what did I just
            do", so it stays on screen. */}
        <div className="flex items-center justify-between gap-3 px-4 py-2 border-t border-outline-variant/10 text-[11px] text-on-surface-variant shrink-0">
          <span className="min-w-0">
            {effective.length === 0
              ? "Nothing loaded."
              : `${effective.length} book${effective.length === 1 ? "" : "s"} will ride with each message.`}
            {effective.length >= BOOK_CONTEXT_MAX_BOOKS ? ` (max ${BOOK_CONTEXT_MAX_BOOKS})` : ""}
          </span>
          {!isEmptySelection(selection) && (
            <button
              onClick={() => bookContextStore.clear()}
              className="shrink-0 min-h-[44px] px-2 -mr-2 font-bold uppercase tracking-widest hover:text-destructive"
            >
              Clear all
            </button>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
};

export default BookContextPicker;
