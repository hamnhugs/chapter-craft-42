import { describe, it, expect, vi } from "vitest";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import CastVoicePrompt from "@/components/CastVoicePrompt";
import type { InworldVoice } from "@/lib/inworldTts";

vi.mock("@/lib/inworldTts", async (orig) => ({
  ...(await orig<typeof import("@/lib/inworldTts")>()),
  synthesizeSpeech: vi.fn(async () => new ArrayBuffer(8)),
}));

const VOICES = [
  { voice_id: "Chip", name: "Chip", languages: ["en"], description: "Cheerful male voice" },
  { voice_id: "Wendy", name: "Wendy", languages: ["en"], description: "Warm adult female voice" },
  { voice_id: "Poppy", name: "Poppy", languages: ["en"], description: "Bright young female voice" },
  { voice_id: "Mark", name: "Mark", languages: ["en"], description: "Calm male voice" },
] as unknown as InworldVoice[];
const member = { id: "m1", name: "Coraline", aliases: [], gender: "female" as const, age: "child" as const, note: "", lines: 1, voiceId: "Poppy" };


(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
function show(el: React.ReactElement) {
  const host = document.createElement("div");
  document.body.innerHTML = "";
  document.body.appendChild(host);
  act(() => { createRoot(host).render(el); });
}
const options = () => [...document.querySelectorAll('[role="option"]')] as HTMLElement[];
const button = (re: RegExp) => [...document.querySelectorAll("button")].find((b) => re.test(b.textContent || "")) as HTMLElement;
const click = (el: HTMLElement) => act(() => { el.click(); });

describe("CastVoicePrompt", () => {
  it("names the character, shows the line, offers every voice but the narrator's, suggestion first", () => {
    show(<CastVoicePrompt member={member} line="Where does that door go?" voices={VOICES} narratorVoiceId="Chip" onDone={() => {}} onStopAsking={() => {}} />);
    expect(document.body.textContent).toContain("Coraline speaks for the first time");
    expect(document.body.textContent).toContain("Where does that door go?");
    const names = options().map((o) => o.textContent || "");
    expect(names.length).toBe(3);
    expect(names[0]).toContain("Poppy");
    expect(names[0]).toContain("Suggested");
    expect(names.join(" ")).not.toContain("Chip");
  });

  it("tapping a voice picks it; the button answers with it", () => {
    const onDone = vi.fn();
    show(<CastVoicePrompt member={member} line="Hello there, mother." voices={VOICES} narratorVoiceId="Chip" onDone={onDone} onStopAsking={() => {}} />);
    click(options().find((o) => /Wendy/.test(o.textContent || ""))!);
    click(button(/^Use Wendy for Coraline$/));
    expect(onDone).toHaveBeenCalledWith("Wendy");
  });

  it("“Pick for me” answers null; “Stop asking” is its own answer", () => {
    const onDone = vi.fn();
    const onStop = vi.fn();
    show(<CastVoicePrompt member={member} line="Hello." voices={VOICES} narratorVoiceId="Chip" onDone={onDone} onStopAsking={onStop} />);
    click(button(/^Pick for me$/));
    expect(onDone).toHaveBeenCalledWith(null);
    click(button(/Stop asking/));
    expect(onStop).toHaveBeenCalled();
  });
});
