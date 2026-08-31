import { describe, it, expect, vi } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// Offline regression check: the gist-aware flip must not move the bytes the
// E2 rerun certified. No provider calls, no network.
vi.mock("@/integrations/supabase/client", () => {
  const die = () => { throw new Error("network reached the block check"); };
  return { supabase: { from: die, rpc: die, auth: { getSession: die } } };
});

const { buildBookContextBlock, bookContextCharBudget, bookHasCatalog } = await import("@/lib/chatBooks");
import type { BookDocument } from "@/types/library";

const DATA = resolve(process.cwd(), "e2-data");
const fixturesPath = resolve(DATA, "fixtures", "books.json");
// The run manifest records the block sizes that were actually measured, so
// this check calibrates against the certified run rather than a hardcoded
// number that a fixture re-export would break.
const metaPath = resolve(DATA, "meta.json");
const ready = existsSync(fixturesPath) && existsSync(metaPath);

describe.skipIf(!ready)("block bytes after the gist-aware flip", () => {
  const books: BookDocument[] = JSON.parse(readFileSync(fixturesPath, "utf8"));

  it("every fixture book has a catalog, so catalog mode stays PURE", () => {
    for (const b of books) expect(bookHasCatalog(b), b.title).toBe(true);
  });

  it("reproduces the measured block sizes exactly", () => {
    const full = buildBookContextBlock(books, { offeredTools: ["list_books", "get_book", "get_chapter_text", "search_book_text"], totalCharBudget: bookContextCharBudget("google/gemini-3.7-flash"), mode: "full" })!;
    const cat = buildBookContextBlock(books, { offeredTools: ["list_books", "get_book", "get_chapter_text", "search_book_text"], totalCharBudget: bookContextCharBudget("google/gemini-3.7-flash"), mode: "catalog" })!;
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    console.log(`[check] full=${full.message!.length} (measured ${meta.block_full.chars}) catalog=${cat.message!.length} (measured ${meta.block_catalog.chars})`);
    expect(full.message!.length).toBe(meta.block_full.chars);
    expect(cat.message!.length).toBe(meta.block_catalog.chars);
    expect(cat.used.every((u) => u.state === "catalog")).toBe(true);
  });

  it("a gist-stripped selection now rides full text instead of a bare map", () => {
    const stripped = books.map((b) => ({ ...b, chapters: b.chapters.map((c) => ({ ...c, gist: null })) }));
    const r = buildBookContextBlock(stripped as BookDocument[], { offeredTools: ["get_chapter_text"], totalCharBudget: bookContextCharBudget("google/gemini-3.7-flash"), mode: "catalog" })!;
    expect(r.used.some((u) => u.state === "catalog")).toBe(false);
    console.log(`[check] gistless-under-catalog states: ${r.used.map((u) => u.state).join(", ")}`);
  });
});
