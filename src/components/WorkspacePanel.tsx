import React, { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import { toast } from "sonner";
import { buildArtifactDoc, type Artifact } from "@/lib/artifacts";
import {
  useWorkspaceItems,
  workspaceStore,
  type WorkspaceItem,
} from "@/lib/workspaceStore";

/**
 * Right-side Workspace panel — the durable home for everything the chat creates.
 *
 * Lists captured HTML/SVG artifacts and deep-research / web-search reports (the
 * "chat files"). Each item can be opened (preview), pinned to the library, or
 * deleted. HTML/SVG render in the same locked-down sandboxed iframe used by the
 * old modal; research reports render as sanitized-by-default markdown.
 *
 * The list survives tab switches and full reloads because it is backed by the
 * IndexedDB-backed workspaceStore, not ephemeral chat state.
 */

const ICON: Record<WorkspaceItem["kind"], string> = {
  html: "deployed_code",
  svg: "image",
  research: "travel_explore",
};

const KIND_LABEL: Record<WorkspaceItem["kind"], string> = {
  html: "HTML",
  svg: "SVG",
  research: "Research",
};

function timeAgo(ts: number): string {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

const WorkspacePanel: React.FC<{
  userId: string | null;
  onClose?: () => void;
  /** Controlled selection (lifted so a chat bubble can open a specific item). */
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}> = ({ userId, onClose, selectedId, onSelect }) => {
  const allItems = useWorkspaceItems();
  const [filter, setFilter] = useState<"all" | "library">("all");

  const items = useMemo(() => {
    let list = allItems.filter((i) => i.userId == null || i.userId === userId);
    if (filter === "library") list = list.filter((i) => i.savedToLibrary);
    return list;
  }, [allItems, userId, filter]);

  const selected = useMemo(
    () => items.find((i) => i.id === selectedId) || null,
    [items, selectedId]
  );

  const handleDelete = (id: string) => {
    workspaceStore.remove(id);
    if (selectedId === id) onSelect(null);
  };

  const handleToggleLibrary = (item: WorkspaceItem) => {
    workspaceStore.toggleLibrary(item.id);
    toast.success(item.savedToLibrary ? "Removed from library" : "Saved to library");
  };

  const handleCopy = async (content: string) => {
    try {
      await navigator.clipboard.writeText(content);
      toast.success("Copied to clipboard");
    } catch {
      toast.error("Couldn't copy");
    }
  };

  const handleClearUnsaved = () => {
    const removable = items.filter((i) => !i.savedToLibrary).length;
    if (!removable) {
      toast.message("Nothing to clear", { description: "Pinned library items are kept." });
      return;
    }
    workspaceStore.clearUnsaved(userId);
    onSelect(null);
    toast.success("Cleared unsaved files");
  };

  return (
    <div className="flex h-full flex-col bg-surface-container-low border-l border-outline-variant/10 min-w-0">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-3 border-b border-outline-variant/10 shrink-0">
        <span className="material-symbols-outlined text-primary-container text-xl">folder_open</span>
        <span className="font-headline font-bold text-sm text-foreground">Workspace</span>
        <span className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">
          {items.length}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => setFilter((f) => (f === "all" ? "library" : "all"))}
            title={filter === "all" ? "Show library only" : "Show all files"}
            className={`inline-flex items-center justify-center h-8 w-8 rounded-lg transition-colors ${
              filter === "library"
                ? "bg-primary-container/20 text-primary"
                : "text-on-surface-variant hover:bg-surface-container-high"
            }`}
          >
            <span
              className="material-symbols-outlined text-[20px]"
              style={filter === "library" ? { fontVariationSettings: "'FILL' 1" } : undefined}
            >
              bookmark
            </span>
          </button>
          {onClose && (
            <button
              onClick={onClose}
              aria-label="Close workspace"
              className="inline-flex items-center justify-center h-8 w-8 rounded-lg text-on-surface-variant hover:bg-surface-container-high transition-colors"
            >
              <span className="material-symbols-outlined text-[20px]">close</span>
            </button>
          )}
        </div>
      </div>

      {/* Detail view */}
      {selected ? (
        <div className="flex flex-col flex-1 min-h-0">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-outline-variant/10 shrink-0">
            <button
              onClick={() => onSelect(null)}
              aria-label="Back to files"
              className="inline-flex items-center justify-center h-8 w-8 rounded-lg text-on-surface-variant hover:bg-surface-container-high transition-colors"
            >
              <span className="material-symbols-outlined text-[20px]">arrow_back</span>
            </button>
            <span className="material-symbols-outlined text-primary-container text-lg shrink-0">
              {ICON[selected.kind]}
            </span>
            <span className="truncate text-sm font-semibold text-foreground flex-1" title={selected.title}>
              {selected.title}
            </span>
            <button
              onClick={() => handleToggleLibrary(selected)}
              title={selected.savedToLibrary ? "Remove from library" : "Save to library"}
              className={`inline-flex items-center justify-center h-8 w-8 rounded-lg transition-colors ${
                selected.savedToLibrary
                  ? "text-primary-container"
                  : "text-on-surface-variant hover:bg-surface-container-high"
              }`}
            >
              <span
                className="material-symbols-outlined text-[20px]"
                style={selected.savedToLibrary ? { fontVariationSettings: "'FILL' 1" } : undefined}
              >
                bookmark
              </span>
            </button>
            <button
              onClick={() => handleCopy(selected.content)}
              title="Copy source"
              className="inline-flex items-center justify-center h-8 w-8 rounded-lg text-on-surface-variant hover:bg-surface-container-high transition-colors"
            >
              <span className="material-symbols-outlined text-[20px]">content_copy</span>
            </button>
            <button
              onClick={() => handleDelete(selected.id)}
              title="Delete"
              className="inline-flex items-center justify-center h-8 w-8 rounded-lg text-on-surface-variant hover:text-destructive hover:bg-surface-container-high transition-colors"
            >
              <span className="material-symbols-outlined text-[20px]">delete</span>
            </button>
          </div>

          {selected.kind === "research" ? (
            <div className="flex-1 min-h-0 overflow-auto px-4 py-3">
              <div className="prose prose-sm prose-invert max-w-none break-words">
                <ReactMarkdown>{selected.content}</ReactMarkdown>
              </div>
              {selected.meta?.citations && selected.meta.citations.length > 0 && (
                <div className="mt-4 pt-3 border-t border-outline-variant/10">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant mb-2">
                    Sources
                  </p>
                  <ul className="space-y-1.5">
                    {selected.meta.citations.map((c, i) => (
                      <li key={i} className="text-xs">
                        <a
                          href={c.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary hover:underline break-all"
                        >
                          {c.title || c.url}
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ) : (
            <div className="flex-1 min-h-0 bg-white">
              <iframe
                key={`${selected.id}-${selected.content.length}`}
                title={selected.title}
                srcDoc={buildArtifactDoc({
                  title: selected.title,
                  kind: selected.kind === "svg" ? "svg" : "html",
                  content: selected.content,
                } as Artifact)}
                sandbox="allow-scripts"
                referrerPolicy="no-referrer"
                className="w-full h-full border-0"
              />
            </div>
          )}
          <div className="px-3 py-1.5 border-t border-outline-variant/10 shrink-0 text-[10px] text-on-surface-variant">
            {selected.kind === "research"
              ? `Saved ${timeAgo(selected.createdAt)}${selected.meta?.source ? ` · ${selected.meta.source}` : ""}`
              : "Sandboxed preview · no network or page access"}
          </div>
        </div>
      ) : (
        <>
          {/* List view */}
          <div className="flex-1 min-h-0 overflow-auto px-2 py-2 space-y-1.5 hide-scrollbar">
            {items.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-center text-on-surface-variant gap-2 px-6">
                <span className="material-symbols-outlined text-4xl text-primary-container/70">
                  {filter === "library" ? "bookmark" : "folder_open"}
                </span>
                <p className="text-sm font-medium text-foreground">
                  {filter === "library" ? "No saved files yet" : "No files yet"}
                </p>
                <p className="text-xs">
                  {filter === "library"
                    ? "Pin a file with the bookmark to keep it here permanently."
                    : "Artifacts and research results from the chat will collect here automatically."}
                </p>
              </div>
            ) : (
              items.map((item) => (
                <button
                  key={item.id}
                  onClick={() => onSelect(item.id)}
                  className="group flex items-start gap-3 w-full text-left rounded-xl bg-surface-container-high/50 border border-outline-variant/15 p-3 hover:border-primary-container/50 hover:bg-surface-container-high transition-colors"
                >
                  <span className="material-symbols-outlined text-primary-container text-2xl shrink-0 mt-0.5">
                    {ICON[item.kind]}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm font-semibold text-foreground truncate flex-1">
                        {item.title}
                      </span>
                      {item.savedToLibrary && (
                        <span
                          className="material-symbols-outlined text-primary-container text-base shrink-0"
                          style={{ fontVariationSettings: "'FILL' 1" }}
                          title="In library"
                        >
                          bookmark
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-on-surface-variant mt-0.5">
                      {KIND_LABEL[item.kind]} · {timeAgo(item.createdAt)}
                    </div>
                  </div>
                  <span
                    className="shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={() => handleToggleLibrary(item)}
                      onKeyDown={(e) => { if (e.key === "Enter") handleToggleLibrary(item); }}
                      title={item.savedToLibrary ? "Remove from library" : "Save to library"}
                      className={`inline-flex items-center justify-center h-7 w-7 rounded-lg cursor-pointer transition-colors ${
                        item.savedToLibrary
                          ? "text-primary-container"
                          : "text-on-surface-variant hover:bg-surface-container-highest"
                      }`}
                    >
                      <span
                        className="material-symbols-outlined text-[18px]"
                        style={item.savedToLibrary ? { fontVariationSettings: "'FILL' 1" } : undefined}
                      >
                        bookmark
                      </span>
                    </span>
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={() => handleDelete(item.id)}
                      onKeyDown={(e) => { if (e.key === "Enter") handleDelete(item.id); }}
                      title="Delete"
                      className="inline-flex items-center justify-center h-7 w-7 rounded-lg cursor-pointer text-on-surface-variant hover:text-destructive hover:bg-surface-container-highest transition-colors"
                    >
                      <span className="material-symbols-outlined text-[18px]">delete</span>
                    </span>
                  </span>
                </button>
              ))
            )}
          </div>

          {/* Footer actions */}
          {items.some((i) => !i.savedToLibrary) && (
            <div className="px-3 py-2 border-t border-outline-variant/10 shrink-0">
              <button
                onClick={handleClearUnsaved}
                className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant flex items-center gap-1 hover:text-destructive transition-colors"
              >
                <span className="material-symbols-outlined text-sm">delete_sweep</span> Clear unsaved
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default WorkspacePanel;
