import { describe, it, expect } from "vitest";
import { CHAT_TOOL_DEFINITIONS } from "@/lib/chatTools";
import { FOUNDRY_TOOL_NAMES } from "@/lib/foundryTools";
import { TOOL_PERMISSION } from "@/lib/toolPermissions";
import { LEAN_MODES, blockedTools } from "@/lib/leanMode";
import { isFoundryTool } from "@/lib/toolAvailability";

/**
 * A TOOL DESCRIPTION MAY ONLY NAME A TOOL THAT CANNOT BE WITHHELD.
 *
 * THE INVARIANT, AND WHY THIS LAYER NEEDS ITS OWN TEST.
 * Nothing that reaches model context may name a tool this turn's request does
 * not carry. src/test/promptToolTruth.test.ts pins that for the system prompt,
 * and it worked: the prompt layer stopped recurring the moment it got a
 * property test. The DESCRIPTION layer had nothing, and three review rounds
 * each found more sites of the same class.
 *
 * Descriptions are the hardest case because they cannot be gated at all.
 * CHAT_TOOL_DEFINITIONS is a frozen module-level array; the roster is filtered
 * per turn by REMOVING whole entries, so a description ships verbatim whenever
 * its own tool ships. There is no `has()` predicate to thread through it. The
 * only available rule is therefore a static one:
 *
 *   a description may name a tool ONLY IF no switch in the app can withhold
 *   that tool while the describing tool survives.
 *
 * "Ungoverned" is derived at runtime from the three real gates — never from a
 * hand-copied list — so a tool that GAINS a permission next month fails this
 * test on the day the permission is added, in the same commit, rather than on
 * the day a user reports the assistant lying about it:
 *
 *   1. TOOL_PERMISSION (toolPermissions.ts)  — any entry at all means a user
 *      switch exists that can pull it. Default-allow does not help: the whole
 *      point is the minority of users who switched it off.
 *   2. blockedTools(mode) over every LEAN_MODES tier (leanMode.ts) — a budget
 *      tier removes the paid generators from the roster outright.
 *   3. isFoundryTool (toolAvailability.ts) — the Foundry's two opt-ins are
 *      INVERTED (off by default), so a Foundry verb is absent for most users.
 *
 * WHAT THIS DOES NOT COVER, stated plainly so nobody reads it as more than it
 * is. It checks the STATIC text of the definitions only. Dynamic tool RESULTS
 * are a separate door with a separate pin (toolResultToolTruth.test.ts), and
 * the system prompt has its own (promptToolTruth.test.ts). The extractor below
 * is also deliberately literal: it finds registered tool names as whole words.
 * A description that describes a withheld capability WITHOUT naming its verb
 * ("ask the user to generate a video first") passes here and is fine by the
 * invariant — the failure mode being prevented is specifically a NAME the
 * model can try to emit.
 *
 * The SECONDARY property — the phantom-verb check for a snake_case token that
 * is in no definition at all — is narrower than the primary one and its limit
 * is easy to miss: it keys on VERB_LIKE, a CLOSED, HAND-MAINTAINED prefix list.
 * `render_gallery` is caught because `render_` is on it; `polish_render` is not,
 * and neither are `compose_`, `publish_`, `refine_`, `convert_`, `summarize_`
 * and every other prefix nobody has added yet. So read that block as "catches
 * the common shapes", never as "no phantom verb can ship". The PRIMARY property
 * is unaffected — it keys on NAME_SET, the real registry, so a governed tool
 * named in a description fails regardless of how the name is spelled.
 *
 * THE MIRROR MATTERS TOO. Over-filtering — refusing to name an ungoverned tool
 * — suppresses legitimate tool use, which is the same harm in the other
 * direction. That is why the rule is "ungoverned names are FINE" and not
 * "descriptions may name nothing", and why the last block below asserts the
 * corpus really does still cross-reference ungoverned tools.
 */

type Def = { function: { name: string; description?: string; parameters?: unknown } };
const DEFS = CHAT_TOOL_DEFINITIONS as unknown as ReadonlyArray<Def>;

const ALL_NAMES: string[] = DEFS.map((d) => d.function.name);
const NAME_SET = new Set(ALL_NAMES);

/** Every tool some switch in this app can remove from the roster while other
 *  tools survive, with the reason — which is what the failure message needs. */
const GOVERNED: Map<string, string> = (() => {
  const m = new Map<string, string>();
  const add = (tool: string, why: string) => {
    const prev = m.get(tool);
    m.set(tool, prev ? `${prev}; ${why}` : why);
  };
  for (const [tool, permId] of Object.entries(TOOL_PERMISSION)) {
    add(tool, `TOOL_PERMISSION["${tool}"] = "${permId}" — a user switch can turn it off`);
  }
  for (const mode of LEAN_MODES) {
    for (const tool of blockedTools(mode)) {
      add(tool, `Lean Mode tier "${mode}" removes it from the roster`);
    }
  }
  for (const tool of ALL_NAMES) {
    if (isFoundryTool(tool)) add(tool, "a Tool Foundry verb — opt-in is INVERTED and off by default");
  }
  // FOUNDRY_TOOL_NAMES is read as well, so a Foundry verb that is somehow not
  // yet in isFoundryTool's set still counts as governed rather than slipping
  // through the gap between the two modules.
  for (const tool of FOUNDRY_TOOL_NAMES) {
    if (!m.has(tool)) add(tool, "a Tool Foundry verb (FOUNDRY_TOOL_NAMES) — opt-in is INVERTED and off by default");
  }
  return m;
})();

/** Every string in a definition that ships to the model: the tool description
 *  and every nested parameter description, at any depth, plus enum values
 *  (an enum reaches the model verbatim too). Keyed by a path so a failure says
 *  WHERE. */
function modelVisibleStrings(node: unknown, path: string, out: Array<[string, string]>): void {
  if (typeof node === "string") {
    out.push([path, node]);
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => modelVisibleStrings(v, `${path}[${i}]`, out));
    return;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      // Keys like `type`, `required` and property NAMES are schema vocabulary,
      // not prose — but a property literally named after a tool would be a
      // false positive we do not want, so only the value strings are walked and
      // the keys are used for the path.
      modelVisibleStrings(v, `${path}.${k}`, out);
    }
  }
}

function stringsOf(def: Def): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  if (def.function.description) out.push(["description", def.function.description]);
  if (def.function.parameters) modelVisibleStrings(def.function.parameters, "parameters", out);
  return out;
}

/** Whole-word snake_case tokens that are registered tool names. Backticks,
 *  quotes and parentheses are all just word boundaries, so `generate_image`,
 *  "generate_image" and generate_image are one case, not three. */
const SNAKE = /[a-z][a-z0-9]*(?:_[a-z0-9]+)+/g;
function toolNamesIn(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(SNAKE)) if (NAME_SET.has(m[0])) found.push(m[0]);
  return found;
}

describe("property: no tool description names a tool that can be withheld", () => {
  for (const def of DEFS) {
    const self = def.function.name;
    it(`${self}`, () => {
      const offences: string[] = [];
      for (const [where, text] of stringsOf(def)) {
        for (const mentioned of toolNamesIn(text)) {
          // A tool naming ITSELF is always true: if this description is in
          // context, its own tool is on the wire by construction.
          if (mentioned === self) continue;
          const why = GOVERNED.get(mentioned);
          if (!why) continue;
          offences.push(
            `${self} · ${where} names "${mentioned}", which is GOVERNED (${why}).\n` +
            `      Descriptions are static — this text ships whenever ${self} ships, including on turns\n` +
            `      that carry no ${mentioned}. Name the CAPABILITY instead of the verb (e.g. "hand them to\n` +
            `      a reference_image_ids slot" rather than "pass them to generate_video"), or drop the clause.\n` +
            `      Offending text: ${JSON.stringify(text.slice(0, 400))}`,
          );
        }
      }
      expect(offences.join("\n\n"), offences.join("\n\n")).toBe("");
    });
  }
});

/** Verb-shaped, backticked, snake_case — i.e. written the way this codebase
 *  writes a callable. Parameter names (`image_id`, `reference_image_ids`) do
 *  not start with a verb, which is what keeps this from flagging them. */
const VERB_LIKE = /^(get|list|create|delete|update|generate|edit|save|show|view|read|write|search|render|lock|unlock|set|run|forge|test|accept|reject|isolate|rename|switch|activate|supersede|link|unlink|recall|upload|import|export|find|make|add|remove|open|close|start|stop|apply|check|build|draw|plan)_/;

describe("property: no description names a tool that does not exist", () => {
  // The other half of described-but-absent, and the purest form of it: a verb
  // that was renamed or never shipped is missing from EVERY turn's roster, not
  // just the ones with a switch off. It reads to the model exactly like a real
  // capability, so it gets narrated instead of called.
  it("every backticked callable in a description is registered", () => {
    const phantoms: string[] = [];
    for (const def of DEFS) {
      for (const [where, text] of stringsOf(def)) {
        for (const m of text.matchAll(/`([a-z][a-z0-9_]*)`/g)) {
          const token = m[1];
          if (!token.includes("_") || NAME_SET.has(token) || !VERB_LIKE.test(token)) continue;
          phantoms.push(`${def.function.name} · ${where} names \`${token}\`, which is in no tool definition.`);
        }
      }
    }
    expect(phantoms.join("\n"), phantoms.join("\n")).toBe("");
  });
});

describe("the rule's own inputs are real, so the property cannot pass vacuously", () => {
  it("reads a substantial roster", () => {
    expect(ALL_NAMES.length).toBeGreaterThan(60);
    // Every name unique — a duplicate registration would silently shadow.
    expect(new Set(ALL_NAMES).size).toBe(ALL_NAMES.length);
  });

  it("derives governance from all three live gates, not a literal", () => {
    // Representative of each source. If any of these stops being governed the
    // app changed, and this test should be read before it is edited.
    expect(GOVERNED.get("generate_image")).toContain("TOOL_PERMISSION");
    expect(GOVERNED.get("generate_video")).toContain("Lean Mode");
    expect(GOVERNED.get("web_search")).toContain("Lean Mode");
    expect(GOVERNED.get("forge_tool")).toContain("Foundry");
    expect(GOVERNED.get("run_tool")).toContain("Foundry");
    expect(GOVERNED.get("test_tool")).toContain("Foundry");
    // …and the free/read-only tools are genuinely ungoverned, or the property
    // above would be asserting something much weaker than it claims.
    for (const free of ["list_images", "show_image", "view_image", "list_books", "get_book", "save_file"]) {
      expect(GOVERNED.has(free), `${free} unexpectedly governed`).toBe(false);
    }
    expect(GOVERNED.size).toBeGreaterThan(25);
  });

  it("the extractor actually finds names in the corpus it walks", () => {
    // Guards the "regex silently matches nothing" failure, which would make
    // every case above pass for the wrong reason.
    let mentions = 0;
    for (const def of DEFS) {
      for (const [, text] of stringsOf(def)) {
        for (const n of toolNamesIn(text)) if (n !== def.function.name) mentions++;
      }
    }
    expect(mentions).toBeGreaterThan(10);
  });

  it("walks nested parameter descriptions, not just the top-level one", () => {
    // The nesting is real: parameters.properties.<p>.description, and one level
    // deeper again for array items. A walker that stopped at the top level
    // would miss most of the corpus.
    const nested = stringsOf(DEFS.find((d) => d.function.name === "generate_image")!)
      .filter(([where]) => where.startsWith("parameters.properties."));
    expect(nested.length).toBeGreaterThan(3);
    expect(stringsOf(DEFS[0]).some(([w]) => w === "description")).toBe(true);
  });

  it("would fail on a violation, and not on its capability-named rewrite", () => {
    // End-to-end proof on a synthetic definition rather than by breaking a real
    // one: the same guidance fails when it names a governed VERB and passes
    // when it names the ungoverned capability, which is the rewrite the failure
    // message asks for. Without this the property could be silently vacuous.
    const offences = (def: Def) => {
      const out: string[] = [];
      for (const [, text] of stringsOf(def)) {
        for (const n of toolNamesIn(text)) if (n !== def.function.name && GOVERNED.has(n)) out.push(n);
      }
      return out;
    };
    const bad: Def = {
      function: {
        name: "render_splat_views",
        description: "Renders stills. Pass the ids to generate_video.",
        parameters: { type: "object", properties: { splat_id: { description: "From list_splats, or forge_tool." } } },
      },
    };
    expect(offences(bad)).toEqual(["generate_video", "forge_tool"]);
    const good: Def = {
      function: {
        name: "render_splat_views",
        description: "Renders stills. Pass the ids into a `reference_image_ids` slot.",
        parameters: { type: "object", properties: { splat_id: { description: "From list_splats." } } },
      },
    };
    expect(offences(good)).toEqual([]);
  });

  it("still cross-references the tools it legitimately may name", () => {
    // THE MIRROR. Gating is not a mute button: dropping every cross-reference
    // would pass the property above and cost the model the routing knowledge
    // that makes multi-tool work coherent. Ungoverned names must survive.
    const ungovernedMentions = new Set<string>();
    for (const def of DEFS) {
      for (const [, text] of stringsOf(def)) {
        for (const n of toolNamesIn(text)) {
          if (n !== def.function.name && !GOVERNED.has(n)) ungovernedMentions.add(n);
        }
      }
    }
    expect(ungovernedMentions.size).toBeGreaterThan(5);
  });
});
