import React, { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import { safeUrlTransform, safeMarkdownComponents } from "@/lib/markdownSafety";
import { toast } from "sonner";
import { type Artifact } from "@/lib/artifacts";
import ArtifactFrame from "@/components/ArtifactFrame";
import SvgArtifactViewer from "@/components/SvgArtifactViewer";
import {
  useWorkspaceItems,
  workspaceStore,
  FOCUS_MAX_ITEMS,
  type WorkspaceItem,
} from "@/lib/workspaceStore";
import {
  KIND_ICON,
  KIND_LABEL,
  downloadWorkspaceFile,
  languageLabel,
} from "@/lib/workspaceFiles";

/**
 * Right-side Workspace panel — the durable home for everything the chat creates:
 * HTML/SVG artifacts, research reports, and the code, documents, data and tool
 * sources the assistant writes inline. Each item can be opened, downloaded,
 * pinned to the library, pinned as chat focus, or deleted.
 *
 * RENDERING IS AN ALLOWLIST, STORAGE IS NOT. Only `html` and `svg` — the two
 * ACTIVE types — reach the locked-down sandboxed iframe. Only `research`, whose
 * markdown path is already sanitized, reaches ReactMarkdown. EVERY other kind,
 * including any kind a newer client invents, falls through to the inert text
 * viewer below, which cannot execute or interpret anything. The old code had
 * this inverted: the frame was the DEFAULT branch, so a `code` item would have
 * been executed as HTML. Keep the named-kinds-first shape.
 *
 * The list survives tab switches and full reloads because it is backed by the
 * IndexedDB-backed workspaceStore, not ephemeral chat state.
 */

const iconFor = (item: WorkspaceItem): string => KIND_ICON[item.kind] || "draft";
const labelFor = (item: WorkspaceItem): string => KIND_LABEL[item.kind] || "File";

/** Line numbers are cheap on normal files and a jank machine on generated
 *  ones; past this the gutter is dropped and the text still renders. */
const MAX_GUTTER_LINES = 2000;

/**
 * The inert viewer — the terminal render path for every non-active kind.
 *
 * Hard rules, all of them load-bearing: no dangerouslySetInnerHTML, no
 * ReactMarkdown, no iframe. Content only ever becomes a React TEXT child, which
 * React escapes. Sideways overflow is contained by the scroll box (the page
 * body must never scroll horizontally on a phone), and the gutter is
 * `sticky left-0` so line numbers survive that horizontal scroll.
 */
const InertFileViewer: React.FC<{ item: WorkspaceItem; onCopy: (text: string) => void }> = ({
  item,
  onCopy,
}) => {
  const lines = useMemo(() => (item.content || "").split("\n"), [item.content]);
  const showGutter = lines.length <= MAX_GUTTER_LINES;
  const lang = item.meta?.language;

  return (
    <div className="flex flex-col flex-1 min-h-0 min-w-0">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-outline-variant/10 shrink-0 min-w-0">
        <span className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant truncate">
          {lang ? languageLabel(lang) : labelFor(item)}
        </span>
        <span className="text-[10px] text-on-surface-variant/70 tabular-nums shrink-0">
          {lines.length} {lines.length === 1 ? "line" : "lines"}
        </span>
        <button
          onClick={() => onCopy(item.content)}
          title="Copy file text"
          className="ml-auto shrink-0 inline-flex items-center gap-1 h-7 px-2 rounded-lg text-[10px] font-bold uppercase tracking-widest text-on-surface-variant hover:bg-surface-container-high transition-colors"
        >
          <span className="material-symbols-outlined text-[16px]">content_copy</span>
          Copy
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto bg-surface-container-lowest/40">
        <div className="flex min-w-max items-start font-mono text-[12px] leading-[1.55]">
          {showGutter && (
            <pre
              aria-hidden="true"
              className="sticky left-0 z-10 select-none px-2 py-3 text-right text-on-surface-variant/45 bg-surface-container-low border-r border-outline-variant/10 tabular-nums"
            >
              {lines.map((_, i) => String(i + 1)).join("\n")}
            </pre>
          )}
          <pre className="px-3 py-3 text-foreground whitespace-pre">{item.content}</pre>
        </div>
      </div>
    </div>
  );
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

  const handleToggleFocus = (item: WorkspaceItem) => {
    const r = workspaceStore.toggleFocused(item.id);
    if (!r.ok) {
      toast.error(`Focus is limited to ${FOCUS_MAX_ITEMS} files — unpin one first.`);
      return;
    }
    toast.success(r.focused ? "Pinned as chat focus — sent to the AI every turn" : "Unpinned from chat focus");
  };

  const handleCopy = async (content: string) => {
    try {
      await navigator.clipboard.writeText(content);
      toast.success("Copied to clipboard");
    } catch {
      toast.error("Couldn't copy");
    }
  };

  /** Every kind is downloadable — the terminal fallback when the app cannot
   *  render something is a file on disk, never a dropped file. */
  const handleDownload = (item: WorkspaceItem) => {
    try {
      downloadWorkspaceFile({
        title: item.title,
        kind: item.kind,
        language: item.meta?.language,
        content: item.content,
      });
    } catch {
      toast.error("Couldn't download this file");
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
          {/* min-w-0 + overflow-hidden: with seven controls the row must clip,
              never widen the panel and scroll the page sideways on a phone. */}
          <div className="flex items-center gap-2 px-3 py-2 border-b border-outline-variant/10 shrink-0 min-w-0 overflow-hidden">
            <button
              onClick={() => onSelect(null)}
              aria-label="Back to files"
              className="shrink-0 inline-flex items-center justify-center h-8 w-8 rounded-lg text-on-surface-variant hover:bg-surface-container-high transition-colors"
            >
              <span className="material-symbols-outlined text-[20px]">arrow_back</span>
            </button>
            <span className="material-symbols-outlined text-primary-container text-lg shrink-0">
              {iconFor(selected)}
            </span>
            <span className="truncate text-sm font-semibold text-foreground flex-1" title={selected.title}>
              {selected.title}
            </span>
            <button
              onClick={() => handleToggleFocus(selected)}
              title={selected.meta?.focused ? "Unpin from chat focus" : "Pin as chat focus — sent to the AI every turn"}
              className={`shrink-0 inline-flex items-center justify-center h-8 w-8 rounded-lg transition-colors ${
                selected.meta?.focused
                  ? "text-primary-container"
                  : "text-on-surface-variant hover:bg-surface-container-high"
              }`}
            >
              <span
                className="material-symbols-outlined text-[20px]"
                style={selected.meta?.focused ? { fontVariationSettings: "'FILL' 1" } : undefined}
              >
                push_pin
              </span>
            </button>
            <button
              onClick={() => handleToggleLibrary(selected)}
              title={selected.savedToLibrary ? "Remove from library" : "Save to library"}
              className={`shrink-0 inline-flex items-center justify-center h-8 w-8 rounded-lg transition-colors ${
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
              className="shrink-0 inline-flex items-center justify-center h-8 w-8 rounded-lg text-on-surface-variant hover:bg-surface-container-high transition-colors"
            >
              <span className="material-symbols-outlined text-[20px]">content_copy</span>
            </button>
            <button
              onClick={() => handleDownload(selected)}
              title="Download file"
              className="shrink-0 inline-flex items-center justify-center h-8 w-8 rounded-lg text-on-surface-variant hover:bg-surface-container-high transition-colors"
            >
              <span className="material-symbols-outlined text-[20px]">download</span>
            </button>
            <button
              onClick={() => handleDelete(selected.id)}
              title="Delete"
              className="shrink-0 inline-flex items-center justify-center h-8 w-8 rounded-lg text-on-surface-variant hover:text-destructive hover:bg-surface-container-high transition-colors"
            >
              <span className="material-symbols-outlined text-[20px]">delete</span>
            </button>
          </div>

          {selected.kind === "research" ? (
            <div className="flex-1 min-h-0 overflow-auto px-4 py-3">
              <div className="prose prose-sm prose-invert max-w-none break-words">
                <ReactMarkdown urlTransform={safeUrlTransform} components={safeMarkdownComponents}>{selected.content}</ReactMarkdown>
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
          ) : selected.kind === "svg" ? (
            // SVG sheets get zoom + SVG/PDF export; keyed so zoom resets per item.
            <SvgArtifactViewer key={selected.id} title={selected.title} content={selected.content} />
          ) : selected.kind === "html" ? (
            // NAMED, not defaulted. Only the two ACTIVE kinds reach a frame.
            <div className="flex-1 min-h-0 bg-white">
              <ArtifactFrame
                key={selected.id}
                title={selected.title}
                artifact={{
                  title: selected.title,
                  kind: "html",
                  content: selected.content,
                } as Artifact}
              />
            </div>
          ) : (
            // code / text / data / tool — and anything a newer client invents,
            // which rowToItem has already normalized to "text".
            <InertFileViewer key={selected.id} item={selected} onCopy={handleCopy} />
          )}
          <div className="px-3 py-1.5 border-t border-outline-variant/10 shrink-0 text-[10px] text-on-surface-variant">
            {selected.kind === "html" || selected.kind === "svg"
              ? "Sandboxed preview · no network or page access"
              : `Saved ${timeAgo(selected.createdAt)}${selected.meta?.source ? ` · ${selected.meta.source}` : ""}${
                  selected.kind === "research" ? "" : " · text only, nothing here runs"
                }`}
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
                    : "Everything the chat produces — artifacts, code, documents, data and research — collects here automatically."}
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
                    {iconFor(item)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm font-semibold text-foreground truncate flex-1">
                        {item.title}
                      </span>
                      {item.meta?.focused && (
                        <span
                          className="material-symbols-outlined text-primary-container text-base shrink-0"
                          style={{ fontVariationSettings: "'FILL' 1" }}
                          title="Pinned as chat focus"
                        >
                          push_pin
                        </span>
                      )}
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
                    <div className="text-[11px] text-on-surface-variant mt-0.5 truncate">
                      {labelFor(item)}
                      {item.meta?.language ? ` · ${languageLabel(item.meta.language)}` : ""} ·{" "}
                      {timeAgo(item.createdAt)}
                    </div>
                  </div>
                  <span
                    className="shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={() => handleToggleFocus(item)}
                      onKeyDown={(e) => { if (e.key === "Enter") handleToggleFocus(item); }}
                      title={item.meta?.focused ? "Unpin from chat focus" : "Pin as chat focus — sent to the AI every turn"}
                      className={`inline-flex items-center justify-center h-7 w-7 rounded-lg cursor-pointer transition-colors ${
                        item.meta?.focused
                          ? "text-primary-container"
                          : "text-on-surface-variant hover:bg-surface-container-highest"
                      }`}
                    >
                      <span
                        className="material-symbols-outlined text-[18px]"
                        style={item.meta?.focused ? { fontVariationSettings: "'FILL' 1" } : undefined}
                      >
                        push_pin
                      </span>
                    </span>
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
