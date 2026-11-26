/**
 * Recordings of the Read tab's read-along, kept on this device so a page that
 * has been read aloud once plays again without paying for the voice again.
 *
 * WHAT IS KEPT. The audio the voice service returned for one stretch of text
 * (a "clip": roughly a paragraph, or one character's line) with its word
 * timings. Clips are bundled by PAGE: every clip carries the page it was made
 * on, so a page's recording can be counted, played, or recorded over as one.
 *
 * HOW A CLIP IS FOUND. By what was said and how — a hash of the text, the
 * voice and the voice settings — not by where it sits on the page. So:
 *   - change the voice, the model or the direction and the old clip is not
 *     played by mistake (it is kept; switching back finds it again);
 *   - a character recast to another voice is re-recorded, the narrator's
 *     paragraphs around them are not;
 *   - starting part-way down a page re-uses every clip whose text lines up.
 *
 * WHERE. IndexedDB, one store, one row per clip, indexed by page. A page is
 * a few megabytes of MP3; rows are written once and never rewritten, which a
 * single growing row per page would be on every paragraph.
 *
 * Nothing here talks to the network, and nothing is shared between devices.
 */

export interface RecordedTokens {
  text: string;
  start: number;
  end: number;
}

export interface RecordedClip {
  audio: ArrayBuffer;
  /** The service's word timings; null when it sent none. */
  words: RecordedTokens[] | null;
}

/** What makes two clips the same clip. Anything that changes the sound. */
export interface ClipIdentity {
  text: string;
  voiceId: string;
  model?: string;
  delivery?: string;
  direction?: string;
  scene?: string;
}

export interface PageRecordingInfo {
  clips: number;
  bytes: number;
}

/** The player's view of one page's recording. */
export interface PageRecorder {
  key(id: ClipIdentity): Promise<string>;
  get(key: string): Promise<RecordedClip | null>;
  put(key: string, clip: RecordedClip): Promise<void>;
}

interface ClipRow {
  id: string;
  page: string;
  audio: ArrayBuffer;
  words: RecordedTokens[] | null;
  bytes: number;
  at: number;
}

const DB_NAME = "bw-read-recordings";
const STORE = "clips";
const BY_PAGE = "page";
const BY_AGE = "at";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("No storage on this device"));
      return;
    }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(STORE, { keyPath: "id" });
      // Page then size: a page is counted from the index alone, without
      // reading megabytes of audio to add up its length.
      store.createIndex(BY_PAGE, ["page", "bytes"]);
      store.createIndex(BY_AGE, "at");
    };
    req.onsuccess = () => {
      // Another tab upgrading must not be blocked by this one.
      req.result.onversionchange = () => { req.result.close(); dbPromise = null; };
      resolve(req.result);
    };
    req.onerror = () => reject(req.error ?? new Error("Couldn't open the recordings"));
    req.onblocked = () => reject(new Error("Recordings are open in another tab"));
  });
  // A failed open is retried next time rather than remembered.
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function finished(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("Recording was not saved"));
  });
}

const ofPage = (scope: string) => IDBKeyRange.bound([scope, 0], [scope, Number.MAX_SAFE_INTEGER]);

/** The page a clip belongs to: one listener, one book, one page. */
export function pageScope(userId: string | null, bookId: string, page: string | number): string {
  return `${userId ?? "anon"}|${bookId}|${page}`;
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** FNV-1a, twice over: only for a browser with no Web Crypto (plain http). */
function weakHash(s: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x811c9dc5) + i;
  }
  return `w${(a >>> 0).toString(16)}${(b >>> 0).toString(16)}${s.length.toString(16)}`;
}

/** A stable name for "this text, in this voice, said this way". */
export async function clipKey(id: ClipIdentity): Promise<string> {
  // Field order is the format: changing it orphans every recording made.
  const canon = JSON.stringify([
    1, id.voiceId, id.model ?? "", id.delivery ?? "", id.direction ?? "", id.scene ?? "", id.text,
  ]);
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return weakHash(canon);
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(canon));
  return hex(new Uint8Array(digest).subarray(0, 16));
}

let askedToPersist = false;
/** Ask the browser, once, not to clear recordings when it is short of room. */
function keepStorage() {
  if (askedToPersist) return;
  askedToPersist = true;
  try { void navigator.storage?.persist?.().catch(() => {}); } catch { /* not offered */ }
}

/** Out of room: let go of the oldest fifth of everything recorded. */
async function dropOldest(db: IDBDatabase): Promise<void> {
  const tx = db.transaction(STORE, "readwrite");
  const store = tx.objectStore(STORE);
  const total = await done(store.count());
  let left = Math.max(1, Math.ceil(total / 5));
  await new Promise<void>((resolve, reject) => {
    const cur = store.index(BY_AGE).openCursor();
    cur.onerror = () => reject(cur.error);
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c || left <= 0) { resolve(); return; }
      c.delete();
      left--;
      c.continue();
    };
  });
  await finished(tx);
}

async function writeRow(db: IDBDatabase, row: ClipRow): Promise<void> {
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).put(row);
  await finished(tx);
}

/** One page's recording. Every call fails soft: no recording, never no voice. */
export function pageRecorder(scope: string, onChange?: () => void): PageRecorder {
  return {
    key: clipKey,
    async get(key) {
      try {
        const db = await openDb();
        const row = await done<ClipRow | undefined>(db.transaction(STORE).objectStore(STORE).get(`${scope}|${key}`));
        return row ? { audio: row.audio, words: row.words } : null;
      } catch {
        return null;
      }
    },
    async put(key, clip) {
      // A copy: the player hands the same bytes to a Blob it is about to play.
      const row: ClipRow = {
        id: `${scope}|${key}`, page: scope, audio: clip.audio.slice(0), words: clip.words, bytes: clip.audio.byteLength, at: Date.now(),
      };
      try {
        const db = await openDb();
        keepStorage();
        try {
          await writeRow(db, row);
        } catch (e) {
          if ((e as DOMException | null)?.name !== "QuotaExceededError") throw e;
          await dropOldest(db);
          await writeRow(db, row);
        }
        onChange?.();
      } catch (e) {
        console.warn("read-along: couldn't keep the recording", e);
      }
    },
  };
}

/** How much of a page is recorded. */
export async function pageRecordingInfo(scope: string): Promise<PageRecordingInfo> {
  try {
    const db = await openDb();
    const sizes = await new Promise<number[]>((resolve, reject) => {
      const out: number[] = [];
      const cur = db.transaction(STORE).objectStore(STORE).index(BY_PAGE).openKeyCursor(ofPage(scope));
      cur.onerror = () => reject(cur.error);
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) { resolve(out); return; }
        out.push(Number((c.key as [string, number])[1]) || 0);
        c.continue();
      };
    });
    return { clips: sizes.length, bytes: sizes.reduce((n, b) => n + b, 0) };
  } catch {
    return { clips: 0, bytes: 0 };
  }
}

/** Throw a page's recording away, so the next listen records it again. */
export async function erasePageRecording(scope: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  const store = tx.objectStore(STORE);
  const keys = await done(store.index(BY_PAGE).getAllKeys(ofPage(scope)));
  for (const k of keys) store.delete(k);
  await finished(tx);
}

/** "2.4 MB" / "310 KB". */
export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}
