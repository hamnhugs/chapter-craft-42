import React, { useEffect, useMemo, useRef, useState } from "react";
import { BookDocument } from "@/types/library";
import { listFolders, createFolder, renameFolder, deleteFolder, moveBookToFolder, setFolderDefaultWiki, BookFolder } from "@/lib/bookFolders";
import { enqueueIngestJobs } from "@/lib/knowledgeApi";
import { useIngestJobs } from "@/hooks/useIngestJobs";
import { useChatSettings } from "@/hooks/useChatSettings";
import { useApp } from "@/context/AppContext";
import { figureJobs } from "@/lib/figureJobs";
import { usePlan } from "@/hooks/usePlan";
import { useIsAdmin } from "@/hooks/useIsAdmin";
import { fetchWikis, type Wiki } from "@/lib/wikisApi";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { isNvidiaModel } from "@/lib/providers/registry";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";


// Managed folder view: user-created folders (book_folders table) that the user
// can rename, recolor and delete. Books can be assigned to a folder; the
// "Digest folder" button runs every book in the folder through knowledge-ingest
// against the currently active neuron, using the user's chosen ingest model.

type BookWithFolder = BookDocument & { folderId?: string | null };

interface Props {
  books: BookDocument[];
  renderBook: (book: BookDocument, index: number) => React.ReactNode;
  activeWikiId: string | null;
}

const LibraryCollections: React.FC<Props> = ({ books, renderBook, activeWikiId }) => {
  const [folders, setFolders] = useState<BookFolder[]>([]);
  const [openFolderId, setOpenFolderId] = useState<string | null>(null);
  const [folderAssignments, setFolderAssignments] = useState<Record<string, string | null>>({});
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const { libraryIngestModel, libraryIngestAutoFile, selectedModel, setLibraryIngestModel, setLibraryIngestAutoFile, savedModels, autoExtractFigures, imageExtractionModel, apiKey } = useChatSettings();
  // Digestion runs SERVER-SIDE against OpenRouter (or the Lovable gateway) —
  // an "nvidia:" id would be forwarded verbatim and 400 on every retry. Send
  // null instead so the server falls back to its own default model.
  const ingestModelRaw = libraryIngestModel || selectedModel || "";
  const ingestModel = ingestModelRaw && !isNvidiaModel(ingestModelRaw) ? ingestModelRaw : null;
  const { loadBookFile, books: allBooks } = useApp();
  const { isPaid, loaded: planLoaded } = usePlan();
  const { isAdmin, loaded: adminLoaded } = useIsAdmin();
  const [showSettings, setShowSettings] = useState(false);
  const [wikis, setWikis] = useState<Wiki[]>([]);
  // Pending single-doc digest prompt after a folder assignment.
  const [digestPrompt, setDigestPrompt] = useState<null | {
    book: BookDocument; folder: BookFolder; suggestedWikiId: string | null;
  }>(null);
  const [selectedDigestWikiId, setSelectedDigestWikiId] = useState<string>("");
  // Live, cross-device view of the user's queue. Survives refresh/tab close
  // because work happens on the server.
  const { jobs, active, recent } = useIngestJobs();

  // When a digest job finishes, the book's neurons exist — kick off figure
  // extraction so illustrations land next to the concepts they teach.
  // Detection is watermark-based, not transition-based: digests run
  // server-side for minutes and the user is told it's "safe to close the
  // tab", so completion usually happens while this component is unmounted.
  // A per-book localStorage watermark (the handled job's finished_at) makes
  // any sighting of a fresh succeeded job fire exactly once per browser,
  // surviving unmounts, view switches, search filters, and stale refetches.
  // The freshness window keeps pre-feature historical digests from firing.
  const figureGateNoticeShown = useRef(false);
  useEffect(() => {
    if (!autoExtractFigures) return;
    const FRESH_MS = 6 * 60 * 60 * 1000;
    for (const j of jobs) {
      if (j.status !== "succeeded" || !j.book_id || !j.finished_at) continue;
      const finished = new Date(j.finished_at).getTime();
      if (!Number.isFinite(finished) || Date.now() - finished > FRESH_MS) continue;
      const wmKey = `figures_auto:${j.book_id}`;
      let wm = 0;
      try { wm = Number(localStorage.getItem(wmKey) || 0); } catch { /* private mode */ }
      if (wm >= finished) continue;
      const book = allBooks.find((b) => b.id === j.book_id);
      if (!book || !book.fileName.toLowerCase().endsWith(".pdf")) continue;
      // Keyless free users would burn the whole client-side scan only to hit
      // the server's 402 Pro gate — skip up front and say so once.
      if (!apiKey) {
        if (!planLoaded || !adminLoaded) continue; // decide once entitlements resolve
        if (!isPaid && !isAdmin) {
          if (!figureGateNoticeShown.current) {
            figureGateNoticeShown.current = true;
            toast(`Skipping figure extraction for "${book.title}" — it needs your own OpenRouter key (Settings → AI Models & Keys) or a Pro plan.`);
          }
          continue;
        }
      }
      try { localStorage.setItem(wmKey, String(finished)); } catch { /* storage full — worst case re-fires */ }
      figureJobs.enqueue({
        bookId: book.id,
        bookTitle: book.title,
        model: imageExtractionModel || undefined,
        load: async () => {
          const url = await loadBookFile(book.id);
          if (!url) throw new Error("Could not load this book's file from storage.");
          return { fileUrl: url };
        },
      });
      toast(`Digested — now extracting figures from "${book.title}"…`, { id: `figures-${book.id}` });
    }
  }, [jobs, autoExtractFigures, imageExtractionModel, allBooks, loadBookFile, apiKey, isPaid, planLoaded, isAdmin, adminLoaded]);

  // On mount, ping the worker so any orphaned jobs from a previous session
  // get drained. Fire-and-forget; failures are non-fatal.
  useEffect(() => {
    enqueueIngestJobs([], { resume: true }).catch(() => {});
    fetchWikis().then(setWikis).catch(() => {});
  }, []);


  // Load folders + book-folder mapping (the mapping lives on books.folder_id
  // which the rest of the app doesn't read, so we pull it directly here).
  useEffect(() => {
    let cancel = false;
    (async () => {
      setLoading(true);
      try {
        const [f, rows] = await Promise.all([
          listFolders(),
          (supabase.from("books" as any) as any).select("id, folder_id"),
        ]);
        if (cancel) return;
        setFolders(f);
        const map: Record<string, string | null> = {};
        for (const r of (rows.data as any[]) || []) map[r.id] = r.folder_id ?? null;
        setFolderAssignments(map);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not load folders");
      } finally {
        if (!cancel) setLoading(false);
      }
    })();
    return () => { cancel = true; };
  }, []);

  const booksInFolder = useMemo<BookWithFolder[]>(() => {
    if (!openFolderId) return [];
    return books.filter((b) => folderAssignments[b.id] === openFolderId);
  }, [books, folderAssignments, openFolderId]);

  const unassigned = useMemo<BookWithFolder[]>(() => {
    return books.filter((b) => !folderAssignments[b.id]);
  }, [books, folderAssignments]);

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    try {
      const f = await createFolder(name);
      setFolders((prev) => [...prev, f]);
      setNewName("");
      toast.success(`Folder "${name}" created`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not create folder");
    }
  };

  const handleRename = async (id: string) => {
    const name = renameDraft.trim();
    if (!name) { setRenaming(null); return; }
    try {
      await renameFolder(id, name);
      setFolders((prev) => prev.map((f) => f.id === id ? { ...f, name } : f));
      setRenaming(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Rename failed");
    }
  };

  const handleDelete = async (id: string) => {
    const f = folders.find((x) => x.id === id);
    if (!f) return;
    if (!window.confirm(`Delete folder "${f.name}"? Books inside will return to "Unassigned" (not deleted).`)) return;
    try {
      await deleteFolder(id);
      setFolders((prev) => prev.filter((x) => x.id !== id));
      setFolderAssignments((prev) => {
        const next = { ...prev };
        for (const k of Object.keys(next)) if (next[k] === id) next[k] = null;
        return next;
      });
      if (openFolderId === id) setOpenFolderId(null);
      toast.success(`Folder deleted`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Delete failed");
    }
  };

  const assignBook = async (bookId: string, folderId: string | null) => {
    try {
      await moveBookToFolder(bookId, folderId);
      setFolderAssignments((prev) => ({ ...prev, [bookId]: folderId }));
      // Only prompt when actually filing into a folder (not when clearing).
      if (folderId) {
        const folder = folders.find((f) => f.id === folderId);
        const book = books.find((b) => b.id === bookId);
        if (folder && book) {
          const suggestedWikiId = folder.default_wiki_id || activeWikiId || (wikis[0]?.id ?? null);
          setSelectedDigestWikiId(suggestedWikiId || "");
          setDigestPrompt({ book, folder, suggestedWikiId });
        }
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Move failed");
    }
  };

  const confirmSingleDigest = async () => {
    if (!digestPrompt) return;
    const wikiId = selectedDigestWikiId;
    if (!wikiId) { toast.error("Pick a neuron first."); return; }
    const { book, folder } = digestPrompt;
    setDigestPrompt(null);
    try {
      const { enqueued } = await enqueueIngestJobs([{
        book_id: book.id,
        wiki_id: wikiId,
        folder_id: folder.id,
        model: ingestModel,
      }]);
      // Remember the chosen neuron for next time on this folder.
      if (folder.default_wiki_id !== wikiId) {
        try {
          await setFolderDefaultWiki(folder.id, wikiId);
          setFolders((prev) => prev.map((f) => f.id === folder.id ? { ...f, default_wiki_id: wikiId } : f));
        } catch { /* non-fatal */ }
      }
      if (enqueued === 0) toast(`"${book.title}" is already queued or digested.`);
      else toast.success(`Queued "${book.title}" — safe to close the tab.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not queue job");
    }
  };


  const handleDigest = async () => {
    if (!openFolderId) return;
    if (!activeWikiId) { toast.error("Pick an active neuron in the Wiki tab first."); return; }
    const targets = booksInFolder;
    if (targets.length === 0) { toast("Folder is empty."); return; }
    if (!window.confirm(`Queue ${targets.length} book${targets.length === 1 ? "" : "s"} for digestion?\n\nThis runs on the server — you can close this tab and it will keep going.`)) return;
    setBusy(true);
    try {
      const { enqueued } = await enqueueIngestJobs(
        targets.map((b) => ({
          book_id: b.id,
          wiki_id: activeWikiId,
          folder_id: openFolderId,
          model: ingestModel,
        })),
      );
      // Remember this neuron on the folder for future single-doc prompts.
      const folder = folders.find((f) => f.id === openFolderId);
      if (folder && folder.default_wiki_id !== activeWikiId) {
        try {
          await setFolderDefaultWiki(openFolderId, activeWikiId);
          setFolders((prev) => prev.map((f) => f.id === openFolderId ? { ...f, default_wiki_id: activeWikiId } : f));
        } catch { /* non-fatal */ }
      }
      if (enqueued === 0) toast("Already in queue — nothing new to add.");
      else toast.success(`Queued ${enqueued} book${enqueued === 1 ? "" : "s"} — safe to close the tab.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not queue jobs");
    } finally {
      setBusy(false);
    }
  };

  // Lookup helpers for live progress UI
  const jobByBookId = useMemo(() => {
    const map = new Map<string, typeof jobs[number]>();
    for (const j of jobs) if (j.book_id && !map.has(j.book_id)) map.set(j.book_id, j);
    return map;
  }, [jobs]);
  const activeInFolder = useMemo(
    () => active.filter((j) => !openFolderId || j.folder_id === openFolderId),
    [active, openFolderId],
  );


  const renderBookCard = (b: BookWithFolder, index: number) => (
    <div key={b.id} className="relative group">
      {renderBook(b, index)}
      <select
        value={folderAssignments[b.id] || ""}
        onChange={(e) => assignBook(b.id, e.target.value || null)}
        className="absolute top-2 right-2 bg-surface-container-high text-xs rounded-md px-1.5 py-0.5 border border-outline-variant/30 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
        title="Move to folder"
      >
        <option value="">Unassigned</option>
        {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
      </select>
    </div>
  );

  if (loading) {
    return <div className="py-16 text-center text-on-surface-variant text-sm">Loading folders…</div>;
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Settings strip */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 text-xs text-on-surface-variant">
          <span className="material-symbols-outlined text-base">folder_managed</span>
          Managed collections{activeWikiId ? "" : " — pick an active neuron to enable digesting"}
        </div>
        <button
          onClick={() => setShowSettings((v) => !v)}
          className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full bg-surface-container-high hover:bg-surface-container-highest"
        >
          <span className="material-symbols-outlined text-sm">tune</span>
          Ingest settings
        </button>
      </div>

      {showSettings && (
        <div className="rounded-xl border border-outline-variant/15 p-3 bg-surface-container-low grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <label className="text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant">Ingest Model</label>
            <select
              value={libraryIngestModel}
              onChange={(e) => setLibraryIngestModel(e.target.value)}
              className="w-full bg-surface-container-high border-none rounded-lg text-sm py-2 px-3"
            >
              <option value="">
                {isNvidiaModel(selectedModel) ? "Server default (NVIDIA models can't digest)" : `Use active chat model (${selectedModel})`}
              </option>
              {/* Digestion is OpenRouter/gateway-only server-side — NVIDIA ids
                  are never offered here. */}
              {savedModels.filter((m) => !isNvidiaModel(m)).map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={libraryIngestAutoFile}
              onChange={(e) => setLibraryIngestAutoFile(e.target.checked)}
              className="mt-1"
            />
            <span>
              <span className="font-medium">Smart-file entries</span>
              <span className="block text-[11px] text-on-surface-variant">
                When on, each digested entry is automatically routed to the best matching neuron.
              </span>
            </span>
          </label>
        </div>
      )}

      {/* Folder list */}
      {!openFolderId ? (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
            {folders.map((f) => {
              const count = books.filter((b) => folderAssignments[b.id] === f.id).length;
              return (
                <div
                  key={f.id}
                  className="group relative flex flex-col items-start gap-3 rounded-2xl p-5 text-left border border-outline-variant/15 bg-surface-container-high transition-all hover:-translate-y-0.5 hover:shadow-xl"
                >
                  <button onClick={() => setOpenFolderId(f.id)} className="absolute inset-0" aria-label={`Open ${f.name}`} />
                  <span className="material-symbols-outlined text-4xl text-primary" style={{ fontVariationSettings: "'FILL' 1" }} aria-hidden>folder</span>
                  <div className="min-w-0 z-10 pointer-events-none">
                    {renaming === f.id ? (
                      <input
                        autoFocus
                        value={renameDraft}
                        onChange={(e) => setRenameDraft(e.target.value)}
                        onBlur={() => handleRename(f.id)}
                        onKeyDown={(e) => { if (e.key === "Enter") handleRename(f.id); if (e.key === "Escape") setRenaming(null); }}
                        className="bg-surface-container-highest rounded px-2 py-0.5 text-sm pointer-events-auto"
                      />
                    ) : (
                      <p className="font-headline font-bold text-base text-foreground truncate w-full">{f.name}</p>
                    )}
                    <p className="text-xs text-on-surface-variant mt-0.5">{count} book{count === 1 ? "" : "s"}</p>
                  </div>
                  <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity z-20">
                    <button
                      onClick={(e) => { e.stopPropagation(); setRenameDraft(f.name); setRenaming(f.id); }}
                      title="Rename"
                      className="p-1 rounded bg-surface-container-high hover:bg-surface-container-highest"
                    >
                      <span className="material-symbols-outlined text-sm">edit</span>
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDelete(f.id); }}
                      title="Delete"
                      className="p-1 rounded bg-surface-container-high hover:bg-red-500/20 text-red-300"
                    >
                      <span className="material-symbols-outlined text-sm">delete</span>
                    </button>
                  </div>
                </div>
              );
            })}
            {/* Create card */}
            <div className="flex flex-col items-stretch gap-2 rounded-2xl p-5 border-2 border-dashed border-outline-variant/30">
              <p className="text-xs uppercase tracking-widest text-on-surface-variant">New folder</p>
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleCreate(); }}
                placeholder="Folder name"
                className="bg-surface-container-high rounded-lg text-sm py-2 px-3 focus:ring-1 focus:ring-primary/40 border-none"
              />
              <button
                onClick={handleCreate}
                disabled={!newName.trim()}
                className="px-3 py-1.5 bg-primary/10 text-primary text-sm font-bold rounded-lg hover:bg-primary hover:text-on-primary-container disabled:opacity-40"
              >
                Create
              </button>
            </div>
          </div>

          {/* Unassigned bucket */}
          {unassigned.length > 0 && (
            <section className="mt-2">
              <p className="text-xs uppercase tracking-widest text-on-surface-variant mb-2 px-1">Unassigned ({unassigned.length})</p>
              <div className="book-grid">
                {unassigned.map((b, i) => renderBookCard(b, i))}
              </div>
            </section>
          )}
        </>
      ) : (
        <>
          <nav className="flex items-center gap-1.5 text-sm">
            <button onClick={() => setOpenFolderId(null)} className="flex items-center gap-1 px-2 py-1 rounded-lg text-on-surface-variant hover:text-primary hover:bg-surface-container-high">
              <span className="material-symbols-outlined text-base">folder_copy</span>
              All collections
            </button>
            <span className="text-on-surface-variant/50" aria-hidden>/</span>
            <span className="flex items-center gap-1.5 px-2 py-1 font-semibold text-foreground">
              <span className="material-symbols-outlined text-base text-primary" style={{ fontVariationSettings: "'FILL' 1" }}>folder_open</span>
              {folders.find((f) => f.id === openFolderId)?.name}
              <span className="text-on-surface-variant font-normal">({booksInFolder.length})</span>
            </span>
            <span className="ml-auto" />
            <button
              onClick={handleDigest}
              disabled={busy || booksInFolder.length === 0 || !activeWikiId}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-primary text-on-primary-container text-xs font-bold disabled:opacity-40"
              title={!activeWikiId ? "Set an active neuron first" : "Queue every book in this folder for server-side digestion"}
            >
              <span className={`material-symbols-outlined text-sm ${busy || activeInFolder.length > 0 ? "animate-spin" : ""}`}>
                {busy || activeInFolder.length > 0 ? "progress_activity" : "auto_awesome"}
              </span>
              {activeInFolder.length > 0
                ? `Digesting ${activeInFolder.length} in background…`
                : "Digest folder into neuron"}
            </button>
          </nav>

          {/* Live queue strip — survives page refresh */}
          {(activeInFolder.length > 0 || recent.length > 0) && (
            <div className="rounded-xl border border-outline-variant/15 bg-surface-container-low p-3 text-xs">
              <div className="flex items-center gap-2 mb-2 text-on-surface-variant">
                <span className="material-symbols-outlined text-sm">cloud_sync</span>
                Server queue · keeps running if you refresh or close the tab
              </div>
              <ul className="space-y-1">
                {activeInFolder.slice(0, 8).map((j) => {
                  const title = books.find((b) => b.id === j.book_id)?.title || j.book_id?.slice(0, 6);
                  return (
                    <li key={j.id} className="flex items-center gap-2">
                      <span className="material-symbols-outlined text-[14px] animate-spin text-primary">progress_activity</span>
                      <span className="truncate flex-1">{title}</span>
                      <span className="text-on-surface-variant truncate max-w-[40%]">
                        {j.status === "running" ? (j.progress || "Working…") : "Queued"}
                      </span>
                    </li>
                  );
                })}
                {recent.slice(0, 4).map((j) => {
                  const title = books.find((b) => b.id === j.book_id)?.title || j.book_id?.slice(0, 6);
                  const ok = j.status === "succeeded";
                  return (
                    <li key={j.id} className="flex items-center gap-2 opacity-70">
                      <span className={`material-symbols-outlined text-[14px] ${ok ? "text-green-400" : "text-red-400"}`}>
                        {ok ? "check_circle" : "error"}
                      </span>
                      <span className="truncate flex-1">{title}</span>
                      <span className="text-on-surface-variant truncate max-w-[40%]">
                        {ok ? (j.progress || "Done") : (j.error || "Failed")}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}


          {booksInFolder.length === 0 ? (
            <div className="py-12 text-center text-on-surface-variant text-sm">
              No books in this folder yet — hover any book card and use the dropdown to move it here.
            </div>
          ) : (
            <div className="book-grid">
              {booksInFolder.map((b, i) => renderBookCard(b, i))}
            </div>
          )}
        </>
      )}

      <AlertDialog open={!!digestPrompt} onOpenChange={(o) => { if (!o) setDigestPrompt(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {wikis.length > 0
                ? <>Digest "{digestPrompt?.book.title}" into a neuron?</>
                : <>No neurons available</>}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {wikis.length > 0 ? (
                <>Choose which neuron should absorb <span className="font-semibold">{digestPrompt?.book.title}</span>. Your choice will be remembered for future documents filed into <span className="font-semibold">{digestPrompt?.folder.name}</span>. Runs on the server — safe to close the tab.</>
              ) : (
                <>Create a neuron in the Wiki tab first, then re-assign this document to be prompted again.</>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {wikis.length > 0 && (
            <div className="flex flex-col gap-2 py-1">
              <label className="text-[10px] font-semibold uppercase tracking-widest text-on-surface-variant">Target neuron</label>
              <select
                value={selectedDigestWikiId}
                onChange={(e) => setSelectedDigestWikiId(e.target.value)}
                className="w-full bg-surface-container-high border-none rounded-lg text-sm py-2 px-3"
                autoFocus
              >
                {wikis.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                    {digestPrompt?.folder.default_wiki_id === w.id ? "  · folder default" : ""}
                    {!digestPrompt?.folder.default_wiki_id && activeWikiId === w.id ? "  · active" : ""}
                  </option>
                ))}
              </select>
              {digestPrompt?.folder.default_wiki_id ? (
                <p className="text-[11px] text-on-surface-variant">
                  Last time, <span className="font-semibold">{digestPrompt.folder.name}</span> was digested into{" "}
                  <span className="font-semibold">{wikis.find((w) => w.id === digestPrompt.folder.default_wiki_id)?.name || "a neuron"}</span>.
                </p>
              ) : (
                <p className="text-[11px] text-on-surface-variant">
                  No remembered neuron for this folder yet — your pick becomes the default.
                </p>
              )}
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Skip</AlertDialogCancel>
            {wikis.length > 0 && (
              <AlertDialogAction onClick={confirmSingleDigest} disabled={!selectedDigestWikiId}>
                Digest into selected neuron
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

    </div>
  );
};

export default LibraryCollections;
