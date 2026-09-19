import { ARTIFACT_MAX_CONTENT } from "@/lib/artifacts";

/**
 * Workspace file taxonomy — what the Workspace accepts, and the one rule that
 * keeps widening it safe.
 *
 * THE PROBLEM THIS SOLVES. The Workspace used to accept exactly three kinds
 * (html / svg / research). Everything else the assistant produced — a Python
 * script, a SQL migration, a JSON payload, an outline, the source of a tool it
 * forged — was stranded in the transcript and lost on the next reload. Every
 * filesystem-backed product (Cursor, Bolt, Replit, Windsurf) strands nothing;
 * every allowlist product strands output, including Claude's own Artifacts.
 *
 * THE INSIGHT. The allowlist was a RENDERING rule misapplied as an ACCEPTANCE
 * rule. web.dev's "Securely hosting user data" splits ACTIVE types (HTML,
 * JavaScript, SVG — types a browser will execute) from inactive everything
 * else. Both dangerous kinds ALREADY passed the old gate. Accepting code, text
 * and data therefore adds ZERO attack surface at the storage layer: the danger
 * lives entirely at the render layer, and the render layer keeps its allowlist
 * (see ACTIVE_KINDS — only those two ever reach a sandboxed frame).
 *
 * THE FALLBACK DIRECTION MATTERS. An unrecognised kind must degrade to inert
 * text, never to markdown and never to a frame. `normalizeKind` is the single
 * choke point for that, and `rowToItem` in workspaceStore calls it so a row
 * written by a NEWER client (a kind this build has never heard of) renders as
 * plain text on an older device instead of being interpreted.
 *
 * INJECTION. Everything stored here can re-enter model context through
 * `read_workspace_item` and the pinned-focus block, so every kind rides the
 * same nonce-fenced, never-obey path. Nothing in this module bypasses it.
 */

export type WorkspaceItemKind =
  | "html"
  | "svg"
  | "research"
  | "code"
  | "text"
  | "data"
  | "tool";

export const WORKSPACE_KINDS: readonly WorkspaceItemKind[] = [
  "html",
  "svg",
  "research",
  "code",
  "text",
  "data",
  "tool",
] as const;

/**
 * ACTIVE per web.dev: a browser will EXECUTE these. They render only inside
 * the sandboxed iframe (`allow-scripts` WITHOUT `allow-same-origin`, which MDN
 * is explicit about: combining the two "lets the embedded document remove the
 * sandbox attribute", i.e. no sandbox at all). Supabase Storage rewrites HTML
 * content types and cannot set response headers, so the frame is the ONLY
 * boundary available in this stack — sanitization is hygiene, not a boundary.
 *
 * Nothing outside this set may ever be handed to ArtifactFrame,
 * dangerouslySetInnerHTML, or ReactMarkdown.
 */
export const ACTIVE_KINDS: ReadonlySet<WorkspaceItemKind> = new Set<WorkspaceItemKind>(["html", "svg"]);

const KNOWN_KINDS = new Set<string>(WORKSPACE_KINDS);

/**
 * The reader's safety valve. Anything this build does not recognise — garbage,
 * a truncated column, or a kind a future client invented — becomes inert
 * "text". Never "research" (that path renders markdown) and never "html".
 */
export function normalizeKind(raw: unknown): WorkspaceItemKind {
  if (typeof raw !== "string") return "text";
  const k = raw.trim().toLowerCase();
  return KNOWN_KINDS.has(k) ? (k as WorkspaceItemKind) : "text";
}

export function isActiveKind(kind: unknown): boolean {
  return typeof kind === "string" && ACTIVE_KINDS.has(kind as WorkspaceItemKind);
}

// ---- Languages ------------------------------------------------------------

/** Normalize a fence info string / language hint to a bare token. */
export function normalizeLanguage(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const first = raw.trim().toLowerCase().split(/[\s,;{}]+/).filter(Boolean)[0] || "";
  return first.replace(/^[.`]+/, "").replace(/[^a-z0-9+#._-]/g, "").slice(0, 24);
}

const LANGUAGE_ALIAS: Record<string, string> = {
  javascript: "js",
  node: "js",
  mjs: "js",
  cjs: "js",
  typescript: "ts",
  golang: "go",
  python: "py",
  python3: "py",
  ruby: "rb",
  rust: "rs",
  shell: "sh",
  bash: "sh",
  zsh: "sh",
  console: "sh",
  markdown: "md",
  yml: "yaml",
  "c++": "cpp",
  "c#": "cs",
  csharp: "cs",
  objectivec: "objc",
  kotlin: "kt",
  postgres: "sql",
  postgresql: "sql",
  plaintext: "text",
  plain: "text",
  txt: "text",
  jsonc: "json",
  json5: "json",
};

function canonicalLanguage(language: unknown): string {
  const l = normalizeLanguage(language);
  return LANGUAGE_ALIAS[l] || l;
}

/** Languages whose payload is DATA, not program text. */
const DATA_LANGUAGES = new Set([
  "json",
  "jsonl",
  "ndjson",
  "csv",
  "tsv",
  "yaml",
  "toml",
  "xml",
  "ini",
  "geojson",
  "properties",
]);

/** Languages that are prose, not source. */
const TEXT_LANGUAGES = new Set(["text", "md", "rst", "adoc", "org", "log", "diff", "patch"]);

/**
 * Which kind a fenced/declared language lands as.
 *
 * DELIBERATELY NEVER RETURNS AN ACTIVE KIND. A ```html or ```svg fence is
 * SOURCE the assistant wrote about, not a document it asked to render — it is
 * stored as inert `code` and shown in the text viewer. Only `create_artifact`
 * (whose zod schema still says `z.enum(["html","svg"])`) mints a renderable
 * item, so no extractor and no save_file call can escalate into the frame.
 */
export function kindForLanguage(language: string): WorkspaceItemKind {
  const l = canonicalLanguage(language);
  if (!l) return "text";
  if (DATA_LANGUAGES.has(l)) return "data";
  if (TEXT_LANGUAGES.has(l)) return "text";
  return "code";
}

const LANGUAGE_LABEL: Record<string, string> = {
  js: "JavaScript",
  jsx: "JSX",
  ts: "TypeScript",
  tsx: "TSX",
  py: "Python",
  rb: "Ruby",
  rs: "Rust",
  go: "Go",
  sh: "Shell",
  sql: "SQL",
  json: "JSON",
  jsonl: "JSONL",
  csv: "CSV",
  tsv: "TSV",
  yaml: "YAML",
  toml: "TOML",
  xml: "XML",
  html: "HTML",
  svg: "SVG",
  css: "CSS",
  scss: "SCSS",
  md: "Markdown",
  java: "Java",
  cpp: "C++",
  cs: "C#",
  c: "C",
  php: "PHP",
  swift: "Swift",
  kt: "Kotlin",
  r: "R",
  lua: "Lua",
  dart: "Dart",
  text: "Text",
  diff: "Diff",
};

/** Human label for a language token ("py" → "Python"). */
export function languageLabel(language: string): string {
  const l = canonicalLanguage(language);
  if (!l) return "Text";
  return LANGUAGE_LABEL[l] || l.toUpperCase();
}

// ---- Extensions & media types --------------------------------------------

const LANGUAGE_EXT: Record<string, string> = {
  js: ".js",
  jsx: ".jsx",
  ts: ".ts",
  tsx: ".tsx",
  py: ".py",
  rb: ".rb",
  rs: ".rs",
  go: ".go",
  sh: ".sh",
  sql: ".sql",
  json: ".json",
  jsonl: ".jsonl",
  ndjson: ".ndjson",
  csv: ".csv",
  tsv: ".tsv",
  yaml: ".yaml",
  toml: ".toml",
  xml: ".xml",
  ini: ".ini",
  geojson: ".geojson",
  properties: ".properties",
  html: ".html",
  svg: ".svg",
  css: ".css",
  scss: ".scss",
  less: ".less",
  md: ".md",
  rst: ".rst",
  java: ".java",
  cpp: ".cpp",
  cs: ".cs",
  c: ".c",
  h: ".h",
  php: ".php",
  swift: ".swift",
  kt: ".kt",
  r: ".r",
  lua: ".lua",
  dart: ".dart",
  vue: ".vue",
  svelte: ".svelte",
  dockerfile: ".dockerfile",
  graphql: ".graphql",
  diff: ".diff",
  patch: ".patch",
  text: ".txt",
  log: ".log",
};

const KIND_DEFAULT_EXT: Record<WorkspaceItemKind, string> = {
  html: ".html",
  svg: ".svg",
  research: ".md",
  code: ".txt",
  text: ".txt",
  data: ".txt",
  tool: ".js",
};

/** File extension (with the dot) for a kind, refined by language when known. */
export function extensionFor(kind: WorkspaceItemKind, language?: string): string {
  // Kind wins for the fixed-shape kinds; language only refines the free ones.
  if (kind === "html" || kind === "svg" || kind === "research") return KIND_DEFAULT_EXT[kind];
  const l = canonicalLanguage(language);
  const byLang = l ? LANGUAGE_EXT[l] : undefined;
  if (byLang) return byLang;
  return KIND_DEFAULT_EXT[kind] || ".txt";
}

const LANGUAGE_MEDIA: Record<string, string> = {
  js: "text/javascript",
  jsx: "text/javascript",
  ts: "text/plain",
  tsx: "text/plain",
  json: "application/json",
  jsonl: "application/x-ndjson",
  ndjson: "application/x-ndjson",
  geojson: "application/geo+json",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  yaml: "application/yaml",
  toml: "application/toml",
  xml: "application/xml",
  css: "text/css",
  md: "text/markdown",
  sql: "application/sql",
  sh: "application/x-sh",
  py: "text/x-python",
};

const KIND_DEFAULT_MEDIA: Record<WorkspaceItemKind, string> = {
  html: "text/html",
  svg: "image/svg+xml",
  research: "text/markdown",
  code: "text/plain",
  text: "text/plain",
  data: "text/plain",
  tool: "text/javascript",
};

/**
 * The honest media type for a kind (stored on `meta.mediaType`). Anything this
 * build does not recognise is `application/octet-stream` — an inert type no
 * browser will interpret.
 *
 * NOTE this is NOT what the downloader puts on the Blob for active kinds; see
 * `downloadBlobType`.
 */
export function mediaTypeFor(kind: WorkspaceItemKind, language?: string): string {
  if (!KNOWN_KINDS.has(kind as string)) return "application/octet-stream";
  if (kind === "html" || kind === "svg" || kind === "research") return KIND_DEFAULT_MEDIA[kind];
  const l = canonicalLanguage(language);
  const byLang = l ? LANGUAGE_MEDIA[l] : undefined;
  return byLang || KIND_DEFAULT_MEDIA[kind] || "application/octet-stream";
}

/**
 * The type the DOWNLOAD blob carries. Active kinds ship as
 * application/octet-stream on purpose: in Chromium a `blob:` URL inherits the
 * creating page's origin, so a `text/html` or `image/svg+xml` blob is a live
 * same-origin document one navigation away. A download never needs a live
 * type, and the file's extension is what the OS opens it with anyway.
 */
function downloadBlobType(kind: WorkspaceItemKind, language?: string): string {
  if (isActiveKind(kind)) return "application/octet-stream";
  const type = mediaTypeFor(kind, language);
  return type.startsWith("text/") || type === "application/json" ? `${type};charset=utf-8` : type;
}

// ---- Filenames ------------------------------------------------------------

const MAX_FILENAME_BASE = 80;
// Win32 device names are still special with an extension ("con.txt" is CON).
const RESERVED_BASENAMES = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/**
 * A filename that cannot escape a directory, cannot spoof its own extension,
 * and cannot be a control-character or right-to-left-override trick.
 *
 * ASCII-only by construction (matching the existing `downloadSheetSvg`
 * convention): the whitelist drops U+202E and friends, which is the classic
 * "gpj.exe renders as exe.jpg" attack, along with every path separator, quote,
 * and shell metacharacter.
 */
export function safeFilename(title: string, kind: WorkspaceItemKind, language?: string): string {
  const ext = extensionFor(kind, language);
  let base = String(title ?? "")
    // Control + C1 characters first, before anything can hide behind them.
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    // Path separators — the whole point: no traversal, no absolute paths.
    .replace(/[\\/]+/g, " ")
    // ASCII whitelist: word chars, dot, dash. Everything else collapses.
    .replace(/[^\w.-]+/g, "-")
    .replace(/-{2,}/g, "-")
    // Leading dots (hidden files) and dashes (argument-shaped names).
    .replace(/^[.\-]+/, "")
    // Windows silently strips trailing dots/spaces, which would defeat the
    // extension we are about to append.
    .replace(/[.\-]+$/, "");

  if (base.length > MAX_FILENAME_BASE) {
    base = base.slice(0, MAX_FILENAME_BASE).replace(/[.\-]+$/, "");
  }
  if (!base || /^\.+$/.test(base)) base = "file";
  // "con.txt" IS the CON device on Windows — test the stem, not the whole name.
  if (RESERVED_BASENAMES.test(base.split(".")[0])) base = `_${base}`;

  return base.toLowerCase().endsWith(ext.toLowerCase()) ? base : `${base}${ext}`;
}

/**
 * Save any workspace file to disk. The terminal fallback for every kind the
 * app cannot render — nothing is ever dropped, at worst it is downloadable.
 *
 * Follows the `downloadSheetSvg` precedent: detached anchor, synchronous
 * click, revoke on the NEXT tick (revoking synchronously cancels the download
 * in some engines before the blob has been read).
 */
export function downloadWorkspaceFile(input: {
  title: string;
  kind: WorkspaceItemKind;
  language?: string;
  content: string;
}): void {
  if (typeof document === "undefined" || typeof URL === "undefined" || !URL.createObjectURL) return;
  const blob = new Blob([input.content ?? ""], { type: downloadBlobType(input.kind, input.language) });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = safeFilename(input.title, input.kind, input.language);
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// ---- Presentation ---------------------------------------------------------

export const KIND_LABEL: Record<WorkspaceItemKind, string> = {
  html: "HTML",
  svg: "SVG",
  research: "Research",
  code: "Code",
  text: "Text",
  data: "Data",
  tool: "Tool",
};

/** material-symbols-outlined glyph names. */
export const KIND_ICON: Record<WorkspaceItemKind, string> = {
  html: "deployed_code",
  svg: "image",
  research: "travel_explore",
  code: "code",
  text: "description",
  data: "data_object",
  tool: "handyman",
};

// ---- Extraction -----------------------------------------------------------

export interface ExtractedFile {
  title: string;
  kind: WorkspaceItemKind;
  language: string;
  content: string;
}

export interface ExtractCodeBlocksOptions {
  /** Fences shorter than this are conversational, not files. */
  minLines?: number;
  /** Ceiling per reply, so one chatty turn cannot flood the Workspace. */
  maxFiles?: number;
}

export const EXTRACT_MIN_LINES = 8;
export const EXTRACT_MAX_FILES = 5;
/** Same ceiling artifacts use — one number for "too big to store". */
export const WORKSPACE_MAX_CONTENT = ARTIFACT_MAX_CONTENT;

/** Longest title we keep from a heading / filename comment. */
const MAX_TITLE = 120;

function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * Stable identity for a file's CONTENT (not its position in a reply). The
 * integrator stores this on `meta.fingerprint`, so re-running the extractor
 * over the same reply — a re-render, a retry, a realtime echo — files the
 * block once instead of once per pass.
 *
 * A dedupe key, deliberately not a security digest.
 */
export function fileFingerprint(input: { kind: WorkspaceItemKind; language?: string; content: string }): string {
  // Normalized, because the SAME file arrives by two routes in one turn: the
  // model calls save_file with the text, then shows it in its reply and the
  // extractor picks the fence up. Those two copies differ only in line endings
  // and trailing blank lines, which is exactly enough to defeat a raw hash and
  // leave the user with two of everything.
  const content = (input.content ?? "").replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").trim();
  return `${input.kind}:${canonicalLanguage(input.language) || "-"}:${content.length}:${fnv1a(content)}`;
}

/** `// src/lib/foo.ts`, `# foo.py`, `<!-- page.html -->`, `-- up.sql`, … */
const FILENAME_COMMENT =
  /^\s*(?:\/\/+|#+|--|;+|%+|\/\*+|\*|<!--)\s*(?:file(?:name)?|path)?\s*:?\s*([\w./\\-]+\.[A-Za-z][A-Za-z0-9]{0,7})\s*(?:\*\/|-->)?\s*$/;

const ATX_HEADING = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;

function stripIndent(line: string, upTo: number): string {
  let i = 0;
  while (i < upTo && i < line.length && line[i] === " ") i++;
  return line.slice(i);
}

function isClosingFence(line: string, ch: string, min: number): boolean {
  const s = line.replace(/^ {0,3}/, "");
  let n = 0;
  while (n < s.length && s[n] === ch) n++;
  return n >= min && s.slice(n).trim() === "";
}

function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === "") start++;
  while (end > start && lines[end - 1].trim() === "") end--;
  return lines.slice(start, end);
}

function cleanTitle(raw: string): string {
  return raw
    .replace(/[`*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TITLE);
}

/**
 * Pull substantial fenced code blocks out of an assistant reply.
 *
 * Pure and side-effect-free — no clock, no randomness, no DOM — so the same
 * reply always yields the same files in the same order, and the integrator can
 * call it from ChatContext without worrying about when.
 *
 * Skips (deliberately): unlabelled fences, blocks under `minLines` that carry
 * no filename comment, and anything past WORKSPACE_MAX_CONTENT (the transcript
 * still holds it; a clipped "file" would be a lie). Handles CommonMark fence
 * nesting — a ````-opened block may contain ``` lines.
 */
export function extractCodeBlocks(
  markdown: string,
  opts: ExtractCodeBlocksOptions = {}
): ExtractedFile[] {
  const src = typeof markdown === "string" ? markdown : "";
  if (!src) return [];
  const minLines = Math.max(1, Math.floor(opts.minLines ?? EXTRACT_MIN_LINES));
  const maxFiles = Math.max(0, Math.floor(opts.maxFiles ?? EXTRACT_MAX_FILES));
  if (maxFiles === 0) return [];

  const lines = src.split(/\r\n|\r|\n/);
  const out: ExtractedFile[] = [];
  const seen = new Set<string>();
  let lastHeading = "";
  let i = 0;

  while (i < lines.length && out.length < maxFiles) {
    const line = lines[i];
    const open = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
    if (!open) {
      const h = ATX_HEADING.exec(line);
      if (h) lastHeading = cleanTitle(h[2]);
      i++;
      continue;
    }

    const indent = open[1].length;
    const fence = open[2];
    const fenceChar = fence[0];
    const info = open[3].trim();
    // CommonMark: a backtick fence's info string may not contain a backtick,
    // otherwise `` `code` `` inline spans would open phantom blocks.
    if (fenceChar === "`" && info.includes("`")) {
      i++;
      continue;
    }

    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      if (isClosingFence(lines[j], fenceChar, fence.length)) break;
      body.push(stripIndent(lines[j], indent));
    }
    const nextIndex = j < lines.length ? j + 1 : lines.length;

    const language = canonicalLanguage(info);
    const kept = trimBlankEdges(body);
    const content = kept.join("\n");
    const first = kept.length > 0 ? kept[0] : "";
    const fileComment = FILENAME_COMMENT.exec(first);
    const filenameTitle = fileComment ? cleanTitle(fileComment[1]) : "";

    // An unlabelled fence is a terminal transcript, a quote, or ASCII art far
    // more often than a file — and without a language we could not name it.
    const substantial = kept.length >= minLines || !!filenameTitle;
    const storable = content.trim().length > 0 && content.length <= WORKSPACE_MAX_CONTENT;

    if (language && substantial && storable) {
      const kind = kindForLanguage(language);
      const title =
        filenameTitle || lastHeading || `${languageLabel(language)} snippet`;
      const file: ExtractedFile = { title, kind, language, content };
      const fp = fileFingerprint(file);
      // Content identity, not position: a reply that repeats the same block
      // (a "before" and an unchanged "after") files it once.
      if (!seen.has(fp)) {
        seen.add(fp);
        out.push(file);
      }
    }

    // A heading describes the ONE block it introduces. Without this reset, a
    // reply with a single heading and three fences would file three files all
    // called "Fetch script".
    lastHeading = "";
    i = nextIndex;
  }

  return out;
}

/**
 * Drop extracted blocks whose text is already being filed by another path —
 * in practice the artifacts of the same turn.
 *
 * A model that BOTH calls create_artifact AND pastes the same source in a
 * fence would otherwise put two copies of one document in the Workspace, one
 * renderable and one inert. The artifact wins (it is the richer surface); the
 * fence is dropped. Comparison is on trimmed content, the same identity
 * ChatContext already uses to dedupe artifacts against the transcript tail.
 */
export function excludeArtifactDuplicates(
  files: ExtractedFile[],
  artifactContents: readonly string[]
): ExtractedFile[] {
  if (!files.length || !artifactContents?.length) return files;
  const taken = new Set(artifactContents.map((c) => (c || "").trim()));
  return files.filter((f) => !taken.has((f.content || "").trim()));
}

// ---- save_file argument validation ---------------------------------------

/** Kinds the model may write directly. Deliberately excludes the ACTIVE kinds
 *  (create_artifact is the only path to a rendered frame) and "research" (the
 *  only markdown-rendered kind, reserved for web-derived reports). */
const SAVEABLE_KINDS = new Set<WorkspaceItemKind>(["code", "text", "data", "tool"]);

function languageFromFilename(filename: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(filename || "").trim());
  if (!m) return "";
  const ext = m[1].toLowerCase();
  if (ext === "txt") return "text";
  if (ext === "yml") return "yaml";
  return canonicalLanguage(ext);
}

/**
 * Result of validating a save_file call.
 *
 * The `?: never` companions are not decoration. This project compiles with
 * `strict: false`, and with strictNullChecks off a truthiness test cannot
 * eliminate a union member — so the obvious `if (!r.ok) return r.error;` in a
 * caller would FAIL to typecheck against a bare discriminated union. With the
 * companions, both properties are always readable (and still impossible to
 * populate on the wrong branch), so callers can write the natural guard.
 */
export type ParsedSaveFile =
  | { ok: true; file: ExtractedFile; error?: never }
  | { ok: false; error: string; file?: never };

/**
 * Validate a `save_file` tool call. Returns a typed error instead of throwing,
 * so the executor can hand the model a sentence it can act on rather than a
 * stack trace.
 *
 * Accepts `{ title?, filename?, language?, kind?, content }`. `kind` is a hint
 * only: an html/svg/research request is silently resolved to an inert kind —
 * the file still LANDS (that is the whole point), it just does not gain the
 * right to execute or to be interpreted as markdown.
 */
export function parseSaveFileArgs(args: unknown): ParsedSaveFile {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return {
      ok: false,
      error: "save_file expects an object with `content`, plus optional `title`, `filename` and `language`.",
    };
  }
  const a = args as Record<string, unknown>;

  // Refuse a non-string `content` rather than String()-ing it. A model filling
  // a parameter that IS structured data often passes the object itself, and
  // coercion turned `{users:{id:"uuid"}}` into the 15-character text
  // "[object Object]" \u2014 which then passed the empty and size checks and was
  // reported saved. An array fared no better: newlines became commas. A file
  // silently replaced by a stringification artefact is worse than a refusal
  // the model can act on.
  if (a.content != null && typeof a.content !== "string") {
    return {
      ok: false,
      error:
        "`content` must be the file's text as a single string, not an object or array. " +
        "Serialise it yourself first \u2014 JSON.stringify(value, null, 2) for a .json file \u2014 and pass the result.",
    };
  }
  const raw = typeof a.content === "string" ? a.content : "";
  const content = raw.replace(/^\uFEFF/, "");
  if (content.trim().length === 0) {
    return {
      ok: false,
      error: "`content` is empty — save_file stores the file's actual text, so there is nothing to save.",
    };
  }
  if (content.length > WORKSPACE_MAX_CONTENT) {
    return {
      ok: false,
      error:
        `\`content\` is ${content.length} characters and the limit is ${WORKSPACE_MAX_CONTENT}. ` +
        "Save it in parts (one module or section per call) and say so in your reply.",
    };
  }

  const filename = typeof a.filename === "string" ? a.filename.trim() : "";
  const language = canonicalLanguage(a.language) || languageFromFilename(filename);

  // Match the RAW string against the saveable set — running it through
  // normalizeKind first would turn "notebook" into "text" and let a garbage
  // kind quietly outrank a perfectly good `language`.
  const rawKind = typeof a.kind === "string" ? a.kind.trim().toLowerCase() : "";
  const kind = SAVEABLE_KINDS.has(rawKind as WorkspaceItemKind)
    ? (rawKind as WorkspaceItemKind)
    : kindForLanguage(language);

  const firstLine = content.split(/\r\n|\r|\n/, 1)[0] || "";
  const fileComment = FILENAME_COMMENT.exec(firstLine);
  const title =
    cleanTitle(typeof a.title === "string" ? a.title : "") ||
    cleanTitle(filename) ||
    (fileComment ? cleanTitle(fileComment[1]) : "") ||
    `${languageLabel(language)} file`;

  return { ok: true, file: { title, kind, language, content } };
}
