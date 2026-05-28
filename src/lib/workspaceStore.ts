import { useSyncExternalStore } from "react";

/**
 * Workspace store — durable, local-first home for the "files" the chat produces:
 * sandboxed HTML/SVG artifacts and deep-research / web-search reports.
 *
 * Why this exists: chat artifacts and raw research answers used to live only as
 * ephemeral `displayOnly` messages in React state. They were never persisted, so
 * they vanished on reload (and felt like they vanished when switching tabs). This
 * store captures every creation into IndexedDB so the right-side Workspace panel
 * can list, re-open, delete, and "save to library" them across sessions.
 *
 * Design:
 *  • IndexedDB (not localStorage) — research reports + HTML can be hundreds of KB
 *    each, well past localStorage's ~5MB synchronous cap. IndexedDB is async and
 *    stores large strings without blocking the main thread.
 *  • A tiny hand-rolled wrapper (no new dependency) keeps the Lovable build safe.
 *  • A module-level observable + `useSyncExternalStore` gives any component a live,
 *    re-rendering view without provider plumbing or ordering constraints, so
 *    ChatContext can `add()` and the panel can read with zero coupling.
 */

export type WorkspaceItemKind = "html" | "svg" | "research";

export interface WorkspaceCitation {
  title?: string;
  url: string;
  snippet?: string;
}

export interface WorkspaceItem {
  id: string;
  /** Owning user (IndexedDB is per-origin, so we scope rows by user id). */
  userId: string | null;
  kind: WorkspaceItemKind;
  title: string;
  /** For html/svg: the inner body markup. For research: markdown text. */
  content: string;
  createdAt: number;
  /** Pinned to the library so it stands apart from auto-captured items. */
  savedToLibrary: boolean;
  meta?: {
    query?: string;
    citations?: WorkspaceCitation[];
    /** Free-form source tag, e.g. "Deep Research", "Web Search". */
    source?: string;
  };
}

export type NewWorkspaceItem = Omit<WorkspaceItem, "id" | "createdAt" | "savedToLibrary"> &
  Partial<Pick<WorkspaceItem, "savedToLibrary">>;

const DB_NAME = "chapter-craft-workspace";
const STORE = "items";
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function hasIDB(): boolean {
  return typeof indexedDB !== "undefined";
}

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (!hasIDB()) {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function idbGetAll(): Promise<WorkspaceItem[]> {
  if (!hasIDB()) return [];
  try {
    const db = await openDb();
    return await new Promise<WorkspaceItem[]>((resolve) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = () => resolve((req.result as WorkspaceItem[]) || []);
      req.onerror = () => resolve([]);
    });
  } catch {
    return [];
  }
}

async function idbPut(item: WorkspaceItem): Promise<void> {
  if (!hasIDB()) return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(item);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {
    /* best-effort */
  }
}

async function idbDelete(id: string): Promise<void> {
  if (!hasIDB()) return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {
    /* best-effort */
  }
}

// ---- Observable layer (useSyncExternalStore-compatible) -------------------

// `items` is replaced (new array) on every mutation; between mutations the SAME
// reference is returned from getSnapshot so React doesn't loop. Newest first.
let items: WorkspaceItem[] = [];
const listeners = new Set<() => void>();
let hydrated = false;

function emit() {
  for (const l of listeners) l();
}

function sortDesc(list: WorkspaceItem[]): WorkspaceItem[] {
  return [...list].sort((a, b) => b.createdAt - a.createdAt);
}

function hydrate() {
  if (hydrated) return;
  hydrated = true;
  idbGetAll().then((loaded) => {
    items = sortDesc(loaded);
    emit();
  });
}

function uid(): string {
  try {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  } catch {
    /* fall through */
  }
  return `ws_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export const workspaceStore = {
  /** Capture a new item. Returns the created record. */
  add(input: NewWorkspaceItem): WorkspaceItem {
    const item: WorkspaceItem = {
      id: uid(),
      createdAt: Date.now(),
      savedToLibrary: input.savedToLibrary ?? false,
      userId: input.userId ?? null,
      kind: input.kind,
      title: (input.title || "Untitled").slice(0, 200),
      content: input.content || "",
      meta: input.meta,
    };
    items = [item, ...items];
    emit();
    void idbPut(item);
    return item;
  },

  remove(id: string) {
    items = items.filter((i) => i.id !== id);
    emit();
    void idbDelete(id);
  },

  toggleLibrary(id: string) {
    let changed: WorkspaceItem | undefined;
    items = items.map((i) => {
      if (i.id !== id) return i;
      changed = { ...i, savedToLibrary: !i.savedToLibrary };
      return changed;
    });
    emit();
    if (changed) void idbPut(changed);
  },

  rename(id: string, title: string) {
    let changed: WorkspaceItem | undefined;
    items = items.map((i) => {
      if (i.id !== id) return i;
      changed = { ...i, title: title.slice(0, 200) };
      return changed;
    });
    emit();
    if (changed) void idbPut(changed);
  },

  /** Delete every item for a user (or all if no user given). Keeps library pins. */
  clearUnsaved(userId: string | null) {
    const toRemove = items.filter(
      (i) => !i.savedToLibrary && (userId == null || i.userId === userId)
    );
    items = items.filter((i) => !toRemove.includes(i));
    emit();
    for (const i of toRemove) void idbDelete(i.id);
  },

  getAll(): WorkspaceItem[] {
    return items;
  },

  subscribe(listener: () => void): () => void {
    hydrate();
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

const EMPTY: WorkspaceItem[] = [];

/** Live, sorted (newest-first) view of all workspace items. */
export function useWorkspaceItems(): WorkspaceItem[] {
  return useSyncExternalStore(
    workspaceStore.subscribe,
    workspaceStore.getAll,
    () => EMPTY
  );
}

/** Derive a short human title from a research answer + optional query. */
export function deriveResearchTitle(answer: string, query?: string): string {
  const q = (query || "").trim();
  if (q) return q.length > 90 ? q.slice(0, 87) + "…" : q;
  const firstLine = (answer || "")
    .replace(/[#*_>`]/g, "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0) || "Research result";
  return firstLine.length > 90 ? firstLine.slice(0, 87) + "…" : firstLine;
}
