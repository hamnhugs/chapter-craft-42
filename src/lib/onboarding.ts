// Onboarding state: who is new, which tabs Bookworm has already explained,
// and how far along the getting-started list is.
//
// Three pieces share it (docs/onboarding-and-notebooks.md):
//   SetupWizard      three screens, once, on first sign-in
//   GettingStarted   the four-step list in the top bar
//   WormCoach        Bookworm explaining each tab the first time it is opened
//
// It lives in localStorage, per account. People who were using the app before
// this shipped are marked `active: false` — nothing pops up for them — and can
// start it from Settings → Account.

import { useSyncExternalStore } from "react";

export type TipId = "library" | "chat" | "viewer" | "wikis" | "wiki" | "settings";

export interface OnboardingState {
  /** False for accounts that predate onboarding: nothing shows on its own. */
  active: boolean;
  tipsSeen: TipId[];
  /** "Don't show tips" — the tab tours stop, the list stays. */
  tipsOff: boolean;
  checklistDismissed: boolean;
  /** Sticky progress the app can't re-derive later. */
  askedCounsel: boolean;
  openedNotebook: boolean;
}

const fresh = (active: boolean): OnboardingState => ({
  active,
  tipsSeen: [],
  tipsOff: false,
  checklistDismissed: false,
  askedCounsel: false,
  openedNotebook: false,
});

const keyFor = (uid: string) => `cc_onboarding_v1:${uid}`;

let uid: string | null = null;
let state: OnboardingState | null = null;
const listeners = new Set<() => void>();

function commit(next: OnboardingState) {
  state = next;
  if (uid) {
    try { localStorage.setItem(keyFor(uid), JSON.stringify(next)); } catch { /* private mode: lasts the session */ }
  }
  listeners.forEach((l) => l());
}

function read(id: string): OnboardingState | null {
  try {
    const raw = localStorage.getItem(keyFor(id));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return { ...fresh(false), ...parsed, tipsSeen: Array.isArray(parsed.tipsSeen) ? parsed.tipsSeen : [] };
  } catch {
    return null;
  }
}

/**
 * Attach the store to an account. `kind` only matters the first time the
 * account is seen on this device: "new" switches onboarding on, "veteran"
 * records that it should stay quiet.
 */
export function beginOnboarding(userId: string, kind: "new" | "veteran") {
  if (uid === userId && state) return;
  uid = userId;
  const saved = read(userId);
  if (saved) {
    state = saved;
    listeners.forEach((l) => l());
  } else {
    commit(fresh(kind === "new"));
  }
}

/** Start again from the top — Settings → Account → Replay. */
export function replayOnboarding() {
  if (!uid) return;
  commit(fresh(true));
}

const update = (patch: Partial<OnboardingState>) => { if (state) commit({ ...state, ...patch }); };

export function markTipSeen(id: TipId) {
  if (state && !state.tipsSeen.includes(id)) update({ tipsSeen: [...state.tipsSeen, id] });
}
export const muteTips = () => update({ tipsOff: true });
export const dismissChecklist = () => update({ checklistDismissed: true });
export function noteProgress(what: "askedCounsel" | "openedNotebook") {
  if (state && !state[what]) update({ [what]: true });
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => { listeners.delete(l); };
};
const snapshot = () => state;

/** The state right now, outside React. */
export const getOnboarding = snapshot;

export function useOnboarding(): OnboardingState | null {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Tests only. */
export function _resetOnboardingStore() {
  uid = null;
  state = null;
}

// ── Pure decisions ─────────────────────────────────────────────────────────

const TIP_IDS: readonly string[] = ["library", "chat", "viewer", "wikis", "wiki", "settings"];

/** The tab's tour, if it should run now. */
export function pendingTip(s: OnboardingState | null, tab: string): TipId | null {
  if (!s || !s.active || s.tipsOff) return null;
  if (!TIP_IDS.includes(tab)) return null;
  return s.tipsSeen.includes(tab as TipId) ? null : (tab as TipId);
}

export type ChecklistId = "ai" | "book" | "ask" | "notebook";

export interface ChecklistItem {
  id: ChecklistId;
  label: string;
  hint: string;
  done: boolean;
}

export interface ChecklistFacts {
  hasAiKey: boolean;
  bookCount: number;
  askedCounsel: boolean;
  openedNotebook: boolean;
}

/** The getting-started list, in the order the app's loop runs. */
export function buildChecklist(f: ChecklistFacts): ChecklistItem[] {
  return [
    { id: "ai", label: "Connect an AI", hint: "About a minute. There are free ones.", done: f.hasAiKey },
    { id: "book", label: "Add your first book", hint: "A PDF or EPUB, or a YouTube link.", done: f.bookCount > 0 },
    { id: "ask", label: "Ask Counsel about it", hint: "Any question, typed or spoken.", done: f.askedCounsel },
    { id: "notebook", label: "Open your notebook", hint: "See what was worth keeping.", done: f.openedNotebook },
  ];
}

/** The step to do next — the first one not done yet. */
export function nextChecklistItem(items: ChecklistItem[]): ChecklistItem | null {
  return items.find((i) => !i.done) ?? null;
}

/** Whether the list still belongs in the top bar. */
export function checklistVisible(s: OnboardingState | null): boolean {
  return !!s && s.active && !s.checklistDismissed;
}
