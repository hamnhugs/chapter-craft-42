import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from "react";
import { flushSync } from "react-dom";
import { BookDocument, Chapter } from "@/types/library";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Wiki, fetchWikis, fetchActiveWikiIds, loadWiki as loadWikiApi, loadWikiSet, createWiki } from "@/lib/wikisApi";
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
  getActiveBook: () => BookDocument | undefined;
  loadBookFile: (bookId: string) => Promise<string>;
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
        list = [created]; active = { primary: created.id, set: [created.id] };
      }
      // Self-heal: drop set members that no longer exist (deleted elsewhere;
      // active_wiki_ids has no FK, so dead ids can linger there). If the
      // primary itself is gone/null, promote the next loaded neuron — or fall
      // back to the first wiki — and persist that repair.
      const existing = new Set(list.map((w) => w.id));
      let set = active.set.filter((id) => existing.has(id));
      let primary = active.primary && existing.has(active.primary) ? active.primary : set[0] ?? null;
      if (!primary) {
        const fallback = list[0];
        await loadWikiApi(fallback.id);
        primary = fallback.id;
        set = [fallback.id];
      } else if (set[0] !== primary) {
        set = [primary, ...set.filter((id) => id !== primary)];
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
      return;
    }

    const loadBooks = async () => {
      const [{ data: bookRows, error: booksError }, { data: chapterRows, error: chaptersError }] = await Promise.all([
        supabase
          .from("books")
          .select("id, title, file_name, page_count, cover_image_url, created_at, category, tags")
          .eq("user_id", user.id)
          .order("created_at", { ascending: false }),
        supabase
          .from("chapters")
          .select("id, book_id, name, start_page, end_page, text_content, created_at")
          .eq("user_id", user.id)
          .order("created_at", { ascending: true }),
      ]);

      if (booksError) {
        console.error("Failed to load books:", booksError);
        return;
      }

      if (chaptersError) {
        console.error("Failed to load chapters:", chaptersError);
        return;
      }

      const chaptersByBookId = (chapterRows || []).reduce<Record<string, Chapter[]>>((acc, chapter: any) => {
        if (!acc[chapter.book_id]) {
          acc[chapter.book_id] = [];
        }

        acc[chapter.book_id].push({
          id: chapter.id,
          name: chapter.name,
          startPage: chapter.start_page,
          endPage: chapter.end_page,
          textContent: chapter.text_content,
        });

        return acc;
      }, {});

      if (bookRows) {
        const dbBooks: BookDocument[] = bookRows.map((b: any) => ({
          id: b.id,
          title: b.title,
          fileName: b.file_name,
          fileData: "",
          pageCount: b.page_count,
          coverImageUrl: b.cover_image_url || undefined,
          chapters: chaptersByBookId[b.id] || [],
          addedAt: new Date(b.created_at).getTime(),
          category: b.category || undefined,
          tags: Array.isArray(b.tags) ? b.tags : [],
        }));
        setBooks(dbBooks);
      }
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
          const { data: chapterRows } = await supabase
            .from("chapters")
            .select("id, name, start_page, end_page, text_content")
            .eq("book_id", b.id)
            .eq("user_id", b.user_id)
            .order("created_at", { ascending: true });
          const chapters: Chapter[] = (chapterRows || []).map((c: any) => ({
            id: c.id,
            name: c.name,
            startPage: c.start_page,
            endPage: c.end_page,
            textContent: c.text_content,
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

        return prev.map((b) => (b.id === finalBookId ? { ...b, ...nextBook } : b));
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
    const existingBook = books.find((book) => book.id === id);

    if (user) {
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
    }

    await supabase.from("books").delete().eq("id", id);
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
    await supabase.from("chapters").update({ name }).eq("id", chapterId).eq("user_id", user.id);
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
    await supabase.from("chapters").delete().eq("id", chapterId).eq("user_id", user.id);
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
    await supabase.from("books").update({ title: newTitle }).eq("id", bookId).eq("user_id", user.id);
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
        removeChapter,
        updateBookTitle,
        updateBookTags,
        getActiveBook,
        loadBookFile,
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
