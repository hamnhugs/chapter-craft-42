import { describe, it, expect } from "vitest";
import {
  ACTIVE_KINDS,
  EXTRACT_MIN_LINES,
  KIND_ICON,
  KIND_LABEL,
  WORKSPACE_KINDS,
  WORKSPACE_MAX_CONTENT,
  extensionFor,
  excludeArtifactDuplicates,
  extractCodeBlocks,
  fileFingerprint,
  kindForLanguage,
  mediaTypeFor,
  normalizeKind,
  parseSaveFileArgs,
  safeFilename,
} from "@/lib/workspaceFiles";

/**
 * The Workspace taxonomy's safety properties, pinned.
 *
 * The load-bearing one is the FALLBACK DIRECTION: an unknown kind must become
 * inert text. The old reader coerced anything unrecognised to "research",
 * which renders as markdown — so a file written by a newer client would be
 * INTERPRETED on an older device. Every "never research" assertion below is
 * that bug's tombstone.
 */

describe("normalizeKind", () => {
  it("passes every known kind through unchanged", () => {
    for (const k of WORKSPACE_KINDS) expect(normalizeKind(k)).toBe(k);
  });

  it("degrades garbage to inert text, never to research or html", () => {
    for (const junk of [null, undefined, 42, {}, [], "", "   ", "RESEARCH!!", "<script>"]) {
      expect(normalizeKind(junk)).toBe("text");
    }
  });

  it("degrades a plausible FUTURE kind to text — the cross-device trap", () => {
    // A newer client invents these; this build must show them, never run or
    // parse them.
    for (const future of ["notebook", "spreadsheet", "diagram", "markdown", "pdf"]) {
      const k = normalizeKind(future);
      expect(k).toBe("text");
      expect(k).not.toBe("research");
      expect(ACTIVE_KINDS.has(k)).toBe(false);
    }
  });

  it("is case- and whitespace-tolerant for legacy rows", () => {
    expect(normalizeKind(" HTML ")).toBe("html");
    expect(normalizeKind("Research")).toBe("research");
  });
});

describe("ACTIVE_KINDS", () => {
  it("contains exactly html and svg", () => {
    expect([...ACTIVE_KINDS].sort()).toEqual(["html", "svg"]);
  });

  it("covers every kind with a label and an icon", () => {
    for (const k of WORKSPACE_KINDS) {
      expect(KIND_LABEL[k]).toBeTruthy();
      expect(KIND_ICON[k]).toBeTruthy();
    }
  });
});

describe("kindForLanguage", () => {
  it("never returns an ACTIVE kind — source is not a document to render", () => {
    for (const lang of ["html", "svg", "xhtml", "HTML"]) {
      const k = kindForLanguage(lang);
      expect(ACTIVE_KINDS.has(k)).toBe(false);
      expect(k).toBe("code");
    }
  });

  it("routes data languages to data and prose to text", () => {
    expect(kindForLanguage("json")).toBe("data");
    expect(kindForLanguage("csv")).toBe("data");
    expect(kindForLanguage("yml")).toBe("data");
    expect(kindForLanguage("markdown")).toBe("text");
    expect(kindForLanguage("")).toBe("text");
    expect(kindForLanguage("python")).toBe("code");
    expect(kindForLanguage("sql")).toBe("code");
  });
});

describe("extensionFor / mediaTypeFor", () => {
  it("uses the language when it knows it and the kind's default otherwise", () => {
    expect(extensionFor("code", "python")).toBe(".py");
    expect(extensionFor("data", "csv")).toBe(".csv");
    expect(extensionFor("code", "brainfuck")).toBe(".txt");
    expect(extensionFor("text")).toBe(".txt");
    expect(extensionFor("research")).toBe(".md");
    expect(extensionFor("svg", "python")).toBe(".svg"); // kind wins for fixed shapes
  });

  it("falls back to an inert octet-stream for a kind it does not know", () => {
    expect(mediaTypeFor("notebook" as never)).toBe("application/octet-stream");
    expect(mediaTypeFor("data", "json")).toBe("application/json");
    expect(mediaTypeFor("text")).toBe("text/plain");
  });
});

describe("safeFilename", () => {
  it("cannot traverse a directory or write an absolute path", () => {
    expect(safeFilename("../../etc/passwd", "code", "sh")).toBe("etc-passwd.sh");
    expect(safeFilename("/etc/shadow", "text")).toBe("etc-shadow.txt");
    expect(safeFilename("C:\\Windows\\System32\\evil", "code", "py")).toBe("C-Windows-System32-evil.py");
    for (const t of ["../../x", "..\\..\\x", "a/b/c"]) {
      const name = safeFilename(t, "text");
      expect(name).not.toMatch(/[\\/]/);
      expect(name).not.toContain("..");
    }
  });

  it("strips control characters and bidi overrides used to spoof extensions", () => {
    const spoof = "invoice\u202Egpj.exe";
    const name = safeFilename(spoof, "text");
    expect(name).not.toContain("\u202E");
    expect(name.endsWith(".txt")).toBe(true);
    expect(safeFilename("a\u0000b\u001fc", "text")).toBe("a-b-c.txt");
  });

  it("refuses hidden files, empty names and Windows device names", () => {
    expect(safeFilename("...", "text")).toBe("file.txt");
    expect(safeFilename("", "text")).toBe("file.txt");
    expect(safeFilename("   ", "text")).toBe("file.txt");
    expect(safeFilename(".bashrc", "text")).toBe("bashrc.txt");
    expect(safeFilename("con", "text")).toBe("_con.txt");
    expect(safeFilename("con.txt", "text")).toBe("_con.txt");
  });

  it("caps absurd lengths and still lands a correct extension", () => {
    const name = safeFilename("z".repeat(5000), "code", "py");
    expect(name.length).toBeLessThanOrEqual(90);
    expect(name.endsWith(".py")).toBe(true);
  });

  it("does not double an extension the title already carries", () => {
    expect(safeFilename("report.md", "research")).toBe("report.md");
    expect(safeFilename("REPORT.MD", "research")).toBe("REPORT.MD");
    expect(safeFilename("notes", "research")).toBe("notes.md");
  });
});

describe("extractCodeBlocks", () => {
  const long = (label: string, n = 10) =>
    Array.from({ length: n }, (_, i) => `${label} line ${i}`).join("\n");

  it("pulls every substantial fence out of a reply that mixes prose and code", () => {
    const reply =
      `Here is the plan.\n\n## Fetch script\n\n\`\`\`python\n${long("py")}\n\`\`\`\n\n` +
      `And the schema:\n\n## Schema\n\n\`\`\`sql\n${long("sql")}\n\`\`\`\n\nDone.`;
    const files = extractCodeBlocks(reply);
    expect(files.length).toBe(2);
    expect(files[0]).toMatchObject({ kind: "code", language: "py", title: "Fetch script" });
    expect(files[1]).toMatchObject({ kind: "code", language: "sql", title: "Schema" });
    expect(files[0].content.split("\n").length).toBe(10);
    expect(files[0].content).not.toContain("```");
  });

  it("skips a tiny fence — three lines of shell is conversation, not a file", () => {
    const reply = "Run:\n\n```sh\ncd app\nnpm ci\nnpm test\n```\n";
    expect(extractCodeBlocks(reply)).toEqual([]);
  });

  it("skips an unlabelled fence even when it is long", () => {
    const reply = `Output:\n\n\`\`\`\n${long("raw", 40)}\n\`\`\`\n`;
    expect(extractCodeBlocks(reply)).toEqual([]);
  });

  it("keeps a nested triple-backtick block intact inside a longer fence", () => {
    const inner = "```js\nconsole.log(1)\n```";
    const reply = `Docs:\n\n\`\`\`\`md\n# Title\n\n${inner}\n\n${long("md", 8)}\n\`\`\`\`\n`;
    const files = extractCodeBlocks(reply);
    expect(files.length).toBe(1);
    expect(files[0].content).toContain("```js");
    expect(files[0].content).toContain("console.log(1)");
    expect(files[0].kind).toBe("text"); // md is prose, not source
  });

  it("takes its title from a filename comment on the first line", () => {
    const reply = `\`\`\`ts\n// src/lib/rate-limit.ts\n${long("ts")}\n\`\`\`\n`;
    const files = extractCodeBlocks(reply);
    expect(files[0].title).toBe("src/lib/rate-limit.ts");
    // The comment stays in the file — it is part of the source.
    expect(files[0].content.startsWith("// src/lib/rate-limit.ts")).toBe(true);
  });

  it("lets a filename comment rescue a SHORT block, and prefers it over a heading", () => {
    const reply = "## Config\n\n```yaml\n# deploy/values.yaml\nreplicas: 2\n```\n";
    const files = extractCodeBlocks(reply);
    expect(files.length).toBe(1);
    expect(files[0]).toMatchObject({ title: "deploy/values.yaml", kind: "data", language: "yaml" });
  });

  it("falls back to a language-named title when nothing else is available", () => {
    const files = extractCodeBlocks(`\`\`\`py\n${long("x")}\n\`\`\``);
    expect(files[0].title).toBe("Python snippet");
  });

  it("does not reuse one heading for every following block", () => {
    const reply = `## Fetch script\n\n\`\`\`py\n${long("a")}\n\`\`\`\n\n\`\`\`sql\n${long("b")}\n\`\`\``;
    const files = extractCodeBlocks(reply);
    expect(files.map((f) => f.title)).toEqual(["Fetch script", "SQL snippet"]);
  });

  it("is pure and stable: same input, byte-identical output every call", () => {
    const reply = `## A\n\n\`\`\`py\n${long("a")}\n\`\`\`\n\n## B\n\n\`\`\`json\n${long("b")}\n\`\`\``;
    expect(JSON.stringify(extractCodeBlocks(reply))).toBe(JSON.stringify(extractCodeBlocks(reply)));
  });

  it("dedupes by CONTENT identity, not position", () => {
    const body = long("same");
    const reply = `Before:\n\n\`\`\`py\n${body}\n\`\`\`\n\nUnchanged:\n\n\`\`\`py\n${body}\n\`\`\``;
    const files = extractCodeBlocks(reply);
    expect(files.length).toBe(1);
    const a = extractCodeBlocks(reply)[0];
    expect(fileFingerprint(a)).toBe(fileFingerprint(files[0]));
  });

  it("obeys maxFiles and minLines", () => {
    const reply = Array.from(
      { length: 8 },
      (_, i) => `\`\`\`py\n${long(`f${i}`)}\n\`\`\``
    ).join("\n\n");
    expect(extractCodeBlocks(reply).length).toBeLessThanOrEqual(5);
    expect(extractCodeBlocks(reply, { maxFiles: 2 }).length).toBe(2);
    expect(extractCodeBlocks("```py\na = 1\nb = 2\n```", { minLines: 2 }).length).toBe(1);
    expect(EXTRACT_MIN_LINES).toBeGreaterThan(2);
  });

  it("never yields an ACTIVE kind, whatever the fence claims", () => {
    const reply = `\`\`\`html\n${long("<p>hi</p>")}\n\`\`\`\n\n\`\`\`svg\n${long("<circle/>")}\n\`\`\``;
    for (const f of extractCodeBlocks(reply)) expect(ACTIVE_KINDS.has(f.kind)).toBe(false);
  });

  it("survives an unclosed fence at the end of a truncated reply", () => {
    const files = extractCodeBlocks(`\`\`\`py\n${long("cut")}`);
    expect(files.length).toBe(1);
    expect(files[0].language).toBe("py");
  });

  it("returns nothing for empty or non-string input", () => {
    expect(extractCodeBlocks("")).toEqual([]);
    expect(extractCodeBlocks(undefined as never)).toEqual([]);
    expect(extractCodeBlocks("Just prose, no fences at all.")).toEqual([]);
  });
});

describe("excludeArtifactDuplicates", () => {
  const long = (label: string, n = 10) =>
    Array.from({ length: n }, (_, i) => `${label} line ${i}`).join("\n");

  it("drops a fence the same turn already filed as an artifact", () => {
    const body = long("<p>x</p>");
    const files = extractCodeBlocks(`\`\`\`html\n${body}\n\`\`\`\n\n\`\`\`py\n${long("keep")}\n\`\`\``);
    expect(files.length).toBe(2);
    const kept = excludeArtifactDuplicates(files, [`\n${body}\n`]);
    expect(kept.map((f) => f.language)).toEqual(["py"]);
  });

  it("is a no-op with no artifacts", () => {
    const files = extractCodeBlocks(`\`\`\`py\n${long("a")}\n\`\`\``);
    expect(excludeArtifactDuplicates(files, [])).toBe(files);
    expect(excludeArtifactDuplicates(files, undefined as never)).toBe(files);
  });
});

describe("parseSaveFileArgs", () => {
  it("rejects empty content with a sentence the model can act on", () => {
    for (const bad of [{ content: "" }, { content: "   \n\t" }, { title: "x" }]) {
      const r = parseSaveFileArgs(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/empty/i);
    }
  });

  it("rejects a non-object argument", () => {
    for (const bad of [null, undefined, "content", 7, ["a"]]) {
      const r = parseSaveFileArgs(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/save_file expects/);
    }
  });

  it("rejects oversized content, naming both numbers", () => {
    const r = parseSaveFileArgs({ content: "x".repeat(WORKSPACE_MAX_CONTENT + 1) });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain(String(WORKSPACE_MAX_CONTENT + 1));
      expect(r.error).toContain(String(WORKSPACE_MAX_CONTENT));
      expect(r.error).toMatch(/parts/i);
    }
  });

  it("accepts a well-formed call and resolves kind from the language", () => {
    const r = parseSaveFileArgs({ title: "Backfill", language: "SQL", content: "select 1;" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.file).toEqual({ title: "Backfill", kind: "code", language: "sql", content: "select 1;" });
  });

  it("derives language and title from a filename when only that is given", () => {
    const r = parseSaveFileArgs({ filename: "reports/q3.csv", content: "a,b\n1,2" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.file).toMatchObject({ kind: "data", language: "csv", title: "reports/q3.csv" });
  });

  it("cannot mint an ACTIVE or markdown-rendered kind — that is create_artifact's job", () => {
    for (const kind of ["html", "svg", "research"]) {
      const r = parseSaveFileArgs({ kind, language: "html", content: "<p>hi</p>", title: "Page" });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(ACTIVE_KINDS.has(r.file.kind)).toBe(false);
        expect(r.file.kind).not.toBe("research");
        // The file still LANDS — nothing is stranded, it just cannot execute.
        expect(r.file.content).toBe("<p>hi</p>");
      }
    }
  });

  it("honours an explicit inert kind, including tool", () => {
    const r = parseSaveFileArgs({ kind: "tool", content: "async function run(){}", title: "runner" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.file.kind).toBe("tool");
  });

  it("ignores a garbage kind rather than failing the save", () => {
    const r = parseSaveFileArgs({ kind: "notebook", language: "py", content: "print(1)" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.file.kind).toBe("code");
  });
});

describe("fileFingerprint", () => {
  it("is stable for identical content and differs when content differs", () => {
    const a = { kind: "code" as const, language: "py", content: "print(1)" };
    expect(fileFingerprint(a)).toBe(fileFingerprint({ ...a }));
    expect(fileFingerprint(a)).not.toBe(fileFingerprint({ ...a, content: "print(2)" }));
    expect(fileFingerprint(a)).not.toBe(fileFingerprint({ ...a, kind: "text" }));
    // A language alias is the same file.
    expect(fileFingerprint(a)).toBe(fileFingerprint({ ...a, language: "python" }));
  });
});
