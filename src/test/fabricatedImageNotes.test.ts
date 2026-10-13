import { describe, expect, it } from "vitest";
import { assistantImageNote, expandImageTurns, fabricatedImageNote, imageReplayFor, stripFabricatedNotes } from "@/lib/chatHistory";

describe("assistantImageNote", () => {
  it("ties a reply's pictures to a tool call, not the upload note", () => {
    const note = assistantImageNote([{ id: "abc", prompt: "A cat" }]);
    expect(note).toContain("image_id: abc");
    expect(note).toContain("tool call");
    expect(note).not.toMatch(/Attached image/);
  });

  it("is empty without images", () => {
    expect(assistantImageNote(undefined)).toBe("");
    expect(assistantImageNote([])).toBe("");
  });
});

describe("stripFabricatedNotes", () => {
  it("removes an invented attached-image note and flags the image claim", () => {
    // The reply logged on 2026-10-13 — no tool ran, the id was made up.
    const r = stripFabricatedNotes(
      'Here is a clean image of a cat. [Attached image — image_id: 5a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d — "A cat against a white background"]',
    );
    expect(r).toEqual({ text: "Here is a clean image of a cat.", found: true, claimsImage: true });
  });

  it("catches spacing variants and app-note imitations", () => {
    expect(stripFabricatedNotes("Done.\n\n[Attached-image — image_id: x]").claimsImage).toBe(true);
    expect(stripFabricatedNotes("Done. [App note — picture(s) a tool call made: image_id: x]").claimsImage).toBe(true);
    const trace = stripFabricatedNotes("Done.\n\n[App note — tools used for this reply: get_book]");
    expect(trace).toEqual({ text: "Done.", found: true, claimsImage: false });
  });

  it("leaves ordinary replies untouched", () => {
    const text = "The [first] chapter is short.\n\nSee [link](https://x).";
    expect(stripFabricatedNotes(text)).toEqual({ text, found: false, claimsImage: false });
  });
});

describe("fabricatedImageNote", () => {
  it("names only offered tools", () => {
    const note = fabricatedImageNote(new Set(["edit_image", "show_image"]));
    expect(note).toContain("call edit_image");
    expect(note).toContain("show_image");
    expect(note).not.toContain("generate_image");
  });

  it("asks for a plain answer when no image tool is offered", () => {
    expect(fabricatedImageNote(new Set())).toContain("no picture was made");
  });
});

describe("image turn replay", () => {
  const gen = { role: "assistant", images: [{ id: "img1", prompt: "A cat" }], toolEvents: [{ name: "generate_image", summary: "", ok: true }] };

  it("only replays pictures an image tool made", () => {
    expect(imageReplayFor(gen, "Here.")).toEqual({ tool: "generate_image", images: [{ id: "img1", prompt: "A cat" }], content: "Here." });
    expect(imageReplayFor({ ...gen, toolEvents: [] }, "Here.")).toBeNull();
    expect(imageReplayFor({ ...gen, images: [{ id: "a", prompt: "p", lens_auto: true }] }, "Here.")).toBeNull();
    expect(imageReplayFor({ ...gen, role: "user" }, "Here.")).toBeNull();
  });

  const history = () => [
    { role: "user", content: "Draw a cat" },
    { role: "assistant", content: "Here. [note]", __imageReplay: imageReplayFor(gen, "Here.") },
    { role: "user", content: "make it orange" },
    {
      role: "assistant", content: "Done. [note]",
      __imageReplay: imageReplayFor({ role: "assistant", images: [{ id: "img2", prompt: "A cat" }], toolEvents: [{ name: "edit_image", summary: "", ok: true }] }, "Done."),
    },
    { role: "user", content: "again" },
  ];

  it("replays as call, result, reply for local models", () => {
    const out = expandImageTurns(history(), true);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant", "user", "assistant", "tool", "assistant", "user"]);
    expect(out[1].tool_calls[0].function).toEqual({ name: "generate_image", arguments: JSON.stringify({ prompt: "A cat" }) });
    expect(out[2]).toMatchObject({ tool_call_id: out[1].tool_calls[0].id, name: "generate_image" });
    expect(JSON.parse(out[2].content)).toMatchObject({ image_id: "img1", shown_to_user: true });
    expect(out[3]).toEqual({ role: "assistant", content: "Here." });
    expect(JSON.parse(out[5].tool_calls[0].function.arguments)).toEqual({ image_id: "img1", instruction: "make it orange" });
    expect(out.some((m) => "__imageReplay" in m)).toBe(false);
  });

  it("keeps the text note for other providers and strips the field", () => {
    const out = expandImageTurns(history(), false);
    expect(out).toHaveLength(5);
    expect(out[1]).toEqual({ role: "assistant", content: "Here. [note]" });
  });

  it("an upload becomes the image a later edit refers to", () => {
    const out = expandImageTurns([
      { role: "user", content: "fix this photo", __imageIds: ["up1"] },
      {
        role: "assistant", content: "Fixed.",
        __imageReplay: imageReplayFor({ role: "assistant", images: [{ id: "img9" }], toolEvents: [{ name: "edit_image", summary: "", ok: true }] }, "Fixed."),
      },
    ], true);
    expect(out[0]).toEqual({ role: "user", content: "fix this photo" });
    expect(JSON.parse(out[1].tool_calls[0].function.arguments).image_id).toBe("up1");
  });
});
