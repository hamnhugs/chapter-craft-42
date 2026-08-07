import { useSyncExternalStore } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  fileFingerprint,
  kindForLanguage,
  mediaTypeFor,
  normalizeKind,
  type WorkspaceItemKind,
} from "@/lib/workspaceFiles";

/**
 * Workspace store — durable, local-first, cross-device home for EVERY "file"
 * the chat produces: sandboxed HTML/SVG artifacts, deep-research / web-search
 * reports, and the code, documents, data and tool sources the assistant writes
 * inline. The taxonomy and the active/inert split live in workspaceFiles.ts;
 * this module only stores and syncs.
 *
 * Persistence model (local-first sync):
 *  • Supabase `workspace_items` is the source of truth → items persist
 *    session-to-session AND device-to-device (anywhere the user signs in).
 *  • IndexedDB is a local cache → instant first paint, offline resilience, and
 *    survival across tab switches / reloads without waiting on the network.
 *  • Supabase Realtime streams INSERT/UPDATE/DELETE so a creation on one device
 *    appears on another live.
 *
 * Writes are optimistic: update memory + IndexedDB immediately, then push to
 * Supabase in the background. All Supabase calls are wrapped and degrade
 * gracefully — if the `workspace_items` table doesn't exist yet, the app simply
 * runs in local-only mode until it does (then sync activates with no code
 * change). The Supabase client is typed against generated types that may not yet
 * include this table, so DB access goes through an untyped handle on purpose.
 */

/** Re-exported so every existing importer (chatFocus, WorkspacePanel,
 *  chatTools, ChatContext) keeps its `from "@/lib/workspaceStore"` import
 *  working unchanged now that the taxonomy lives in workspaceFiles.ts. */
export type { WorkspaceItemKind } from "@/lib/workspaceFiles";

export interface WorkspaceCitation {
  title?: string;
  url: string;
  snippet?: string;
}

export interface WorkspaceItem {
  id: string;
  /** Owning user. Server rows are scoped by this via RLS. */
  userId: string | null;
  kind: WorkspaceItemKind;
  title: string;
  /** For html/svg: the inner body markup. For research: markdown text.
   *  For code/text/data/tool: the file's source, verbatim. */
  content: string;
  createdAt: number;
  /** Pinned to the library so it stands apart from auto-captured items. */
  savedToLibrary: boolean;
  meta?: {
    query?: string;
    citations?: WorkspaceCitation[];
    /** Free-form source tag, e.g. "Deep Research", "Web Search". */
    source?: string;
    /** Pinned as standing chat context ("focus"). Lives in the JSONB meta
     *  column so it syncs cross-device with zero migration. */
    focused?: boolean;
    /** Language token for code/data files ("py", "sql", "json"). Drives the
     *  download extension, the viewer's chip, and the focus-block label. */
    language?: string;
    /** Honest media type, recorded at capture time. Advisory only — the
     *  downloader re-derives what it puts on the Blob. */
    mediaType?: string;
    /** Content identity (see fileFingerprint). Lets a re-run of the extractor
     *  recognise a block it already filed instead of duplicating it. */
    fingerprint?: string;
  };
}

/** Hard ceiling on simultaneously focused items. Multi-document research
 *  shows item COUNT alone degrades answers independent of token length
 *  (up to 20%, "More Documents, Same Length"), so the store — not the UI —
 *  enforces the cap and every surface gets the same refusal. */
export const FOCUS_MAX_ITEMS = 5;

export type NewWorkspaceItem = Omit<WorkspaceItem, "id" | "createdAt" | "savedToLibrary"> &
  Partial<Pick<WorkspaceItem, "savedToLibrary">>;

/** Input for `workspaceStore.addFile` — the narrow seam the chat uses to file
 *  a produced file. `kind` is optional: omit it and the language decides (and
 *  a language can only ever choose an INERT kind, see kindForLanguage). */
export interface NewWorkspaceFile {
  userId: string | null;
  title: string;
  content: string;
  kind?: WorkspaceItemKind;
  language?: string;
  savedToLibrary?: boolean;
  meta?: WorkspaceItem["meta"];
}

const TABLE = "workspace_items";
// Untyped handle: the generated Database type may not include workspace_items
// yet (Lovable regenerates it when the table is created). This keeps the client
// code compiling before and after that happens.
const db = supabase as any;

// ---- IndexedDB local cache ------------------------------------------------

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
      const idb = req.result;
      if (!idb.objectStoreNames.contains(STORE)) {
        idb.createObjectStore(STORE, { keyPath: "id" });
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
    const idb = await openDb();
    return await new Promise<WorkspaceItem[]>((resolve) => {
      const tx = idb.transaction(STORE, "readonly");
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
    const idb = await openDb();
    await new Promise<void>((resolve) => {
      const tx = idb.transaction(STORE, "readwrite");
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
    const idb = await openDb();
    await new Promise<void>((resolve) => {
      const tx = idb.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    });
  } catch {
    /* best-effort */
  }
}

// ---- Supabase row mapping -------------------------------------------------

interface WorkspaceRow {
  id: string;
  user_id: string | null;
  kind: string;
  title: string;
  content: string | null;
  saved_to_library: boolean | null;
  meta: WorkspaceItem["meta"] | null;
  created_at: string;
}

function rowToItem(row: WorkspaceRow): WorkspaceItem {
  return {
    id: row.id,
    userId: row.user_id ?? null,
    // THE reader-side safety valve. This used to coerce anything unrecognised
    // to "research", which renders as markdown — so a kind written by a newer
    // client would be INTERPRETED on an older device. normalizeKind degrades
    // to inert "text" instead: unknown input can only ever be shown, never run
    // and never parsed.
    kind: normalizeKind(row.kind),
    title: row.title || "Untitled",
    content: row.content || "",
    createdAt: row.created_at ? Date.parse(row.created_at) || Date.now() : Date.now(),
    savedToLibrary: !!row.saved_to_library,
    meta: row.meta || undefined,
  };
}

function itemToRow(item: WorkspaceItem): WorkspaceRow {
  return {
    id: item.id,
    user_id: item.userId,
    kind: item.kind,
    title: item.title,
    content: item.content,
    saved_to_library: item.savedToLibrary,
    meta: item.meta ?? null,
    created_at: new Date(item.createdAt).toISOString(),
  };
}

async function serverUpsert(item: WorkspaceItem): Promise<void> {
  if (!item.userId) return; // only sync signed-in items
  try {
    const { error } = await db.from(TABLE).upsert(itemToRow(item), { onConflict: "id" });
    if (error) console.debug("[workspace] upsert skipped:", error.message);
  } catch (e: any) {
    console.debug("[workspace] upsert failed:", e?.message);
  }
}

async function serverDelete(id: string): Promise<void> {
  try {
    const { error } = await db.from(TABLE).delete().eq("id", id);
    if (error) console.debug("[workspace] delete skipped:", error.message);
  } catch (e: any) {
    console.debug("[workspace] delete failed:", e?.message);
  }
}

/** PostgREST silently caps an un-ranged select at max-rows (1000 on hosted
 *  Supabase) — no error, just a short array. That ceiling used to be
 *  unreachable; now that every code block, document and dataset lands here it
 *  is a matter of time, and the failure looks exactly like "my old files
 *  vanished". Drain in pages instead of trusting one call. */
const FETCH_PAGE = 1000;

async function serverFetch(userId: string): Promise<WorkspaceItem[] | null> {
  try {
    const rows: WorkspaceRow[] = [];
    for (let from = 0; ; from += FETCH_PAGE) {
      const { data, error } = await db
        .from(TABLE)
        .select("id, user_id, kind, title, content, saved_to_library, meta, created_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .range(from, from + FETCH_PAGE - 1);
      if (error) {
        console.debug("[workspace] fetch skipped (local-only):", error.message);
        // A later page failing would silently truncate the library, which is
        // the bug this paging exists to prevent — so only a FIRST-page failure
        // degrades to local-only; anything after it keeps what we have.
        return from === 0 ? null : rows.map(rowToItem);
      }
      const page = (data as WorkspaceRow[]) || [];
      rows.push(...page);
      if (page.length < FETCH_PAGE) break;
    }
    return rows.map(rowToItem);
  } catch (e: any) {
    console.debug("[workspace] fetch failed:", e?.message);
    return null;
  }
}

// ---- Observable layer (useSyncExternalStore-compatible) -------------------

// `items` is replaced (new array) on every mutation; between mutations the SAME
// reference is returned from getSnapshot so React doesn't loop. Newest first.
let items: WorkspaceItem[] = [];
const listeners = new Set<() => void>();
let hydrated = false;

let currentUserId: string | null = null;
let realtimeChannel: any = null;

function emit() {
  for (const l of listeners) l();
}

function sortDesc(list: WorkspaceItem[]): WorkspaceItem[] {
  return [...list].sort((a, b) => b.createdAt - a.createdAt);
}

function upsertLocal(item: WorkspaceItem) {
  const idx = items.findIndex((i) => i.id === item.id);
  if (idx === -1) {
    items = sortDesc([item, ...items]);
  } else {
    const copy = [...items];
    copy[idx] = item;
    items = sortDesc(copy);
  }
}

function hydrate() {
  if (hydrated) return;
  hydrated = true;
  idbGetAll().then((loaded) => {
    // The cache is written by whichever build was last installed, so it gets
    // the same unknown-kind treatment the server rows get — never trust a
    // stored kind string on the way in.
    items = sortDesc(
      loaded
        .filter((i): i is WorkspaceItem => !!i && typeof i.id === "string")
        .map((i) => (i.kind === normalizeKind(i.kind) ? i : { ...i, kind: normalizeKind(i.kind) }))
    );
    emit();
    if (currentUserId) void syncFromServer(currentUserId);
  });
}

async function syncFromServer(userId: string) {
  const remote = await serverFetch(userId);
  if (!remote) return; // table missing / offline → stay local-only

  const remoteIds = new Set(remote.map((r) => r.id));
  // Local items for this user that the server doesn't have yet (created offline
  // or before the table existed) → push them up.
  const localOnly = items.filter((i) => i.userId === userId && !remoteIds.has(i.id));
  for (const i of localOnly) void serverUpsert(i);

  // Server is source of truth for this user; keep other users' local items.
  const others = items.filter((i) => i.userId !== userId);
  items = sortDesc([...remote, ...localOnly, ...others]);
  emit();
  // Refresh the local cache with the reconciled set.
  for (const i of [...remote, ...localOnly]) void idbPut(i);
}

function teardownRealtime() {
  if (realtimeChannel) {
    try { supabase.removeChannel(realtimeChannel); } catch { /* no-op */ }
    realtimeChannel = null;
  }
}

function setupRealtime(userId: string) {
  try {
    realtimeChannel = supabase
      .channel(`workspace-items-${userId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: TABLE, filter: `user_id=eq.${userId}` },
        (payload: any) => {
          if (payload.eventType === "DELETE") {
            const id = payload.old?.id;
            if (id) {
              items = items.filter((i) => i.id !== id);
              emit();
              void idbDelete(id);
            }
            return;
          }
          const row = payload.new as WorkspaceRow | undefined;
          if (!row) return;
          const item = rowToItem(row);
          upsertLocal(item);
          emit();
          void idbPut(item);
        }
      )
      .subscribe();
  } catch (e: any) {
    console.debug("[workspace] realtime unavailable:", e?.message);
  }
}

function uid(): string {
  try {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  } catch {
    /* fall through */
  }
  return `ws_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function addItem(input: NewWorkspaceItem): WorkspaceItem {
  const item: WorkspaceItem = {
    id: uid(),
    createdAt: Date.now(),
    savedToLibrary: input.savedToLibrary ?? false,
    userId: input.userId ?? null,
    kind: normalizeKind(input.kind),
    title: (input.title || "Untitled").slice(0, 200),
    content: input.content || "",
    meta: input.meta,
  };
  items = sortDesc([item, ...items]);
  emit();
  void idbPut(item);
  void serverUpsert(item);
  return item;
}

export const workspaceStore = {
  /**
   * Bind the store to the signed-in user: pulls their items from Supabase
   * (cross-device) and opens a realtime subscription. Call on login / logout.
   */
  setUser(userId: string | null) {
    if (userId === currentUserId) return;
    currentUserId = userId;
    teardownRealtime();
    if (userId) {
      if (hydrated) void syncFromServer(userId);
      setupRealtime(userId);
    }
    emit();
  },

  /** Capture a new item. Returns the created record. */
  add(input: NewWorkspaceItem): WorkspaceItem {
    return addItem(input);
  },

  /**
   * File a produced file — an extracted code block, a `save_file` call, a
   * forged tool's source — with kind, language and media type filled in.
   *
   * DEDUPE IS THE POINT. The extractor is pure and content-addressed, so the
   * same reply yields the same fingerprints every time it is processed; this
   * returns the item that already holds that content instead of stacking
   * copies (`created: false` so the caller can report truthfully rather than
   * claiming a save that did not happen). Scope matches what the panel shows:
   * this user's items plus pre-login (null-user) ones.
   *
   * `kind` is TRUSTED here — this is an app-code seam, exactly like `add`.
   * Anything the MODEL supplies must be resolved through parseSaveFileArgs or
   * extractCodeBlocks first; neither of those can ever return an active kind.
   */
  addFile(input: NewWorkspaceFile): { item: WorkspaceItem; created: boolean } {
    const kind = input.kind ? normalizeKind(input.kind) : kindForLanguage(input.language || "");
    const content = input.content || "";
    const language = input.language ? String(input.language) : undefined;
    const fingerprint = fileFingerprint({ kind, language, content });
    const userId = input.userId ?? null;

    const existing = items.find(
      (i) => i.meta?.fingerprint === fingerprint && (i.userId == null || i.userId === userId)
    );
    if (existing) return { item: existing, created: false };

    const item = addItem({
      userId,
      kind,
      title: input.title,
      content,
      savedToLibrary: input.savedToLibrary,
      meta: {
        ...(input.meta || {}),
        ...(language ? { language } : {}),
        mediaType: mediaTypeFor(kind, language),
        fingerprint,
      },
    });
    return { item, created: true };
  },

  remove(id: string) {
    items = items.filter((i) => i.id !== id);
    emit();
    void idbDelete(id);
    void serverDelete(id);
  },

  toggleLibrary(id: string) {
    let changed: WorkspaceItem | undefined;
    items = items.map((i) => {
      if (i.id !== id) return i;
      changed = { ...i, savedToLibrary: !i.savedToLibrary };
      return changed;
    });
    emit();
    if (changed) {
      void idbPut(changed);
      void serverUpsert(changed);
    }
  },

  /** Pin/unpin an item as chat focus. Refuses (never silently drops) past
   *  the cap so callers can explain rather than mystify. */
  toggleFocused(id: string): { ok: true; focused: boolean } | { ok: false; reason: "cap" } {
    const target = items.find((i) => i.id === id);
    // Already gone (realtime delete / another device) — nothing to toggle.
    if (!target) return { ok: true, focused: false };
    const turningOn = target.meta?.focused !== true;
    if (turningOn) {
      // Count the SAME null-inclusive union getFocused returns — pre-login
      // (null-userId) pins and account pins share one budget, or the cap
      // would pass here while buildFocusBlock silently drops the overflow.
      const viewer = target.userId ?? currentUserId;
      const current = items.filter(
        (i) => i.meta?.focused === true && (i.userId == null || i.userId === viewer)
      ).length;
      if (current >= FOCUS_MAX_ITEMS) return { ok: false, reason: "cap" };
    }
    let changed: WorkspaceItem | undefined;
    items = items.map((i) => {
      if (i.id !== id) return i;
      // Drop the key entirely when unpinning — JSON.stringify skips undefined,
      // so the synced meta stays clean instead of carrying focused:false noise.
      const nextMeta = { ...(i.meta || {}) };
      if (turningOn) nextMeta.focused = true;
      else delete nextMeta.focused;
      changed = { ...i, meta: Object.keys(nextMeta).length > 0 ? nextMeta : undefined };
      return changed;
    });
    emit();
    if (changed) {
      void idbPut(changed);
      void serverUpsert(changed);
    }
    return { ok: true, focused: turningOn };
  },

  /** The current focus set for a user, in store (newest-first) order.
   *  Non-reactive by design: sendMessage reads it at send time without
   *  adding React state to its dependency graph. */
  getFocused(userId: string | null): WorkspaceItem[] {
    return items.filter(
      (i) => i.meta?.focused === true && (i.userId == null || i.userId === userId)
    );
  },

  rename(id: string, title: string) {
    let changed: WorkspaceItem | undefined;
    items = items.map((i) => {
      if (i.id !== id) return i;
      changed = { ...i, title: title.slice(0, 200) };
      return changed;
    });
    emit();
    if (changed) {
      void idbPut(changed);
      void serverUpsert(changed);
    }
  },

  /** Delete every unsaved item for a user (keeps library pins). */
  clearUnsaved(userId: string | null) {
    const toRemove = items.filter(
      (i) => !i.savedToLibrary && (userId == null || i.userId === userId)
    );
    items = items.filter((i) => !toRemove.includes(i));
    emit();
    for (const i of toRemove) {
      void idbDelete(i.id);
      void serverDelete(i.id);
    }
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
