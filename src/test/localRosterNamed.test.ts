import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHAT_TOOL_DEFINITIONS } from "@/lib/chatTools";
import { findTools, LOCAL_NAMED_TOOLS, planLocalRoster } from "@/lib/localRoster";

const ALL: any[] = CHAT_TOOL_DEFINITIONS as unknown as any[];

beforeEach(() => {
  // No embedder: ranking falls back to words, which never reach the floor here.
  vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("named tools", () => {
  it("naming an app adds craft on a later turn, under the floor", async () => {
    await planLocalRoster({ userId: "u", query: "hello there", pool: ALL });
    const later = await planLocalRoster({ userId: "u", query: "open the fox in Photoshop and blur the background", pool: ALL });
    expect(later.added).toContain("craft");
    expect(later.names).toContain("craft");
  });

  it("matches each app's name and the apps they stand in for", () => {
    const [re] = LOCAL_NAMED_TOOLS[0];
    for (const q of ["PhotoCraft", "design craft", "filmcraft", "photoshop", "InDesign", "Premiere Pro"]) expect(re.test(q), q).toBe(true);
    for (const q of ["a photo of a shop", "the design of the craft", "the premise", "indigo design"]) expect(re.test(q), q).toBe(false);
  });

  it("adds nothing the gates withheld", async () => {
    const pool = ALL.filter((d) => d.function.name !== "craft");
    await planLocalRoster({ userId: "u", query: "hello", pool });
    const later = await planLocalRoster({ userId: "u", query: "open it in photocraft", pool });
    expect(later.names).not.toContain("craft");
  });

  it("find_tools points at the tool already in hand instead of adding others", async () => {
    const r = await findTools({ userId: "u", need: "add a gaussian blur to a picture in PhotoCraft", pool: ALL, offered: new Set(["craft", "find_tools"]) });
    expect(r.added).toEqual([]);
    expect(r.result).toMatchObject({ already_available: { name: "craft" } });
    expect(String((r.result as any).note)).toMatch(/craft, which you already have/);
  });
});
