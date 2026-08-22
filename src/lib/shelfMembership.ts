import { supabase } from "@/integrations/supabase/client";

// Non-exclusive shelf membership, DUAL-MODE. The book_shelf_members junction
// ships in the 20260821120000_shelf_membership migration, which the user
// applies via a Lovable prompt out-of-band — push order vs apply order is not
// controllable — so reads fall back to the exclusive books.folder_id column
// while the table doesn't exist, and writes go to BOTH stores (the junction
// as data, folder_id as a best-effort single-shelf mirror for stale cached
// bundles) until the deferred migration drops the column.
//
// Design laws this module encodes (each earned by a review finding):
//  - Writes are DELTAS (add/remove specific shelves), never replace-the-set:
//    deltas from two rapid toggles commute at the database, so no write can
//    delete a membership another in-flight write just added.
//  - The first membership READ doubles as the availability probe — a
//    missing-schema error caches fallback mode for the session (applying the
//    migration is user-gated; re-asking helps nobody), any other error
//    throws and stays re-probeable. No separate probe round trip, and no
//    HEAD request (HEAD error responses carry no JSON body, so the error
//    code the classifier needs may never arrive).
//  - Junction writes are attempted whenever the junction is not KNOWN
//    missing — even in a fallback-mode session — so a transient startup
//    failure can't make a session's shelf changes silently vanish on the
//    next junction-mode reload.
//  - Membership has exactly ONE client copy: books[].folderIds in
//    AppContext. This module only talks to the database; AppContext owns
//    the state patch and the toggle semantics.

/** null = unknown, true = junction confirmed live, false = confirmed missing
 *  (sticky for the session — the migration is a user-gated action). */
let junctionCache: boolean | null = null;

/** True when the error means the shelf-membership migration hasn't been
 *  applied yet. PGRST205 = table missing from PostgREST's schema cache,
 *  42P01 = relation does not exist; the column codes guard against a
 *  partially-applied migration. */
function isMissingSchema(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "42P01" || code === "PGRST205" || code === "42703" || code === "PGRST204";
}

/** Drop the availability cache (used after the migration lands, and by tests). */
export function resetShelfJunctionAvailability(): void {
  junctionCache = null;
}

const PAGE_SIZE = 500;
const MAX_PAGES = 40;

/**
 * All shelf memberships for a user, as bookId → folderIds. Returns null in
 * fallback mode (junction not applied yet) — the caller then keeps its
 * folder_id-derived memberships. Throws on transient failures (network,
 * auth): a read failure is not a mode change, and the caller must not wipe
 * the fallback data it already has.
 *
 * Paged because PostgREST silently caps un-ranged selects at 1000 rows
 * (documented repo lesson), and a junction table crosses that line faster
 * than any base table. Ordered by (book_id, folder_id) — the PK columns, a
 * TOTAL order — because range() paging over a sort with ties can skip or
 * duplicate rows at page boundaries, and the migration's backfill stamps
 * every pre-existing membership with one identical created_at.
 */
export async function fetchShelfMembership(userId: string): Promise<Map<string, string[]> | null> {
  if (junctionCache === false) return null;
  const map = new Map<string, string[]>();
  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE_SIZE;
    const { data, error } = await (supabase.from("book_shelf_members" as any) as any)
      .select("book_id, folder_id")
      .eq("user_id", userId)
      .order("book_id", { ascending: true })
      .order("folder_id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) {
      if (isMissingSchema(error)) { junctionCache = false; return null; }
      throw error; // transient — junctionCache stays as-is, next call re-asks
    }
    const batch = (data || []) as { book_id: string; folder_id: string }[];
    for (const row of batch) {
      const list = map.get(row.book_id) || [];
      list.push(row.folder_id);
      map.set(row.book_id, list);
    }
    if (batch.length < PAGE_SIZE) {
      junctionCache = true;
      return map;
    }
  }
  // Never silently truncate: memberships past the cap would show as
  // unshelved. 20k rows is far past any real library, but say so if it hits.
  console.warn(`Shelf membership read hit the ${MAX_PAGES * PAGE_SIZE}-row page cap; some memberships were not loaded.`);
  junctionCache = true;
  return map;
}

export interface ShelfDelta {
  /** Shelf ids to add this book to. */
  adds: string[];
  /** Shelf ids to remove this book from. */
  removes: string[];
  /** books.folder_id mirror write — omit when the mirror value is unchanged
   *  (skips a round trip). The mirror is BEST-EFFORT: it exists only so
   *  stale cached bundles keep seeing a coherent single-shelf world until
   *  the deferred migration drops the column. */
  mirror?: { value: string | null };
}

/**
 * Persist one book's membership delta. Adds land before removes, so a
 * mid-flight failure leaves a superset — never an emptied set. Junction ops
 * run whenever the junction is not known-missing, even in a fallback-mode
 * session (see the module header); `junctionLive` decides which store is
 * authoritative for errors:
 *  - junctionLive=true: a junction failure throws (the caller rolls back);
 *    a mirror failure is only logged — the membership already committed.
 *  - junctionLive=false: the mirror write is the authoritative one and
 *    throws; a best-effort junction failure is only logged.
 * A missing-schema junction error is neither: it caches fallback mode and
 * the mirror write proceeds as the write of record.
 */
export async function applyShelfDelta(
  userId: string,
  bookId: string,
  delta: ShelfDelta,
  junctionLive: boolean,
): Promise<void> {
  const { adds, removes, mirror } = delta;

  const onJunctionError = (error: unknown): void => {
    if (isMissingSchema(error)) {
      junctionCache = false;
      return;
    }
    if (junctionLive) throw error;
    console.error("Best-effort junction write failed (fallback session):", error);
  };

  if (junctionCache !== false && adds.length > 0) {
    // ignoreDuplicates → ON CONFLICT DO NOTHING: re-adding an existing row
    // is a no-op, not a row rewrite, and duplicate conflict targets in one
    // payload can't raise Postgres error 21000.
    const { error } = await (supabase.from("book_shelf_members" as any) as any)
      .upsert(
        adds.map((folder_id) => ({ folder_id, book_id: bookId, user_id: userId })),
        { onConflict: "folder_id,book_id", ignoreDuplicates: true },
      );
    if (error) onJunctionError(error);
  }
  if (junctionCache !== false && removes.length > 0) {
    const { error } = await (supabase.from("book_shelf_members" as any) as any)
      .delete()
      .eq("book_id", bookId)
      .eq("user_id", userId)
      .in("folder_id", removes);
    if (error) onJunctionError(error);
  }

  if (mirror) {
    const { error } = await supabase
      .from("books")
      .update({ folder_id: mirror.value } as any)
      .eq("id", bookId)
      .eq("user_id", userId);
    if (error) {
      if (!junctionLive) throw error;
      console.error("Shelf membership saved, but the folder_id mirror write failed:", error);
    }
  }
}
