import { useSyncExternalStore } from "react";

/**
 * The notebooks, as the Workspace needs to know them: a name and a colour per
 * id, and which one Counsel has loaded.
 *
 * AppContext owns this data and publishes it here. The Workspace panel reads
 * it from here rather than from useApp() because it is also mounted with no
 * AppProvider around it (#/workspace-lab), where an empty directory simply
 * means "no notebooks" and the panel looks exactly as it did before filing.
 */
export interface DirectoryNotebook {
  id: string;
  name: string;
  color: string;
}

export interface NotebookDirectory {
  notebooks: DirectoryNotebook[];
  /** Counsel's loaded primary — where new Workspace items are filed. */
  activeId: string | null;
}

const EMPTY: NotebookDirectory = { notebooks: [], activeId: null };
let current: NotebookDirectory = EMPTY;
const listeners = new Set<() => void>();

export const notebookDirectory = {
  set(notebooks: DirectoryNotebook[], activeId: string | null) {
    current = { notebooks, activeId };
    for (const l of listeners) l();
  },
  get(): NotebookDirectory {
    return current;
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export function useNotebookDirectory(): NotebookDirectory {
  return useSyncExternalStore(notebookDirectory.subscribe, notebookDirectory.get, () => EMPTY);
}
