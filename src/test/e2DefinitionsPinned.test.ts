import { describe, it, expect } from "vitest";
import { createHash } from "crypto";
import { CHAT_TOOL_DEFINITIONS, executeChatTool } from "@/lib/chatTools";
import { E2_ROSTER } from "@/harness/e2/harnessCore";

/**
 * The E2 quality gate certified a configuration: the frozen question set,
 * the catalog block bytes (blockcheck.e2run.ts), and `rosterSha` — a hash of
 * the DEFINITIONS of exactly the E2_ROSTER tools. The library agent enriches
 * list_books/get_book RESULTS (shelves, provenance) and adds four verbs, and
 * the claim that the certified run still stands rests on two things pinned
 * here:
 *  1. the four E2 definitions are byte-identical to the certified ones, so
 *     rosterSha does not move and the checkpoint would still resume;
 *  2. with no shelf reader in deps — which is exactly the harness's deps —
 *     list_books returns the SAME shape the certified traces saw: a bare
 *     array, no shelves, no shelf_ids.
 * Change either on purpose: re-run the E2 set and update the digest below.
 */

const CERTIFIED_E2_DEFS_SHA = "5184e9daa9df05ac";

describe("E2 configuration pins (docs/library-agent.md §2)", () => {
  it("the E2 roster definitions are byte-identical to the certified ones", () => {
    const defs = (CHAT_TOOL_DEFINITIONS as ReadonlyArray<any>).filter((d) => (E2_ROSTER as readonly string[]).includes(d.function.name));
    expect(defs.map((d) => d.function.name)).toEqual([...E2_ROSTER]);
    const sha = createHash("sha256").update(JSON.stringify(defs)).digest("hex").slice(0, 16);
    expect(sha, `E2 definitions changed — sha ${sha}. Rerun the frozen E2 set before updating the pin.`).toBe(CERTIFIED_E2_DEFS_SHA);
  });

  it("list_books without a shelf reader returns the certified bare-array shape", async () => {
    const books = [
      { id: "b1", title: "One", fileName: "one.pdf", fileData: "", pageCount: 3, chapters: [], addedAt: 0, folderIds: ["s1"] },
      { id: "b2", title: "Two", fileName: "two.pdf", fileData: "", pageCount: 5, chapters: [{ id: "c", name: "C", startPage: 1, endPage: 5, textContent: "" }], addedAt: 0, folderIds: [] },
    ];
    const deps = { books, activeBookId: "b1", setActiveBookId: () => {}, addChapter: async () => {}, updateChapter: () => {}, removeChapter: () => {}, permissionsSnapshot: {} } as any;
    const { result } = await executeChatTool("list_books", "{}", deps);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual([
      { id: "b1", title: "One", page_count: 3, chapter_count: 0, is_active: true },
      { id: "b2", title: "Two", page_count: 5, chapter_count: 1, is_active: false },
    ]);
  });
});
