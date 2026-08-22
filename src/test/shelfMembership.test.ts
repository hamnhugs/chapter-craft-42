import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The dual-mode shelf-membership layer. Three contracts under test:
 *
 * 1. The first READ doubles as the availability probe: a missing-schema
 *    error caches fallback mode for the session (the migration is a
 *    user-gated action — stop asking), a transient error THROWS and stays
 *    re-probeable, success caches junction mode. No separate probe request.
 *
 * 2. Writes are DELTAS — adds land before removes (a mid-flight failure
 *    leaves a superset, never an emptied set), adds use ON CONFLICT DO
 *    NOTHING, and junction ops run even in a fallback-mode session unless
 *    the junction is KNOWN missing, so a transient startup failure can't
 *    make the session's shelf changes vanish on the next reload.
 *
 * 3. Error authority follows the mode: junction-live sessions throw on
 *    junction failures and only log mirror failures (the membership already
 *    committed); fallback sessions throw on the mirror write (their write
 *    of record) and only log best-effort junction failures.
 */
const state = vi.hoisted(() => ({
  // One entry per supabase.from() call, consumed in order. "throw" rejects.
  queue: [] as (Record<string, unknown> | "throw")[],
  calls: [] as { table: string; ops: [string, unknown[]][] }[],
}));

vi.mock("@/integrations/supabase/client", () => {
  const METHODS = ["select", "limit", "eq", "in", "not", "order", "range", "upsert", "delete", "update", "insert"];
  function builder(table: string) {
    const call = { table, ops: [] as [string, unknown[]][] };
    state.calls.push(call);
    const p: Record<string, unknown> = {
      then(resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) {
        const result = state.queue.length ? state.queue.shift()! : { data: [], error: null };
        if (result === "throw") return Promise.reject(new Error("offline")).then(resolve, reject);
        return Promise.resolve({ data: null, error: null, ...result }).then(resolve, reject);
      },
    };
    for (const m of METHODS) {
      p[m] = (...args: unknown[]) => { call.ops.push([m, args]); return p; };
    }
    return p;
  }
  return { supabase: { from: (table: string) => builder(table) } };
});

const {
  fetchShelfMembership, applyShelfDelta, resetShelfJunctionAvailability,
} = await import("@/lib/shelfMembership");

beforeEach(() => {
  resetShelfJunctionAvailability();
  state.queue = [];
  state.calls = [];
});

const junctionCalls = () => state.calls.filter((c) => c.table === "book_shelf_members");
const bookCalls = () => state.calls.filter((c) => c.table === "books");

describe("fetchShelfMembership — the read that doubles as the probe", () => {
  it("groups junction rows into bookId → folderIds and orders by the PK columns (a TOTAL order — ties at page boundaries skip or duplicate rows)", async () => {
    state.queue = [{ data: [
      { book_id: "b1", folder_id: "s1" },
      { book_id: "b1", folder_id: "s2" },
      { book_id: "b2", folder_id: "s1" },
    ], error: null }];
    const map = await fetchShelfMembership("u1");
    expect(map).not.toBeNull();
    expect(map!.get("b1")).toEqual(["s1", "s2"]);
    expect(map!.get("b2")).toEqual(["s1"]);
    expect(map!.has("b3")).toBe(false);
    const orders = junctionCalls()[0].ops.filter(([m]) => m === "order").map(([, a]) => a[0]);
    expect(orders).toEqual(["book_id", "folder_id"]);
  });

  it.each(["42P01", "PGRST205"])(
    "missing schema (%s) → null, cached for the session — the next read doesn't even ask",
    async (code) => {
      state.queue = [{ error: { code } }];
      expect(await fetchShelfMembership("u1")).toBeNull();
      expect(await fetchShelfMembership("u1")).toBeNull();
      expect(junctionCalls()).toHaveLength(1);
    },
  );

  it("a transient failure THROWS (the caller keeps its folder_id data) and stays re-probeable", async () => {
    state.queue = [
      { error: { code: "PGRST301", message: "JWT expired" } },
      { data: [{ book_id: "b1", folder_id: "s1" }], error: null },
    ];
    await expect(fetchShelfMembership("u1")).rejects.toBeTruthy();
    const map = await fetchShelfMembership("u1"); // it really did ask again
    expect(map!.get("b1")).toEqual(["s1"]);
    expect(junctionCalls()).toHaveLength(2);
  });
});

describe("applyShelfDelta — delta writes, dual-store", () => {
  it("adds land BEFORE removes, adds use ON CONFLICT DO NOTHING, and the mirror write targets books", async () => {
    await applyShelfDelta("u1", "b1", { adds: ["s2"], removes: ["s1"], mirror: { value: "s2" } }, true);
    expect(state.calls.map((c) => c.table)).toEqual(["book_shelf_members", "book_shelf_members", "books"]);
    const [up, del, mirror] = state.calls;
    expect(up.ops[0][0]).toBe("upsert");
    expect(up.ops[0][1][0]).toEqual([{ folder_id: "s2", book_id: "b1", user_id: "u1" }]);
    expect(up.ops[0][1][1]).toEqual({ onConflict: "folder_id,book_id", ignoreDuplicates: true });
    expect(del.ops.map(([m]) => m)).toContain("delete");
    expect(del.ops).toContainEqual(["in", ["folder_id", ["s1"]]]);
    expect(mirror.ops).toContainEqual(["update", [{ folder_id: "s2" }]]);
  });

  it("a toggle that doesn't move folderIds[0] omits the mirror round trip entirely", async () => {
    await applyShelfDelta("u1", "b1", { adds: ["s3"], removes: [] }, true);
    expect(state.calls.map((c) => c.table)).toEqual(["book_shelf_members"]);
  });

  it("junction ops run in a FALLBACK session too (transient startup failure must not lose writes), with failures only logged", async () => {
    // Cache is unknown (no fetch ran): junction attempted, error swallowed,
    // mirror write proceeds and is authoritative.
    state.queue = [{ error: { code: "PGRST301", message: "blip" } }, { error: null }];
    await applyShelfDelta("u1", "b1", { adds: ["s1"], removes: [], mirror: { value: "s1" } }, false);
    expect(junctionCalls()).toHaveLength(1);
    expect(bookCalls()).toHaveLength(1);
  });

  it("a KNOWN-missing junction (cached by a read) skips junction round trips — only the mirror write goes out", async () => {
    state.queue = [{ error: { code: "42P01" } }]; // fetch caches fallback mode
    expect(await fetchShelfMembership("u1")).toBeNull();
    state.calls = [];
    await applyShelfDelta("u1", "b1", { adds: ["s1"], removes: [], mirror: { value: "s1" } }, false);
    expect(junctionCalls()).toHaveLength(0);
    expect(bookCalls()).toHaveLength(1);
  });

  it("a missing-schema error DURING a write caches fallback mode and lets the mirror write proceed as the write of record", async () => {
    state.queue = [{ error: { code: "PGRST205" } }, { error: null }];
    await applyShelfDelta("u1", "b1", { adds: ["s1"], removes: [], mirror: { value: "s1" } }, true);
    expect(bookCalls()).toHaveLength(1);
    state.calls = [];
    await applyShelfDelta("u1", "b1", { adds: ["s2"], removes: [], mirror: { value: "s1" } }, true);
    expect(junctionCalls()).toHaveLength(0); // cached: no more junction attempts
  });

  it("junction-live: a junction failure throws BEFORE the mirror write (the caller rolls back)", async () => {
    state.queue = [{ error: { code: "57014", message: "canceled" } }];
    await expect(
      applyShelfDelta("u1", "b1", { adds: ["s1"], removes: [], mirror: { value: "s1" } }, true),
    ).rejects.toBeTruthy();
    expect(bookCalls()).toHaveLength(0);
  });

  it("junction-live: a failed mirror does NOT fail the committed membership", async () => {
    state.queue = [{ error: null }, { error: { code: "57014", message: "mirror failed" } }];
    await expect(
      applyShelfDelta("u1", "b1", { adds: ["s1"], removes: [], mirror: { value: "s1" } }, true),
    ).resolves.toBeUndefined();
  });

  it("fallback session: a mirror failure throws — it was the write of record", async () => {
    state.queue = [{ error: null }, { error: { code: "57014", message: "boom" } }];
    await expect(
      applyShelfDelta("u1", "b1", { adds: ["s1"], removes: [], mirror: { value: "s1" } }, false),
    ).rejects.toBeTruthy();
  });
});
