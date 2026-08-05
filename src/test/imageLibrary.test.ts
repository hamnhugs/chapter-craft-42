import { describe, it, expect } from "vitest";
import {
  mergeImageRows,
  deriveProvenance,
  filterImages,
  LibraryAttachmentRow,
  LibraryMemoryRow,
} from "@/lib/imageLibrary";

// The Brain-tab image library projects image_attachments + image_memories
// into one list keyed by storage_path. These tests pin the pure projection:
// the merge (attachment primary, memory folded in), the newest-first order,
// the provenance classes derived from the model/kind strings the writers
// actually use, and the client-side search that finally covers OCR and tags.

const att = (over: Partial<LibraryAttachmentRow> = {}): LibraryAttachmentRow => ({
  id: "att-1",
  prompt: "a red dragon",
  caption: "A dragon rendered in red",
  model: "google/gemini-2.5-flash-image",
  kind: "generated",
  book_id: null,
  storage_path: "uid/aaa.png",
  created_at: "2026-08-01T10:00:00Z",
  ...over,
});

const mem = (over: Partial<LibraryMemoryRow> = {}): LibraryMemoryRow => ({
  id: "mem-1",
  storage_path: "uid/aaa.png",
  caption: "Photo of a whiteboard",
  ocr_text: "Q3 roadmap: ship the library",
  tags: ["whiteboard", "planning"],
  width: 1024,
  height: 768,
  created_at: "2026-07-01T10:00:00Z",
  ...over,
});

describe("mergeImageRows", () => {
  it("dedupes a shared storage_path and keeps the attachment row primary", () => {
    const out = mergeImageRows(
      [att({ id: "a1", storage_path: "uid/shared.jpg", model: "upload", prompt: "User upload — cat.jpg" })],
      [mem({ id: "m1", storage_path: "uid/shared.jpg", created_at: "2026-08-02T00:00:00Z" })],
    );
    expect(out).toHaveLength(1);
    const img = out[0];
    expect(img.key).toBe("uid/shared.jpg");
    expect(img.attachmentId).toBe("a1");
    expect(img.memoryId).toBe("m1");
    // Attachment fields win…
    expect(img.prompt).toBe("User upload — cat.jpg");
    expect(img.model).toBe("upload");
    expect(img.createdAt).toBe("2026-08-01T10:00:00Z");
    // …memory-only fields fold in.
    expect(img.ocrText).toBe("Q3 roadmap: ship the library");
    expect(img.tags).toEqual(["whiteboard", "planning"]);
    expect(img.width).toBe(1024);
    expect(img.height).toBe(768);
    expect(img.sources).toEqual({ attachment: true, memory: true });
    expect(img.provenance).toBe("upload");
  });

  it("uses the memory caption when the attachment caption is empty (uploads)", () => {
    const out = mergeImageRows(
      [att({ caption: "", prompt: "" })],
      [mem({ caption: "Captioned by the vision model" })],
    );
    expect(out[0].caption).toBe("Captioned by the vision model");
    expect(out[0].title).toBe("Captioned by the vision model");
  });

  it("surfaces memory-only rows with provenance memory-only", () => {
    const out = mergeImageRows([], [mem({ id: "m9", storage_path: "uid/stranded.jpg" })]);
    expect(out).toHaveLength(1);
    expect(out[0].provenance).toBe("memory-only");
    expect(out[0].attachmentId).toBeUndefined();
    expect(out[0].memoryId).toBe("m9");
    expect(out[0].sources).toEqual({ attachment: false, memory: true });
    expect(out[0].title).toBe("Photo of a whiteboard");
  });

  it("sorts newest-first by created_at with id desc as tiebreak", () => {
    const out = mergeImageRows(
      [
        att({ id: "a1", storage_path: "uid/1.png", created_at: "2026-08-01T00:00:00Z" }),
        att({ id: "b2", storage_path: "uid/2.png", created_at: "2026-08-03T00:00:00Z" }),
        // Same timestamp as b2 — the higher id must come first.
        att({ id: "c3", storage_path: "uid/3.png", created_at: "2026-08-03T00:00:00Z" }),
      ],
      [mem({ id: "m1", storage_path: "uid/4.png", created_at: "2026-08-02T00:00:00Z" })],
    );
    expect(out.map((i) => i.key)).toEqual(["uid/3.png", "uid/2.png", "uid/4.png", "uid/1.png"]);
  });

  it("returns empty for empty inputs", () => {
    expect(mergeImageRows([], [])).toEqual([]);
  });
});

describe("deriveProvenance", () => {
  it("classifies each writer's model/kind strings", () => {
    expect(deriveProvenance(att({ model: "upload" }))).toBe("upload");
    expect(deriveProvenance(att({ kind: "figure" }))).toBe("figure");
    expect(deriveProvenance(att({ kind: "generated", book_id: "book-1" }))).toBe("figure");
    expect(deriveProvenance(att({ model: "blueprint-sheet" }))).toBe("sheet");
    expect(deriveProvenance(att({ model: "splat-turntable" }))).toBe("splat-views");
    expect(deriveProvenance(att({ model: "google/gemini-3-pro-image" }))).toBe("generated");
    expect(deriveProvenance(null)).toBe("memory-only");
  });

  it("keeps edits under generated — edit rows carry the generator's model id", () => {
    expect(deriveProvenance(att({ model: "gemini-2.5-flash-image" }))).toBe("generated");
  });
});

describe("filterImages", () => {
  const list = mergeImageRows(
    [att({ id: "a1", storage_path: "uid/dragon.png", prompt: "a red DRAGON", caption: "" })],
    [mem({ id: "m1", storage_path: "uid/board.jpg", caption: "Whiteboard photo", ocr_text: "Q3 ROADMAP notes", tags: ["Planning", "office"] })],
  );

  it("matches ocr_text case-insensitively", () => {
    expect(filterImages(list, "roadmap").map((i) => i.key)).toEqual(["uid/board.jpg"]);
  });

  it("matches tags case-insensitively", () => {
    expect(filterImages(list, "planning").map((i) => i.key)).toEqual(["uid/board.jpg"]);
  });

  it("matches prompt/title case-insensitively", () => {
    expect(filterImages(list, "dragon").map((i) => i.key)).toEqual(["uid/dragon.png"]);
  });

  it("returns the full list for an empty or whitespace query", () => {
    expect(filterImages(list, "")).toEqual(list);
    expect(filterImages(list, "   ")).toEqual(list);
  });

  it("returns empty when nothing matches and for empty input", () => {
    expect(filterImages(list, "zebra")).toEqual([]);
    expect(filterImages([], "anything")).toEqual([]);
  });
});
