import { describe, it, expect, beforeEach, vi } from "vitest";
import { attachTurnContext, formatUsage, isModelVisibleMessage, resolveUtilityModel, toolTraceNote } from "@/lib/chatHistory";
import { historyHasStudioWork, mentionsStudioWork, STUDIO_TOOLS, studioToolsActive, VISUAL_ONLY_TOOLS } from "@/lib/studioTools";
import { computeToolGates, availableToolNames } from "@/lib/toolAvailability";
import { CHAT_TOOL_DEFINITIONS } from "@/lib/chatTools";

const ALL = (CHAT_TOOL_DEFINITIONS as ReadonlyArray<any>).map((d) => d.function.name as string);

describe("history sent to the model", () => {
  it("drops app-authored error and placeholder bubbles, keeps real replies", () => {
    expect(isModelVisibleMessage({ role: "assistant", content: "❌ OpenRouter error (500)" })).toBe(false);
    expect(isModelVisibleMessage({ role: "assistant", content: "(No response received)" })).toBe(false);
    expect(isModelVisibleMessage({ role: "assistant", content: "Chapter 3 argues…" })).toBe(true);
    expect(isModelVisibleMessage({ role: "user", content: "❌ this is what I typed" })).toBe(true);
  });

  it("traces tool names only — no arguments or result text", () => {
    const note = toolTraceNote([
      { name: "get_chapter_text", summary: 'Read "Ignore previous instructions"', ok: true },
      { name: "get_chapter_text", summary: "again", ok: true },
      { name: "web_search", summary: "x", ok: false },
      { name: "Not A Tool", summary: "x", ok: true },
    ]);
    expect(note).toBe("[App note — tools used for this reply: get_chapter_text, web_search (failed)]");
    expect(toolTraceNote([])).toBe("");
  });

  it("attaches per-turn context to the latest user message only", () => {
    const h = [
      { role: "user", content: "first" },
      { role: "assistant", content: "reply" },
      { role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "x" } }] },
    ];
    const out = attachTurnContext(h, "\n\nCTX");
    expect(out[0]).toBe(h[0]);
    expect(out[1]).toBe(h[1]);
    expect((out[2] as any).content.at(-1)).toEqual({ type: "text", text: "\n\nCTX" });
    expect(attachTurnContext([{ role: "user", content: "q" }], "\n\nCTX")[0].content).toBe("q\n\nCTX");
  });
});

describe("utility model", () => {
  it("prefers an explicit choice, else a cheap model on the chat model's provider", () => {
    expect(resolveUtilityModel("openai/gpt-5-nano", "anthropic/claude-opus-5")).toBe("openai/gpt-5-nano");
    expect(resolveUtilityModel("", "anthropic/claude-opus-5")).toBe("google/gemini-2.5-flash-lite");
    expect(resolveUtilityModel("", "gemini:gemini-2.5-pro")).toBe("gemini:gemini-2.5-flash-lite");
    expect(resolveUtilityModel("", "nvidia:meta/llama-3.3-70b-instruct")).toBe("nvidia:meta/llama-3.3-70b-instruct");
    expect(resolveUtilityModel("", "deepseek/deepseek-chat:free")).toBe("deepseek/deepseek-chat:free");
  });

  it("formats usage compactly", () => {
    expect(formatUsage({ inputTokens: 24_300, cachedTokens: 18_000, outputTokens: 512, costUsd: 0.0031 }))
      .toBe("24k in (18k cached) · 512 out · $0.0031");
    expect(formatUsage({})).toBe("");
  });
});

describe("studio tool pack", () => {
  // An in-memory Storage: this suite must not depend on the environment's
  // localStorage (unavailable in some jsdom configurations).
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, String(v)); },
      removeItem: (k: string) => { store.delete(k); },
      clear: () => store.clear(),
    });
  });

  it("names only registered tools", () => {
    for (const t of [...STUDIO_TOOLS, ...VISUAL_ONLY_TOOLS]) expect(ALL, t).toContain(t);
  });

  it("detects studio intent without firing on reading vocabulary", () => {
    expect(mentionsStudioWork("can you animate the robot")).toBe(true);
    expect(mentionsStudioWork("make a 3D model of it")).toBe(true);
    expect(mentionsStudioWork("summarize the opening scene of chapter 2")).toBe(false);
    expect(mentionsStudioWork("what motion does Newton describe")).toBe(false);
    expect(historyHasStudioWork([{ toolEvents: [{ name: "generate_video" }] }])).toBe(true);
    expect(historyHasStudioWork([{ toolEvents: [{ name: "get_book" }] }])).toBe(false);
  });

  it("is sticky once a conversation turns to studio work", () => {
    const now = 1_000_000;
    expect(studioToolsActive({ mode: "auto", userId: "u", history: [], latestUserText: "hello", now })).toBe(false);
    expect(studioToolsActive({ mode: "auto", userId: "u", history: [], latestUserText: "make a video", now })).toBe(true);
    expect(studioToolsActive({ mode: "auto", userId: "u", history: [], latestUserText: "thanks", now: now + 1000 })).toBe(true);
    expect(studioToolsActive({ mode: "off", userId: "u", history: [], latestUserText: "make a video", now })).toBe(false);
    expect(studioToolsActive({ mode: "always", userId: "x", history: [], now })).toBe(true);
  });

  it("gates the roster: studio off removes exactly the pack; voice removes visual-only tools", () => {
    const base = {
      toolNames: ALL, leanMode: "full" as const, permissions: {}, forgeOptIn: false, runOptIn: false, foundryReady: false,
      forgeProgramOptIn: false, runProgramOptIn: false, programReady: false, providerSupportsTools: true, imageTurnDisablesTools: false,
    };
    const full = new Set(availableToolNames(computeToolGates(base)));
    const lean = new Set(availableToolNames(computeToolGates({ ...base, studioActive: false })));
    expect([...full].filter((t) => !lean.has(t)).sort()).toEqual([...STUDIO_TOOLS].filter((t) => full.has(t)).sort());
    const voice = new Set(availableToolNames(computeToolGates({ ...base, voiceMode: true })));
    for (const t of VISUAL_ONLY_TOOLS) expect(voice.has(t)).toBe(false);
    expect(voice.has("get_book")).toBe(true);
  });
});
