// Going somewhere in the app on Counsel's say-so (the open_view chat tool).
//
// A tool can't call React state setters, so it hands a target to the one
// function here, which ChatContext wires to AppContext's own navigation — the
// same calls a tap makes. Opening is only looking: nothing here changes which
// notebooks Counsel has loaded, and nothing writes data.
//
// Two of the places are inside a tab that may or may not be mounted (an open
// notebook's Files list, a Workspace file beside the chat), so each has a
// request that waits to be taken on mount plus an event for when the tab is
// already up — the pattern openPassage.ts uses for notes.

import { OPEN_NOTE_EVENT, OPEN_NOTE_PENDING_KEY } from "@/lib/openPassage";
import { requestSettingsSection } from "@/lib/settingsNav";
import { workspaceStore } from "@/lib/workspaceStore";

export type NotebookListTab = "notes" | "files";

export type AppViewTarget =
  | { view: "counsel" | "library" | "reader" | "notebooks" }
  | { view: "notebook"; notebookId: string; tab?: NotebookListTab }
  | { view: "note"; entryId: string; notebookId: string | null }
  | { view: "file"; itemId: string }
  | { view: "settings"; section?: string };

/** The slice of AppContext navigation needs. */
export interface AppNavigator {
  setActiveTab: (tab: "library" | "viewer" | "chat" | "wikis" | "wiki" | "settings") => void;
  openNotebook: (wikiId: string) => void;
}

export const NOTEBOOK_TAB_EVENT = "notebook-list-tab";
export const WORKSPACE_OPEN_EVENT = "workspace-open-request";

let pendingNotebookTab: { wikiId: string; tab: NotebookListTab } | null = null;

/** The list an open notebook was asked to show, if the request was for THIS
 *  notebook. Taking it clears it, so it applies once. */
export function takeNotebookTab(wikiId: string | null): NotebookListTab | null {
  if (!pendingNotebookTab || !wikiId || pendingNotebookTab.wikiId !== wikiId) return null;
  const { tab } = pendingNotebookTab;
  pendingNotebookTab = null;
  return tab;
}

const emit = (name: string) => {
  // After the tab switch has been asked for, so a freshly mounted panel hears it too.
  setTimeout(() => {
    try { window.dispatchEvent(new CustomEvent(name)); } catch { /* non-browser */ }
  }, 0);
};

export function openAppView(app: AppNavigator, target: AppViewTarget): void {
  switch (target.view) {
    case "counsel": app.setActiveTab("chat"); return;
    case "library": app.setActiveTab("library"); return;
    case "reader": app.setActiveTab("viewer"); return;
    case "notebooks": app.setActiveTab("wikis"); return;
    case "notebook":
      pendingNotebookTab = { wikiId: target.notebookId, tab: target.tab ?? "notes" };
      app.openNotebook(target.notebookId);
      emit(NOTEBOOK_TAB_EVENT);
      return;
    case "note": {
      const { entryId } = target;
      try { sessionStorage.setItem(OPEN_NOTE_PENDING_KEY, entryId); } catch { /* the event still works */ }
      // Shown inside its own notebook when that is known, so Back lands there.
      if (target.notebookId) app.openNotebook(target.notebookId);
      else app.setActiveTab("wiki");
      setTimeout(() => {
        try { window.dispatchEvent(new CustomEvent(OPEN_NOTE_EVENT, { detail: { entryId } })); } catch { /* non-browser */ }
      }, 0);
      return;
    }
    case "file":
      workspaceStore.requestOpen(target.itemId);
      app.setActiveTab("chat");
      emit(WORKSPACE_OPEN_EVENT);
      return;
    case "settings":
      if (target.section) requestSettingsSection(target.section);
      app.setActiveTab("settings");
      return;
  }
}
