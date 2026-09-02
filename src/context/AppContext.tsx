import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from "react";
import { flushSync } from "react-dom";
import { toast } from "sonner";
import { BookDocument, Chapter } from "@/types/library";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Wiki, fetchWikis, fetchActiveWikiIds, loadWiki as loadWikiApi, loadWikiSet, createWiki, sessionActiveWikiIds } from "@/lib/wikisApi";
import { fetchShelfMembership, applyShelfDelta, type ShelfDelta } from "@/lib/shelfMembership";
import { listFolders, createFolder, renameFolder, deleteFolder, type BookFolder } from "@/lib/bookFolders";
import { MAX_ACTIVE_NEURONS } from "@/lib/neuronAccess";

type TabId = "library" | "viewer" | "chat" | "wiki" | "wikis" | "settings" | "admin";

interface AppState {
  books: BookDocument[];
  activeBookId: string | null;
  activeTab: TabId;
  wikis: Wiki[];
  activeWikiId: string | null;
  activeWiki: Wiki | undefined;
  /** Full ordered loaded set — [0] is the primary (= activeWikiId). */
  activeWikiIds: string[];
  /** Loaded neurons in order, primary first (ids resolved against `wikis`). */
  activeWikis: Wiki[];
  addBook: (book: BookDocument, sourceFile?: File) => Promise<string>;
  removeBook: (id: string) => void;
  setActiveBook: (id: string) => void;
  setActiveBookSilent: (id: string) => void;
  /** Book id awaiting a neuron choice in the load dialog (null = dialog closed). */
  pendingBookLoadId: string | null;
  /** Entry point for loading a book from the Vault: opens the neuron-pick dialog. */
  requestBookLoad: (bookId: string) => void;
  /** Resolves the load dialog: loads the chosen neuron (if any/changed) then opens the book. neuronId null = skip / keep current. chainWikiIds (when set) loads that whole set instead. */
  resolveBookLoad: (neuronId: string | null, chainWikiIds?: string[]) => Promise<void>;
  setActiveTab: (tab: TabId) => void;
  addChapter: (bookId: string, chapter: Chapter) => Promise<void>;
  updateChapter: (bookId: string, chapterId: string, name: string) => void;
  removeChapter: (bookId: string, chapterId: string) => void;
  updateBookTitle: (bookId: string, newTitle: string) => void;
  updateBookTags: (bookId: string, category: string | null, tags: string[]) => Promise<void>;
  /** Toggle one shelf on/off for a book. Optimistic (state patches before
   *  the write, inverse-delta rollback on failure); in multi-shelf mode a
   *  check adds membership, in exclusive fallback it replaces it. */
  toggleBookShelf: (bookId: string, shelfId: string) => Promise<void>;
  /** THE shelf roster — one copy for the whole app. Membership already had
   *  this law (books[].folderIds); the roster did not, so the Vault and the
   *  chat picker each fetched their own and drifted: a shelf created in one
   *  was invisible to the other, and a shelf deleted in one lingered as a
   *  phantom that resolved to nothing. */
  shelves: BookFolder[];
  /** True until the first roster load settles (success or failure). */
  shelvesLoading: boolean;
  createShelf: (name: string) => Promise<BookFolder>;
  renameShelf: (id: string, name: string) => Promise<void>;
  /** Deletes the shelf AND drops it from every book's folderIds. The DB
   *  cascades junction rows and SET NULLs the folder_id mirror; this keeps
   *  client state in step without a reload or per-book writes. */
  deleteShelf: (id: string) => Promise<void>;
  /** Patch a freshly generated shelf digest into the roster. The DB write
   *  happens in shelfDigest.ts; this only mirrors it locally. */
  applyShelfDigest: (shelfId: string, summary: string, model: string) => void;
  /** True once the shelf-membership junction is confirmed live this session —
   *  until then shelf assignment is exclusive (one shelf per book). */
  multiShelf: boolean;
  /** False until the first membership read settles. Shelf UI must not state
   *  a count before this: books load with EMPTY folderIds, so a count read
   *  early is a confident zero rather than "not known yet". */
  membershipLoaded: boolean;
  getActiveBook: () => BookDocument | undefined;
  loadBookFile: (bookId: string) => Promise<string>;
  /** Fetch one chapter's text on demand (not loaded at startup). */
  loadChapterText: (chapterId: string) => Promise<string>;
  loadChapterTextStrict: (chapterId: string) => Promise<{ ok: boolean; text?: string; error?: string }>;
  /** Fetch every chapter's text for one book on demand. */
  loadBookChapterText: (bookId: string) => Promise<void>;
  /** Patch freshly generated chapter gists into library state (catalog mode).
   *  DB writes happen in chapterGists.ts; this only mirrors them locally. */
  applyChapterGists: (gistById: Record<string, string>) => void;
  /** Patch a freshly generated book summary into library state. The DB write
   *  happens in bookSummary.ts; this only mirrors it locally. */
  applyBookSummary: (bookId: string, summary: string, model: string) => void;

  refreshWikis: () => Promise<void>;
  setActiveWiki: (wikiId: string) => Promise<void>;
  /** Replace the loaded set. ids[0] becomes the primary; capped at MAX_ACTIVE_NEURONS. */
  setActiveNeurons: (wikiIds: string[]) => Promise<void>;
  /** Add/remove a secondary neuron from the loaded set (primary can't be removed). Resolves to the new set. */
  toggleNeuronInSession: (wikiId: string) => Promise<string[]>;
  signOut: () => void;
}

const AppContext = createContext<AppState | null>(null);

const DEFAULT_STORAGE_EXTENSION = "pdf";

/** Page through a Supabase select so a library bigger than the API's default
 *  row cap still loads completely. Returns rows gathered so far plus the error
 *  that stopped it (if any) — a partial library beats none. */
const PAGE_SIZE = 500;
async function fetchAllRows(
  query: (from: number, to: number) => PromiseLike<{ data: any[] | null; error: any }>
): Promise<{ rows: any[]; error: any }> {
  const rows: any[] = [];
  for (let page = 0; page < 40; page++) {
    const from = page * PAGE_SIZE;
    const { data, error } = await query(from, from + PAGE_SIZE - 1);
    if (error) return { rows, error };
    const batch = data || [];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return { rows, error: null };
}


const getFileExtension = (fileName: string) => {
  const parts = fileName.toLowerCase().split(".");
  return parts.length > 1 ? parts.pop() || DEFAULT_STORAGE_EXTENSION : DEFAULT_STORAGE_EXTENSION;
};

const getStoragePath = (userId: string, bookId: string, fileName: string) => {
  return `${userId}/${bookId}.${getFileExtension(fileName)}`;
};

const getStoragePathsForBook = (userId: string, bookId: string, fileName: string) => {
  const primaryPath = getStoragePath(userId, bookId, fileName);
  const legacyPath = `${userId}/${bookId}.pdf`;

  return primaryPath === legacyPath ? [primaryPath] : [primaryPath, legacyPath];
};

export const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [books, setBooks] = useState<BookDocument[]>([]);
  const [multiShelf, setMultiShelf] = useState(false);
  const [membershipLoaded, setMembershipLoaded] = useState(false);
  const [shelves, setShelves] = useState<BookFolder[]>([]);
  const [shelvesLoading, setShelvesLoading] = useState(true);
  const [activeBookId, setActiveBookId] = useState<string | null>(null);
  const [pendingBookLoadId, setPendingBookLoadId] = useState<string | null>(null);
  // Restore-the-last-book runs once per signed-in session (guard ref).
  const restoredBookRef = useRef(false);
  const [activeTab, setActiveTab] = useState<TabId>("library");
  const [wikis, setWikis] = useState<Wiki[]>([]);
  const [activeWikiId, setActiveWikiId] = useState<string | null>(null);
  // Full ordered loaded set — invariant: activeWikiIds[0] === activeWikiId.
  const [activeWikiIds, setActiveWikiIds] = useState<string[]>([]);
  // Synchronously-updated mirror of the loaded set. Mutations read and write
  // THIS (before their awaits), so two quick toggles compose instead of the
  // second overwriting the first from a stale closure.
  const activeWikiIdsRef = useRef<string[]>([]);

  const commitActiveSet = useCallback((ids: string[]) => {
    activeWikiIdsRef.current = ids;
    sessionActiveWikiIds.current = ids; // chat tools read this when the DB can't hold the set
    setActiveWikiId(ids[0] ?? null);
    setActiveWikiIds(ids);
  }, []);
  const { user, signOut } = useAuth();

  // Navigate between tabs with a View Transitions cross-fade where supported.
  // flushSync forces React to commit the new tab inside the transition's
  // snapshot callback. Falls back to a plain update on older engines or when
  // the user prefers reduced motion.
  const navigateTab = useCallback((tab: TabId) => {
    const doc = document as Document & {
      startViewTransition?: (cb: () => void) => unknown;
    };
    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (typeof doc.startViewTransition === "function" && !reduceMotion) {
      doc.startViewTransition(() => flushSync(() => setActiveTab(tab)));
    } else {
      setActiveTab(tab);
    }
  }, []);

  const refreshWikis = useCallback(async () => {
    if (!user) { setWikis([]); setActiveWikiId(null); setActiveWikiIds([]); activeWikiIdsRef.current = []; return; }
    try {
      let [list, active] = await Promise.all([fetchWikis(), fetchActiveWikiIds()]);
      if (list.length === 0) {
        const created = await createWiki({ name: "My 1st Neuron", description: "Your default neuron — extracted knowledge lives here." });
        await loadWikiApi(created.id);
        list = [created]; active = { primary: created.id, set: [created.id], setPersisted: true };
      }
      // Self-heal: drop set members that no longer exist (deleted elsewhere;
      // active_wiki_ids has no FK, so dead ids can linger there). If the
      // primary itself is gone/null, promote the next loaded neuron — or fall
      // back to the first wiki. Persist any repair: the DB primary is what
      // the AI tools and the knowledge-extract edge function write to, so a
      // local-only heal would leave them targeting NULL/dead ids forever.
      const existing = new Set(list.map((w) => w.id));
      let set = active.set.filter((id) => existing.has(id));
      let primary = active.primary && existing.has(active.primary) ? active.primary : set[0] ?? null;
      if (!primary) {
        const fallback = list[0];
        await loadWikiApi(fallback.id);
        primary = fallback.id;
        set = [fallback.id];
      } else {
        if (set[0] !== primary) set = [primary, ...set.filter((id) => id !== primary)];
        if (primary !== active.primary || set.length !== active.set.length) {
          try { await loadWikiSet(set); } catch { /* best-effort — retried on next refresh */ }
        }
      }
      // Pre-migration the array column can't persist the set — keep this
      // session's extra loaded neurons instead of collapsing to the primary
      // every time something unrelated triggers a refresh. (Post-migration
      // setPersisted is true and the DB is authoritative.)
      if (!active.setPersisted && activeWikiIdsRef.current[0] === primary) {
        const extras = activeWikiIdsRef.current.filter((id) => existing.has(id) && !set.includes(id));
        set = [...set, ...extras].slice(0, MAX_ACTIVE_NEURONS);
      }
      setWikis(list);
      commitActiveSet(set);
    } catch (err) { console.error("Failed to load wikis:", err); }
  }, [user, commitActiveSet]);

  useEffect(() => { refreshWikis(); }, [refreshWikis]);

  // Listen for AI-tool-driven wiki switches/creates to refresh active wiki state live.
  useEffect(() => {
    const handler = () => { refreshWikis(); };
    window.addEventListener("wiki-active-changed", handler);
    return () => window.removeEventListener("wiki-active-changed", handler);
  }, [refreshWikis]);

  // Shared write path: claim the ref BEFORE the network round-trips so a
  // second mutation started while this one is in flight composes with it
  // (instead of overwriting from a stale snapshot); roll back on failure.
  const applyActiveSet = useCallback(async (ids: string[]) => {
    const prev = activeWikiIdsRef.current;
    activeWikiIdsRef.current = ids;
    try {
      await loadWikiSet(ids);
    } catch (err) {
      // Only roll back if no later mutation has claimed the ref meanwhile.
      if (activeWikiIdsRef.current === ids) activeWikiIdsRef.current = prev;
      throw err;
    }
    commitActiveSet(activeWikiIdsRef.current);
    const nowIso = new Date().toISOString();
    setWikis((p) => p.map((w) => (ids.includes(w.id) ? { ...w, last_loaded_at: nowIso } : w)));
  }, [commitActiveSet]);

  const setActiveWiki = useCallback(async (wikiId: string) => {
    // Single-load replaces the whole set (activation replaces context, never
    // silently appends) — the long-standing behavior of every "Load" button.
    await applyActiveSet([wikiId]);
  }, [applyActiveSet]);

  const setActiveNeurons = useCallback(async (wikiIds: string[]) => {
    const ids = Array.from(new Set(wikiIds)).slice(0, MAX_ACTIVE_NEURONS);
    if (ids.length === 0) throw new Error("No neurons to load — they may have been deleted.");
    await applyActiveSet(ids);
  }, [applyActiveSet]);

  const toggleNeuronInSession = useCallback(async (wikiId: string): Promise<string[]> => {
    const current = activeWikiIdsRef.current;
    if (wikiId === current[0]) return current; // the primary can't be unloaded
    let next: string[];
    if (current.includes(wikiId)) {
      next = current.filter((id) => id !== wikiId);
    } else {
      if (current.length >= MAX_ACTIVE_NEURONS) {
        throw new Error(`You can load up to ${MAX_ACTIVE_NEURONS} neurons at once — unload one first.`);
      }
      next = [...current, wikiId];
    }
    await applyActiveSet(next);
    return next;
  }, [applyActiveSet]);

  const getAuthenticatedUserId = useCallback(async () => {
    if (user?.id) return user.id;

    const { data, error } = await supabase.auth.getUser();

    if (error) {
      console.error("Failed to resolve authenticated user:", error);
      throw error;
    }

    if (!data.user?.id) {
      throw new Error("Your session expired. Please sign in again.");
    }

    return data.user.id;
  }, [user?.id]);

  useEffect(() => {
    if (!user) {
      setBooks([]);
      setActiveBookId(null);
      setMultiShelf(false);
      return;
    }

    let cancelled = false;

    // Books first, chapter METADATA second, chapter TEXT never at startup.
    // The old single fetch pulled every chapter's full text (megabytes on a
    // real library) and threw the whole library away if it failed — which is
    // how the chat ended up reporting "no books" while the Vault had 50.
    const loadBooks = async () => {
      // First read IS the probe (house law — no HEAD probes): ask for the
      // summary columns; a 42703 means the book-summary migration
      // (20260902120000) isn't applied yet, so retry without them and this
      // session runs a summary-less catalog. Same shape as the chapters.gist
      // feature-detect below.
      const BOOK_COLUMNS =
        "id, title, file_name, page_count, cover_image_url, created_at, category, tags, folder_id";
      const loadBookRows = async () => {
        const withSummary = await fetchAllRows((from, to) =>
          supabase
            .from("books")
            .select(`${BOOK_COLUMNS}, summary, summary_model, summarized_at`)
            .eq("user_id", user.id)
            .order("created_at", { ascending: false })
            .range(from, to)
        );
        if (!withSummary.error || (withSummary.error as any)?.code !== "42703") return withSummary;
        return fetchAllRows((from, to) =>
          supabase
            .from("books")
            .select(BOOK_COLUMNS)
            .eq("user_id", user.id)
            .order("created_at", { ascending: false })
            .range(from, to)
        );
      };
      const bookRows = await loadBookRows();

      if (cancelled) return;

      if (bookRows.error) {
        console.error("Failed to load books:", bookRows.error);
        return;
      }

      const dbBooks: BookDocument[] = bookRows.rows.map((b: any) => ({
        id: b.id,
        title: b.title,
        fileName: b.file_name,
        fileData: "",
        pageCount: b.page_count,
        coverImageUrl: b.cover_image_url || undefined,
        chapters: [],
        addedAt: new Date(b.created_at).getTime(),
        category: b.category || undefined,
        tags: Array.isArray(b.tags) ? b.tags : [],
        summary: b.summary ?? null,
        summaryModel: b.summary_model ?? null,
        summarizedAt: b.summarized_at ? new Date(b.summarized_at).getTime() : null,
        // EMPTY, deliberately. The junction read below is the authority.
        // Seeding from the single-valued folder_id mirror meant a book on
        // three shelves rendered as being on one — with the shelf menu's
        // checkboxes wrong to match — for as long as that read took. The
        // mirror is held back in `mirrorFolderId` and used only if the
        // junction turns out to be unavailable.
        folderIds: [],
      }));
      const mirrorFolderId = new Map<string, string | null>(
        bookRows.rows.map((b: any) => [b.id as string, (b.folder_id as string | null) ?? null]),
      );
      /** Fallback path: derive single-shelf membership from the mirror. */
      const applyMirrorMembership = () => {
        setBooks((prev) => prev.map((b) => {
          if (!initialIds.has(b.id)) return b;
          const mirror = mirrorFolderId.get(b.id);
          return { ...b, folderIds: mirror ? [mirror] : [] };
        }));
      };
      // The library (and the chat's view of it) is usable from here on, even
      // if chapters never arrive.
      setBooks(dbBooks);
      const initialIds = new Set(dbBooks.map((b) => b.id));

      // Chapters and shelf membership load concurrently and patch state
      // INDEPENDENTLY — they touch disjoint fields, and gating one behind
      // the other would delay whichever resolves first for no reason.
      // First read IS the probe (house law — no HEAD probes): ask for the
      // gist column; a 42703 means the Stage-1 catalog migration isn't
      // applied yet, so retry without it and this session runs a gistless
      // catalog. Any other error keeps the existing degradation (books stay,
      // chapters are an enhancement).
      const loadChapterRows = async () => {
        const withGist = await fetchAllRows((from, to) =>
          supabase
            .from("chapters")
            .select("id, book_id, name, start_page, end_page, created_at, gist")
            .eq("user_id", user.id)
            .order("created_at", { ascending: true })
            .range(from, to)
        );
        if (!withGist.error || (withGist.error as any)?.code !== "42703") return withGist;
        return fetchAllRows((from, to) =>
          supabase
            .from("chapters")
            .select("id, book_id, name, start_page, end_page, created_at")
            .eq("user_id", user.id)
            .order("created_at", { ascending: true })
            .range(from, to)
        );
      };
      void loadChapterRows().then((chapterRows) => {
        if (cancelled) return;

        if (chapterRows.error) {
          // Books stay. A chapter list is an enhancement, not a precondition.
          console.error("Failed to load chapters:", chapterRows.error);
          return;
        }

        const chaptersByBookId = chapterRows.rows.reduce<Record<string, Chapter[]>>((acc, chapter: any) => {
          if (!acc[chapter.book_id]) acc[chapter.book_id] = [];
          acc[chapter.book_id].push({
            id: chapter.id,
            name: chapter.name,
            startPage: chapter.start_page,
            endPage: chapter.end_page,
            textContent: "",
            gist: chapter.gist ?? null,
          });
          return acc;
        }, {});

        setBooks((prev) => prev.map((b) => ({ ...b, chapters: chaptersByBookId[b.id] || b.chapters })));
      });

      void fetchShelfMembership(user.id)
        .then((membership) => {
          if (cancelled) return;
          if (!membership) {
            // null = junction not applied yet. Fall back to the mirror we
            // held back, so the session still shows the memberships it can
            // represent (one shelf per book) rather than none.
            applyMirrorMembership();
            return;
          }
          setMultiShelf(true);
          // Patch only books that existed when the snapshot was taken — a
          // book that arrived after (realtime INSERT, upload) keeps its own
          // folderIds; the snapshot can't speak for it.
          setBooks((prev) => prev.map((b) =>
            initialIds.has(b.id) ? { ...b, folderIds: membership.get(b.id) || [] } : b
          ));
        })
        .catch((e) => {
          // Transient failure — not a mode change, and not a reason to show
          // an empty library of shelves. Fall back to the mirror; the session
          // keeps the exclusive UI, and applyShelfDelta still lands junction
          // rows best-effort whenever the junction isn't known-missing, so
          // nothing written this session vanishes on the next reload.
          if (cancelled) return;
          console.error("Failed to load shelf membership:", e);
          applyMirrorMembership();
        })
        .finally(() => { if (!cancelled) setMembershipLoaded(true); });
    };
    loadBooks();


    // Realtime: auto-refresh library when books are added/removed elsewhere
    // (e.g. video transcript PDFs auto-saved by the edge function, mobile app uploads)
    const channel = supabase
      .channel(`books-realtime-${user.id}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "books", filter: `user_id=eq.${user.id}` },
        async (payload) => {
          const b: any = payload.new;
          // Same first-read-is-the-probe fallback as the startup load.
          // "gist" is cast until Lovable's applied migration regenerates
          // types.ts — same convention as every other pre-apply column.
          let chapterRows: any[] | null = null;
          let chErr: any = null;
          ({ data: chapterRows, error: chErr } = (await supabase
            .from("chapters")
            .select("id, name, start_page, end_page, gist" as any)
            .eq("book_id", b.id)
            .eq("user_id", b.user_id)
            .order("created_at", { ascending: true })) as any);
          if (chErr && chErr.code === "42703") {
            ({ data: chapterRows } = (await supabase
              .from("chapters")
              .select("id, name, start_page, end_page")
              .eq("book_id", b.id)
              .eq("user_id", b.user_id)
              .order("created_at", { ascending: true })) as any);
          }
          const chapters: Chapter[] = (chapterRows || []).map((c: any) => ({
            id: c.id,
            name: c.name,
            startPage: c.start_page,
            endPage: c.end_page,
            textContent: "",
            gist: c.gist ?? null,
          }));

          setBooks((prev) => {
            if (prev.some((x) => x.id === b.id)) return prev;
            const newBook: BookDocument = {
              id: b.id,
              title: b.title,
              fileName: b.file_name,
              fileData: "",
              pageCount: b.page_count ?? 0,
              coverImageUrl: b.cover_image_url || undefined,
              chapters,
              addedAt: new Date(b.created_at).getTime(),
              category: b.category || undefined,
              tags: Array.isArray(b.tags) ? b.tags : [],
              // A just-inserted book carries at most its folder_id mirror;
              // junction rows for it would be written by this same client.
              // A just-inserted book has no junction rows yet; the mirror is
              // all there is to go on, and for a new book it is accurate.
              folderIds: b.folder_id ? [b.folder_id] : [],
            };

            return [newBook, ...prev];
          });
        }
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "books", filter: `user_id=eq.${user.id}` },
        (payload) => {
          const oldId = (payload.old as any)?.id;
          if (!oldId) return;
          setBooks((prev) => prev.filter((b) => b.id !== oldId));
          setActiveBookId((prev) => (prev === oldId ? null : prev));
        }
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [user]);


  // Allow the once-per-session restore to run again when the account changes.
  useEffect(() => {
    restoredBookRef.current = false;
  }, [user?.id]);

  // Restore the last-opened book across reloads — SILENTLY (no tab jump), so
  // Counsel/the AI still knows which book is loaded after a refresh. Runs once,
  // as soon as the library has loaded, and only if nothing is already active.
  useEffect(() => {
    if (!user || restoredBookRef.current || books.length === 0) return;
    restoredBookRef.current = true;
    if (activeBookId) return;
    try {
      const saved = localStorage.getItem(`cc_active_book_${user.id}`);
      if (saved && books.some((b) => b.id === saved)) {
        setActiveBookId(saved);
      }
    } catch {
      /* localStorage unavailable — skip restore */
    }
  }, [user, books, activeBookId]);

  // Persist the active book so it survives reloads (per-user key).
  useEffect(() => {
    if (!user) return;
    try {
      if (activeBookId) localStorage.setItem(`cc_active_book_${user.id}`, activeBookId);
      else localStorage.removeItem(`cc_active_book_${user.id}`);
    } catch {
      /* localStorage unavailable — non-fatal */
    }
  }, [user, activeBookId]);

  const addBook = useCallback(async (book: BookDocument, sourceFile?: File) => {
    if (!user) throw new Error("You must be signed in to upload books");

    const { data: existingRow, error: existingRowError } = await supabase
      .from("books")
      .select("id, file_name")
      .eq("user_id", user.id)
      .ilike("file_name", book.fileName)
      .limit(1)
      .maybeSingle();

    if (existingRowError) {
      console.error("Failed to look up existing book record:", existingRowError);
      throw existingRowError;
    }

    const existingBookId = existingRow?.id as string | undefined;
    let finalBookId = existingBookId || book.id;
    let createdNewBook = false;

    if (!existingBookId) {
      const { data, error } = await supabase
        .from("books")
        .insert({ id: book.id, title: book.title, file_name: book.fileName, page_count: book.pageCount, user_id: user.id })
        .select()
        .single();

      if (error || !data) {
        console.error("Failed to create book record:", error);
        throw error || new Error("Failed to create book record");
      }

      finalBookId = data.id;
      createdNewBook = true;
    } else {
      const { error: updateError } = await supabase
        .from("books")
        .update({ title: book.title, file_name: book.fileName, page_count: book.pageCount })
        .eq("id", existingBookId)
        .eq("user_id", user.id);

      if (updateError) {
        console.error("Failed to update existing book record:", updateError);
        throw updateError;
      }
    }

    if (!sourceFile && !book.fileData) {
      setBooks((prev) => {
        const existingIndex = prev.findIndex((b) => b.id === finalBookId);
        const nextBook = { ...book, id: finalBookId, fileData: "" };

        if (existingIndex === -1) return [nextBook, ...prev];

        return prev.map((b) => (b.id === finalBookId ? { ...b, ...nextBook } : b));
      });
      return finalBookId;
    }

    try {
      const uploadFileName = sourceFile?.name || book.fileName;
      const blob = sourceFile
        ? sourceFile
        : await (await fetch(book.fileData)).blob();
      const uploadPath = getStoragePath(user.id, finalBookId, uploadFileName);
      const uploadContentType = sourceFile?.type || (uploadFileName.toLowerCase().endsWith(".pdf")
        ? "application/pdf"
        : "application/octet-stream");

      const { error: uploadError } = await supabase.storage
        .from("book-pdfs")
        .upload(uploadPath, blob, { contentType: uploadContentType, upsert: true });

      if (uploadError) throw uploadError;

      if (existingRow?.file_name) {
        const stalePaths = getStoragePathsForBook(user.id, finalBookId, existingRow.file_name)
          .filter((path) => path !== uploadPath);

        if (stalePaths.length > 0) {
          await supabase.storage.from("book-pdfs").remove(stalePaths);
        }
      }

      const cachedFileUrl = sourceFile ? URL.createObjectURL(sourceFile) : book.fileData;

      setBooks((prev) => {
        const existingIndex = prev.findIndex((b) => b.id === finalBookId);
        const nextBook = { ...book, id: finalBookId, fileData: cachedFileUrl };

        if (existingIndex === -1) return [nextBook, ...prev];

        // Re-upload: the freshly constructed book carries folderIds: [] —
        // keep the existing membership, a re-upload is not an unshelving.
        return prev.map((b) => (b.id === finalBookId ? { ...b, ...nextBook, folderIds: b.folderIds } : b));
      });
    } catch (err) {
      console.error("Failed to upload document to storage:", err);

      if (createdNewBook) {
        await supabase.from("books").delete().eq("id", finalBookId).eq("user_id", user.id);
        setBooks((prev) => prev.filter((b) => b.id !== finalBookId));
      }

      throw err instanceof Error ? err : new Error("Document upload failed");
    }

    return finalBookId;
  }, [user]);

  const removeBook = useCallback(async (id: string) => {
    if (!user) return;
    const existingBook = books.find((book) => book.id === id);

    const storagePaths = existingBook
      ? getStoragePathsForBook(user.id, id, existingBook.fileName)
      : [`${user.id}/${id}.pdf`];

    await supabase.storage.from("book-pdfs").remove(Array.from(new Set(storagePaths)));

    // Extracted figures: the DB rows go with the book via ON DELETE
    // CASCADE, but their JPEGs in generated-images would be orphaned
    // forever — the cascaded rows are the only pointers to them.
    try {
      const dir = `${user.id}/figures/${id}`;
      const { data: figs } = await supabase.storage.from("generated-images").list(dir, { limit: 200 });
      if (figs && figs.length > 0) {
        await supabase.storage.from("generated-images").remove(figs.map((f) => `${dir}/${f.name}`));
      }
    } catch { /* best-effort — never block the delete */ }

    const { error } = await supabase.from("books").delete().eq("id", id).eq("user_id", user.id);
    if (error) {
      console.error("Failed to delete book:", error);
      toast.error("Could not delete book — it is still in your library");
      return;
    }
    setBooks((prev) => prev.filter((b) => b.id !== id));
    setActiveBookId((prev) => (prev === id ? null : prev));
  }, [user, books]);

  const setActiveBook = useCallback((id: string) => {
    setActiveBookId(id);
    navigateTab("viewer");
  }, [navigateTab]);

  const setActiveBookSilent = useCallback((id: string) => {
    setActiveBookId(id);
  }, []);

  // Loading a book from the Vault routes through here so the user can pick a
  // neuron to load alongside it. The picker pre-selects the active neuron and
  // is fully skippable, so opening the book never blocks on a choice (see
  // LoadNeuronDialog + the UX research behind the conditional/default pattern).
  const requestBookLoad = useCallback((bookId: string) => {
    setPendingBookLoadId(bookId);
  }, []);

  const resolveBookLoad = useCallback(async (neuronId: string | null, chainWikiIds?: string[]) => {
    const bookId = pendingBookLoadId;
    setPendingBookLoadId(null);
    if (!bookId) return;
    try {
      if (chainWikiIds && chainWikiIds.length > 0) {
        // A chain was picked — load the whole set alongside the book.
        await setActiveNeurons(chainWikiIds);
      } else if (neuronId && neuronId !== activeWikiId) {
        // Only switch neurons when the user picked a different one — avoids a
        // redundant loadWiki round-trip when they keep the current neuron.
        await setActiveWiki(neuronId);
      }
    } catch (err) {
      console.error("Failed to load neuron alongside book:", err);
    }
    setActiveBook(bookId);
  }, [pendingBookLoadId, activeWikiId, setActiveWiki, setActiveNeurons, setActiveBook]);

  const addChapter = useCallback(async (bookId: string, chapter: Chapter) => {
    const userId = await getAuthenticatedUserId();

    const { data: existingBook, error: existingBookError } = await supabase
      .from("books")
      .select("id")
      .eq("id", bookId)
      .eq("user_id", userId)
      .maybeSingle();

    if (existingBookError) {
      console.error("Failed to verify book before saving chapter:", existingBookError);
      throw existingBookError;
    }

    if (!existingBook) {
      throw new Error("This book is no longer available in your library. Please reopen it and try again.");
    }

    const { data, error } = await supabase
      .from("chapters")
      .insert({
        id: chapter.id,
        book_id: bookId,
        name: chapter.name,
        start_page: chapter.startPage,
        end_page: chapter.endPage,
        text_content: chapter.textContent,
        user_id: userId,
      })
      .select()
      .single();

    if (error || !data) {
      console.error("Failed to save chapter:", error);
      throw error || new Error("Failed to save chapter");
    }

    const finalChapter = { ...chapter, id: data.id };
    setBooks((prev) =>
      prev.map((b) =>
        b.id === bookId ? { ...b, chapters: [...b.chapters, finalChapter] } : b
      )
    );
  }, [getAuthenticatedUserId]);

  const updateChapter = useCallback(async (bookId: string, chapterId: string, name: string) => {
    if (!user) return;
    // Local state only follows a confirmed write — otherwise the UI would
    // show a rename that silently never persisted.
    const { error } = await supabase.from("chapters").update({ name }).eq("id", chapterId).eq("user_id", user.id);
    if (error) {
      console.error("Failed to rename chapter:", error);
      toast.error("Could not rename chapter");
      return;
    }
    setBooks((prev) =>
      prev.map((b) =>
        b.id === bookId
          ? { ...b, chapters: b.chapters.map((c) => (c.id === chapterId ? { ...c, name } : c)) }
          : b
      )
    );
  }, [user]);

  const removeChapter = useCallback(async (bookId: string, chapterId: string) => {
    if (!user) return;
    const { error } = await supabase.from("chapters").delete().eq("id", chapterId).eq("user_id", user.id);
    if (error) {
      console.error("Failed to delete chapter:", error);
      toast.error("Could not delete chapter");
      return;
    }
    setBooks((prev) =>
      prev.map((b) =>
        b.id === bookId
          ? { ...b, chapters: b.chapters.filter((c) => c.id !== chapterId) }
          : b
      )
    );
  }, [user]);

  const updateBookTitle = useCallback(async (bookId: string, newTitle: string) => {
    if (!user) return;
    const { error } = await supabase.from("books").update({ title: newTitle }).eq("id", bookId).eq("user_id", user.id);
    if (error) {
      console.error("Failed to rename book:", error);
      toast.error("Could not rename book");
      return;
    }
    setBooks((prev) =>
      prev.map((b) => (b.id === bookId ? { ...b, title: newTitle } : b))
    );
  }, [user]);

  const updateBookTags = useCallback(async (bookId: string, category: string | null, tags: string[]) => {
    if (!user) return;
    const { error } = await supabase
      .from("books")
      .update({ category, tags })
      .eq("id", bookId)
      .eq("user_id", user.id);
    if (error) {
      console.error("Failed to save book tags:", error);
      throw error;
    }
    setBooks((prev) =>
      prev.map((b) => (b.id === bookId ? { ...b, category: category || undefined, tags } : b))
    );
  }, [user]);

  // Shelf membership changes go through here so books[].folderIds (the
  // single client copy of membership) never goes stale — the Shelves view
  // derives entirely from it. The next set is computed INSIDE the functional
  // update and applied optimistically before the write: the shelf menu stays
  // open across toggles, and a second click issued before the first write's
  // round trip resolves must see the first click's result, not the
  // render-captured base (else its delta silently undoes the first toggle).
  // Deltas from overlapping toggles commute at the database.
  const toggleBookShelf = useCallback(async (bookId: string, shelfId: string) => {
    if (!user) return;
    let delta: ShelfDelta | null = null;
    setBooks((prev) => prev.map((b) => {
      if (b.id !== bookId) return b;
      const member = b.folderIds.includes(shelfId);
      // Unchecking is mode-independent; checking replaces the set in the
      // exclusive fallback (one shelf per book is all folder_id can hold).
      const next = member
        ? b.folderIds.filter((id) => id !== shelfId)
        : multiShelf ? [...b.folderIds, shelfId] : [shelfId];
      delta = {
        adds: next.filter((id) => !b.folderIds.includes(id)),
        removes: b.folderIds.filter((id) => !next.includes(id)),
        ...((next[0] ?? null) !== (b.folderIds[0] ?? null)
          ? { mirror: { value: next[0] ?? null } }
          : {}),
      };
      return { ...b, folderIds: next };
    }));
    if (!delta) return; // unknown book id
    const d: ShelfDelta = delta;
    try {
      await applyShelfDelta(user.id, bookId, d, multiShelf);
    } catch (error) {
      // Roll back by INVERSE DELTA, not by snapshot — a snapshot restore
      // would clobber any later optimistic toggle on the same book.
      setBooks((prev) => prev.map((b) => {
        if (b.id !== bookId) return b;
        const rolled = b.folderIds.filter((id) => !d.adds.includes(id));
        for (const id of d.removes) if (!rolled.includes(id)) rolled.push(id);
        return { ...b, folderIds: rolled };
      }));
      console.error("Failed to update book shelves:", error);
      throw error;
    }
  }, [user, multiShelf]);

  // Deleting a shelf cascades its junction rows and SET NULLs books.folder_id
  // server-side; this mirrors both into client state without per-book writes.
  // Internal now — deleteShelf is the only caller, so no surface can drop a
  // shelf from the books without also dropping it from the roster.
  const clearShelfLocal = useCallback((folderId: string) => {
    setBooks((prev) => prev.map((b) =>
      b.folderIds.includes(folderId)
        ? { ...b, folderIds: b.folderIds.filter((id) => id !== folderId) }
        : b
    ));
  }, []);

  // ── The shelf roster ────────────────────────────────────────────────────
  // Loaded once per signed-in session and mutated in place. Every consumer
  // reads this array; nobody else calls listFolders.
  useEffect(() => {
    if (!user) {
      setShelves([]);
      setShelvesLoading(false);
      return;
    }
    let cancelled = false;
    setShelvesLoading(true);
    listFolders()
      .then((rows) => { if (!cancelled) setShelves(rows); })
      .catch((e) => {
        if (cancelled) return;
        // A roster failure is not fatal — books still render, membership
        // still resolves; only shelf NAMES are missing. Say so once.
        console.error("Failed to load shelves:", e);
        toast.error("Couldn't load your shelves");
      })
      .finally(() => { if (!cancelled) setShelvesLoading(false); });
    return () => { cancelled = true; };
  }, [user]);

  const createShelf = useCallback(async (name: string): Promise<BookFolder> => {
    const created = await createFolder(name);
    // Insert in the order listFolders would return it (sort_index, then name),
    // so the roster does not reshuffle on the next reload.
    setShelves((prev) => [...prev, created].sort(
      (a, b) => a.sort_index - b.sort_index || a.name.localeCompare(b.name),
    ));
    return created;
  }, []);

  const renameShelf = useCallback(async (id: string, name: string): Promise<void> => {
    const trimmed = name.trim();
    await renameFolder(id, trimmed);
    setShelves((prev) => prev
      .map((f) => (f.id === id ? { ...f, name: trimmed } : f))
      .sort((a, b) => a.sort_index - b.sort_index || a.name.localeCompare(b.name)));
  }, []);

  const deleteShelf = useCallback(async (id: string): Promise<void> => {
    await deleteFolder(id);
    setShelves((prev) => prev.filter((f) => f.id !== id));
    clearShelfLocal(id);
  }, [clearShelfLocal]);

  const getActiveBook = useCallback(() => {
    return books.find((b) => b.id === activeBookId);
  }, [books, activeBookId]);

  const loadBookFile = useCallback(async (bookId: string): Promise<string> => {
    const existing = books.find((b) => b.id === bookId);
    if (existing?.fileData) return existing.fileData;

    if (!user) return "";

    const candidatePaths = existing
      ? getStoragePathsForBook(user.id, bookId, existing.fileName)
      : [`${user.id}/${bookId}.pdf`];

    try {
      for (const path of candidatePaths) {
        const { data, error } = await supabase.storage
          .from("book-pdfs")
          .download(path);

        if (error || !data) continue;

        const url = URL.createObjectURL(data);

        setBooks((prev) =>
          prev.map((b) => (b.id === bookId ? { ...b, fileData: url } : b))
        );

        return url;
      }

      console.error("Failed to download document: no matching file found in storage");
      return "";
    } catch (err) {
      console.error("Error loading book file:", err);
      return "";
    }
  }, [user, books]);

  /** Chapter text on demand. Startup no longer carries it, so anything that
   *  needs the actual words (the chat's get_chapter_text, auto-tagging) asks
   *  for it here and the result is cached back into the library. */
  const loadChapterText = useCallback(async (chapterId: string): Promise<string> => {
    if (!user || !chapterId) return "";
    const cached = books.flatMap((b) => b.chapters).find((c) => c.id === chapterId);
    if (cached?.textContent) return cached.textContent;
    const { data, error } = await supabase
      .from("chapters")
      .select("text_content")
      .eq("id", chapterId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (error || !data) {
      if (error) console.error("Failed to load chapter text:", error);
      return "";
    }
    const text = (data as any).text_content || "";
    if (text) {
      setBooks((prev) =>
        prev.map((b) => ({
          ...b,
          chapters: b.chapters.map((c) => (c.id === chapterId ? { ...c, textContent: text } : c)),
        }))
      );
    }
    return text;
  }, [user, books]);

  /** loadChapterText with a TYPED failure channel. The legacy loader returns
   *  "" for BOTH "load failed" and "chapter truly empty", which makes any
   *  consumer that must be honest about the difference lie on a network blip
   *  (Stage 2 law: a locator write must reject as "couldn't verify — retry",
   *  never as "quote not found"; read_span must say "couldn't read", never
   *  emit a drift claim). Same cache-back behavior as the legacy loader. */
  const loadChapterTextStrict = useCallback(async (chapterId: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> => {
    if (!user || !chapterId) return { ok: false, error: "not signed in or missing chapter id" };
    const cached = books.flatMap((b) => b.chapters).find((c) => c.id === chapterId);
    if (cached?.textContent) return { ok: true, text: cached.textContent };
    const { data, error } = await supabase
      .from("chapters")
      .select("text_content")
      .eq("id", chapterId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (error) return { ok: false, error: error.message || "failed to load chapter text" };
    if (!data) return { ok: false, error: "chapter not found" };
    const text = (data as any).text_content || "";
    if (text) {
      setBooks((prev) =>
        prev.map((b) => ({
          ...b,
          chapters: b.chapters.map((c) => (c.id === chapterId ? { ...c, textContent: text } : c)),
        }))
      );
    }
    return { ok: true, text };
  }, [user, books]);

  /** Hydrate every chapter of one book with its text (auto-tagging needs
   *  excerpts across the whole book). */
  const loadBookChapterText = useCallback(async (bookId: string): Promise<void> => {
    if (!user || !bookId) return;
    const book = books.find((b) => b.id === bookId);
    if (book && book.chapters.length > 0 && book.chapters.every((c) => c.textContent)) return;
    const { data, error } = await supabase
      .from("chapters")
      .select("id, text_content")
      .eq("book_id", bookId)
      .eq("user_id", user.id);
    if (error || !data) {
      if (error) console.error("Failed to load book text:", error);
      return;
    }
    const byId = new Map<string, string>(data.map((r: any) => [r.id, r.text_content || ""]));
    setBooks((prev) =>
      prev.map((b) =>
        b.id === bookId
          ? { ...b, chapters: b.chapters.map((c) => ({ ...c, textContent: byId.get(c.id) ?? c.textContent })) }
          : b
      )
    );
  }, [user, books]);


  /** Mirror freshly written gists into state so the catalog updates without a
   *  reload. Touches only the named chapter ids; everything else is untouched. */
  const applyChapterGists = useCallback((gistById: Record<string, string>) => {
    setBooks((prev) =>
      prev.map((b) =>
        b.chapters.some((c) => gistById[c.id] !== undefined)
          ? { ...b, chapters: b.chapters.map((c) => (gistById[c.id] !== undefined ? { ...c, gist: gistById[c.id] } : c)) }
          : b
      )
    );
  }, []);

  const applyBookSummary = useCallback((bookId: string, summary: string, model: string) => {
    setBooks((prev) => prev.map((b) =>
      b.id === bookId
        ? { ...b, summary, summaryModel: model, summarizedAt: Date.now() }
        : b
    ));
  }, []);

  const applyShelfDigest = useCallback((shelfId: string, summary: string, model: string) => {
    setShelves((prev) => prev.map((f) =>
      f.id === shelfId
        ? { ...f, summary, summary_model: model, summarized_at: new Date().toISOString() }
        : f
    ));
  }, []);

  const activeWiki = wikis.find((w) => w.id === activeWikiId);
  const activeWikis = activeWikiIds
    .map((id) => wikis.find((w) => w.id === id))
    .filter((w): w is Wiki => !!w);

  return (
    <AppContext.Provider
      value={{
        books,
        activeBookId,
        activeTab,
        wikis,
        activeWikiId,
        activeWiki,
        activeWikiIds,
        activeWikis,
        addBook,
        removeBook,
        setActiveBook,
        setActiveBookSilent,
        pendingBookLoadId,
        requestBookLoad,
        resolveBookLoad,
        setActiveTab: navigateTab,
        addChapter,
        updateChapter,
        applyChapterGists,
        applyBookSummary,
        removeChapter,
        updateBookTitle,
        updateBookTags,
        toggleBookShelf,
        membershipLoaded,
        shelves,
        shelvesLoading,
        createShelf,
        renameShelf,
        deleteShelf,
        applyShelfDigest,
        multiShelf,
        getActiveBook,
        loadBookFile,
        loadChapterText,
        loadChapterTextStrict,
        loadBookChapterText,

        refreshWikis,
        setActiveWiki,
        setActiveNeurons,
        toggleNeuronInSession,
        signOut,
      }}
    >
      {children}
    </AppContext.Provider>
  );
};

// eslint-disable-next-line react-refresh/only-export-components
export const useApp = (): AppState => {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used within AppProvider");
  return ctx;
};
