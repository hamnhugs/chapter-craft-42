import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { CHAT_TOOL_DEFINITIONS } from "@/lib/chatTools";
import { TOOL_PERMISSION } from "@/lib/toolPermissions";
import { LEAN_MODES, blockedTools } from "@/lib/leanMode";
import { isFoundryTool } from "@/lib/toolAvailability";

/**
 * A TOOL RESULT MAY NEVER NAME A TOOL THIS TURN DOES NOT CARRY.
 *
 * WHY THIS FILE IS A SOURCE-LEVEL LINT AND NOT A UNIT TEST.
 * Tool results are DYNAMIC. There is no array to walk the way
 * toolDescriptionTruth.test.ts walks CHAT_TOOL_DEFINITIONS: a result is
 * assembled inside a 3,000-line switch out of database rows, provider
 * responses and the turn's arguments, and reaching one branch means standing up
 * Supabase, a provider and a signed-in user. Three review rounds each found
 * more sites of this one class and each round fixed them by hand; the reviewer
 * named the cause exactly — "the PROMPT layer has a property test; the
 * TOOL-RESULTS layer is pinned by nothing." So the SOURCE is pinned, the same
 * way chatContextWiring.test.ts pins ChatContext's send path.
 *
 * THE RULE. Every string literal in chatTools.ts and foundryTools.ts that names
 * a GOVERNED tool must be one of:
 *   (a) lexically inside the branch of a `toolOnWire(...)` gate that is emitted
 *       when that tool IS on the wire, or
 *   (b) in the allowlist at the bottom, with one line of reasoning.
 *
 * "Governed" is derived at runtime from the three real gates — TOOL_PERMISSION,
 * every Lean tier's blockedTools, and isFoundryTool — never from a hand-copied
 * list, so a tool that GAINS a permission next month starts failing this test
 * in the same commit that adds it. Naming an UNGOVERNED tool (list_images,
 * show_image, save_file …) is always fine and is deliberately not flagged:
 * over-filtering suppresses legitimate tool use, which is the same harm in the
 * other direction.
 *
 * ── WHAT THIS TECHNIQUE DOES NOT COVER ───────────────────────────────────────
 * A lint that overstates its coverage is worse than no lint, because it stops
 * people looking. Honestly, then:
 *
 *  1. TWO FILES ONLY. Other modules also reach model context — the prompt
 *     builder (pinned by promptToolTruth.test.ts), leanMode's prompt block
 *     (pinned there too), toolAvailability's gateRefusal, textToolCalls. This
 *     scan does not look at them.
 *  2. LITERALS ONLY. A name that arrives through a variable — `${toolName}`,
 *     a row from the database, a provider's error text — is invisible here.
 *  3. WHOLE LITERALS ONLY. `"…call gener" + "ate_video"` would evade it.
 *     Nobody writes that; it is listed so nobody believes it is checked.
 *  4. BARE-NAME LITERALS ARE SKIPPED. A literal whose entire content is a tool
 *     name is how the code REFERS to tools — `case "delete_image":`,
 *     `perms["run_tool"]`, `toolOnWire("generate_video", deps)` — and flagging
 *     ~70 switch labels would bury the real findings. A model-visible value
 *     that is exactly a tool name and nothing else would therefore be missed.
 *  5. THE GATE SCOPE IS LEXICAL AND DELIBERATELY DUMB. It understands one
 *     shape — `<gate> ? A : B` — and finds the branch boundary by counting
 *     brackets. A nested ternary inside a branch ends the range early, which
 *     produces a FALSE POSITIVE (something must be justified), never a false
 *     negative. That is the direction the errors are allowed to run in.
 *  6. COMMENTS ARE EXCLUDED. They never ship. The scanner strips them
 *     properly rather than by regex, which is why it is a character scanner.
 *
 * Everything the scan cannot prove ends up in the allowlist, in the open, with
 * a reason — that is the point, not a workaround.
 */

const FILES = ["src/lib/chatTools.ts", "src/lib/foundryTools.ts"] as const;
type FileName = (typeof FILES)[number];

const ALL_TOOLS: string[] = (CHAT_TOOL_DEFINITIONS as ReadonlyArray<any>).map((d) => d.function.name as string);
const TOOL_SET = new Set(ALL_TOOLS);

/** Governed = some switch can pull it while other tools survive. Same
 *  derivation as toolDescriptionTruth.test.ts, re-derived rather than shared:
 *  two independent copies cannot both be weakened by one edit. */
const GOVERNED = new Map<string, string>();
{
  const add = (t: string, why: string) => GOVERNED.set(t, GOVERNED.has(t) ? `${GOVERNED.get(t)}; ${why}` : why);
  for (const [tool, permId] of Object.entries(TOOL_PERMISSION)) add(tool, `TOOL_PERMISSION → "${permId}"`);
  for (const mode of LEAN_MODES) for (const t of blockedTools(mode)) add(t, `Lean tier "${mode}"`);
  for (const t of ALL_TOOLS) if (isFoundryTool(t)) add(t, "Tool Foundry opt-in (inverted, off by default)");
}

/** Do the same switches govern both tools, so a gate on `gated` proves
 *  `mentioned` is on the wire too? accept_generation and reject_generation
 *  share the single "production_ledger" permission and are withheld as a pair;
 *  gating one and naming the other is correct, not an oversight. */
function coveredBy(gated: string, mentioned: string): boolean {
  if (gated === mentioned) return true;
  const a = TOOL_PERMISSION[gated];
  const b = TOOL_PERMISSION[mentioned];
  if (!a || a !== b) return false;
  if (isFoundryTool(gated) !== isFoundryTool(mentioned)) return false;
  for (const mode of LEAN_MODES) {
    if (blockedTools(mode).includes(gated) !== blockedTools(mode).includes(mentioned)) return false;
  }
  return true;
}

// ── the scanner ──────────────────────────────────────────────────────────────
// A character scanner, not a regex. Regexes cannot tell a `"` inside a comment
// from one that opens a string, and getting that wrong silently fuses hundreds
// of lines of code into one "literal" — which is exactly how a lint ends up
// reporting nonsense and being deleted.

interface Literal {
  /** Index of the first character of the literal's CONTENT. */
  start: number;
  text: string;
}

interface Scan {
  literals: Literal[];
  /** True at every index the scanner was reading executable code. */
  isCode: boolean[];
  /** Indices of the `}` that closes a `${…}` interpolation. It is code, but it
   *  balances a `{` the scanner consumed as template text, so a bracket count
   *  that treats it as a closer walks off the end of the expression. */
  interpClose: Set<number>;
}

function scanSource(src: string): Scan {
  const literals: Literal[] = [];
  const isCode = new Array<boolean>(src.length).fill(false);
  const interpClose = new Set<number>();
  const stack: Array<{ kind: "tmpl" } | { kind: "expr"; depth: number }> = [];
  let mode: "code" | "line" | "block" | "sq" | "dq" | "tmpl" | "regex" = "code";
  let chunkStart = -1;
  let lastSig = "\n";
  let i = 0;
  const emit = (end: number) => {
    if (chunkStart >= 0 && end > chunkStart) literals.push({ start: chunkStart, text: src.slice(chunkStart, end) });
    chunkStart = -1;
  };
  while (i < src.length) {
    const c = src[i];
    if (mode === "code") {
      isCode[i] = true;
      if (c === "/" && src[i + 1] === "/") { mode = "line"; i += 2; continue; }
      if (c === "/" && src[i + 1] === "*") { mode = "block"; i += 2; continue; }
      // Regex-literal start, by the standard "what can precede a division"
      // heuristic. Getting this wrong only matters if a regex contains a quote,
      // and several in these files do (/["']/).
      if (c === "/" && /[(,=:[!&|?{};+\n]/.test(lastSig)) { mode = "regex"; i++; continue; }
      if (c === '"') { mode = "dq"; chunkStart = i + 1; i++; continue; }
      if (c === "'") { mode = "sq"; chunkStart = i + 1; i++; continue; }
      if (c === "`") { stack.push({ kind: "tmpl" }); mode = "tmpl"; chunkStart = i + 1; i++; continue; }
      const top = stack[stack.length - 1];
      if (top && top.kind === "expr") {
        if (c === "{") { top.depth++; i++; lastSig = c; continue; }
        if (c === "}") {
          if (top.depth === 0) { stack.pop(); interpClose.add(i); mode = "tmpl"; chunkStart = i + 1; i++; lastSig = "}"; continue; }
          top.depth--; i++; lastSig = c; continue;
        }
      }
      if (!/\s/.test(c)) lastSig = c;
      i++; continue;
    }
    if (mode === "line") { if (c === "\n") { mode = "code"; lastSig = "\n"; } i++; continue; }
    if (mode === "block") { if (c === "*" && src[i + 1] === "/") { mode = "code"; i += 2; continue; } i++; continue; }
    if (mode === "regex") {
      if (c === "\\") { i += 2; continue; }
      if (c === "[") { while (i < src.length && src[i] !== "]") { if (src[i] === "\\") i++; i++; } i++; continue; }
      if (c === "/" || c === "\n") { mode = "code"; lastSig = c === "/" ? "/" : "\n"; i++; continue; }
      i++; continue;
    }
    if (mode === "sq" || mode === "dq") {
      const quote = mode === "sq" ? "'" : '"';
      if (c === "\\") { i += 2; continue; }
      if (c === quote) { emit(i); mode = "code"; lastSig = quote; i++; continue; }
      i++; continue;
    }
    // template text
    if (c === "\\") { i += 2; continue; }
    if (c === "$" && src[i + 1] === "{") {
      emit(i);
      stack.push({ kind: "expr", depth: 0 });
      mode = "code"; lastSig = "{"; i += 2; continue;
    }
    if (c === "`") { emit(i); stack.pop(); mode = "code"; lastSig = "`"; i++; continue; }
    i++;
  }
  return { literals, isCode, interpClose };
}

// ── gate ranges ──────────────────────────────────────────────────────────────

interface Range { start: number; end: number; tool: string }

/** From `pos`, skip forward over the rest of a boolean condition looking for
 *  the `?` of a ternary. The allowed characters are exactly what a gate
 *  condition's tail can contain — `)`, `!`, `===`, `&&`, a property access, a
 *  word. Anything else (a quote, a brace, a semicolon) means this gate is not
 *  used as a ternary and gates nothing. */
function findTernary(src: string, pos: number): { q: number; tail: string } | null {
  let tail = "";
  for (let j = pos; j < src.length && j - pos < 200; j++) {
    const c = src[j];
    if (c === "?") {
      if (src[j + 1] === "." || src[j + 1] === "?" || src[j - 1] === "?") return null; // ?. and ??
      return { q: j, tail };
    }
    if (!/[\s)!=<>&|.\w]/.test(c)) return null;
    tail += c;
  }
  return null;
}

/** Walk one arm of a ternary. Returns the index just past it. Positions the
 *  scanner marked as non-code (string bodies, comments) are skipped, so quotes
 *  and colons inside prose cannot end the arm. */
function armEnd(src: string, scan: Scan, from: number, stopAtColon: boolean): number {
  let depth = 0;
  for (let j = from; j < src.length; j++) {
    if (!scan.isCode[j]) continue;
    if (scan.interpClose.has(j)) continue;
    const c = src[j];
    if (c === "(" || c === "[" || c === "{") { depth++; continue; }
    if (c === ")" || c === "]" || c === "}") { if (depth === 0) return j; depth--; continue; }
    if (depth === 0 && stopAtColon && c === ":") return j;
    if (depth === 0 && (c === ";" || c === ",")) return j;
  }
  return src.length;
}

/** The character range that is emitted when `tool` IS on the wire. `inverted`
 *  flips which arm that is — `ctx.forgeOnWire === false ? A : B` puts the
 *  on-wire text in B. */
function positiveArm(src: string, scan: Scan, q: number, tool: string, inverted: boolean): Range {
  const colon = armEnd(src, scan, q + 1, true);
  if (!inverted) return { start: q + 1, end: colon, tool };
  return { start: colon + 1, end: armEnd(src, scan, colon + 1, false), tool };
}

/** Constants used as the first argument instead of a literal. */
const CONST_TOOL: Record<string, string> = { FORGE_TOOL: "forge_tool", RUN_TOOL: "run_tool" };

/** Gate identifiers this file declares by hand, per source file, because the
 *  gate is computed in ANOTHER module and handed across a seam. Each one is
 *  pinned by an assertion below — a hand-declared bridge that nothing checks is
 *  just a hole with a comment next to it. */
const DECLARED_BRIDGES: Record<string, Array<{ id: string; tool: string }>> = {
  // FoundryToolContext.forgeOnWire is populated at chatTools.ts's single
  // executeFoundryTool call site with `await toolOnWire(FORGE_TOOL, deps)` —
  // the same predicate the roster uses. The assertion "the forgeOnWire bridge
  // is real" below fails if that stops being true.
  "src/lib/foundryTools.ts": [{ id: "ctx.forgeOnWire", tool: "forge_tool" }],
};

function gateRanges(rel: string, src: string, scan: Scan): Range[] {
  const ranges: Range[] = [];
  const anchors: Array<{ at: number; tool: string; inverted: boolean }> = [];

  // 1. Direct calls: toolOnWire("X", deps) / toolOnWire(FORGE_TOOL, deps).
  const call = /toolOnWire\(\s*(?:"([a-z0-9_]+)"|([A-Z_]+))/g;
  for (const m of src.matchAll(call)) {
    const at = m.index!;
    if (!scan.isCode[at]) continue;
    const tool = m[1] || CONST_TOOL[m[2]];
    if (!tool) continue;
    // Find the call's closing paren so the anchor sits after the arguments.
    let j = src.indexOf("(", at);
    let depth = 0;
    for (; j < src.length; j++) {
      if (!scan.isCode[j]) continue;
      if (src[j] === "(") depth++;
      else if (src[j] === ")") { depth--; if (depth === 0) { j++; break; } }
    }
    const before = src.slice(Math.max(0, at - 40), at);
    anchors.push({ at: j, tool, inverted: /!\s*\(?\s*(await\s+)?$/.test(before) });
  }

  // 2. Identifiers bound from a gate: `const canRunNow = autoApproved && (await
  //    toolOnWire("run_tool", deps));`. A `&&` chain is sound (the identifier
  //    is true only if the gate was), a `||` or a `!` in the binding is NOT, so
  //    those are refused rather than trusted.
  const bind = /const\s+([A-Za-z_$][\w$]*)\s*=\s*([^;]*?toolOnWire\(\s*(?:"([a-z0-9_]+)"|([A-Z_]+))[^;]*);/g;
  const bound: Array<{ id: string; tool: string }> = [];
  for (const m of src.matchAll(bind)) {
    if (!scan.isCode[m.index!]) continue;
    const tool = m[3] || CONST_TOOL[m[4]];
    if (!tool) continue;
    if (m[2].includes("||") || m[2].includes("!")) continue;
    bound.push({ id: m[1], tool });
  }
  for (const b of [...bound, ...(DECLARED_BRIDGES[rel] || [])]) {
    const use = new RegExp(`(?<![\\w$.])${b.id.replace(/\./g, "\\.")}(?![\\w$])`, "g");
    for (const m of src.matchAll(use)) {
      const at = m.index! + b.id.length;
      if (!scan.isCode[m.index!]) continue;
      const before = src.slice(Math.max(0, m.index! - 20), m.index!);
      anchors.push({ at, tool: b.tool, inverted: /!\s*$/.test(before) });
    }
  }

  for (const a of anchors) {
    const t = findTernary(src, a.at);
    if (!t) continue;
    // `=== false` inverts the arms just as a leading `!` does.
    const inverted = a.inverted !== /===\s*false/.test(t.tail);
    ranges.push(positiveArm(src, scan, t.q, a.tool, inverted));
  }
  return ranges;
}

// ── structural exclusions ────────────────────────────────────────────────────

/** `console.warn("[generate_video] insertPendingVideo failed", e)` — a
 *  developer diagnostic in the browser console. It is not in the tool result,
 *  so it never reaches the model, and stripping tool names out of the one
 *  channel that exists for debugging would be a real loss. */
function isConsoleArg(src: string, litStart: number): boolean {
  return /console\.\w+\(\s*$/.test(src.slice(Math.max(0, litStart - 60), litStart - 1));
}

/** `event: { name, summary: "run_tool requires opt-in", ok: false }` —
 *  ToolEvent.summary is the USER's receipt. ChatContext pushes events onto
 *  `assistantEvents`, which becomes the message's `toolEvents` (the chips under
 *  the bubble, persisted as tool_events); only `result` is JSON.stringify'd
 *  into the role:"tool" message the model reads. `[^{}]*` keeps this from
 *  matching a `summary:` inside a nested object such as foundryTools' RESULT
 *  body `conformance: { summary: … }`, which IS model-visible. */
function isEventSummary(src: string, litStart: number): boolean {
  return /event:\s*\{[^{}]*summary:\s*$/.test(src.slice(Math.max(0, litStart - 200), litStart - 1));
}

// ── the allowlist ────────────────────────────────────────────────────────────
// Every entry is a site the scan cannot prove and a human has. One line of
// reasoning each. `snippet` must appear inside the offending literal; an entry
// that matches nothing fails the test, so a fixed site cannot leave its excuse
// behind.

interface Allowed { file: FileName; tool: string; snippet: string; why: string }

const ALLOWLIST: Allowed[] = [
  // ── self-reference ─────────────────────────────────────────────────────────
  // The tool naming itself in its OWN result. It just ran, so it cleared the
  // permission choke point and Lean Mode this turn: it is on the wire by
  // construction, and telling the model how to complete the call it is halfway
  // through is the entire point of a confirmation result.
  {
    file: "src/lib/chatTools.ts", tool: "generate_video",
    snippet: "Tell the user the estimated cost and ask them to confirm; only then call generate_video",
    why: "self-reference — generate_video's own over-threshold cost confirmation; it just ran, so it is on the wire.",
  },
  {
    file: "src/lib/chatTools.ts", tool: "generate_video",
    snippet: "confirm the exact cost and ask them to approve before proceeding; only then call generate_video",
    why: "self-reference — generate_video's unknown-price confirmation result.",
  },
  {
    file: "src/lib/chatTools.ts", tool: "generate_splat",
    snippet: "Tell the user the cost and ask them to confirm; only then call generate_splat",
    why: "self-reference — generate_splat's own over-threshold cost confirmation.",
  },
  {
    file: "src/lib/chatTools.ts", tool: "generate_splat",
    snippet: "confirm the cost and ask them to approve before proceeding; only then call generate_splat",
    why: "self-reference — generate_splat's unknown-price confirmation result.",
  },
  {
    file: "src/lib/foundryTools.ts", tool: "test_tool",
    snippet: "Fix the errors below and call test_tool again",
    why: "self-reference — test_tool's own static-gate failure.",
  },
  {
    file: "src/lib/foundryTools.ts", tool: "test_tool",
    snippet: "change the code, and call test_tool again",
    why: "self-reference — test_tool's own CONFORMANCE_FAILED result.",
  },

  // ── implied by the running tool's own gate ─────────────────────────────────
  // Not self-reference: a DIFFERENT verb, named in a result whose own tool
  // cannot be on the wire unless that verb is too. Each is a subset argument
  // against toolAvailability.ts's rules, checked in the assertions below so it
  // cannot quietly stop being true.
  {
    file: "src/lib/foundryTools.ts", tool: "list_tools",
    snippet: "Call list_tools for the exact names, drafts included.",
    why: "read_tool needs forgeOptIn && foundryReady; list_tools needs (forgeOptIn || runOptIn) && foundryReady — strictly weaker, so read_tool running proves it.",
  },
  {
    file: "src/lib/foundryTools.ts", tool: "list_tools",
    snippet: "Try again, or call list_tools.",
    why: "same read_tool ⟹ list_tools subset argument.",
  },
  {
    file: "src/lib/foundryTools.ts", tool: "list_tools",
    snippet: "Call list_tools for the exact names — drafts are included there.",
    why: "same read_tool ⟹ list_tools subset argument.",
  },
  {
    file: "src/lib/foundryTools.ts", tool: "test_tool",
    snippet: "To try a fix, call test_tool with the candidate code",
    why: "read_tool's note. read_tool needs forgeOptIn && foundryReady; test_tool needs only forgeOptIn (it is exempt from the migration gate) — strictly weaker.",
  },
  {
    file: "src/lib/foundryTools.ts", tool: "forge_tool",
    snippet: "only forge_tool once it is clean",
    why: "read_tool's note. read_tool and forge_tool have the IDENTICAL gate (both in NEEDS_FORGE, neither exempt from off_foundry_unavailable), so read_tool running proves forge_tool is on the wire.",
  },
];

// ── the lint ─────────────────────────────────────────────────────────────────

interface Finding { file: FileName; line: number; tool: string; text: string }

function lint(rel: FileName): {
  findings: Finding[];
  used: Set<Allowed>;
  stats: { literals: number; gates: number; gateCovered: number };
} {
  const src = readFileSync(resolve(process.cwd(), rel), "utf8");
  const scan = scanSource(src);
  const ranges = gateRanges(rel, src, scan);
  const findings: Finding[] = [];
  const used = new Set<Allowed>();
  const mine = ALLOWLIST.filter((a) => a.file === rel);
  let gateCovered = 0;

  for (const lit of scan.literals) {
    if (TOOL_SET.has(lit.text.trim())) continue; // limit 4: bare-name literal
    if (isConsoleArg(src, lit.start)) continue;
    if (isEventSummary(src, lit.start)) continue;
    for (const m of lit.text.matchAll(/[a-z][a-z0-9]*(?:_[a-z0-9]+)+/g)) {
      const tool = m[0];
      if (!GOVERNED.has(tool)) continue;
      const abs = lit.start + m.index!;
      if (ranges.some((r) => abs >= r.start && abs < r.end && coveredBy(r.tool, tool))) { gateCovered++; continue; }
      const entry = mine.find((a) => a.tool === tool && lit.text.includes(a.snippet));
      if (entry) { used.add(entry); continue; }
      findings.push({ file: rel, line: src.slice(0, abs).split("\n").length, tool, text: lit.text.slice(0, 220) });
    }
  }
  return { findings, used, stats: { literals: scan.literals.length, gates: ranges.length, gateCovered } };
}

const RESULTS = Object.fromEntries(FILES.map((f) => [f, lint(f)])) as Record<FileName, ReturnType<typeof lint>>;

describe("no string literal names a governed tool outside its gate", () => {
  for (const file of FILES) {
    it(file, () => {
      const { findings } = RESULTS[file];
      const report = findings
        .map(
          (f) =>
            `${f.file}:${f.line} names "${f.tool}" — governed by ${GOVERNED.get(f.tool)}.\n` +
            `      This string can reach the model on a turn that carries no ${f.tool}. Either wrap the\n` +
            `      OPTIONAL clause in \`(await toolOnWire("${f.tool}", deps) ? "…with ${f.tool}…" : "…")\`\n` +
            `      — gate the tail, never the verdict, and the remaining sentence must read naturally —\n` +
            `      or add an ALLOWLIST entry in this file with one line of reasoning.\n` +
            `      Literal: ${JSON.stringify(f.text)}`,
        )
        .join("\n\n");
      expect(report, report).toBe("");
    });
  }
});

describe("the allowlist stays honest", () => {
  it("has no entry that matches nothing", () => {
    const used = new Set<Allowed>();
    for (const file of FILES) for (const a of RESULTS[file].used) used.add(a);
    const stale = ALLOWLIST.filter((a) => !used.has(a)).map((a) => `${a.file} · ${a.tool} · ${a.snippet}`);
    expect(stale, `allowlist entries matching nothing (fixed? delete them):\n${stale.join("\n")}`).toEqual([]);
  });

  it("gives every entry a reason", () => {
    for (const a of ALLOWLIST) {
      expect(a.why.length, `${a.tool} · ${a.snippet}`).toBeGreaterThan(30);
    }
  });

  it("keeps the subset arguments the Foundry entries rest on true", () => {
    // The three foundryTools entries are only sound because of how
    // toolAvailability.ts groups the Foundry verbs. If that grouping moves,
    // those entries become excuses for real bugs — so it is asserted here
    // rather than trusted to a comment.
    const AV = readFileSync(resolve(process.cwd(), "src/lib/toolAvailability.ts"), "utf8");
    // read_tool rides with forge_tool…
    expect(AV).toContain('export const FOUNDRY_REPAIR_TOOLS = ["read_tool", "test_tool"] as const;');
    expect(AV).toContain("const NEEDS_FORGE = new Set<string>([FORGE_TOOL, ...FOUNDRY_REPAIR_TOOLS]);");
    // …list_tools needs only EITHER switch…
    expect(AV).toContain("(tool === FOUNDRY_SURVEY_TOOL && !input.forgeOptIn && !input.runOptIn)");
    // …and test_tool alone is exempt from the migration gate, which is what
    // makes it strictly weaker than read_tool rather than equal to it.
    expect(AV).toContain('applies: (tool, input) => FOUNDRY_TOOLS.has(tool) && tool !== "test_tool" && !input.foundryReady');
  });

  it("keeps the forgeOnWire bridge real", () => {
    // DECLARED_BRIDGES tells the scan that `ctx.forgeOnWire` in foundryTools.ts
    // is a toolOnWire("forge_tool") gate. It is one only because chatTools.ts
    // fills it from exactly that call, at its single call site.
    const CT = readFileSync(resolve(process.cwd(), "src/lib/chatTools.ts"), "utf8");
    expect(CT).toContain("forgeOnWire: await toolOnWire(FORGE_TOOL, deps),");
    expect((CT.match(/forgeOnWire:/g) || []).length).toBe(1);
    // And foundryTools reads it with the fail-OPEN comparison. `=== false`
    // rather than `!ctx.forgeOnWire` is load-bearing: an omitted flag (tests,
    // direct invocation) means "no roster to consult" and must KEEP the clause,
    // because over-filtering suppresses a tool that is genuinely there.
    const FT = readFileSync(resolve(process.cwd(), "src/lib/foundryTools.ts"), "utf8");
    expect(FT).toContain("ctx.forgeOnWire === false");
    expect(FT).not.toContain("!ctx.forgeOnWire");
  });
});

describe("the scanner is doing what the failure messages claim", () => {
  // A lint whose matcher silently matches nothing passes forever and protects
  // nothing. These are its self-tests.
  const CT = readFileSync(resolve(process.cwd(), "src/lib/chatTools.ts"), "utf8");
  const scan = scanSource(CT);

  it("finds thousands of literals and does not fuse the file into a few", () => {
    expect(RESULTS["src/lib/chatTools.ts"].stats.literals).toBeGreaterThan(1500);
    const longest = Math.max(...scan.literals.map((l) => l.text.length));
    // The longest legitimate literal in the file is a few hundred characters of
    // guidance prose. A quote mishandled in a comment produces one span
    // thousands of characters long that swallows real code.
    expect(longest).toBeLessThan(2500);
  });

  it("reads real prose out of a result and ignores the comment above it", () => {
    const texts = scan.literals.map((l) => l.text);
    expect(texts.some((t) => t.includes("All images above are ALREADY displayed to the user inline"))).toBe(true);
    // A distinctive phrase that exists only inside a `//` comment.
    expect(texts.some((t) => t.includes("Permission enforced at the executeChatTool choke point"))).toBe(false);
  });

  it("recognises every toolOnWire gate in the tree", () => {
    // Eleven hand-placed call sites across the two files at the time of
    // writing. This number is allowed to grow; if it SHRINKS, a gate was
    // deleted and the class this whole ship exists to close is back.
    const calls = (CT.match(/toolOnWire\(/g) || []).length;
    expect(calls).toBeGreaterThanOrEqual(11);
    expect(RESULTS["src/lib/chatTools.ts"].stats.gates).toBeGreaterThanOrEqual(8);
  });

  it("clears real mentions THROUGH the gates, not through the exclusions", () => {
    // The anti-vacuity guard that matters most. The file passes either because
    // the gates are recognised or because the mentions were skipped as bare
    // names / console tags / receipts — and those two look identical from the
    // outside. Ten real prose mentions in chatTools.ts and one in foundryTools
    // are cleared by a toolOnWire arm at the time of writing; if that count
    // collapses, the lint has stopped reading the gates and is passing for the
    // wrong reason.
    expect(RESULTS["src/lib/chatTools.ts"].stats.gateCovered).toBeGreaterThanOrEqual(10);
    expect(RESULTS["src/lib/foundryTools.ts"].stats.gateCovered).toBeGreaterThanOrEqual(1);
  });

  it("actually excludes the console tags and event summaries it says it does", () => {
    expect(isConsoleArg(CT, CT.indexOf("[generate_video] insertPendingVideo failed"))).toBe(true);
    expect(isEventSummary(CT, CT.indexOf("run_tool requires opt-in"))).toBe(true);
    // …and does NOT swallow a `summary:` nested inside a model-visible result.
    const FT = readFileSync(resolve(process.cwd(), "src/lib/foundryTools.ts"), "utf8");
    const nested = FT.indexOf("summary: report.summary");
    expect(nested).toBeGreaterThan(-1);
    expect(isEventSummary(FT, nested + "summary: ".length)).toBe(false);
  });

  it("would catch a violation, and does not catch its gated twin", () => {
    // The end-to-end proof, on synthetic source rather than by deleting a real
    // gate: the same sentence fails ungated and passes gated.
    const bad = `const x = { note: "Then animate it with generate_video." };`;
    const good = `const x = { note: "Done." + (await toolOnWire("generate_video", deps) ? " Then animate it with generate_video." : " It is in the library.") };`;
    const check = (src: string) => {
      const s = scanSource(src);
      const r = gateRanges("synthetic", src, s);
      const hits: string[] = [];
      for (const lit of s.literals) {
        if (TOOL_SET.has(lit.text.trim())) continue;
        for (const m of lit.text.matchAll(/[a-z][a-z0-9]*(?:_[a-z0-9]+)+/g)) {
          if (!GOVERNED.has(m[0])) continue;
          const abs = lit.start + m.index!;
          if (r.some((g) => abs >= g.start && abs < g.end && coveredBy(g.tool, m[0]))) continue;
          hits.push(m[0]);
        }
      }
      return hits;
    };
    expect(check(bad)).toEqual(["generate_video"]);
    expect(check(good)).toEqual([]);
    // And the mirror: naming it in the OFF arm is still a violation.
    const wrongArm = `const x = { note: (await toolOnWire("generate_video", deps) ? "A." : "Use generate_video later.") };`;
    expect(check(wrongArm)).toEqual(["generate_video"]);
  });

  it("treats an inverted gate's other arm as the on-wire one", () => {
    const inverted = `const x = { next: ctx.forgeOnWire === false ? "Save it yourself." : "Call forge_tool with this code." };`;
    const s = scanSource(inverted);
    const r = gateRanges("src/lib/foundryTools.ts", inverted, s);
    const forgeAt = inverted.indexOf("forge_tool with");
    expect(r.some((g) => forgeAt >= g.start && forgeAt < g.end && g.tool === "forge_tool")).toBe(true);
    // …and the OTHER arm is not covered, so a stray name there would be caught.
    const otherAt = inverted.indexOf("Save it yourself");
    expect(r.some((g) => otherAt >= g.start && otherAt < g.end)).toBe(false);
  });
});
