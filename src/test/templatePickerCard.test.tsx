import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const sendMessage = vi.fn();
vi.mock("@/context/ChatContext", () => ({ useChat: () => ({ sendMessage, isLoading: false }) }));
const list = vi.fn();
const del = vi.fn();
vi.mock("@/lib/craftApps", () => ({
  listDesignTemplates: () => list(),
  deleteDesignTemplate: (n: string) => del(n),
  designTemplateThumb: () => Promise.reject(new Error("no thumb in tests")),
}));

import TemplatePickerCard from "@/components/TemplatePickerCard";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement; let root: Root;
const render = async () => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); await act(async () => { root.render(<TemplatePickerCard />); }); await act(async () => {}); };
const unmount = () => { act(() => root.unmount()); host.remove(); };
const text = () => host.textContent || "";
const byText = (t: string) => Array.from(host.querySelectorAll("span,p")).find((e) => e.textContent === t) as HTMLElement;
const click = async (el: Element) => { await act(async () => { (el as HTMLElement).click(); }); await act(async () => {}); };

const tpl = (name: string, slug: string) => ({ name, slug, about: `${name}: 612×792 pt`, width: 612, height: 792, parts: ["headline", "image"], created: "2026-10-14" });

describe("TemplatePickerCard", () => {
  beforeEach(() => { sendMessage.mockReset(); list.mockReset(); del.mockReset(); });
  afterEach(() => unmount());

  it("shows the saved templates and sends the pick as the user's next message", async () => {
    list.mockResolvedValue([tpl("Movie Night", "movie-night"), tpl("Spring cover", "spring-cover")]);
    await render();
    expect(text()).toContain("Movie Night");
    expect(text()).toContain("8.5 × 11 in · headline, image");
    await click(byText("Spring cover"));
    expect(sendMessage).toHaveBeenCalledWith('Use my "Spring cover" template.');
    // One pick per card.
    await click(byText("Movie Night"));
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(text()).toContain("Using this layout");
  });

  it("deletes only on a second click", async () => {
    list.mockResolvedValue([tpl("Movie Night", "movie-night")]);
    del.mockResolvedValue(undefined);
    await render();
    await click(host.querySelector('[aria-label="Delete Movie Night"]')!);
    expect(del).not.toHaveBeenCalled();
    await click(host.querySelector('[aria-label="Really delete Movie Night"]')!);
    expect(del).toHaveBeenCalledWith("Movie Night");
    expect(text()).not.toContain("Movie Night");
  });

  it("explains how to save one when there are none", async () => {
    list.mockResolvedValueOnce([]);
    await render();
    expect(text()).toContain("No templates yet.");
    expect(text()).toContain("Pages panel");
  });

  it("says when the bridge is down", async () => {
    list.mockRejectedValueOnce(new Error("The craft bridge isn't running."));
    await render();
    expect(text()).toContain("The craft bridge isn't running.");
  });
});
