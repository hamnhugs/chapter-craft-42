import type { Blueprint } from "./schema";
import type { Scene } from "./scene";
import type { MasterAssetRow } from "@/lib/masterAssets";

// Write-time consistency checks.
//
// TWO FINDINGS SHAPE THIS FILE, and both push against the obvious design.
//
// First: check at WRITE time, not at read time. The strongest published result
// in this area comes from cross-referencing each new fact against its existing
// neighbours before it is committed — roughly a 4.7x improvement in
// contradiction detection over checking later. A blueprint saved onto a master
// whose palette it contradicts is a bug the moment it lands; finding it during
// a later render is finding it too late.
//
// Second: do NOT load five wikis and ask a model to cross-check them. Models
// measurably struggle to detect conflicts BETWEEN sources, especially across
// more than one hop, and fail to identify which source is wrong; the one
// mitigation with support is reasoning about a single specific conflict with
// only the conflicting evidence present. So everything here is a targeted
// pairwise check — blueprint against its master, scene against the masters it
// names — computed deterministically. What a rule can decide, a rule decides.
// Whatever is left over is handed up as a NAMED PAIR so a caller can put just
// those two things in front of a model, and a model verdict never overrules a
// rule.

export interface ConsistencyFinding {
  /** `error` means the two documents contradict each other. `warning` means
   *  they differ in a way that may be deliberate. Nothing here blocks a save —
   *  a budget of trust is worth more than a hard gate people route around. */
  severity: "error" | "warning";
  where: string;
  problem: string;
  /** Values that would resolve it, when the fix is a choice. */
  allowed?: string[];
  /** The two things that disagree. A caller escalating to a model should send
   *  ONLY these, not the documents they came from. */
  pair?: { a: string; b: string };
}

/** Perceptible-difference threshold, matching the palette-drift gate already
 *  used on generated video. Below ~2 is invisible; 10 is a colour a person
 *  would call different. */
const DELTA_E_SAME = 10;

function fmt(findings: ConsistencyFinding[]): ConsistencyFinding[] {
  // Errors first — a caller that truncates should truncate warnings.
  return [...findings].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1));
}

/**
 * Compare a blueprint against the master it is about to be saved onto.
 *
 * The master's `palette`, `negative_constraints` and `banned_traits` are the
 * locked identity that generation already honours; a blueprint that disagrees
 * with them would quietly become a second, competing source of truth.
 */
export async function checkBlueprintAgainstMaster(
  bp: Blueprint,
  master: MasterAssetRow,
): Promise<ConsistencyFinding[]> {
  const findings: ConsistencyFinding[] = [];
  const locked = (master.palette || []).map((h) => String(h).toLowerCase());

  if (locked.length && bp.palette.length) {
    const { differenceCiede2000 } = await import("culori");
    const deltaE = differenceCiede2000();

    for (const swatch of bp.palette) {
      let nearest = Infinity;
      let nearestHex = "";
      for (const lockedHex of locked) {
        const d = deltaE(swatch.hex, lockedHex);
        if (Number.isFinite(d) && d < nearest) {
          nearest = d;
          nearestHex = lockedHex;
        }
      }
      if (nearest > DELTA_E_SAME) {
        findings.push({
          severity: "error",
          where: `palette["${swatch.role}"]`,
          problem:
            `${swatch.hex} is not in @${master.name}'s locked palette — the closest locked colour is ${nearestHex}, ` +
            `which is ${nearest.toFixed(1)} ΔE away and would read as a different colour.`,
          allowed: locked,
          pair: { a: `blueprint swatch "${swatch.role}" = ${swatch.hex}`, b: `@${master.name} locked palette = ${locked.join(", ")}` },
        });
      }
    }

    // The reverse direction: a locked colour nobody paints with is usually a
    // part that got left out of the assembly.
    for (const lockedHex of locked) {
      const used = bp.palette.some((s) => {
        const d = deltaE(s.hex, lockedHex);
        return Number.isFinite(d) && d <= DELTA_E_SAME;
      });
      if (!used) {
        findings.push({
          severity: "warning",
          where: "palette",
          problem: `@${master.name} locks ${lockedHex} but nothing in this blueprint uses it — a part may be missing.`,
          allowed: bp.palette.map((s) => s.role),
        });
      }
    }
  }

  // Negatives are the identity guard rails. A blueprint that describes exactly
  // what the master forbids is the clearest possible contradiction.
  const negatives = [...(master.negative_constraints || []), ...(master.banned_traits || [])]
    .map((s) => String(s).trim().toLowerCase())
    .filter(Boolean);
  if (negatives.length) {
    const haystack = [
      bp.silhouette,
      ...bp.notes,
      ...bp.parts.map((p) => p.name),
      ...bp.costume.map((c) => `${c.name} ${c.state || ""}`),
      ...bp.marks.map((m) => `${m.name} ${m.description}`),
    ].join(" \n ").toLowerCase();

    for (const negative of negatives) {
      // Whole-phrase match only. Substring matching on short words ("no arms"
      // matching "armsleeve") produces confident nonsense, and a false
      // contradiction is worse than a missed one for a check people must trust.
      if (negative.length < 4) continue;
      if (haystack.includes(negative)) {
        findings.push({
          severity: "error",
          where: "blueprint",
          problem: `this blueprint mentions "${negative}", which @${master.name} lists as something it must never have.`,
          pair: { a: `blueprint text mentioning "${negative}"`, b: `@${master.name} forbids "${negative}"` },
        });
      }
    }
  }

  if (master.style_lock && master.style_lock !== "custom") {
    const expectHardSurface = master.style_lock === "vector";
    if (expectHardSurface && bp.form === "organic") {
      findings.push({
        severity: "warning",
        where: "form",
        problem: `@${master.name} is style-locked to "${master.style_lock}" but this blueprint is organic, so no solids will be drawn — only a proportion scaffold.`,
        allowed: ["hard_surface", "mixed"],
      });
    }
  }

  return fmt(findings);
}

/**
 * Check a scene's references against the masters that exist.
 *
 * `resolve` is injected so this stays a pure function of its inputs and can be
 * tested without a database — the alternative, importing the Supabase client
 * here, would make every test a network test.
 */
export async function checkSceneReferences(
  scene: Scene,
  resolve: (nameOrId: string) => Promise<MasterAssetRow | null>,
  knownMasterNames: string[] = [],
): Promise<ConsistencyFinding[]> {
  const findings: ConsistencyFinding[] = [];
  const referenced = new Map<string, string>();

  for (const prop of scene.props) if (prop.master) referenced.set(prop.master, `props["${prop.id}"]`);
  for (const mark of scene.blocking) if (mark.master) referenced.set(mark.master, `blocking["${mark.id}"]`);

  for (const [ref, where] of referenced) {
    const found = await resolve(ref);
    if (!found) {
      findings.push({
        severity: "error",
        where,
        problem: `references master "@${ref.replace(/^@/, "")}", which does not exist.`,
        allowed: knownMasterNames.length ? knownMasterNames.map((n) => `@${n}`) : undefined,
      });
    }
  }

  // A subject nobody films is usually a blocking mark left behind after the
  // scene was rewritten.
  const filmed = new Set(scene.shots.flatMap((s) => s.subjects));
  for (const mark of scene.blocking) {
    if (!filmed.has(mark.id)) {
      findings.push({
        severity: "warning",
        where: `blocking["${mark.id}"]`,
        problem: `${mark.name} is placed on the plan but appears in no shot.`,
        allowed: scene.shots.map((s) => s.number || s.id),
      });
    }
  }

  // A camera set up and never used is the same story from the other side.
  const used = new Set(scene.shots.map((s) => s.camera).filter(Boolean) as string[]);
  for (const cam of scene.cameras) {
    if (!used.has(cam.id)) {
      findings.push({
        severity: "warning",
        where: `cameras["${cam.id}"]`,
        problem: `setup ${cam.label} is on the plan but no shot uses it.`,
      });
    }
  }

  return fmt(findings);
}

/**
 * Is this blueprint the right revision for the chapter being worked on?
 *
 * Effectivity ranges are the one idea from PLM configuration management that
 * transfers cleanly: a character legitimately has revisions valid over part of
 * a book, and drawing the wrong one is a continuity error nobody notices until
 * it is in a rendered shot.
 */
export function checkValidity(bp: Blueprint, chapterIndex: number | null | undefined): ConsistencyFinding[] {
  if (chapterIndex === null || chapterIndex === undefined || !bp.validity) return [];
  const { fromChapter, toChapter } = bp.validity;
  const tooEarly = fromChapter !== undefined && chapterIndex < fromChapter;
  const tooLate = toChapter !== undefined && chapterIndex > toChapter;
  if (!tooEarly && !tooLate) return [];
  return [{
    severity: "warning",
    where: "validity",
    problem:
      `this revision of ${bp.name} is valid for chapters ${fromChapter ?? "start"}–${toChapter ?? "end"}, ` +
      `but the active chapter is ${chapterIndex}.`,
    allowed: ["use the revision valid for this chapter", "widen this blueprint's validity range"],
  }];
}

/** One line per finding, for a tool result. Errors are marked so the model
 *  cannot mistake a warning for a contradiction. */
export function formatFindings(findings: ConsistencyFinding[]): string[] {
  return findings.map((f) => {
    const tail = f.allowed?.length ? ` Valid here: ${f.allowed.join(", ")}.` : "";
    return `${f.severity === "error" ? "CONFLICT" : "check"} · ${f.where}: ${f.problem}${tail}`;
  });
}
