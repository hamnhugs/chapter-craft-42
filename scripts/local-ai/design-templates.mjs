// Templates for DesignCraft pages: "save this design so I can use it again".
//
// A template is a snapshot of one page, kept in three files under
// crafts/templates/<slug>/:
//   template.designcraft  DesignCraft's own file (file.serialize). The pictures
//                         are embedded, so it reopens exactly: fonts, colours,
//                         gradients, effects, every frame where it was.
//   thumb.png             a screenshot of the page (render_page), so people
//                         and the chat can see what it is
//   manifest.json         which frame is the headline, picture, body… (its
//                         "slots"), the type size each slot was designed at,
//                         and the page it came from
// Using a template opens that file as a new document. New words and pictures
// then go into the slots: the frames stay where the designer put them, and the
// text steps down in size only when it wouldn't otherwise fit (craft-bridge.mjs
// fitTemplate). Pure helpers here; the bridge does the DesignCraft calls.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";

/** One file out of a zip (a .designcraft is one): the central directory gives
 *  each entry's offset; stored (0) and deflated (8) are what zips use. */
export function zipEntry(buf, name) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("not a zip file");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let k = 0; k < count; k++) {
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const entry = buf.toString("utf8", p + 46, p + 46 + nlen);
    if (entry === name) {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      return method === 8 ? inflateRawSync(data) : Buffer.from(data);
    }
    p += 46 + nlen + xlen + clen;
  }
  return null;
}

/** The document model inside a .designcraft file. */
export function designcraftJson(buf) {
  const doc = zipEntry(buf, "document.json");
  if (!doc) throw new Error("no document.json in the DesignCraft file");
  return JSON.parse(doc.toString("utf8"));
}

/** How a story's text is set: its biggest type size, the font of its first
 *  run, and whether it's italic — from the character runs, then the
 *  paragraph style, then DesignCraft's default (12 pt). */
export function storyType(docJson, storyId) {
  const st = docJson?.stories?.[String(storyId)];
  if (!st) return null;
  const pstyles = docJson.styles?.paragraph || [];
  const pstyle = pstyles.find((s) => s.name === st.paras?.[0]?.style) || {};
  const runs = st.chars?.length ? st.chars : [{}];
  const sizes = runs.map((r) => Number(r.over?.size ?? pstyle.chars?.size ?? 12));
  const first = runs[0] || {};
  const fontStyle = String(first.over?.fontStyle ?? pstyle.chars?.fontStyle ?? "Regular");
  return {
    text: String(st.text || ""),
    size: Math.max(...sizes),
    font: first.over?.fontFamily ?? pstyle.chars?.fontFamily ?? null,
    style: fontStyle,
    italic: /italic|oblique/i.test(fontStyle),
  };
}

const ROLE_OF_NAME = ["headline", "subhead", "image", "body", "caption", "footer"];

/** Which frame on a page is which part, for a page designed by hand (frames
 *  the bridge named keep their role). `items`: the page's parts as the bridge
 *  reads them ({id, kind, role, named, bounds, story}); `page`: {bounds}.
 *  The rules are how a reader takes a page in: the biggest short type is the
 *  headline; small type on the bottom strip is the footer; short italic type
 *  right under a picture is its caption; the next-biggest short line is the
 *  subhead; the rest is body. */
export function guessSlots(items, page, docJson) {
  const [, py0, , py1] = page.bounds;
  const H = py1 - py0;
  const slots = [];
  const texts = [];
  for (const it of items) {
    const box = it.bounds.map((v) => Math.round(v * 10) / 10);
    if (it.kind === "image") { slots.push({ id: it.id, role: "image", kind: "image", box }); continue; }
    const t = storyType(docJson, it.story) || { text: "", size: 12 };
    texts.push({ id: it.id, kind: "text", box, named: it.named ? it.role : null, ...t });
  }
  const free = texts.filter((t) => !t.named);
  const taken = new Set(texts.filter((t) => t.named).map((t) => t.named));
  const assign = (t, role) => { t.role = role; taken.add(role); };
  for (const t of texts) if (t.named) t.role = t.named;
  const short = (t) => t.text.length <= 140 && !/\n\s*\n/.test(t.text);
  const bodySize = (() => { const s = free.filter((t) => !short(t)).map((t) => t.size); return s.length ? Math.min(...s) : Math.min(...free.map((t) => t.size), 12); })();
  if (!taken.has("headline")) {
    const h = free.filter(short).sort((a, b) => b.size - a.size || a.box[1] - b.box[1])[0];
    if (h && h.size >= bodySize * 1.4) assign(h, "headline");
  }
  if (!taken.has("footer")) {
    const f = free.filter((t) => !t.role && short(t) && t.box[1] >= py0 + H * 0.82).sort((a, b) => b.box[3] - a.box[3])[0];
    if (f) assign(f, "footer");
  }
  if (!taken.has("caption")) {
    const imgs = slots.filter((s) => s.kind === "image");
    const c = free.find((t) => !t.role && short(t) && t.italic && imgs.some((i) => t.box[1] >= i.box[3] - 2 && t.box[1] - i.box[3] < 40));
    if (c) assign(c, "caption");
  }
  if (!taken.has("subhead")) {
    const s = free.filter((t) => !t.role && short(t)).sort((a, b) => b.size - a.size || a.box[1] - b.box[1])[0];
    if (s && (s.size > bodySize * 1.1 || free.length > 2)) assign(s, "subhead");
  }
  for (const t of texts) if (!t.role) t.role = "body";
  for (const t of texts) slots.push({ id: t.id, role: t.role, kind: "text", box: t.box, size: t.size, font: t.font, text: t.text.slice(0, 200) });
  // Pictures: the biggest is the hero, listed first.
  return slots.sort((a, b) => (a.kind === b.kind ? (a.kind === "image" ? area(b.box) - area(a.box) : a.box[1] - b.box[1]) : a.kind === "image" ? 1 : -1));
}
const area = (b) => (b[2] - b[0]) * (b[3] - b[1]);

export function slugify(name) {
  return String(name || "").toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_]+/g, "-").replace(/-+/g, "-").slice(0, 60) || "template";
}

export function listTemplates(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((slug) => { try { return JSON.parse(readFileSync(join(dir, slug, "manifest.json"), "utf8")); } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => String(b.created).localeCompare(String(a.created)));
}

/** A template by name the way people say it: exact name or slug, then the
 *  one whose name contains the words ("the fair one" → "Summer Book Fair"). */
export function findTemplate(dir, name) {
  const all = listTemplates(dir);
  const q = String(name || "").toLowerCase().trim();
  if (!q) return null;
  const qs = slugify(q);
  return all.find((t) => t.slug === qs || t.name.toLowerCase() === q)
    || all.find((t) => t.slug.includes(qs) || qs.includes(t.slug))
    || bestByWords(all, qs)
    || null;
}

const STOP = new Set(["the", "a", "an", "my", "our", "one", "template", "design", "layout", "page", "flyer", "poster", "for", "with", "from", "that", "this"]);
/** The template sharing the most words with what was said, if any does. */
function bestByWords(all, qs) {
  const words = qs.split("-").filter((w) => w.length > 2 && !STOP.has(w));
  let best = null, score = 0;
  for (const t of all) {
    const tw = t.slug.split("-");
    const n = words.filter((w) => tw.some((x) => x.startsWith(w) || w.startsWith(x))).length;
    if (n > score) { score = n; best = t; }
  }
  return best;
}

export function writeTemplate(dir, manifest, fileBuf, thumbBuf) {
  const at = join(dir, manifest.slug);
  mkdirSync(at, { recursive: true });
  writeFileSync(join(at, "template.designcraft"), fileBuf);
  if (thumbBuf) writeFileSync(join(at, "thumb.png"), thumbBuf);
  writeFileSync(join(at, "manifest.json"), JSON.stringify(manifest, null, 2));
  return at;
}

export function deleteTemplate(dir, slug) {
  const at = join(dir, slugify(slug));
  if (!existsSync(join(at, "manifest.json"))) return false;
  rmSync(at, { recursive: true, force: true });
  return true;
}

/** What a template offers, in a line for the model: its parts and size. */
export function describeTemplate(t) {
  const roles = t.slots.map((s) => s.role);
  const count = (r) => roles.filter((x) => x === r).length;
  const parts = [...new Set(roles)].map((r) => (count(r) > 1 ? `${count(r)} ${r}s` : r));
  return `${t.name}: ${Math.round(t.width)}×${Math.round(t.height)} pt; parts ${parts.join(", ")}`;
}
