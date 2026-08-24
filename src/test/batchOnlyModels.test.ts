import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isBatchOnlyModel } from "@/lib/utils";

/**
 * ":batch" MODEL IDS MUST NEVER REACH A LIVE ENDPOINT.
 *
 * Live failure, 2026-08-24: the user picked `google/gemini-3.6-flash:batch`
 * in the model picker (it is the same model at ~half price, so it looks like
 * the better row) and every chat send died with OpenRouter's
 * `404: This model is only available through the Batch API` — reported as
 * "the speech-to-text button breaks sending", because dictation happened to
 * be how the message was composed. Nothing in this app speaks the batch
 * endpoint, so the id class is refused at the send choke point, skipped by
 * the background summarizer, and filtered from every live-role picker.
 *
 * The gate deliberately does NOT silently strip ":batch" and send anyway:
 * the un-suffixed sibling bills at full price, and swapping a user's model
 * for a differently-priced one invisibly is the exact class the
 * provider-visibility rule exists to prevent. The refusal NAMES the sibling.
 */

const src = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

describe("isBatchOnlyModel", () => {
  it("matches the id class, case-insensitively, only as a suffix", () => {
    expect(isBatchOnlyModel("google/gemini-3.6-flash:batch")).toBe(true);
    expect(isBatchOnlyModel("google/gemini-3.6-flash:BATCH")).toBe(true);
    expect(isBatchOnlyModel("google/gemini-3.6-flash")).toBe(false);
    // Other OpenRouter variant suffixes stay runnable.
    expect(isBatchOnlyModel("nvidia/nemotron-3-ultra-550b-a55b:free")).toBe(false);
    expect(isBatchOnlyModel("deepseek/deepseek-v4-flash:nitro")).toBe(false);
    // ":batch" mid-id is not the variant syntax.
    expect(isBatchOnlyModel("vendor/batch-model")).toBe(false);
    expect(isBatchOnlyModel("")).toBe(false);
  });
});

describe("the gates exist at both choke points", () => {
  const CTX = src("src/context/ChatContext.tsx");

  it("the send path refuses batch-only models beside the embedding gate, naming the runnable sibling", () => {
    expect(CTX).toContain("if (isBatchOnlyModel(model)) {");
    // The refusal must be ACTIONABLE: it names the same model without the
    // suffix rather than just declaring failure.
    expect(CTX).toContain('model.replace(/:batch$/i, "")');
  });

  it("the rolling summarizer skips batch-only models — it would otherwise 404 silently forever", () => {
    expect(CTX).toContain("if (!model || isEmbeddingModel(model) || isBatchOnlyModel(model)) return;");
  });

  it("the gate never rewrites the model on the wire — refusal, not silent substitution", () => {
    // A `model = model.replace(/:batch/...)` style rewrite would change the
    // user's pricing invisibly. The only replace() allowed is inside the
    // refusal MESSAGE string (a template literal), asserted above.
    const rewrites = [...CTX.matchAll(/model\s*=\s*[^;\n]*:batch/gi)];
    expect(rewrites).toEqual([]);
  });
});

describe("every live-role picker filters the class", () => {
  const SETTINGS = src("src/components/SettingsPanel.tsx");

  it("all six model dropdowns exclude batch-only ids", () => {
    // Five keep the currently-set value visible (so a select never silently
    // jumps off a mis-set value); the wiki dropdown has no such value risk.
    const filters = SETTINGS.match(/isBatchOnlyModel\(m\)/g) || [];
    expect(filters.length).toBeGreaterThanOrEqual(6);
  });

  it("saved-model chips explain WHY a batch id is greyed, in the tooltip", () => {
    expect(SETTINGS).toContain("Batch-pricing variant");
  });
});
