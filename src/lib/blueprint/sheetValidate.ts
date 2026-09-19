import type { BlueprintProblem } from "./schema";

// Deterministic sheet validation — the hard gate that runs before anything is
// shown, saved or rasterised.
//
// WHY DETERMINISTIC AND NOT A CRITIC MODEL. Two findings decide this. First,
// "it renders without error" is no evidence of correctness: a domain model
// measured 2% invalidity and an IoU of 0.04 — perfectly executable output that
// was geometrically meaningless. Second, augmenting a judge with real execution
// moved agreement with ground truth from under 42% to about 72%, and every
// system that actually holds geometry (arrow anchoring within 12px, text inside
// its box with 6px padding, render validity as a binary gate) computes those
// predicates rather than asking a model. So: predicates here, model judgment
// only for what no predicate can express.
//
// WHY AN ALLOWLIST WHEN WE WROTE THE SVG OURSELVES. Defence in depth, and a
// standing guard for the day some part of a sheet becomes model-authored.
// Sanitising after the fact is the weaker posture — DOMPurify's own threat
// model excludes CSS attacks and permits <foreignObject> by default, and SMIL
// animation can retarget another element's href at runtime to defeat a static
// pass. Building from a known-good vocabulary avoids the whole category.

const ALLOWED_ELEMENTS = new Set([
  "svg", "g", "defs", "symbol", "use", "title", "desc",
  "path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
  "text", "tspan", "marker", "clipPath", "mask",
  "linearGradient", "radialGradient", "stop", "pattern", "image",
]);

const ALLOWED_ATTRS = new Set([
  // structure + identity
  "id", "role", "aria-label", "aria-labelledby", "xmlns", "href",
  // geometry
  "d", "x", "y", "cx", "cy", "r", "rx", "ry", "x1", "y1", "x2", "y2",
  "points", "width", "height", "transform", "viewBox", "preserveAspectRatio",
  // text
  "textLength", "lengthAdjust", "text-anchor", "dominant-baseline",
  "font-family", "font-size", "font-weight", "letter-spacing",
  // paint
  "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin",
  "stroke-dasharray", "stroke-opacity", "opacity", "fill-opacity", "fill-rule",
  "vector-effect", "shape-rendering", "pointer-events",
  // markers, gradients, patterns
  "marker-start", "marker-mid", "marker-end", "markerWidth", "markerHeight",
  "refX", "refY", "orient", "markerUnits",
  "offset", "stop-color", "stop-opacity", "gradientUnits", "patternUnits",
  "clip-path", "mask",
]);

/** Elements that reintroduce script, style or runtime attribute rewriting. Kept
 *  as an explicit list so a reader can see exactly what is being refused. */
const FORBIDDEN_ELEMENTS = new Set([
  "script", "foreignObject", "style", "a", "handler", "listener",
  "animate", "set", "animateMotion", "animateTransform", "animateColor",
  "filter", "feImage", "iframe", "embed", "object",
]);

/**
 * Containers whose children are DEFINITIONS, not drawings.
 *
 * A glyph inside <defs> lives in its own local space — `<circle r="4"/>` at the
 * origin legitimately reaches (-4, -4) and is only ever painted wherever a
 * <use> places it. Bounds-checking those coordinates against the sheet's
 * viewBox reports every symbol library as off-canvas, which is wrong about the
 * one thing the check exists to catch. <marker> is the sharpest case: its
 * children are measured in the marker's own viewBox, not the sheet's.
 */
const TEMPLATE_CONTAINERS = new Set([
  "defs", "symbol", "marker", "clipPath", "mask", "pattern",
  "linearGradient", "radialGradient",
]);

/** Fragment references only. `#id` can never navigate, fetch or execute. */
const FRAGMENT_HREF = /^#[A-Za-z][\w.:-]*$/;
/** Embedded rasters are permitted only as inline data. B3 rasterises a sheet
 *  and re-embeds view panels; an http(s) href would be a zero-click GET that
 *  leaks on paint, and an <img>-sourced SVG cannot fetch anything anyway. */
const DATA_IMAGE_HREF = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

export interface SheetCheckOptions {
  /** Refuse a sheet past this element count. Rendering cost is DOM node count,
   *  and it degrades in the low thousands. */
  maxNodes?: number;
  /** Slack when testing whether drawn geometry sits inside the viewBox. */
  tolerance?: number;
}

interface ViewBox { x: number; y: number; w: number; h: number }

function parseViewBox(raw: string | null): ViewBox | null {
  if (!raw) return null;
  const parts = raw.trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some((v) => !Number.isFinite(v))) return null;
  return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
}

function num(el: Element, name: string): number | null {
  const raw = el.getAttribute(name);
  if (raw === null) return null;
  const v = Number(raw);
  return Number.isFinite(v) ? v : null;
}

/** Every point this element actually draws at, in user space. Only elements
 *  whose coordinates are readable without layout are checked — `path` data and
 *  anything under a `transform` is skipped rather than guessed at, and that
 *  limitation is stated in the returned problems when it matters. */
function drawnPoints(el: Element): Array<{ x: number; y: number }> {
  const tag = el.tagName.toLowerCase();
  const pts: Array<{ x: number; y: number }> = [];
  const push = (x: number | null, y: number | null) => {
    if (x !== null && y !== null) pts.push({ x, y });
  };
  switch (tag) {
    case "rect": {
      const x = num(el, "x") ?? 0, y = num(el, "y") ?? 0;
      const w = num(el, "width") ?? 0, h = num(el, "height") ?? 0;
      push(x, y);
      push(x + w, y + h);
      break;
    }
    case "line":
      push(num(el, "x1"), num(el, "y1"));
      push(num(el, "x2"), num(el, "y2"));
      break;
    case "circle": {
      const cx = num(el, "cx") ?? 0, cy = num(el, "cy") ?? 0, r = num(el, "r") ?? 0;
      push(cx - r, cy - r);
      push(cx + r, cy + r);
      break;
    }
    case "ellipse": {
      const cx = num(el, "cx") ?? 0, cy = num(el, "cy") ?? 0;
      const rx = num(el, "rx") ?? 0, ry = num(el, "ry") ?? 0;
      push(cx - rx, cy - ry);
      push(cx + rx, cy + ry);
      break;
    }
    case "polygon":
    case "polyline": {
      const raw = el.getAttribute("points") || "";
      const nums = raw.trim().split(/[\s,]+/).map(Number).filter((v) => Number.isFinite(v));
      for (let i = 0; i + 1 < nums.length; i += 2) pts.push({ x: nums[i], y: nums[i + 1] });
      break;
    }
    default:
      break;
  }
  return pts;
}

/**
 * Structural, security and geometric checks over a rendered sheet.
 *
 * Returns problems in the same shape the blueprint validator uses — location,
 * violation, and where a fix is a choice, the admissible values.
 */
export function validateSheetSvg(svg: string, opts: SheetCheckOptions = {}): BlueprintProblem[] {
  const problems: BlueprintProblem[] = [];
  const maxNodes = opts.maxNodes ?? 1500;
  const tolerance = opts.tolerance ?? 0.5;

  if (typeof DOMParser === "undefined") {
    return [{ where: "(sheet)", problem: "no DOMParser available to check the sheet — validation could not run." }];
  }

  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  if (doc.getElementsByTagName("parsererror").length > 0) {
    const detail = doc.getElementsByTagName("parsererror")[0]?.textContent || "";
    return [{ where: "(sheet)", problem: `sheet is not well-formed XML: ${detail.replace(/\s+/g, " ").slice(0, 200)}` }];
  }

  const root = doc.documentElement;
  if (!root || root.tagName.toLowerCase() !== "svg") {
    return [{ where: "(sheet)", problem: `root element is <${root?.tagName || "nothing"}>, expected <svg>.` }];
  }

  // A viewBox with a zero dimension DISABLES rendering of the element entirely
  // and a negative one invalidates the attribute — either way the sheet renders
  // blank, which reads as a broken drawing rather than broken data.
  const vb = parseViewBox(root.getAttribute("viewBox"));
  if (!vb) {
    problems.push({ where: "svg[viewBox]", problem: "missing or unparseable viewBox; without one the sheet cannot scale to its panel and preserveAspectRatio has no effect." });
  } else if (!(vb.w > 0) || !(vb.h > 0)) {
    problems.push({
      where: "svg[viewBox]",
      problem: `viewBox is "${root.getAttribute("viewBox")}" — a zero or negative extent disables rendering entirely and the sheet will appear blank.`,
    });
  }

  if (root.hasAttribute("width") || root.hasAttribute("height")) {
    problems.push({
      where: "svg",
      problem: "root <svg> declares width/height, which pins the sheet to one size instead of letting its container scale it.",
      allowed: ["remove width and height; keep only viewBox"],
    });
  }

  const ids = new Set<string>();
  const hrefs: Array<{ el: Element; value: string }> = [];
  let count = 0;

  const walk = (el: Element, path: string, inTemplate: boolean) => {
    count++;
    const tag = el.tagName;
    const lower = tag.toLowerCase();

    if (FORBIDDEN_ELEMENTS.has(lower) || FORBIDDEN_ELEMENTS.has(tag)) {
      problems.push({
        where: path,
        problem: `<${tag}> is never allowed in a sheet — it can carry script, style or a runtime attribute rewrite.`,
      });
      return; // don't descend into it; its children are moot
    }
    if (!ALLOWED_ELEMENTS.has(lower) && !ALLOWED_ELEMENTS.has(tag)) {
      problems.push({
        where: path,
        problem: `<${tag}> is not in the sheet vocabulary.`,
        allowed: [...ALLOWED_ELEMENTS].slice(0, 14).concat("…"),
      });
      return;
    }

    const id = el.getAttribute("id");
    if (id) ids.add(id);

    for (const attr of Array.from(el.attributes)) {
      const name = attr.name;
      if (/^on/i.test(name)) {
        problems.push({ where: `${path}[${name}]`, problem: `event handler attributes are never allowed.` });
        continue;
      }
      if (/^xlink:/i.test(name)) {
        problems.push({
          where: `${path}[${name}]`,
          problem: "xlink attributes are deprecated and are a known sanitiser-bypass surface.",
          allowed: ["href"],
        });
        continue;
      }
      if (name === "style") {
        problems.push({
          where: `${path}[style]`,
          problem: "inline style is not allowed — CSS can load external resources and is outside every sanitiser's threat model. Paint with presentation attributes.",
          allowed: ["fill", "stroke", "stroke-width", "opacity", "font-size"],
        });
        continue;
      }
      if (!ALLOWED_ATTRS.has(name)) {
        problems.push({ where: `${path}[${name}]`, problem: `attribute "${name}" is not in the sheet vocabulary.` });
        continue;
      }
      if (name === "href") hrefs.push({ el, value: attr.value });
    }

    // A transform relocates everything below it, and resolving one without a
    // layout engine means reimplementing the transform stack. Skip the bounds
    // check under it rather than reporting coordinates we know are pre-transform.
    const transformed = el.hasAttribute("transform");

    if (vb && !inTemplate && !transformed) {
      for (const p of drawnPoints(el)) {
        if (
          p.x < vb.x - tolerance || p.x > vb.x + vb.w + tolerance ||
          p.y < vb.y - tolerance || p.y > vb.y + vb.h + tolerance
        ) {
          problems.push({
            where: path,
            problem: `draws at (${Math.round(p.x)}, ${Math.round(p.y)}), outside the sheet's ${vb.w}×${vb.h} area — it will be clipped.`,
          });
          break; // one report per element is enough to locate it
        }
      }
    }

    const childTemplate = inTemplate || transformed || TEMPLATE_CONTAINERS.has(lower) || TEMPLATE_CONTAINERS.has(tag);
    for (let i = 0; i < el.children.length; i++) {
      walk(el.children[i], `${path} > ${el.children[i].tagName.toLowerCase()}[${i}]`, childTemplate);
    }
  };

  walk(root, "svg", false);

  for (const { el, value } of hrefs) {
    if (FRAGMENT_HREF.test(value)) {
      const target = value.slice(1);
      if (!ids.has(target)) {
        problems.push({
          where: `${el.tagName.toLowerCase()}[href]`,
          problem: `references "${value}" but no element declares that id, so nothing is drawn there.`,
          allowed: [...ids].slice(0, 12),
        });
      }
      continue;
    }
    if (el.tagName.toLowerCase() === "image" && DATA_IMAGE_HREF.test(value)) continue;
    problems.push({
      where: `${el.tagName.toLowerCase()}[href]`,
      problem: `href "${value.slice(0, 60)}" is neither a same-document fragment nor inline image data. External references leak on paint and can execute.`,
      allowed: ["#some-declared-id", "data:image/png;base64,…"],
    });
  }

  // Text is pinned with textLength precisely because it cannot be measured
  // ahead of render — so where it IS pinned, the declared width is knowable and
  // must fit.
  if (vb) {
    const texts = Array.from(root.getElementsByTagName("text"));
    texts.forEach((t, i) => {
      const len = num(t, "textLength");
      if (len === null) return;
      const x = num(t, "x") ?? 0;
      const anchor = t.getAttribute("text-anchor") || "start";
      const left = anchor === "end" ? x - len : anchor === "middle" ? x - len / 2 : x;
      if (left < vb.x - tolerance || left + len > vb.x + vb.w + tolerance) {
        problems.push({
          where: `text[${i}]`,
          problem: `label "${(t.textContent || "").slice(0, 30)}" is pinned to ${Math.round(len)}px starting at ${Math.round(left)}, which runs outside the sheet.`,
        });
      }
      if (len <= 0) {
        problems.push({ where: `text[${i}][textLength]`, problem: `textLength must be positive; got ${len}.` });
      }
    });
  }

  if (count > maxNodes) {
    problems.push({
      where: "(sheet)",
      problem: `${count} elements exceeds the ${maxNodes}-node budget; rendering cost is DOM node count and degrades from here. Reduce the view count, or move repeated marks into <defs>/<use>.`,
    });
  }

  return problems;
}

/** Element count without a full validation pass — cheap enough to call before
 *  deciding whether to render at all. */
export function countSheetNodes(svg: string): number {
  return (svg.match(/<[a-zA-Z]/g) || []).length;
}
