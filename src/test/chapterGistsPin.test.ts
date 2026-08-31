import { describe, it, expect, vi } from "vitest";

/**
 * The gist generator's reasoning pin, driven end-to-end through a captured
 * adapter. Measured live (2026-08-31, google/gemini-3.7-flash on OpenRouter):
 * a thinking model spent ~600 completion tokens reasoning before its first
 * content byte, so the old 120n+100 budget finished at MAX_TOKENS with one
 * truncated `1|` line — every other chapter in the batch counted "failed",
 * and re-runs failed the same way forever. Two fixes ride together: the
 * OpenRouter reasoning-off pin (extraBody, now actually forwarded by
 * completeChat — see providers.test.ts) and a budget with room for models
 * that refuse to fully disable thinking. This file pins both at the
 * generateBookGists seam so a refactor can't silently drop either.
 */

const captured: any[] = [];
let completeChatReply = "";

vi.mock("@/integrations/supabase/client", () => {
  const chain: any = {
    select: () => chain,
    limit: async () => ({ data: [], error: null }),
    update: () => ({ eq: async () => ({ error: null }) }),
    in: async () => ({ data: [], error: null }),
    eq: async () => ({ error: null }),
  };
  return { supabase: { from: () => chain } };
});

vi.mock("@/lib/providers/registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/providers/registry")>()),
  resolveModel: (id: string) => ({
    provider: id.startsWith("nvidia:") ? "nvidia" : "openrouter",
    localId: id.replace(/^nvidia:/, ""),
    adapter: {
      id: id.startsWith("nvidia:") ? "nvidia" : "openrouter",
      completeChat: async (req: unknown) => {
        captured.push(req);
        return completeChatReply;
      },
      streamChat: () => {
        throw new Error("not used here");
      },
    },
  }),
  providerConfigured: () => true,
  providerKey: () => "test-key",
}));

const { generateBookGists } = await import("@/lib/chapterGists");

const book = (id: string, n: number): any => ({
  id,
  title: "Pinned Book",
  fileName: "pinned.pdf",
  pageCount: 10,
  chapters: Array.from({ length: n }, (_, i) => ({
    id: `${id}-c${i + 1}`,
    name: `Chapter ${i + 1}`,
    startPage: i + 1,
    endPage: i + 1,
    textContent: `Body of chapter ${i + 1}. `.repeat(40),
  })),
});

describe("generateBookGists thinking-model budget (live-measured 2026-08-31)", () => {
  it("openrouter runs carry the raised budget and NO reasoning field", async () => {
    captured.length = 0;
    completeChatReply = "1| First chapter gist that is long enough.\n2| Second chapter gist that is long enough.";
    const res = await generateBookGists(book("b-or", 2), {
      model: "google/gemini-3.7-flash",
      keys: { apiKey: "k" },
    });
    expect(Object.keys(res.written)).toHaveLength(2);
    expect(res.failed).toBe(0);
    expect(captured).toHaveLength(1);
    // No reasoning field: OpenRouter 400s `reasoning:{enabled:false}` on
    // mandatory-reasoning models (the user's default among them), and a pin
    // that breaks the default model is worse than the starvation it fixes.
    expect(captured[0].extraBody).toBeUndefined();
    // The fix: 320/chapter + 1200 headroom, sized so the measured ~600-token
    // reasoning burst can never starve the content lines again.
    expect(captured[0].maxTokens).toBe(320 * 2 + 1_200);
  });

  it("nvidia runs keep their own no-thinking body instead", async () => {
    captured.length = 0;
    completeChatReply = "1| First chapter gist that is long enough.";
    await generateBookGists(book("b-nv", 1), {
      model: "nvidia:nvidia/nemotron-3-super-120b-a12b",
      keys: { apiKey: "k", nvidiaKeyLast4: "1234" },
    });
    expect(captured).toHaveLength(1);
    // Exact shape belongs to nvidiaCatalog's own tests; here it only must
    // not have been replaced by the OpenRouter pin.
    expect(captured[0].extraBody).not.toEqual({ reasoning: { enabled: false } });
    expect(JSON.stringify(captured[0].extraBody ?? {})).toContain("chat_template_kwargs");
  });
});
