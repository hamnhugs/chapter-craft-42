import { parse } from "acorn";
import { full as walkFull } from "acorn-walk";
import {
  HELD_OUT_VARIANT_COUNT,
  heldOutCapabilityHandler,
  heldOutVariantLabel,
  stubCapabilityHandler,
} from "@/lib/toolFoundry";

/**
 * Conformance — the layer that decides whether a self-authored tool is worth
 * keeping, and the description pin that keeps an approval honest.
 *
 * WHY THIS EXISTS. A tool that passes its author's own tests is almost
 * certainly wrong: across 222 preserved self-authored tools, 96.8% scored zero
 * on held-out inputs while their in-session verifiers stayed green
 * (arXiv:2604.00392). Self-generated skill libraries measure NET NEGATIVE
 * (−1.3pp) where human-curated ones give +16.6pp (arXiv:2602.12670). The fix
 * that measures is a check the generator did not author: +30.0pp for a
 * verifier that cannot see the generator's reasoning (arXiv:2604.01687).
 *
 * So there are three layers, kept SEPARATE in the report on purpose:
 *
 *   1. authorTests — the model's own cases against the documented stub. This
 *      is the layer that already existed, and the layer that lies.
 *   2. heldOut     — the same cases against app-owned fixtures the model was
 *      never shown (toolFoundry CAPABILITY_REGISTRY[].heldOut). Every variant
 *      is legal under the documented contract; only the values differ.
 *   3. properties  — metamorphic relations, which need no oracle at all: pure
 *      input/output relations detect 75% of erroneous programs at an 8.6%
 *      false-positive rate (arXiv:2406.06864).
 *
 * DESIGN RULE applied to every check below: a check a CORRECT tool can fail is
 * worse than no check, because it destroys trust in the badge. Where a
 * property cannot be decided soundly the check reports itself as not
 * applicable — its note starts with "n/a — ", the summary counts those
 * separately, and it never reports green for something it did not test.
 */

type RunFn = typeof import("@/lib/toolSandbox").runToolSandboxed;
type RunResult = Awaited<ReturnType<RunFn>>;
type CapHandler = (cap: string, args: unknown) => Promise<unknown>;

export interface ConformanceCheck {
  name: string;
  pass: boolean;
  note: string;
}

export interface ConformanceReport {
  authorTests: ConformanceCheck[];
  heldOut: ConformanceCheck[];
  properties: ConformanceCheck[];
  /** One honest sentence, e.g. "4/4 author tests · 3/4 held-out · 2/2 properties". */
  summary: string;
  passed: boolean;
}

/** Prefix marking a check that could not be decided. Never green-washed: the
 *  summary reports the count of these alongside the pass counts. */
export const NOT_APPLICABLE = "n/a — ";

const RUN_TIMEOUT_MS = 5000;
const MAX_AUTHOR_TESTS = 8;
/** Distinct argument sets replayed against each held-out variant. Every run
 *  costs a VM boot, so this bounds the matrix at 3 × 3. */
const MAX_HELD_OUT_ARG_SETS = 3;
const NOTE_CAP = 240;

const clip = (s: string, n = NOTE_CAP) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const isNa = (c: ConformanceCheck) => c.note.startsWith(NOT_APPLICABLE);

/** Stable JSON for comparing two run results. Key order is whatever the tool
 *  emitted; the same program on the same input emits the same order, which is
 *  exactly what determinism is asking about. */
function j(value: unknown): string {
  try {
    const out = JSON.stringify(value === undefined ? null : value);
    return out === undefined ? "<<unserializable>>" : out;
  } catch {
    return "<<unserializable>>";
  }
}

/**
 * Blank out values that legitimately differ between two runs of a CORRECT
 * tool. Over-normalizing is safe in one direction only: it can hide a real
 * nondeterminism (a missed detection) but can never invent one (a false
 * positive). Per the design rule, that is the trade we want.
 */
function normalizeVolatile(json: string): string {
  return json
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, "<ts>")
    .replace(/\b1[5-9]\d{11}\b/g, "<epoch-ms>")
    .replace(/\b1[5-9]\d{8}\b/g, "<epoch-s>");
}

/** Errors that mean "the program crashed", as opposed to "the program
 *  deliberately rejected this input". Rejecting `{}` with a clear message is
 *  good tool design and must never score as a robustness failure. */
const CRASH_ERROR_RE =
  /(is not a function|is not iterable|cannot read (?:propert|.*of)|of undefined|of null|undefined is not|null is not|is not defined|cannot convert undefined|maximum call stack|out of memory)/i;

function isCrash(error: string | undefined): boolean {
  return CRASH_ERROR_RE.test(String(error || ""));
}

/** Failures of the HARNESS, not of the tool: the sandbox never booted, or the
 *  run was stopped by a budget rather than by the program. These decide
 *  nothing about the tool and must not be scored either way — silently
 *  banking them as a pass is how a check becomes decoration. */
const INFRA_ERROR_RE = /^sandbox unavailable|^capability (violation|call limit|data budget)/i;

function isInfrastructure(error: string | undefined): boolean {
  return INFRA_ERROR_RE.test(String(error || "").trim());
}

/**
 * Does `run`'s body ever read its first parameter? This grounds the
 * non-constancy property in something provable instead of guessing from
 * behaviour. Every uncertain path returns true, because true is the answer
 * that cannot produce a false failure.
 */
export function toolReadsArgs(code: string): boolean {
  let ast: unknown;
  try {
    ast = parse(code, { ecmaVersion: 2020, sourceType: "script" });
  } catch {
    return true; // unparseable — never fail a tool on a guess
  }
  let paramName: string | null = null;
  let destructured = false;
  let found = false;
  walkFull(ast as never, (node: any) => {
    if (found || node.type !== "FunctionDeclaration" || node.id?.name !== "run") return;
    found = true;
    let p = node.params?.[0];
    if (!p) return; // run() declared with no parameters at all
    if (p.type === "AssignmentPattern") p = p.left;
    if (p.type === "Identifier") paramName = p.name;
    else destructured = true; // { a, b } / [a] — reads args by definition
  });
  if (destructured) return true;
  if (!paramName) return false;
  // The declaration site is itself an Identifier node, so a single occurrence
  // means "declared and never used". Counting across the whole program can
  // only over-count, which again errs toward true.
  let hits = 0;
  walkFull(ast as never, (node: any) => {
    if (node.type === "Identifier" && node.name === paramName) hits++;
  });
  return hits > 1;
}

/**
 * The name of `run`'s SECOND parameter, or null when there isn't one.
 *
 * This matters more than it looks. analyzeToolCode derives the capability set
 * from member expressions whose object is literally named `caps` — so a tool
 * written as `run(args, c)` derives NO capabilities, ships an empty manifest,
 * passes the static gate, and then gets killed by the sandbox's capability
 * violation the first time it reads anything. It fails closed, which is right,
 * but the reason is invisible. Naming it lets test_tool say so.
 */
export function toolCapsParamName(code: string): string | null {
  let ast: unknown;
  try {
    ast = parse(code, { ecmaVersion: 2020, sourceType: "script" });
  } catch {
    return null;
  }
  let name: string | null = null;
  let found = false;
  walkFull(ast as never, (node: any) => {
    if (found || node.type !== "FunctionDeclaration" || node.id?.name !== "run") return;
    found = true;
    let p = node.params?.[1];
    if (!p) return;
    if (p.type === "AssignmentPattern") p = p.left;
    if (p.type === "Identifier") name = p.name;
  });
  return name;
}

/** Argument sets that are materially different, in first-seen order. */
function distinctArgSets(tests: Array<{ args?: unknown } | null | undefined>): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const t of tests) {
    const a = t?.args ?? {};
    const key = j(a);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

/** Values that only appear when something was stringified by accident. */
const STRINGIFICATION_ARTIFACTS = new Set([
  "[object Object]",
  "[object Promise]",
  "[object Undefined]",
  "[object Null]",
  "undefined",
  "NaN",
  "Infinity",
  "-Infinity",
]);

function findArtifact(value: unknown, path = "result", depth = 0): string | null {
  if (depth > 8) return null;
  if (typeof value === "string") {
    return STRINGIFICATION_ARTIFACTS.has(value) ? `${path} = ${JSON.stringify(value)}` : null;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length && i < 200; i++) {
      const hit = findArtifact(value[i], `${path}[${i}]`, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 200)) {
      const hit = findArtifact(v, `${path}.${k}`, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

export async function runConformance(input: {
  code: string;
  capabilities: string[];
  tests: Array<{ args: unknown; expect?: string }>;
  runSandboxed: RunFn;
}): Promise<ConformanceReport> {
  const code = input.code;
  const capabilities = [...(input.capabilities || [])].sort();
  const tests = (input.tests || []).slice(0, MAX_AUTHOR_TESTS);
  const pure = capabilities.length === 0;

  const exec = (args: unknown, onCapability: CapHandler): Promise<RunResult> =>
    input.runSandboxed({ code, args, capabilities, onCapability, timeoutMs: RUN_TIMEOUT_MS });

  const stub = stubCapabilityHandler();

  // ── layer 1: the author's own cases against the documented stub ───────────
  const authorTests: ConformanceCheck[] = [];
  /** Successful stub results keyed by the JSON of their argument set, reused
   *  by the sensitivity comparison so no run is paid for twice. */
  const stubByArgs = new Map<string, string>();
  /** The first successful result, preferring a NON-EMPTY one: a tool whose
   *  first case deliberately probes a not-found path legitimately returns
   *  null, and must not be scored as "returns nothing" because of it. */
  let firstStubValue: { value: unknown } | null = null;
  let anyNonEmpty = false;

  for (let i = 0; i < tests.length; i++) {
    const t = tests[i] || ({} as { args: unknown; expect?: string });
    const args = t.args ?? {};
    const res = await exec(args, stub);
    const label = `test ${i + 1}`;
    if (!res.ok) {
      authorTests.push({ name: label, pass: false, note: clip(String(res.error || "run failed")) });
      continue;
    }
    stubByArgs.set(j(args), j(res.value));
    const nonEmpty = res.value !== null && res.value !== undefined;
    if (!firstStubValue || (nonEmpty && !anyNonEmpty)) firstStubValue = { value: res.value };
    if (nonEmpty) anyNonEmpty = true;
    const expect = typeof t.expect === "string" ? t.expect : "";
    if (expect.length > 0) {
      const hay = j(res.value);
      authorTests.push(hay.includes(expect)
        ? { name: label, pass: true, note: `found ${JSON.stringify(clip(expect, 60))} in the result` }
        : { name: label, pass: false, note: `expected substring ${JSON.stringify(clip(expect, 60))} not found in the result` });
    } else {
      authorTests.push({ name: label, pass: true, note: "ran without error — no assertion was given, so nothing about the answer was verified" });
    }
  }
  if (tests.length === 0) {
    authorTests.push({ name: "author tests", pass: false, note: "no test cases were supplied" });
  }

  // Stop here when the author's own cases already failed. They are the only
  // BLOCKING layer, so nothing below can change the verdict — and running it
  // anyway costs up to ~20 more sandbox boots at 5s each, which is a minute
  // and a half of a held-open stream for a tool that is already rejected. The
  // remaining layers are reported as undecided rather than as passes.
  if (authorTests.some((c) => !c.pass)) {
    const skipped = (name: string): ConformanceCheck => ({
      name,
      pass: true,
      note: `${NOT_APPLICABLE}not run — the author's own test cases failed first, so this could not change the verdict`,
    });
    const heldOutSkipped = [skipped("held-out fixtures")];
    const propsSkipped = [skipped("properties")];
    return {
      authorTests,
      heldOut: heldOutSkipped,
      properties: propsSkipped,
      summary: clip(
        `${authorTests.filter((c) => c.pass).length}/${authorTests.length} author tests` +
          ` — failing: ${authorTests.filter((c) => !c.pass).map((c) => c.name).join(", ")}` +
          ` (held-out and property checks were skipped)`,
        400,
      ),
      passed: false,
    };
  }

  // The no-argument call: run it once here so it is available both to the
  // sensitivity comparison (as a stub baseline) and to the robustness probe.
  const emptyKey = j({});
  let emptyProbe: RunResult | null = null;
  if (!stubByArgs.has(emptyKey)) {
    emptyProbe = await exec({}, stub);
    if (emptyProbe.ok) stubByArgs.set(emptyKey, j(emptyProbe.value));
  }

  // ── layer 2: held-out fixtures the model has never been shown ─────────────
  const heldOut: ConformanceCheck[] = [];

  if (pure) {
    heldOut.push({
      name: "held-out fixtures",
      pass: true,
      note: `${NOT_APPLICABLE}this tool declares no capabilities, so there is no data shape to vary. Only the properties below constrain it.`,
    });
  } else {
    // `{}` goes first: it is the call a repair loop most often makes, and for
    // filter-shaped tools it is the argument set most likely to let the
    // fixture data through — which is what keeps the sensitivity check below
    // meaningful rather than noisy.
    const argSets = distinctArgSets([{ args: {} }, ...tests]).slice(0, MAX_HELD_OUT_ARG_SETS);
    // Which of those the AUTHOR actually supplied. `{}` is synthesized here,
    // and a tool with a required argument rightly THROWS on it — the robustness
    // property owns that verdict and explicitly blesses it. Counting the same
    // rejection as a held-out failure would fail every well-validated tool
    // (1/4 held-out, a red card) for doing exactly what good tools do, and a
    // check a correct tool can fail is worse than no check at all. One probe,
    // one owner: `{}` is judged by robustness, never here.
    const authorKeys = new Set(distinctArgSets(tests).map((a) => j(a)));
    /** variant index -> argsJson -> resultJson, successful runs only. */
    const variantOutputs: Array<Map<string, string>> = [];

    for (let v = 0; v < HELD_OUT_VARIANT_COUNT; v++) {
      const handler = heldOutCapabilityHandler(v);
      const outputs = new Map<string, string>();
      const failures: string[] = [];
      let judged = 0;
      for (const argSet of argSets) {
        const key = j(argSet);
        const judgedHere = authorKeys.has(key);
        const res = await exec(argSet, handler);
        if (!res.ok) {
          if (!judgedHere) continue; // synthesized probe — robustness owns it
          judged++;
          failures.push(`args ${clip(key, 40)} → ${clip(String(res.error || "run failed"), 110)}`);
          continue;
        }
        const encoded = j(res.value);
        if (encoded === "<<unserializable>>") {
          if (judgedHere) { judged++; failures.push(`args ${clip(key, 40)} → the result did not survive JSON`); }
          continue;
        }
        if (judgedHere) judged++;
        outputs.set(key, encoded);
      }
      variantOutputs.push(outputs);
      const label = clip(heldOutVariantLabel(v, capabilities), 100);
      if (judged === 0) {
        // Nothing the author supplied reached this variant, so the layer
        // decided nothing. Say that rather than banking an unearned pass.
        heldOut.push({
          name: `held-out: ${label}`,
          pass: true,
          note: `${NOT_APPLICABLE}none of the supplied argument sets exercised this variant`,
        });
        continue;
      }
      heldOut.push(failures.length === 0
        ? {
            name: `held-out: ${label}`,
            pass: true,
            note: `all ${judged} supplied argument set(s) returned a JSON value without throwing — this checks survival on undocumented-but-legal data, not correctness (there is no oracle for these)`,
          }
        : { name: `held-out: ${label}`, pass: false, note: clip(failures.join(" · ")) });
    }

    // Sensitivity: if the underlying data moves this much and the output never
    // does, the tool is not using what it asked permission to read. Guarded
    // hard against false positives — it fires only when at least one argument
    // set ran cleanly against the stub AND all held-out variants, and every
    // such argument set produced byte-identical output throughout.
    const comparable = argSets
      .map((a) => j(a))
      .filter((key) => stubByArgs.has(key) && variantOutputs.every((m) => m.has(key)));
    if (comparable.length === 0) {
      heldOut.push({
        name: "held-out: output sensitivity",
        pass: true,
        note: `${NOT_APPLICABLE}no argument set completed against both the documented fixture and every held-out variant, so there was nothing to compare.`,
      });
    } else {
      const frozen = comparable.every((key) => {
        const seen = new Set<string>([stubByArgs.get(key) as string]);
        for (const m of variantOutputs) seen.add(m.get(key) as string);
        return seen.size === 1;
      });
      heldOut.push(frozen
        ? {
            name: "held-out: output sensitivity",
            pass: false,
            note: clip(`the result was byte-identical across the documented fixture and all ${HELD_OUT_VARIANT_COUNT} held-out variants, for every argument set tested — the tool is not using the data it reads (or it is constant by design, in which case it does not need ${capabilities.join(", ")})`),
          }
        : {
            name: "held-out: output sensitivity",
            pass: true,
            note: `the result changed when the underlying data changed (${comparable.length} argument set(s) compared)`,
          });
    }
  }

  // ── layer 3: metamorphic properties (no oracle required) ─────────────────
  const properties: ConformanceCheck[] = [];
  const primaryArgs = tests.length > 0 ? (tests[0]?.args ?? {}) : {};

  // determinism — the same arguments twice must give the same answer.
  {
    const a = await exec(primaryArgs, stub);
    const b = await exec(primaryArgs, stub);
    if (!a.ok && !b.ok) {
      const same = String(a.error) === String(b.error);
      properties.push({
        name: "determinism",
        pass: same,
        note: same
          ? `${NOT_APPLICABLE}the tool failed identically on both runs, so there was no output to compare (${clip(String(a.error), 120)})`
          : clip(`two runs of the same input failed differently: ${clip(String(a.error), 80)} vs ${clip(String(b.error), 80)}`),
      });
    } else if (!a.ok || !b.ok) {
      properties.push({
        name: "determinism",
        pass: false,
        note: clip(`one of two identical runs succeeded and the other did not (${clip(String(a.error || b.error), 140)})`),
      });
    } else {
      const same = normalizeVolatile(j(a.value)) === normalizeVolatile(j(b.value));
      properties.push({
        name: "determinism",
        pass: same,
        note: same
          ? "two runs with identical arguments produced identical output (timestamps ignored)"
          : "two runs with identical arguments produced different output — something in the tool is random or time-dependent, so its results are not reproducible",
      });
    }
  }

  // non-constancy — different arguments must be able to change the answer.
  // Fires ONLY when a structural and a behavioural signal agree, because a
  // tool whose two argument sets legitimately select the same data (limit:5 vs
  // limit:10 over one item) is correct and must not be punished for it.
  {
    const sets = distinctArgSets(tests);
    if (sets.length < 2) {
      properties.push({
        name: "non-constancy",
        pass: true,
        note: `${NOT_APPLICABLE}only one distinct argument set was supplied, so there was nothing to vary.`,
      });
    } else if (toolReadsArgs(code)) {
      properties.push({
        name: "non-constancy",
        pass: true,
        note: `${NOT_APPLICABLE}run() does read its args parameter, so the arguments reach the logic; whether they change the answer needs an oracle this layer does not have.`,
      });
    } else {
      // Compare against the richest fixture so argument-shaped differences
      // (limits, filters) have something to bite on.
      const richest = pure ? stub : heldOutCapabilityHandler(HELD_OUT_VARIANT_COUNT - 1);
      const outs: string[] = [];
      for (const s of sets.slice(0, 2)) {
        const r = await exec(s, richest);
        if (r.ok) outs.push(j(r.value));
      }
      const identical = outs.length === 2 && outs[0] === outs[1];
      properties.push({
        name: "non-constancy",
        pass: !identical,
        note: identical
          ? "run() never reads its args parameter, and two different argument sets produced identical output — the arguments in the tests are decorative. Read them, or take them out of the tests."
          : "run() ignores its args parameter, but the tested argument sets did not collapse to a single answer.",
      });
    }
  }

  // robustness — `{}` and a dropped optional argument must not CRASH. A
  // deliberate validation error is good behaviour and passes.
  {
    const probes: Array<{ label: string; args: unknown; pre?: RunResult | null }> = [
      { label: "{}", args: {}, pre: emptyProbe },
    ];
    if (primaryArgs && typeof primaryArgs === "object" && !Array.isArray(primaryArgs)) {
      const keys = Object.keys(primaryArgs as Record<string, unknown>);
      if (keys.length > 1) {
        const stripped = { ...(primaryArgs as Record<string, unknown>) };
        const dropped = keys[keys.length - 1];
        delete stripped[dropped];
        probes.push({ label: `without "${dropped}"`, args: stripped });
      }
    }
    const crashes: string[] = [];
    const rejections: string[] = [];
    const infra: string[] = [];
    for (const p of probes) {
      const r = p.pre ?? (await exec(p.args, stub));
      if (r.ok) continue;
      const err = String(r.error || "");
      // Order matters. The harness's own failures are neither a crash nor a
      // rejection, and `killed` is the sandbox saying the program never
      // finished — a tool that HANGS on missing arguments used to land in
      // `rejections` and be reported as "a deliberate message, which is fine",
      // which is the most misleading sentence this file could produce.
      if (isInfrastructure(err)) infra.push(`${p.label} → ${clip(err, 80)}`);
      else if (r.killed) crashes.push(`${p.label} → ${clip(err, 110)} (the program never finished)`);
      else if (isCrash(err)) crashes.push(`${p.label} → ${clip(err, 110)}`);
      else rejections.push(`${p.label} → ${clip(err, 60)}`);
    }
    properties.push({
      name: "robustness",
      pass: crashes.length === 0,
      note: clip(crashes.length > 0
        ? `crashed on missing arguments: ${crashes.join(" · ")}`
        : infra.length > 0
          ? `${NOT_APPLICABLE}the sandbox could not complete this probe, so nothing was decided (${infra.join(" · ")})`
          : rejections.length > 0
            ? `missing arguments were rejected with a deliberate message, which is fine (${rejections.join(" · ")})`
            : `handled ${probes.map((p) => p.label).join(" and ")} without throwing`),
    });
  }

  // serializability — the result has to cross the JSON boundary as usable
  // data. Round-tripping the parsed value would be a tautology (the sandbox
  // already hands back parsed JSON), so this looks for the damage that
  // boundary actually does: a dropped value, or a stringification artefact
  // sitting where a real one should be.
  {
    if (!firstStubValue) {
      properties.push({
        name: "serializability",
        pass: false,
        note: "no test case produced a result to inspect.",
      });
    } else {
      const v = firstStubValue.value;
      const artifact = findArtifact(v);
      const empty = v === null || v === undefined;
      properties.push({
        name: "serializability",
        pass: !empty && !artifact,
        note: empty
          ? "every test case returned nothing (null), even though the fixtures they ran against had data in them — the caller gets no usable result"
          : artifact
            ? clip(`a value was stringified by accident: ${artifact} — usually a template literal wrapped around an object, or arithmetic on a missing number`)
            : "the result crossed the JSON boundary intact, with no stringification artefacts",
      });
    }
  }

  // ── report ───────────────────────────────────────────────────────────────
  const tally = (checks: ConformanceCheck[]) => `${checks.filter((c) => c.pass).length}/${checks.length}`;
  const all = [...authorTests, ...heldOut, ...properties];
  const naTotal = all.filter(isNa).length;
  const segments = [
    `${tally(authorTests)} author tests`,
    pure ? "held-out n/a (no capabilities)" : `${tally(heldOut)} held-out`,
    `${tally(properties)} properties`,
  ];
  const passed = all.every((c) => c.pass);
  const failing = all.filter((c) => !c.pass);
  const tail = failing.length > 0
    ? ` — failing: ${failing.map((c) => c.name).join(", ")}`
    : naTotal > 0
      ? ` — nothing failed (${naTotal} check${naTotal === 1 ? "" : "s"} not applicable)`
      : " — all green";
  const summary = clip(`${segments.join(" · ")}${tail}`, 400);

  return { authorTests, heldOut, properties, summary, passed };
}

// ── description pinning ─────────────────────────────────────────────────────
/**
 * The confirmed gap this closes. `tool_fingerprint()` hashes
 * `code || E'\n--manifest--\n' || manifest::text` — the DESCRIPTION is not in
 * it. The description is the only thing the model reads when deciding whether
 * to call a tool, and rug-pulls on approved tool descriptions succeed up to
 * 72.8% of the time (MCPTox, arXiv:2508.14925); the named defect is "a single
 * approval persistent trust model" plus the absence of a data–instruction
 * boundary (arXiv:2604.02837, 26.1% of 42,447 audited agent skills carrying at
 * least one vulnerability).
 *
 * The agent_tools_guard trigger already freezes the description of any row
 * that has ever been approved, so the residual hole is narrower than "edit it
 * afterwards" — it is the window between the user reading the approval card
 * and approve_tool() running, during which a description edit changes nothing
 * the fingerprint can see, and the client's own reviewed-vs-current comparison
 * is equally blind. Putting `description_sha256` in the manifest closes that
 * window with NO migration (manifest is a client-written JSONB column already
 * inside the hash) and gives every later run a cheap re-verification.
 */
export async function sha256Hex(text: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("crypto.subtle is unavailable — description pinning needs a secure context");
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Build the manifest to STORE on a tool row. The description is hashed exactly
 * as it will be persisted (i.e. after sanitizeToolDescription) — nothing is
 * normalized in here, because a normalizing hash silently forgives the very
 * edit this exists to catch.
 */
export async function manifestFor(
  capabilities: string[],
  description: string,
): Promise<{ capabilities: string[]; description_sha256: string }> {
  return {
    capabilities: [...(capabilities || [])].sort(),
    description_sha256: await sha256Hex(description ?? ""),
  };
}

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/**
 * Re-verify a stored description against its approved manifest.
 *
 *   { ok: true,  legacy: false } — pinned and unchanged. Safe to run.
 *   { ok: false, legacy: false } — pinned and CHANGED. Refuse: this is the
 *                                 rug-pull the pin exists to catch.
 *   { ok: false, legacy: true  } — no usable pin (forged before pinning
 *                                 existed, or the pin is malformed). Neither
 *                                 pass it nor hard-fail it: say so, and offer
 *                                 one re-approval.
 */
export async function descriptionMatchesManifest(
  manifest: unknown,
  description: string,
): Promise<{ ok: boolean; legacy: boolean }> {
  const stored = (manifest && typeof manifest === "object" && !Array.isArray(manifest))
    ? (manifest as Record<string, unknown>).description_sha256
    : undefined;
  if (typeof stored !== "string" || !SHA256_HEX_RE.test(stored)) return { ok: false, legacy: true };
  const actual = await sha256Hex(description ?? "");
  return { ok: actual === stored, legacy: false };
}
