// Live: the craft tool's own code → the app's /local/crafts proxy → the craft
// bridge → the real PhotoCraft, DesignCraft and FilmCraft engines. Needs the
// app up (scripts/local-up.sh) and the apps installed (install-crafts.sh).
//
//   LIVE_CRAFTS=1 npx vitest run src/test/localCraftLive.test.ts
//
// Library writes (storing exported pictures, adding books) need a signed-in
// browser session, so this stops at the workspace; craftApps.test.ts covers them.

import { beforeAll, describe, expect, it } from "vitest";
import { runCraftTool } from "@/lib/craftApps";

const APP = process.env.CC_APP_URL || "http://127.0.0.1:8080";
const deps = {
  books: [{ id: "b", title: "The Lighthouse", chapters: [{ id: "ch-storm", name: "The Storm", textContent: "The storm came in at dusk. ".repeat(400) }] }] as any,
};

describe.skipIf(process.env.LIVE_CRAFTS !== "1")("craft tool, live", () => {
  beforeAll(() => {
    // The browser resolves /local/crafts against the page; node needs the origin.
    const real = globalThis.fetch;
    // jsdom's AbortSignal isn't one Node's fetch accepts, so the timeout is dropped.
    globalThis.fetch = ((url: any, { signal: _s, ...init }: any = {}) => real(typeof url === "string" && url.startsWith("/") ? APP + url : url, {
      ...init, headers: { ...(init?.headers || {}), Origin: APP },
    })) as typeof fetch;
    if (typeof (AbortSignal as any).timeout !== "function") (AbortSignal as any).timeout = () => new AbortController().signal;
  });

  const call = async (args: any) => {
    const r = await runCraftTool(args, deps);
    expect(r.event.ok, `${JSON.stringify(args)} → ${JSON.stringify(r.result).slice(0, 300)}`).toBe(true);
    return r.result;
  };

  it("reports the three apps", async () => {
    const s = await call({ action: "status" });
    expect(Object.keys(s)).toEqual(["photocraft", "designcraft", "filmcraft"]);
  }, 30_000);

  it("finds and runs a command by its catalog id", async () => {
    await call({ action: "send", app: "photocraft", text: "Winter Fox" });
    const found = await call({ action: "find_commands", app: "photocraft", query: "gaussian blur" });
    const id = found.commands[0].id;
    expect(id).toMatch(/blur/i);
    expect(found.next).toContain(id);
    const ran = await call({ action: "run", app: "photocraft", steps: [{ id, params: { radius: 4 } }] });
    expect(ran.ok).toBe(true);
    const doc = await call({ action: "inspect", app: "photocraft" });
    expect(JSON.stringify(doc.document)).toMatch(/Winter Fox|layers/);
  }, 120_000);

  it("lays a whole chapter out across pages and exports a PDF", async () => {
    const sent = await call({ action: "send", app: "designcraft", chapter_id: "ch-storm" });
    expect(JSON.stringify(sent.result)).toMatch(/"overset":false/);
    const pdf = await call({ action: "export", app: "designcraft", format: "pdf", title: "The Storm" });
    expect(pdf.mime).toBe("application/pdf");
    expect(pdf.bytes).toBeGreaterThan(5_000);
  }, 180_000);

  it("moves PhotoCraft's work into FilmCraft and looks at the frame", async () => {
    const moved = await call({ action: "transfer", app: "photocraft", to: "filmcraft" });
    expect(moved.exported).toMatch(/\.png$/);
    const seen = await call({ action: "preview", app: "filmcraft", seconds: 1 });
    expect(String(seen.__vision)).toMatch(/^data:image\/png;base64,/);
  }, 180_000);

  it("reaches the apps' raw tools", async () => {
    const t = await call({ action: "app_tools", app: "designcraft" });
    expect(t.tools.map((x: any) => x.name)).toContain("place_image");
  }, 60_000);
});
