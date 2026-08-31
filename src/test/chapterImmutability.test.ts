import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * CHAPTER TEXT IS IMMUTABLE PER CHAPTER ID — the load-bearing invariant of
 * the Card Catalog (docs/stage2-card-pointers.md §1).
 *
 * Every locator stored on a knowledge entry is {chapter_id, char_start,
 * char_end} into chapters.text_content. Isolation always INSERTs a new
 * chapter id; rename touches only the name; gists are derived metadata. The
 * moment any code path starts UPDATE-ing text_content under an existing id,
 * every locator in the user's wiki silently rots — read_span would serve
 * wrong spans while claiming provenance. That failure is invisible at the
 * site that causes it, which is why it gets a source lint here rather than a
 * code-review convention.
 *
 * Mechanics: for every `.from("chapters")` site in src (tests excluded), any
 * `.update(` chained within the following window must not carry
 * `text_content` in its payload. INSERTs are exempt by construction — ingest
 * and isolation create NEW ids, which is exactly the invariant.
 */

const SRC = join(__dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === "test" || name === "__tests__" || name === "harness" || name === "node_modules") continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\./.test(name)) {
      out.push(p);
    }
  }
  return out;
}

interface UpdateSite {
  file: string;
  index: number;
  payloadWindow: string;
}

function chapterUpdateSites(): UpdateSite[] {
  const sites: UpdateSite[] = [];
  for (const file of walk(SRC)) {
    const text = readFileSync(file, "utf8");
    let at = 0;
    for (;;) {
      const hit = text.indexOf('from("chapters")', at);
      if (hit === -1) break;
      at = hit + 1;
      // The chain window: far past any realistic builder chain, small enough
      // that an unrelated later statement's update doesn't false-positive.
      const window = text.slice(hit, hit + 400);
      const up = window.indexOf(".update(");
      if (up !== -1) {
        sites.push({ file, index: hit, payloadWindow: window.slice(up, up + 300) });
      }
    }
  }
  return sites;
}

describe("chapter text immutability (locator substrate)", () => {
  const sites = chapterUpdateSites();

  it("the lint is looking at real code — the known metadata updaters exist", () => {
    // rename_chapter (name) and the gist writer are the two legitimate
    // UPDATE paths today. If this assertion fails, the grep pattern rotted
    // and the whole lint is blind — fix the pattern, don't delete the pin.
    const payloads = sites.map((s) => s.payloadWindow).join("\n");
    expect(payloads).toContain("name");
    expect(payloads).toContain("gist");
  });

  it("no code path UPDATEs chapters.text_content under an existing id", () => {
    const offenders = sites.filter((s) => s.payloadWindow.includes("text_content"));
    expect(
      offenders.map((o) => `${o.file} @${o.index}: ${o.payloadWindow.slice(0, 120)}`),
      "chapters.text_content must never be updated in place — chapter text is immutable per id; " +
      "every stored locator depends on it (docs/stage2-card-pointers.md §1). Insert a NEW chapter instead.",
    ).toEqual([]);
  });
});
