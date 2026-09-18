import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  resolveTurnPrompt,
  renderTurnPromptBlock,
  turnPromptStore,
  VOICE_BREVITY_SENTENCE,
  AUTO_SELECTION,
  type ResolvablePreset,
  type TurnPromptSelection,
  decideRoute,
  narrowPermissions,
  hasContextBindings,
  ROUTE_MIN_TURNS_BETWEEN_SWITCHES,
} from "@/lib/promptRouting";
import { computeCacheBreakpoints, MAX_CACHE_BREAKPOINTS } from "@/lib/cacheLayout";

/**
 * THE SWITCHER MAY NEVER NAME A PROMPT THAT IS NOT IN THE REQUEST.
 *
 * This is the prompt-layer twin of the tool-truth law in promptToolTruth.test.ts,
 * and it exists because of a specific, documented failure shape in persona
 * switchers: the UI reports a persona as active while the code applies it
 * somewhere else (or nowhere), and the user has no way to tell. A receipt that
 * can lie is worse than no receipt, so the centrepiece below is a PROPERTY over
 * a generated matrix rather than a handful of examples — it holds for
 * combinations nobody has thought to write down.
 */

const preset = (over: Partial<ResolvablePreset> = {}): ResolvablePreset => ({
  id: "p1",
  name: "Editor",
  body: "Cut every third adjective.",
  scope: "both",
  is_active: false,
  ...over,
});

describe("resolveTurnPrompt", () => {
  it("adds nothing when there is no prompt at all", () => {
    const r = resolveTurnPrompt({ presets: [], selection: AUTO_SELECTION, lane: "chat", inlinedBody: "" });
    expect(r.block).toBe("");
    expect(r.used).toEqual({ id: null, name: null, source: "none", why: "No prompt applied." });
  });

  it("reports the saved default without re-injecting it", () => {
    // The active preset is ALREADY at the top of the stable prompt. Adding it
    // again would be duplicate bytes and a second cache entry for no gain.
    const p = preset({ is_active: true });
    const r = resolveTurnPrompt({ presets: [p], selection: AUTO_SELECTION, lane: "chat", inlinedBody: p.body });
    expect(r.block).toBe("");
    expect(r.used.id).toBe("p1");
    expect(r.used.source).toBe("default");
  });

  it("says so when the default is scoped to the other lane", () => {
    const p = preset({ is_active: true, scope: "voice" });
    const r = resolveTurnPrompt({ presets: [p], selection: AUTO_SELECTION, lane: "chat", inlinedBody: "" });
    expect(r.block).toBe("");
    expect(r.used.id).toBeNull();
    expect(r.used.why).toContain("Voice only");
  });

  it("injects a pinned prompt that differs from the inlined one", () => {
    const r = resolveTurnPrompt({
      presets: [preset()],
      selection: { mode: "pinned", presetId: "p1" },
      lane: "chat",
      inlinedBody: "Something else entirely.",
    });
    expect(r.block).toContain("Cut every third adjective.");
    expect(r.block).toContain('## Active Instructions — "Editor"');
    expect(r.block).toContain("Where these conflict with the custom instructions above, follow these.");
    expect(r.used).toMatchObject({ id: "p1", name: "Editor", source: "manual" });
  });

  it("injects nothing when the pinned body is already inlined", () => {
    const p = preset();
    const r = resolveTurnPrompt({
      presets: [p],
      selection: { mode: "pinned", presetId: "p1" },
      lane: "chat",
      inlinedBody: `  ${p.body}  `,
    });
    expect(r.block).toBe("");
    // Still NAMED, because the body genuinely is in the request.
    expect(r.used.id).toBe("p1");
  });

  it("falls back to the default when the pinned prompt was deleted", () => {
    const p = preset({ id: "other", name: "Critic", is_active: true });
    const r = resolveTurnPrompt({
      presets: [p],
      selection: { mode: "pinned", presetId: "gone" },
      lane: "chat",
      inlinedBody: p.body,
    });
    expect(r.used.id).toBe(null);
    expect(r.used.why).toContain("no longer exists");
  });

  it("refuses a pinned prompt scoped to the other lane, and says why", () => {
    const r = resolveTurnPrompt({
      presets: [preset({ scope: "chat" })],
      selection: { mode: "pinned", presetId: "p1" },
      lane: "voice",
      inlinedBody: "",
    });
    expect(r.block).toBe("");
    expect(r.used.id).toBeNull();
    expect(r.used.why).toContain("Chat only");
  });

  it("injects nothing for a prompt with an empty body", () => {
    const r = resolveTurnPrompt({
      presets: [preset({ body: "   " })],
      selection: { mode: "pinned", presetId: "p1" },
      lane: "chat",
      inlinedBody: "",
    });
    expect(r.block).toBe("");
    expect(r.used.why).toContain("no instructions");
  });

  it("Plain applies nothing, and admits when a saved prompt is still inlined", () => {
    const r = resolveTurnPrompt({
      presets: [preset({ is_active: true })],
      selection: { mode: "plain" },
      lane: "chat",
      inlinedBody: "Cut every third adjective.",
    });
    expect(r.block).toBe("");
    expect(r.used.id).toBeNull();
    // The honest case: Plain cannot remove what Settings put in the stable
    // prompt, so it must not pretend otherwise.
    expect(r.used.why).toContain("still applied from Settings");
  });

  it("restates voice brevity after an override, so a chatty prompt can't talk over it", () => {
    const r = resolveTurnPrompt({
      presets: [preset({ scope: "both" })],
      selection: { mode: "pinned", presetId: "p1" },
      lane: "voice",
      inlinedBody: "different",
    });
    expect(r.block).toContain(VOICE_BREVITY_SENTENCE);
    expect(r.block.indexOf(VOICE_BREVITY_SENTENCE)).toBeGreaterThan(r.block.indexOf("Cut every third"));
  });

  it("does NOT restate voice brevity on a typed turn", () => {
    const r = resolveTurnPrompt({
      presets: [preset()],
      selection: { mode: "pinned", presetId: "p1" },
      lane: "chat",
      inlinedBody: "different",
    });
    expect(r.block).not.toContain(VOICE_BREVITY_SENTENCE);
  });
});

describe("property: the receipt never names a prompt that is not in the request", () => {
  const BODIES = ["", "Cut every third adjective.", "Be blunt."];
  const SCOPES = ["both", "chat", "voice"] as const;
  const LANES = ["chat", "voice"] as const;
  const SELECTIONS: TurnPromptSelection[] = [
    { mode: "auto" },
    { mode: "plain" },
    { mode: "pinned", presetId: "p1" },
    { mode: "pinned", presetId: "missing" },
  ];

  it("holds across every combination of body, scope, lane, selection and default", () => {
    let checked = 0;
    for (const body of BODIES) {
      for (const scope of SCOPES) {
        for (const lane of LANES) {
          for (const sel of SELECTIONS) {
            for (const isActive of [true, false]) {
              for (const inlinedBody of ["", body, "unrelated text"]) {
                const p = preset({ body, scope, is_active: isActive });
                const r = resolveTurnPrompt({ presets: [p], selection: sel, lane, inlinedBody });
                checked++;

                // THE PROPERTY: if the receipt names a prompt, that prompt's
                // own words are genuinely somewhere in the request — either in
                // the block we just built, or already inlined in the stable
                // prompt by the caller.
                if (r.used.id !== null) {
                  const inBlock = r.block.includes(p.body.trim()) && p.body.trim() !== "";
                  const inStable = inlinedBody.trim() === p.body.trim() && p.body.trim() !== "";
                  expect(
                    inBlock || inStable,
                    `named "${r.used.name}" but its text is in neither the block nor the stable prompt ` +
                      `(body=${JSON.stringify(body)} scope=${scope} lane=${lane} sel=${sel.mode} inlined=${JSON.stringify(inlinedBody)})`,
                  ).toBe(true);
                }

                // The converse: a block is never built without naming who wrote it.
                if (r.block !== "") {
                  expect(r.used.id, "built a block but named no prompt").not.toBeNull();
                  expect(r.block).toContain(p.name);
                }

                // A receipt always explains itself in words.
                expect(r.used.why.length).toBeGreaterThan(0);
              }
            }
          }
        }
      }
    }
    expect(checked).toBe(3 * 3 * 2 * 4 * 2 * 3);
  });
});

describe("renderTurnPromptBlock", () => {
  it("survives a nameless prompt without producing an empty heading", () => {
    const block = renderTurnPromptBlock({ name: "   ", body: "Do the thing.", lane: "chat" });
    expect(block).toContain('## Active Instructions — "Untitled"');
  });
});

describe("turnPromptStore", () => {
  beforeEach(() => {
    turnPromptStore._reset();
    try { sessionStorage.clear(); } catch { /* jsdom without storage */ }
  });

  it("defaults to auto and round-trips a pin for one user", () => {
    turnPromptStore.init("u1");
    expect(turnPromptStore.get()).toEqual({ mode: "auto" });
    turnPromptStore.set({ mode: "pinned", presetId: "p1" });
    turnPromptStore.init(null);
    turnPromptStore.init("u1");
    expect(turnPromptStore.get()).toEqual({ mode: "pinned", presetId: "p1" });
  });

  it("does not carry one user's pin to another", () => {
    turnPromptStore.init("u1");
    turnPromptStore.set({ mode: "plain" });
    turnPromptStore.init("u2");
    expect(turnPromptStore.get()).toEqual({ mode: "auto" });
  });

  it("falls back to auto on junk rather than inventing a mode", () => {
    try {
      sessionStorage.setItem("counsel_prompt_override_u3", JSON.stringify({ mode: "chaos" }));
    } catch { return; }
    turnPromptStore.init("u3");
    expect(turnPromptStore.get()).toEqual({ mode: "auto" });
  });

  it("notifies subscribers", () => {
    turnPromptStore.init("u1");
    let hits = 0;
    const off = turnPromptStore.subscribe(() => { hits++; });
    turnPromptStore.set({ mode: "plain" });
    expect(hits).toBe(1);
    off();
    turnPromptStore.set({ mode: "auto" });
    expect(hits).toBe(1);
  });
});

describe("cache layout", () => {
  /** The expression ChatContext used before the switchable layer existed.
   *  Kept here so "did default behaviour move?" is a test, not a memory. */
  const legacy = (book: boolean, focus: boolean, summary: boolean, latestUserIndex: number, tailChars: number, total: number) => {
    const len = (book ? 1 : 0) + 1 + (focus ? 1 : 0) + (summary ? 1 : 0);
    return [
      { index: len - 1 - (summary ? 1 : 0) },
      ...(summary ? [{ index: len - 1 }] : []),
      { index: latestUserIndex, tailChars },
      ...(total - 1 > latestUserIndex ? [{ index: total - 1 }] : []),
    ];
  };

  const layoutFor = (book: boolean, focus: boolean, summary: boolean, turnPrompt: boolean, toolRounds: number) => {
    const len = (book ? 1 : 0) + 1 + (focus ? 1 : 0) + (summary ? 1 : 0) + (turnPrompt ? 1 : 0);
    const historyLen = 3; // any non-empty history; the latest user message is last
    const latestUserIndex = len + historyLen - 1;
    return {
      stableSystemEnd: (book ? 1 : 0) + (focus ? 1 : 0),
      leadingSystemEnd: len - 1,
      latestUserIndex,
      tailChars: 120,
      totalMessages: latestUserIndex + 1 + toolRounds,
    };
  };

  const FLAGS = [false, true];

  it("never exceeds the four markers the adapter will actually honour", () => {
    for (const book of FLAGS) for (const focus of FLAGS) for (const summary of FLAGS) for (const turnPrompt of FLAGS) {
      for (const toolRounds of [0, 1, 4]) {
        const bps = computeCacheBreakpoints(layoutFor(book, focus, summary, turnPrompt, toolRounds));
        expect(bps.length, `book=${book} focus=${focus} summary=${summary} prompt=${turnPrompt} rounds=${toolRounds}`)
          .toBeLessThanOrEqual(MAX_CACHE_BREAKPOINTS);
      }
    }
  });

  it("reproduces the legacy layout exactly when no prompt layer is present", () => {
    for (const book of FLAGS) for (const focus of FLAGS) for (const summary of FLAGS) {
      for (const toolRounds of [0, 2]) {
        const l = layoutFor(book, focus, summary, false, toolRounds);
        expect(computeCacheBreakpoints(l), `book=${book} focus=${focus} summary=${summary}`)
          .toEqual(legacy(book, focus, summary, l.latestUserIndex, l.tailChars, l.totalMessages));
      }
    }
  });

  it("keeps the stable head marked when the prompt layer is added", () => {
    // The whole point: adding the switchable layer must not move the marker
    // that protects the ~23K instruction prompt.
    for (const book of FLAGS) for (const focus of FLAGS) for (const summary of FLAGS) {
      const without = computeCacheBreakpoints(layoutFor(book, focus, summary, false, 0));
      const withIt = computeCacheBreakpoints(layoutFor(book, focus, summary, true, 0));
      expect(withIt[0]).toEqual(without[0]);
    }
  });

  it("marks the end of the system block whenever a churning tail exists", () => {
    const bps = computeCacheBreakpoints(layoutFor(true, true, false, true, 0));
    // book(0) prompt(1) focus(2) turnPrompt(3) → stable head ends at 2.
    expect(bps[0]).toEqual({ index: 2 });
    expect(bps[1]).toEqual({ index: 3 });
  });
});

describe("the voice sentence cannot drift from the builder", () => {
  it("is still present verbatim in buildChatSystemPrompt", () => {
    // promptRouting re-states brevity AFTER an override, because the override
    // now rides later than the builder's own voice sentence. Two copies of a
    // string is a drift hazard, so this pins them together.
    const src = readFileSync(resolve(__dirname, "../lib/buildChatSystemPrompt.ts"), "utf8");
    expect(src).toContain(VOICE_BREVITY_SENTENCE);
  });
});

describe("decideRoute", () => {
  const cand = (id: string, similarity: number, name = id) => ({ id, name, similarity });
  const base = {
    candidates: [] as Array<{ id: string; name: string; similarity: number }>,
    activeId: null as string | null,
    activeSimilarity: null as number | null,
    topMemoryScore: null as number | null,
    plainOnRecall: true,
    turnsSinceSwitch: 99,
  };

  it("does nothing when no prompt has routing enabled", () => {
    expect(decideRoute(base).action).toBe("keep");
  });

  it("switches when the winner is confident and clearly ahead of both rivals", () => {
    const d = decideRoute({
      ...base,
      candidates: [cand("critic", 0.91, "Critic"), cand("editor", 0.6)],
      activeId: "editor",
      activeSimilarity: 0.6,
    });
    expect(d.action).toBe("switch");
    expect(d.promptId).toBe("critic");
    expect(d.why).toContain("Critic");
  });

  it("refuses to switch on a thin margin over the prompt already on", () => {
    const d = decideRoute({
      ...base,
      candidates: [cand("critic", 0.82), cand("other", 0.1)],
      activeId: "editor",
      activeSimilarity: 0.79, // 0.03 behind — inside ROUTE_MARGIN
    });
    expect(d.action).toBe("keep");
  });

  it("refuses to switch when two prompts fit about equally", () => {
    const d = decideRoute({
      ...base,
      candidates: [cand("a", 0.9, "A"), cand("b", 0.87, "B")],
      activeId: null,
      activeSimilarity: 0,
    });
    // Without this, two near-identical prompts trade the conversation on noise.
    expect(d.action).toBe("keep");
    expect(d.why).toContain("equally");
  });

  it("keeps a confident incumbent even when something scores higher", () => {
    const d = decideRoute({
      ...base,
      candidates: [cand("critic", 0.95), cand("x", 0.1)],
      activeId: "editor",
      activeSimilarity: 0.8, // already above ROUTE_CONFIDENT
    });
    expect(d.action).toBe("keep");
  });

  it("will not switch twice in quick succession", () => {
    const input = {
      ...base,
      candidates: [cand("critic", 0.95), cand("x", 0.1)],
      activeId: "editor",
      activeSimilarity: 0.2,
      turnsSinceSwitch: 1,
    };
    expect(decideRoute(input).action).toBe("keep");
    expect(decideRoute({ ...input, turnsSinceSwitch: ROUTE_MIN_TURNS_BETWEEN_SWITCHES }).action).toBe("switch");
  });

  it("stands down on a recall-dominated turn, and says why (PRISM)", () => {
    const input = {
      ...base,
      candidates: [cand("critic", 0.95), cand("x", 0.1)],
      activeId: "editor",
      activeSimilarity: 0.2,
      topMemoryScore: 0.85,
    };
    const guarded = decideRoute(input);
    expect(guarded.action).toBe("keep");
    expect(guarded.why).toContain("recall");
    // ...and the guard is a setting, not a law.
    expect(decideRoute({ ...input, plainOnRecall: false }).action).toBe("switch");
  });

  it("parks the turn as evidence when nothing fits at all", () => {
    const d = decideRoute({ ...base, candidates: [cand("critic", 0.3)] });
    expect(d.action).toBe("propose_new");
    expect(d.promptId).toBeNull();
  });

  it("never switches to the prompt that is already in force", () => {
    const d = decideRoute({
      ...base,
      candidates: [cand("editor", 0.99)],
      activeId: "editor",
      activeSimilarity: 0.99,
    });
    expect(d.action).toBe("keep");
  });

  it("always reports the scores it decided on", () => {
    const d = decideRoute({
      ...base,
      candidates: [cand("a", 0.9), cand("b", 0.4)],
      activeSimilarity: 0.5,
    });
    expect(d.scores).toEqual({ s_max: 0.9, s_active: 0.5, s_2nd: 0.4, novelty: 1 - 0.9 });
  });

  it("is biased toward keeping: a random matrix switches only rarely", () => {
    // Guards against a future edit that quietly makes the router eager. This
    // is a behavioural budget, not a proof — but an edit that doubles the
    // switch rate will trip it.
    let switches = 0, total = 0;
    for (let a = 0; a <= 10; a++) {
      for (let m = 0; m <= 10; m++) {
        for (let s = 0; s <= 10; s += 2) {
          total++;
          const d = decideRoute({
            ...base,
            candidates: [cand("w", m / 10, "W"), cand("r", s / 10, "R")],
            activeId: "cur",
            activeSimilarity: a / 10,
          });
          if (d.action === "switch") switches++;
        }
      }
    }
    expect(switches / total).toBeLessThan(0.25);
    expect(switches).toBeGreaterThan(0); // and it does still fire
  });
});

describe("narrowPermissions: a prompt may take tools away, never grant them", () => {
  it("turns off what the binding marks false", () => {
    expect(narrowPermissions({ a: true, b: true }, { a: false }))
      .toEqual({ a: false, b: true });
  });

  it("leaves a user's OFF permission off even when the binding says true", () => {
    // The whole safety property. A preset row is ordinary user data; if a
    // `true` here could re-enable a tool, writing one would be a way around
    // every consent gate in the app.
    expect(narrowPermissions({ danger: false }, { danger: true }))
      .toEqual({ danger: false });
  });

  it("leaves a user's ON permission on when the binding says true", () => {
    expect(narrowPermissions({ x: true }, { x: true })).toEqual({ x: true });
  });

  it("is a no-op for a prompt with no tool binding", () => {
    const perms = { a: true, b: false };
    expect(narrowPermissions(perms, null)).toBe(perms);
    expect(narrowPermissions(perms, undefined)).toBe(perms);
  });

  it("never mutates the caller's map", () => {
    const perms = { a: true };
    narrowPermissions(perms, { a: false });
    expect(perms).toEqual({ a: true });
  });

  it("property: the result is never more permissive than the user's own map", () => {
    const VALUES = [true, false, undefined] as const;
    for (const userVal of VALUES) {
      for (const bindVal of VALUES) {
        const user: Record<string, boolean> = userVal === undefined ? {} : { t: userVal };
        const bind: Record<string, boolean> | null = bindVal === undefined ? null : { t: bindVal };
        const out = narrowPermissions(user, bind);
        // "allowed" is: not explicitly false (the app's documented default).
        const allowedBefore = user.t !== false;
        const allowedAfter = out.t !== false;
        expect(
          !allowedAfter || allowedBefore,
          `binding turned t ON: user=${String(userVal)} bind=${String(bindVal)}`,
        ).toBe(true);
      }
    }
  });
});

describe("bindings travel with the resolved prompt", () => {
  const bound = (over: Partial<ResolvablePreset> = {}): ResolvablePreset => ({
    ...preset(),
    neuron_ids: ["n1"],
    book_id: "b1",
    tool_permissions: { generate_image: false },
    ...over,
  });

  it("carries them when the prompt applies", () => {
    const r = resolveTurnPrompt({
      presets: [bound()],
      selection: { mode: "pinned", presetId: "p1" },
      lane: "chat",
      inlinedBody: "different",
    });
    expect(r.bindings).toEqual({ neuronIds: ["n1"], bookId: "b1", toolPermissions: { generate_image: false } });
  });

  it("carries them for the saved default too", () => {
    const p = bound({ is_active: true });
    const r = resolveTurnPrompt({ presets: [p], selection: AUTO_SELECTION, lane: "chat", inlinedBody: p.body });
    expect(r.bindings?.neuronIds).toEqual(["n1"]);
  });

  it("brings NOTHING when the prompt did not apply", () => {
    // Scope mismatch: the prompt is not in this request, so its tools must not
    // be narrowed and its neurons must not be claimed.
    const r = resolveTurnPrompt({
      presets: [bound({ scope: "voice" })],
      selection: { mode: "pinned", presetId: "p1" },
      lane: "chat",
      inlinedBody: "",
    });
    expect(r.used.id).toBeNull();
    expect(r.bindings).toBeNull();
  });

  it("brings nothing when Plain is chosen", () => {
    const r = resolveTurnPrompt({
      presets: [bound({ is_active: true })],
      selection: { mode: "plain" },
      lane: "chat",
      inlinedBody: "",
    });
    expect(r.bindings).toBeNull();
  });

  it("property: bindings are non-null exactly when a prompt is named", () => {
    const SELECTIONS: TurnPromptSelection[] = [
      { mode: "auto" }, { mode: "plain" },
      { mode: "pinned", presetId: "p1" }, { mode: "pinned", presetId: "gone" },
    ];
    for (const scope of ["both", "chat", "voice"] as const) {
      for (const lane of ["chat", "voice"] as const) {
        for (const sel of SELECTIONS) {
          for (const isActive of [true, false]) {
            const p = bound({ scope, is_active: isActive });
            const r = resolveTurnPrompt({ presets: [p], selection: sel, lane, inlinedBody: p.body });
            expect(
              (r.bindings !== null) === (r.used.id !== null),
              `bindings/name disagree: scope=${scope} lane=${lane} sel=${sel.mode} active=${isActive}`,
            ).toBe(true);
          }
        }
      }
    }
  });

  it("hasContextBindings only counts context, not tool narrowing", () => {
    // Tool narrowing is per-turn and needs no switch; neurons and a book are
    // what a switch actually LOADS, and what the router must not touch.
    expect(hasContextBindings(bound())).toBe(true);
    expect(hasContextBindings(bound({ neuron_ids: [], book_id: null }))).toBe(false);
    expect(hasContextBindings(preset())).toBe(false);
  });
});
