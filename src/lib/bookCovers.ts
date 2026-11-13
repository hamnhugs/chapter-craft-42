/**
 * Where a book's cover image lives and how it gets to an <img>.
 *
 * Covers are stored beside the book's own file, in the private `book-pdfs`
 * bucket at `<user>/<book>.cover.jpg` — the bucket already exists and already
 * carries owner-only insert/update/delete/select policies for that folder, so
 * covers need no new bucket and no migration.
 *
 * A private object has no permanent URL, so `books.cover_image_url` holds a
 * MARKER (`cover:<path>?v=<stamp>`) rather than a link, and the client swaps
 * it for a signed URL. Signed URLs are cached in localStorage for most of
 * their life: a stable URL across sessions is what lets the browser's own
 * image cache do its job, where a fresh signature every load would re-download
 * every cover every time.
 *
 * Anything in `cover_image_url` that is not a marker (an http(s) or data URL
 * written by some other path) is passed through untouched.
 */

import { supabase } from "@/integrations/supabase/client";

const BUCKET = "book-pdfs";
const MARKER = "cover:";
const SIGN_TTL_S = 60 * 60 * 24 * 7;
/** Re-sign a day early, so a URL never expires mid-session. */
const REFRESH_MARGIN_MS = 24 * 60 * 60 * 1000;
const CACHE_KEY = "cc.coverUrls.v1";
const CACHE_MAX = 3000;

type Cache = Record<string, { url: string; exp: number }>;

let cache: Cache | null = null;

function readCache(): Cache {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}");
    cache = parsed && typeof parsed === "object" ? (parsed as Cache) : {};
  } catch {
    cache = {};
  }
  return cache!;
}

function writeCache() {
  if (!cache) return;
  try {
    const now = Date.now();
    const live = Object.entries(cache).filter(([, v]) => v.exp > now);
    // Newest-expiring first: when over the cap, the oldest signatures go.
    live.sort((a, b) => b[1].exp - a[1].exp);
    cache = Object.fromEntries(live.slice(0, CACHE_MAX));
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch { /* private mode / quota — the in-memory copy still serves this session */ }
}

export const coverPath = (userId: string, bookId: string) => `${userId}/${bookId}.cover.jpg`;

export const isCoverMarker = (raw: string | null | undefined): raw is string =>
  typeof raw === "string" && raw.startsWith(MARKER);

/** The marker written to `books.cover_image_url`. The stamp makes a replaced
 *  cover a different cache key, so the old signed URL is never reused. */
export const coverMarker = (userId: string, bookId: string, stamp = Date.now()) =>
  `${MARKER}${coverPath(userId, bookId)}?v=${stamp}`;

const markerPath = (marker: string) => marker.slice(MARKER.length).split("?")[0];

/**
 * What to hand an <img> right now, without a network round-trip: a direct URL
 * as-is, a marker's cached signed URL, or undefined when it has to be signed
 * first (see `signCovers`).
 */
export function coverUrlNow(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  if (!isCoverMarker(raw)) return raw;
  const hit = readCache()[raw];
  return hit && hit.exp - REFRESH_MARGIN_MS > Date.now() ? hit.url : undefined;
}

/**
 * Sign every marker that has no usable cached URL. Resolves to marker → URL
 * for the ones that were signed. Batched (the storage API signs many paths in
 * one request); a failed batch is skipped — those books keep their generated
 * placeholder until the next load.
 */
export async function signCovers(markers: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const todo = Array.from(new Set(markers.filter((m) => isCoverMarker(m) && !coverUrlNow(m))));
  if (todo.length === 0) return out;
  const c = readCache();
  for (let i = 0; i < todo.length; i += 100) {
    const batch = todo.slice(i, i + 100);
    try {
      const { data, error } = await supabase.storage.from(BUCKET).createSignedUrls(batch.map(markerPath), SIGN_TTL_S);
      if (error || !data) continue;
      data.forEach((row, j) => {
        if (!row?.signedUrl || row.error) return;
        const marker = batch[j];
        c[marker] = { url: row.signedUrl, exp: Date.now() + SIGN_TTL_S * 1000 };
        out.set(marker, row.signedUrl);
      });
    } catch { /* offline — placeholders stand in */ }
  }
  if (out.size > 0) writeCache();
  return out;
}

/**
 * Store a cover and point the book's row at it. Resolves to the marker and a
 * URL the caller can show immediately (an object URL for the blob it already
 * holds — no round-trip to see the cover it just made), or null on failure.
 */
export async function saveCover(
  userId: string,
  bookId: string,
  blob: Blob,
): Promise<{ marker: string; url: string } | null> {
  try {
    const path = coverPath(userId, bookId);
    const { error: upErr } = await supabase.storage
      .from(BUCKET)
      .upload(path, blob, { contentType: "image/jpeg", upsert: true, cacheControl: "31536000" });
    if (upErr) return null;
    const marker = coverMarker(userId, bookId);
    const { error } = await supabase
      .from("books")
      .update({ cover_image_url: marker })
      .eq("id", bookId)
      .eq("user_id", userId);
    if (error) return null;
    const url = URL.createObjectURL(blob);
    return { marker, url };
  } catch {
    return null;
  }
}

/** Best-effort cleanup when a book is deleted for good. */
export async function removeCover(userId: string, bookId: string): Promise<void> {
  try { await supabase.storage.from(BUCKET).remove([coverPath(userId, bookId)]); } catch { /* orphan, harmless */ }
}
