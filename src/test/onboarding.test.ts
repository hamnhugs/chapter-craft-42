import { describe, it, expect, beforeEach } from "vitest";
import {
  _resetOnboardingStore,
  beginOnboarding,
  buildChecklist,
  checklistVisible,
  dismissChecklist,
  markTipSeen,
  muteTips,
  nextChecklistItem,
  noteProgress,
  pendingTip,
  replayOnboarding,
  getOnboarding,
  type OnboardingState,
} from "@/lib/onboarding";
import { TAB_TIPS } from "@/lib/onboardingTips";

/**
 * Onboarding state.
 *
 * WHAT THIS PROTECTS. Two promises: someone who was already using the app
 * never has a tour sprung on them, and a tab's tour runs once — not again
 * after a reload, not again for the next account on the same browser.
 */

const current = (): OnboardingState | null => getOnboarding();

beforeEach(() => {
  localStorage.clear();
  _resetOnboardingStore();
});

describe("who gets onboarding", () => {
  it("is on for a new account and off for one that predates it", () => {
    beginOnboarding("new-user", "new");
    expect(pendingTip(current(), "library")).toBe("library");
    expect(checklistVisible(current())).toBe(true);

    _resetOnboardingStore();
    beginOnboarding("old-user", "veteran");
    expect(pendingTip(current(), "library")).toBeNull();
    expect(checklistVisible(current())).toBe(false);
  });

  it("keeps the first decision: a new account stays new after it gets a key", () => {
    beginOnboarding("u", "new");
    markTipSeen("library");
    _resetOnboardingStore(); // reload
    beginOnboarding("u", "veteran"); // has a key now, so the caller says veteran
    expect(current()?.active).toBe(true);
    expect(pendingTip(current(), "library")).toBeNull();
    expect(pendingTip(current(), "chat")).toBe("chat");
  });

  it("keeps accounts on one browser apart", () => {
    beginOnboarding("a", "new");
    markTipSeen("chat");
    _resetOnboardingStore();
    beginOnboarding("b", "new");
    expect(pendingTip(current(), "chat")).toBe("chat");
  });

  it("replay starts a veteran from the top", () => {
    beginOnboarding("u", "veteran");
    replayOnboarding();
    expect(pendingTip(current(), "wikis")).toBe("wikis");
    expect(checklistVisible(current())).toBe(true);
  });
});

describe("tab tours", () => {
  it("run once per tab, and never for a tab without one", () => {
    beginOnboarding("u", "new");
    expect(pendingTip(current(), "admin")).toBeNull();
    markTipSeen("viewer");
    markTipSeen("viewer");
    expect(current()?.tipsSeen).toEqual(["viewer"]);
    expect(pendingTip(current(), "viewer")).toBeNull();
  });

  it("stop when tips are switched off, and the list stays", () => {
    beginOnboarding("u", "new");
    muteTips();
    expect(pendingTip(current(), "library")).toBeNull();
    expect(checklistVisible(current())).toBe(true);
    dismissChecklist();
    expect(checklistVisible(current())).toBe(false);
  });

  it("survives unreadable saved state", () => {
    localStorage.setItem("cc_onboarding_v1:u", "{not json");
    beginOnboarding("u", "new");
    expect(current()?.active).toBe(true);
  });

  it("are short: every tab has one to three steps, each with something to say", () => {
    for (const [id, tip] of Object.entries(TAB_TIPS)) {
      expect(tip.steps.length, id).toBeGreaterThanOrEqual(1);
      expect(tip.steps.length, id).toBeLessThanOrEqual(3);
      for (const s of tip.steps) {
        expect(s.title.length, id).toBeLessThanOrEqual(34);
        expect(s.body.length, id).toBeLessThanOrEqual(170);
      }
    }
  });
});

describe("the getting-started list", () => {
  it("points at the first step not done", () => {
    const none = buildChecklist({ hasAiKey: false, bookCount: 0, askedCounsel: false, openedNotebook: false });
    expect(nextChecklistItem(none)?.id).toBe("ai");
    const some = buildChecklist({ hasAiKey: true, bookCount: 2, askedCounsel: false, openedNotebook: true });
    expect(some.map((i) => i.done)).toEqual([true, true, false, true]);
    expect(nextChecklistItem(some)?.id).toBe("ask");
    const all = buildChecklist({ hasAiKey: true, bookCount: 1, askedCounsel: true, openedNotebook: true });
    expect(nextChecklistItem(all)).toBeNull();
  });

  it("remembers progress the app can't work out again", () => {
    beginOnboarding("u", "new");
    noteProgress("askedCounsel");
    _resetOnboardingStore();
    beginOnboarding("u", "new");
    expect(current()?.askedCounsel).toBe(true);
    expect(current()?.openedNotebook).toBe(false);
  });
});
