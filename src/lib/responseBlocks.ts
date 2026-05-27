import { z } from "zod";

// Whitelisted, validated "blocks" the assistant may emit (via the render_blocks
// tool) to present rich, structured content inline. The model can only pick
// from these shapes; the client renders each with a trusted component and
// silently drops anything that doesn't validate. Text fields are markdown.

const InlineMd = z.string().max(4000);

export const BlockSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("callout"),
    variant: z.enum(["info", "success", "warning", "danger", "tip"]).default("info"),
    title: z.string().max(160).optional(),
    body: InlineMd,
  }),
  z.object({
    type: z.literal("card"),
    title: z.string().max(160),
    body: InlineMd,
    footer: z.string().max(200).optional(),
  }),
  z.object({
    type: z.literal("table"),
    columns: z.array(z.string().max(80)).min(1).max(8),
    rows: z.array(z.array(z.string().max(600)).max(8)).max(60),
  }),
  z.object({
    type: z.literal("chart"),
    chart: z.enum(["bar", "line", "area", "pie"]),
    data: z.array(z.record(z.string(), z.union([z.string(), z.number()]))).min(1).max(60),
    xKey: z.string().max(60),
    series: z.array(z.string().max(60)).min(1).max(6),
  }),
  z.object({
    type: z.literal("timeline"),
    items: z.array(z.object({ when: z.string().max(80), label: z.string().max(400) })).min(1).max(40),
  }),
  z.object({
    type: z.literal("steps"),
    ordered: z.boolean().default(true),
    items: z.array(z.string().max(500)).min(1).max(30),
  }),
  z.object({
    type: z.literal("keyValue"),
    pairs: z.array(z.object({ key: z.string().max(100), value: z.string().max(500) })).min(1).max(30),
  }),
  z.object({
    type: z.literal("comparison"),
    columns: z.array(z.string().max(80)).min(2).max(3),
    rows: z.array(z.object({ label: z.string().max(160), cells: z.array(InlineMd).min(1).max(3) })).min(1).max(40),
  }),
  z.object({
    type: z.literal("quiz"),
    question: z.string().max(500),
    options: z.array(z.string().max(300)).min(2).max(6),
    answerIndex: z.number().int().nonnegative(),
    explanation: InlineMd.optional(),
  }),
]);

export type ResponseBlock = z.infer<typeof BlockSchema>;

/**
 * Parse + validate a blocks payload from the model. Accepts a JSON string,
 * an array, or an object of shape { blocks: [...] }. Invalid/unknown blocks
 * are dropped rather than throwing, so a single bad block never breaks the UI.
 */
export function parseBlocks(raw: unknown): ResponseBlock[] {
  let value: unknown = raw;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return []; }
  }
  if (value && typeof value === "object" && !Array.isArray(value) && Array.isArray((value as any).blocks)) {
    value = (value as any).blocks;
  }
  if (!Array.isArray(value)) return [];
  const out: ResponseBlock[] = [];
  for (const item of value.slice(0, 20)) {
    const parsed = BlockSchema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}
