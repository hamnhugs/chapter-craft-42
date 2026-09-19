import { z } from "zod";

// Whitelisted, validated "blocks" the assistant may emit (via the render_blocks
// tool) to present rich, structured content inline. The model can only pick
// from these shapes; the client renders each with a trusted component and
// drops anything that doesn't validate. Text fields are markdown.
//
// The schema is intentionally lenient (coerces numbers/booleans to strings,
// normalizes type aliases and object-rows) so small model deviations still
// render instead of silently failing — while still rejecting unknown shapes.

// Coerce primitives (and stringify objects) so a stray number/boolean doesn't
// fail a string field.
const str = (max: number) =>
  z.preprocess(
    (v) => (v === null || v === undefined ? v : typeof v === "object" ? JSON.stringify(v) : String(v)),
    z.string().max(max),
  );

const InlineMd = str(4000);

export const BlockSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("callout"),
    variant: z.enum(["info", "success", "warning", "danger", "tip"]).catch("info"),
    title: str(160).optional(),
    body: InlineMd,
  }),
  z.object({
    type: z.literal("card"),
    title: str(160),
    body: InlineMd,
    footer: str(200).optional(),
  }),
  z.object({
    type: z.literal("table"),
    columns: z.array(str(80)).min(1).max(8),
    rows: z.array(z.array(str(600)).max(8)).max(60),
  }),
  z.object({
    type: z.literal("chart"),
    chart: z.enum(["bar", "line", "area", "pie"]).catch("bar"),
    data: z.array(z.record(z.string(), z.union([z.string(), z.number()]))).min(1).max(60),
    xKey: str(60),
    series: z.array(str(60)).min(1).max(6),
  }),
  z.object({
    type: z.literal("timeline"),
    items: z.array(z.object({ when: str(80), label: str(400) })).min(1).max(40),
  }),
  z.object({
    type: z.literal("steps"),
    ordered: z.coerce.boolean().catch(true),
    items: z.array(str(500)).min(1).max(30),
  }),
  z.object({
    type: z.literal("keyValue"),
    pairs: z.array(z.object({ key: str(100), value: str(500) })).min(1).max(30),
  }),
  z.object({
    type: z.literal("comparison"),
    columns: z.array(str(80)).min(2).max(3),
    rows: z.array(z.object({ label: str(160), cells: z.array(InlineMd).min(1).max(3) })).min(1).max(40),
  }),
  z.object({
    type: z.literal("quiz"),
    question: str(500),
    options: z.array(str(300)).min(2).max(6),
    answerIndex: z.coerce.number().int().nonnegative().catch(0),
    explanation: InlineMd.optional(),
  }),
]);

export type ResponseBlock = z.infer<typeof BlockSchema>;

// Map common synonyms the model might use to our canonical block types.
const TYPE_ALIASES: Record<string, string> = {
  "key_value": "keyValue", "key-value": "keyValue", "keyvalue": "keyValue", "kv": "keyValue", "facts": "keyValue",
  "bullets": "steps", "list": "steps", "checklist": "steps", "ordered_list": "steps",
  "note": "callout", "alert": "callout", "warning": "callout", "tip": "callout",
  "compare": "comparison", "comparison_table": "comparison",
  "bar_chart": "chart", "line_chart": "chart", "pie_chart": "chart", "graph": "chart",
};

function normalizeItem(raw: any): any {
  if (!raw || typeof raw !== "object") return raw;
  const item = { ...raw };
  if (typeof item.type === "string") {
    const key = item.type.trim().toLowerCase();
    item.type = TYPE_ALIASES[key] ?? item.type.trim();
  }
  // table: accept object-rows by aligning to columns; coerce values to strings.
  if (item.type === "table" && Array.isArray(item.columns) && Array.isArray(item.rows)) {
    item.rows = item.rows.map((r: any) =>
      Array.isArray(r) ? r
        : (r && typeof r === "object") ? item.columns.map((c: string) => r[c])
          : [r],
    );
  }
  // comparison: accept rows given as { label, <col>: cell } objects.
  if (item.type === "comparison" && Array.isArray(item.columns) && Array.isArray(item.rows)) {
    item.rows = item.rows.map((r: any) => {
      if (r && typeof r === "object" && !Array.isArray(r.cells)) {
        return { label: r.label ?? r.name ?? "", cells: item.columns.map((c: string) => r[c]) };
      }
      return r;
    });
  }
  // chart: tolerate common key aliases.
  if (item.type === "chart") {
    if (!item.xKey && (item.x || item.nameKey || item.labelKey)) item.xKey = item.x ?? item.nameKey ?? item.labelKey;
    if (!item.series && Array.isArray(item.keys)) item.series = item.keys;
    if (!item.chart && typeof item.kind === "string") item.chart = item.kind;
  }
  return item;
}

export interface ParseResult { blocks: ResponseBlock[]; issues: string[]; }

/** Parse + validate; returns valid blocks plus human-readable issues for any
 *  that were dropped (so the model can be told what to fix). */
export function parseBlocksVerbose(raw: unknown): ParseResult {
  let value: unknown = raw;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return { blocks: [], issues: ["arguments were not valid JSON"] }; }
  }
  if (value && typeof value === "object" && !Array.isArray(value) && Array.isArray((value as any).blocks)) {
    value = (value as any).blocks;
  }
  if (!Array.isArray(value)) return { blocks: [], issues: ["expected an array of blocks, or { blocks: [...] }"] };

  const blocks: ResponseBlock[] = [];
  const issues: string[] = [];
  value.slice(0, 20).forEach((item, i) => {
    const norm = normalizeItem(item);
    const parsed = BlockSchema.safeParse(norm);
    if (parsed.success) blocks.push(parsed.data);
    else {
      const t = norm && typeof norm === "object" ? (norm as any).type : undefined;
      const detail = parsed.error.issues.slice(0, 3).map((x) => `${x.path.join(".") || "(root)"}: ${x.message}`).join("; ");
      issues.push(`block ${i} (type=${t ?? "?"}): ${detail}`);
    }
  });
  return { blocks, issues };
}

/** Convenience: just the valid blocks. */
export function parseBlocks(raw: unknown): ResponseBlock[] {
  return parseBlocksVerbose(raw).blocks;
}
