import React, { useEffect, useMemo, useRef, useState } from "react";
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
import { useNotebookDirectory } from "@/lib/notebookDirectory";
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
 * FILED BY NOTEBOOK. Every item belongs to the notebook Counsel had loaded
 * when it was made (meta.wikiId, stamped in the store). The list opens on the
 * loaded notebook's files, so one project's files are not buried under every
 * other project's; the row of chips under the header switches notebook, shows
 * what still needs one, or shows everything.
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
 * Panel width at which the viewer switches to WIDE density.
 *
 * The panel is now drag-resizable, so width is a real variable and the panel
 * has to earn every pixel the user gives it. Four things do that work:
 * the 78ch measure cap (workspace-typography.css), the SVG zoom floor
 * (SvgArtifactViewer), a real scrollbar on the list, and the labelled header
 * controls below. 640 is the point at which the detail header has room for
 * text beside its icons without squeezing the filename to nothing.
 *
 * Measured in JS, never with a container query: `container-type: inline-size`
 * implies `contain: layout`, which creates a containing block and would
 * silently trap the fullscreen overlay inside this panel instead of the
 * viewport.
 */
export const WIDE_DENSITY_PX = 640;

type Density = "narrow" | "wide";

/** Which files the list shows. "auto" follows the notebook Counsel has
 *  loaded (everything, when it has none) until the person picks a chip. */
type Scope = "auto" | "all" | "unfiled" | { wikiId: string };

/** Scope chips, as complete literals for Tailwind's scanner. */
const SCOPE_CHIP_CLASS = {
  on: "shrink-0 inline-flex items-center gap-1.5 h-7 max-w-[11rem] px-2.5 rounded-full text-[11px] font-semibold bg-primary-container/20 text-primary border border-primary-container/40 transition-colors",
  off: "shrink-0 inline-flex items-center gap-1.5 h-7 max-w-[11rem] px-2.5 rounded-full text-[11px] font-semibold text-on-surface-variant border border-outline-variant/20 hover:bg-surface-container-high transition-colors",
};

/**
 * Detail-header control shape, as two COMPLETE literals — Tailwind's content
 * scanner cannot see a class name assembled by concatenation.
 *
 * The narrow string is byte-identical to what this panel has always
 * rendered. That is a hard gate, not a nicety: this ship adds capability at
 * width, it removes none at narrowness, and the deliberate seven-control clip
 * documented at the header row below still has to behave exactly as it does
 * today on a phone.
 */
const HEADER_CONTROL_SHAPE: Record<Density, string> = {
  narrow: "shrink-0 inline-flex items-center justify-center h-8 w-8 rounded-lg",
  wide: "shrink-0 inline-flex items-center justify-center gap-1 h-8 px-2 rounded-lg",
};

/** Label typography for the wide-density header controls. */
const HEADER_LABEL_CLASS = "text-[11px] font-semibold whitespace-nowrap";

/** List scroll behaviour, also as complete literals. At wide the list gives
 *  up `hide-scrollbar` for a real (thin, themed) one: a long file list in a
 *  wide panel with no scroll indicator reads as if it had already ended. */
const LIST_SCROLL_CLASS: Record<Density, string> = {
  narrow: "flex-1 min-h-0 overflow-auto px-2 py-2 space-y-1.5 hide-scrollbar",
  wide: "flex-1 min-h-0 overflow-auto px-2 py-2 space-y-1.5 scrollbar-thin",
};

/**
 * Fullscreen toggle.
 *
 * ENTER is an ordinary icon button. EXIT is not: Escape does not exist on a
 * phone, and a landscape phone is exactly the device this whole feature is
 * for. So in fullscreen the way out is a visible, text-labelled button with a
 * 44px minimum touch target (WCAG 2.5.8 asks 24x24; 44 is the platform HIG
 * floor and the number that matters when the target is a thumb). One obvious
 * tap, never a gesture, never a keyboard-only affordance.
 */
const FULLSCREEN_ENTER_CLASS =
  "shrink-0 inline-flex items-center justify-center h-8 w-8 rounded-lg text-on-surface-variant hover:bg-surface-container-high transition-colors";
const FULLSCREEN_EXIT_CLASS =
  "shrink-0 inline-flex items-center justify-center gap-1.5 h-11 min-h-[44px] min-w-[44px] px-3 rounded-xl bg-primary-container/20 text-primary-container hover:bg-primary-container/30 transition-colors";

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
  /** Up to 2000 numbers stringified and joined. Unmemoized this re-ran on
   *  every render of the panel — which was tolerable at a fixed width and is
   *  not now that a drag handle can re-render this subtree once per pointer
   *  event. Skipped entirely when the gutter is hidden, as before. */
  const gutter = useMemo(
    () => (showGutter ? lines.map((_, i) => String(i + 1)).join("\n") : ""),
    [lines, showGutter],
  );
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
              {gutter}
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
  /** True while the shell is showing this panel as a full-viewport takeover.
   *  Drives the exit affordance, NOT the layout — the shell owns geometry. */
  fullscreen?: boolean;
  /** Provided by the shell. Absent (e.g. an embedder that has no fullscreen
   *  mode) means the toggle is not rendered at all. */
  onToggleFullscreen?: () => void;
  /** Lets the shell move focus to the fullscreen control when it flips mode.
   *  A BUTTON ref on purpose: nothing in this feature may ever focus an input
   *  or a textarea (Android opens the soft keyboard on any programmatic
   *  focus once the session has seen a gesture — src/lib/focusPolicy.ts). */
  fullscreenButtonRef?: React.RefObject<HTMLButtonElement>;
}> = ({ userId, onClose, selectedId, onSelect, fullscreen, onToggleFullscreen, fullscreenButtonRef }) => {
  const allItems = useWorkspaceItems();
  const [filter, setFilter] = useState<"all" | "library">("all");
  const { notebooks, activeId } = useNotebookDirectory();
  const [scope, setScope] = useState<Scope>("auto");

  // ── Width density ───────────────────────────────────────────────────────
  // The panel measures ITSELF rather than reading the window, because in
  // `dock` geometry its width is whatever the user dragged it to and has no
  // fixed relationship to the viewport.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [density, setDensity] = useState<Density>("narrow");
  const densityRef = useRef<Density>("narrow");

  useEffect(() => {
    const el = rootRef.current;
    // jsdom (and any pre-2020 browser) has no ResizeObserver; narrow is the
    // correct, unchanged-from-today fallback.
    if (!el || typeof ResizeObserver === "undefined") return;

    let raf = 0;
    const measure = (width: number) => {
      // A zero width means "detached or display:none", not "very narrow" —
      // acting on it would flip density every time the panel is hidden.
      if (!width) return;
      const next: Density = width >= WIDE_DENSITY_PX ? "wide" : "narrow";
      // No-op when unchanged: a resize observer that writes on every callback
      // is how "ResizeObserver loop completed with undelivered notifications"
      // gets thrown, and that error is dispatched at *error* severity — it
      // trips catch-all handlers and has been observed to abort in-progress
      // drags.
      if (next === densityRef.current) return;
      densityRef.current = next;
      // Every DOM/state write is deferred out of the observer callback into
      // the next frame, which is the documented avoidance for that same loop
      // error.
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        raf = 0;
        setDensity(next);
      });
    };

    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      measure(entry ? entry.contentRect.width : el.clientWidth);
    });
    ro.observe(el);
    // Seed from the current box so a panel that mounts wide does not spend a
    // frame rendering narrow.
    measure(el.clientWidth);

    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  const wide = density === "wide";

  const mine = useMemo(
    () => allItems.filter((i) => i.userId == null || i.userId === userId),
    [allItems, userId],
  );

  const notebookById = useMemo(() => new Map(notebooks.map((n) => [n.id, n])), [notebooks]);
  /** The notebook an item is filed in, or null. An id whose notebook was
   *  deleted counts as unfiled — the file outlives the notebook. */
  const notebookOf = (item: WorkspaceItem) =>
    (item.meta?.wikiId && notebookById.get(item.meta.wikiId)) || null;

  // Per-notebook counts, for the chips. Signed-out and notebook-less accounts
  // have nothing to file under: no chips, and the panel is the flat list it
  // always was.
  const { counts, unfiledCount } = useMemo(() => {
    const counts = new Map<string, number>();
    let unfiledCount = 0;
    for (const i of mine) {
      const id = i.meta?.wikiId;
      if (id && notebookById.has(id)) counts.set(id, (counts.get(id) || 0) + 1);
      else unfiledCount++;
    }
    return { counts, unfiledCount };
  }, [mine, notebookById]);
  const filingOn = notebooks.length > 0;

  // The loaded notebook first, then every other notebook that holds files.
  const scopeNotebooks = useMemo(
    () => [
      ...notebooks.filter((n) => n.id === activeId),
      ...notebooks.filter((n) => n.id !== activeId && counts.has(n.id)),
    ],
    [notebooks, activeId, counts],
  );

  // What "auto" means right now. A picked notebook that has since been
  // deleted falls back the same way.
  const effectiveScope: Exclude<Scope, "auto"> = !filingOn
    ? "all"
    : scope === "auto" || (typeof scope === "object" && !notebookById.has(scope.wikiId))
      ? activeId && notebookById.has(activeId) ? { wikiId: activeId } : "all"
      : scope;
  const scopeWikiId = typeof effectiveScope === "object" ? effectiveScope.wikiId : null;
  const scopeNotebook = scopeWikiId ? notebookById.get(scopeWikiId) || null : null;
  const unfiledScope = effectiveScope === "unfiled";

  const items = useMemo(() => {
    let list = mine;
    if (scopeWikiId) list = list.filter((i) => i.meta?.wikiId === scopeWikiId);
    else if (unfiledScope) list = list.filter((i) => !(i.meta?.wikiId && notebookById.has(i.meta.wikiId)));
    if (filter === "library") list = list.filter((i) => i.savedToLibrary);
    return list;
  }, [mine, scopeWikiId, unfiledScope, notebookById, filter]);

  // From everything, not the scoped list: a chat bubble or the Notebooks tab
  // can open a file from a notebook other than the one being browsed.
  const selected = useMemo(
    () => mine.find((i) => i.id === selectedId) || null,
    [mine, selectedId]
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
    // Only what is listed: clearing one notebook's files must never reach
    // into another's.
    const removable = items.filter((i) => !i.savedToLibrary).map((i) => i.id);
    if (!removable.length) {
      toast.message("Nothing to clear", { description: "Pinned library items are kept." });
      return;
    }
    workspaceStore.removeMany(removable);
    onSelect(null);
    toast.success("Cleared unsaved files");
  };

  return (
    <div
      ref={rootRef}
      className="flex h-full flex-col bg-surface-container-low border-l border-outline-variant/10 min-w-0"
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-3 border-b border-outline-variant/10 shrink-0">
        <span className="material-symbols-outlined text-primary-container text-xl">folder_open</span>
        {/* `truncate` is the pressure valve for this row, and it exists
            because of the fullscreen control below. "Workspace" is a single
            unbreakable word, so as a flex item it has min-width:auto and
            never yields; on a 360px phone in fullscreen the labelled exit
            button (~156px) pushes the CLOSE button off the edge instead.
            overflow:hidden drops the automatic minimum size to zero, so the
            wordmark is what gives. At every width that fits today — which is
            every width, since the row only grew when an embedder opted into
            fullscreen — this renders identically. */}
        <span className="font-headline font-bold text-sm text-foreground truncate">Workspace</span>
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
          {onToggleFullscreen && (
            <button
              ref={fullscreenButtonRef}
              onClick={onToggleFullscreen}
              aria-pressed={!!fullscreen}
              aria-label={fullscreen ? "Exit full screen" : "Expand workspace to full screen"}
              title={fullscreen ? "Exit full screen" : "Expand workspace to full screen"}
              className={fullscreen ? FULLSCREEN_EXIT_CLASS : FULLSCREEN_ENTER_CLASS}
            >
              <span className="material-symbols-outlined text-[20px]">
                {fullscreen ? "close_fullscreen" : "open_in_full"}
              </span>
              {/* Labelled only on the way OUT, and at every width: a phone in
                  fullscreen has no Escape key and no visible chrome, so the
                  exit must be unmissable even on a 393px portrait screen. */}
              {fullscreen && <span className="text-xs font-semibold whitespace-nowrap">Exit full screen</span>}
            </button>
          )}
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
            {/* The five action controls. At WIDE they carry text labels — an
                icon-only `push_pin` is genuinely ambiguous ("pin to library"?
                "pin to top"?) and a wide panel has the room to just say what
                it does. At NARROW every class string and every child below is
                exactly what shipped before, so the clip note above still
                describes real behaviour. */}
            <button
              onClick={() => handleToggleFocus(selected)}
              title={selected.meta?.focused ? "Unpin from chat focus" : "Pin as chat focus — sent to the AI every turn"}
              className={`${HEADER_CONTROL_SHAPE[density]} transition-colors ${
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
              {wide && <span className={HEADER_LABEL_CLASS}>Focus</span>}
            </button>
            <button
              onClick={() => handleToggleLibrary(selected)}
              title={selected.savedToLibrary ? "Remove from library" : "Save to library"}
              className={`${HEADER_CONTROL_SHAPE[density]} transition-colors ${
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
              {wide && <span className={HEADER_LABEL_CLASS}>Library</span>}
            </button>
            <button
              onClick={() => handleCopy(selected.content)}
              title="Copy source"
              className={`${HEADER_CONTROL_SHAPE[density]} text-on-surface-variant hover:bg-surface-container-high transition-colors`}
            >
              <span className="material-symbols-outlined text-[20px]">content_copy</span>
              {wide && <span className={HEADER_LABEL_CLASS}>Copy</span>}
            </button>
            <button
              onClick={() => handleDownload(selected)}
              title="Download file"
              className={`${HEADER_CONTROL_SHAPE[density]} text-on-surface-variant hover:bg-surface-container-high transition-colors`}
            >
              <span className="material-symbols-outlined text-[20px]">download</span>
              {wide && <span className={HEADER_LABEL_CLASS}>Download</span>}
            </button>
            <button
              onClick={() => handleDelete(selected.id)}
              title="Delete"
              className={`${HEADER_CONTROL_SHAPE[density]} text-on-surface-variant hover:text-destructive hover:bg-surface-container-high transition-colors`}
            >
              <span className="material-symbols-outlined text-[20px]">delete</span>
              {wide && <span className={HEADER_LABEL_CLASS}>Delete</span>}
            </button>
          </div>

          {selected.kind === "research" ? (
            <div className="flex-1 min-h-0 overflow-auto px-4 py-3">
              {/* `max-w-none` is gone and `cc-measure` replaces it. Those
                  Tailwind prose classes emit ZERO CSS in this app — the
                  typography plugin is installed but never registered — so
                  `max-w-none` was losing a specificity fight it looked like it
                  was winning, and reports rendered unclamped at any width.
                  `.prose` is kept because the fruit-stripe theme keys off it.
                  See src/styles/workspace-typography.css. */}
              <div className="prose prose-sm prose-invert cc-measure break-words">
                <ReactMarkdown urlTransform={safeUrlTransform} components={safeMarkdownComponents}>{selected.content}</ReactMarkdown>
              </div>
              {selected.meta?.citations && selected.meta.citations.length > 0 && (
                // Same measure as the prose above it, via the cap-only class:
                // a Sources block that spans the full panel while the report
                // it belongs to is centred at 78ch reads as a layout bug, and
                // the rule above it would visibly overhang the text. Cap-only
                // because `.cc-measure`'s list rules would put disc markers
                // on this list, which is a narrow-width change R5 forbids.
                <div className="mt-4 pt-3 border-t border-outline-variant/10 cc-measure-box">
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
          <div className="flex items-center gap-2 px-3 py-1.5 border-t border-outline-variant/10 shrink-0 text-[10px] text-on-surface-variant min-w-0">
            <span className="truncate min-w-0 flex-1">
              {selected.kind === "html" || selected.kind === "svg"
                ? "Sandboxed preview · no network or page access"
                : `Saved ${timeAgo(selected.createdAt)}${selected.meta?.source ? ` · ${selected.meta.source}` : ""}${
                    selected.kind === "research" ? "" : " · text only, nothing here runs"
                  }`}
            </span>
            {filingOn && selected.userId && (
              <button
                onClick={() => workspaceStore.requestFiling([selected.id])}
                title="Move to another notebook"
                className="shrink-0 inline-flex items-center gap-1 max-w-[50%] h-6 px-2 rounded-full border border-outline-variant/20 font-semibold hover:bg-surface-container-high hover:text-foreground transition-colors"
              >
                {notebookOf(selected) ? (
                  <span aria-hidden className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: notebookOf(selected)!.color }} />
                ) : (
                  <span className="material-symbols-outlined text-[14px]" aria-hidden>drive_file_move</span>
                )}
                <span className="truncate">{notebookOf(selected)?.name || "Needs a notebook"}</span>
              </button>
            )}
          </div>
        </div>
      ) : (
        <>
          {/* Notebook scope: one line that scrolls, like Counsel's chip row. */}
          {filingOn && (
            <div
              role="tablist"
              aria-label="Show files from"
              className="flex flex-nowrap items-center gap-1.5 px-2 py-2 border-b border-outline-variant/10 shrink-0 overflow-x-auto hide-scrollbar"
            >
              {scopeNotebooks.map((n) => (
                <button
                  key={n.id}
                  role="tab"
                  aria-selected={scopeWikiId === n.id}
                  onClick={() => setScope({ wikiId: n.id })}
                  title={n.id === activeId ? `${n.name} — open in Counsel, new files go here` : n.name}
                  className={scopeWikiId === n.id ? SCOPE_CHIP_CLASS.on : SCOPE_CHIP_CLASS.off}
                >
                  <span aria-hidden className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: n.color }} />
                  <span className="truncate">{n.name}</span>
                  <span className="tabular-nums opacity-70">{counts.get(n.id) || 0}</span>
                </button>
              ))}
              {unfiledCount > 0 && (
                <button
                  role="tab"
                  aria-selected={effectiveScope === "unfiled"}
                  onClick={() => setScope("unfiled")}
                  title="Files that aren't in a notebook yet"
                  className={effectiveScope === "unfiled" ? SCOPE_CHIP_CLASS.on : SCOPE_CHIP_CLASS.off}
                >
                  <span className="material-symbols-outlined text-[14px]" aria-hidden>inbox</span>
                  <span className="truncate">Needs a notebook</span>
                  <span className="tabular-nums opacity-70">{unfiledCount}</span>
                </button>
              )}
              <button
                role="tab"
                aria-selected={effectiveScope === "all"}
                onClick={() => setScope("all")}
                className={effectiveScope === "all" ? SCOPE_CHIP_CLASS.on : SCOPE_CHIP_CLASS.off}
              >
                All
                <span className="tabular-nums opacity-70">{mine.length}</span>
              </button>
            </div>
          )}
          {effectiveScope === "unfiled" && items.some((i) => i.userId) && (
            <div className="px-2 pt-2 shrink-0">
              <button
                onClick={() => workspaceStore.requestFiling(items.filter((i) => i.userId).map((i) => i.id))}
                className="flex items-center justify-center gap-1.5 w-full min-h-[36px] rounded-lg border border-dashed border-outline-variant/40 text-xs font-semibold text-on-surface-variant hover:border-primary-container/60 hover:text-primary transition-colors"
              >
                <span className="material-symbols-outlined text-[16px]" aria-hidden>drive_file_move</span>
                {items.length === 1 ? "Move it to a notebook" : `Move all ${items.filter((i) => i.userId).length} to a notebook`}
              </button>
            </div>
          )}

          {/* List view */}
          <div className={LIST_SCROLL_CLASS[density]}>
            {items.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-center text-on-surface-variant gap-2 px-6">
                <span className="material-symbols-outlined text-4xl text-primary-container/70">
                  {filter === "library" ? "bookmark" : "folder_open"}
                </span>
                <p className="text-sm font-medium text-foreground">
                  {filter === "library"
                    ? "No saved files yet"
                    : scopeNotebook
                      ? `Nothing in ${scopeNotebook.name} yet`
                      : "No files yet"}
                </p>
                <p className="text-xs">
                  {filter === "library"
                    ? "Pin a file with the bookmark to keep it here permanently."
                    : scopeNotebook
                      ? scopeNotebook.id === activeId
                        ? "Whatever Counsel makes while this notebook is open is filed here."
                        : "Open this notebook in Counsel and what it makes is filed here."
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
                      {filingOn && !scopeWikiId && notebookOf(item) ? ` · ${notebookOf(item)!.name}` : ""}
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
                    {filingOn && item.userId && (
                      <span
                        role="button"
                        tabIndex={0}
                        onClick={() => workspaceStore.requestFiling([item.id])}
                        onKeyDown={(e) => { if (e.key === "Enter") workspaceStore.requestFiling([item.id]); }}
                        title="Move to another notebook"
                        className="inline-flex items-center justify-center h-7 w-7 rounded-lg cursor-pointer text-on-surface-variant hover:bg-surface-container-highest transition-colors"
                      >
                        <span className="material-symbols-outlined text-[18px]">drive_file_move</span>
                      </span>
                    )}
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
