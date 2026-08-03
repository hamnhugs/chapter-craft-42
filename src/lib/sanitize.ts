// PostgREST filter strings treat `%`, `,`, `(` and `)` as syntax, so any
// user- or model-supplied text that lands inside an .or()/.ilike() filter has
// to come through here. Four files carried private copies of this regex and a
// fifth (search_wiki) had none — which is exactly how an injectable OR shipped.
// One helper, imported everywhere, so the next search can't forget.
//
// `_` is deliberately left alone: it is only a single-character wildcard, which
// is harmless in fuzzy search and stripping it would break queries for names
// like "robot_master". Exact-match lookups (resolve-by-name before an UPDATE)
// must not use ilike at all — use .eq on a normalized value instead.
export function sanitizeIlike(raw: string): string {
  return raw.replace(/[%,()]/g, " ").replace(/\s+/g, " ").trim();
}
