import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * PromptSwitcher — the chip must open on TAP, never on touch-down.
 *
 * THE BUG THIS LOCKS OUT. Radix's `DropdownMenuTrigger` toggles the menu from
 * its `onPointerDown` handler. That is fine for a button sitting still on a
 * page, and wrong for this chip, because it lives in Counsel's horizontally
 * scrolling tool row: on a phone the finger that lands on "Prompt" in order to
 * FLICK THE ROW SIDEWAYS opens the menu before it has travelled a pixel. The
 * user reported exactly this — the prompt control firing while scrolling the
 * options at the bottom of the tab — and what it changes (which saved prompt
 * is steering the conversation) is not something to change by accident.
 *
 * THE FIX THIS GUARDS. `preventDefault()` on pointerdown, which makes Radix's
 * `composeEventHandlers` skip their internal toggle, plus a controlled `open`
 * driven from `onClick`. The browser already refuses to fire `click` when a
 * touch turns into a scroll, so deferring to it is what buys back the scroll
 * gesture — and it is what WCAG 2.2 SC 2.5.2 (Pointer Cancellation) asks for:
 * no action on the down-event.
 *
 * The assertion reads `data-state` off the TRIGGER rather than looking for the
 * menu, so it does not depend on Radix's portalled content mounting under
 * jsdom. Rendering goes through react-dom/client + React.act directly, not
 * @testing-library/react — see libraryShelves.test.tsx for why (RTL v16's peer
 * @testing-library/dom is not declared, so `render()` throws on import).
 */

vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "u1" } }) }));
vi.mock("@/hooks/usePromptPresets", () => ({ usePromptPresets: () => ({ presets: [] }) }));
vi.mock("@/hooks/usePromptBindings", () => ({
  usePromptBindings: () => ({ applyBindings: vi.fn(async () => ""), describeBindings: () => "" }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import PromptSwitcher from "@/components/PromptSwitcher";

let container: HTMLDivElement;
let root: Root;

const mount = async () => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await React.act(async () => {
    root.render(<PromptSwitcher onManage={() => {}} />);
  });
};

/** The chip itself — labelled "Prompt: <name>" by the component. */
const trigger = (): HTMLButtonElement => {
  const el = container.querySelector<HTMLButtonElement>('button[aria-label^="Prompt:"]');
  if (!el) throw new Error("PromptSwitcher trigger not found");
  return el;
};

/**
 * jsdom ships no `PointerEvent` constructor. React dispatches its synthetic
 * pointer events off the native event's TYPE, not its class, so a MouseEvent
 * named "pointerdown" reaches `onPointerDown` exactly as a real one would —
 * and it still carries `preventDefault()`, which is the whole subject here.
 */
const fire = async (el: HTMLElement, type: string) => {
  await React.act(async () => {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }));
  });
};

type Mutable = { IS_REACT_ACT_ENVIRONMENT?: boolean };

beforeEach(async () => {
  (globalThis as unknown as Mutable).IS_REACT_ACT_ENVIRONMENT = true;
  window.sessionStorage?.clear();
  window.localStorage?.clear();
  await mount();
});

afterEach(async () => {
  await React.act(async () => { root.unmount(); });
  container.remove();
  delete (globalThis as unknown as Mutable).IS_REACT_ACT_ENVIRONMENT;
});

describe("PromptSwitcher activation", () => {
  it("does NOT open on pointerdown — the touch that starts a scroll must not change the prompt", async () => {
    await fire(trigger(), "pointerdown");
    expect(trigger().getAttribute("data-state")).toBe("closed");
  });

  it("opens on click, so the browser's scroll-vs-tap decision is the one that counts", async () => {
    await fire(trigger(), "pointerdown");
    await fire(trigger(), "click");
    expect(trigger().getAttribute("data-state")).toBe("open");
  });

  it("a pointerdown that never becomes a click leaves the menu shut", async () => {
    await fire(trigger(), "pointerdown");
    await fire(trigger(), "pointermove");
    await fire(trigger(), "pointerup");
    expect(trigger().getAttribute("data-state")).toBe("closed");
  });

  // The pointerdown veto must not cost keyboard users the control. Radix keeps
  // its own `onKeyDown` on the trigger, and nothing here default-prevents a key
  // event — but that is the kind of thing a later refactor breaks silently, so
  // it is asserted rather than assumed.
  it("still opens from the keyboard", async () => {
    for (const key of ["Enter", " "]) {
      await React.act(async () => {
        trigger().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      });
      expect(trigger().getAttribute("data-state")).toBe("open");
      await fire(trigger(), "click"); // shut it again before trying the next key
      expect(trigger().getAttribute("data-state")).toBe("closed");
    }
  });
});
