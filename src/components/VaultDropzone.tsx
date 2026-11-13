import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * The Vault's "add a book" surface: three file tiles that fan apart while
 * something is dragged over, and a light beam that runs around the border.
 *
 * Adapted from 21st.dev "File Upload" (@extend-hq/file-upload). Kept: the
 * drag-depth counter (dragleave fires on every child, so a plain boolean
 * flickers), the fanned icon cluster and the beam. Dropped: its own file
 * list and validation — the Vault's upload queue already does both — and the
 * hugeicons / border-beam packages, replaced by Material Symbols and a CSS
 * conic gradient (.cc-drop-beam in index.css).
 *
 * Two shapes:
 *  - VaultDropzone    — the big panel. Only shown while the library is EMPTY,
 *                       where adding a book is the page's one job. With books
 *                       on the shelves it used to sit above them and push the
 *                       first book ~1,400px down a 1440x900 screen.
 *  - VaultDropOverlay — what a populated Vault shows while files are dragged
 *                       over it: the whole window becomes the target, so the
 *                       drop area costs no space until the moment it's wanted.
 */

const TILES = [
  { icon: "picture_as_pdf", label: "PDF", idle: "translate(-78%,-50%) rotate(-8deg)", active: "translate(-150%,-46%) rotate(-16deg) scale(1.08)" },
  { icon: "menu_book", label: "EPUB", idle: "translate(-50%,-50%)", active: "translate(-50%,-62%) scale(1.18)" },
  { icon: "description", label: "DOC", idle: "translate(-22%,-50%) rotate(8deg)", active: "translate(50%,-46%) rotate(16deg) scale(1.08)" },
];

const FileTiles: React.FC<{ fanned: boolean }> = ({ fanned }) => (
  <div className="cc-dropzone-icon relative mb-5 h-16 w-40" aria-hidden>
    {TILES.map((t, i) => (
      <div
        key={t.label}
        className={cn(
          "absolute left-1/2 top-1/2 grid size-14 place-items-center rounded-xl border border-outline-variant/20 bg-surface-container-high text-on-surface-variant shadow-sm",
          "transition-[transform,color,background-color,box-shadow] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
          i === 1 && "z-10",
          fanned ? "bg-surface-container-highest text-primary shadow-lg shadow-black/25" : "group-hover:text-primary",
        )}
        style={{ transform: fanned ? t.active : t.idle }}
      >
        <span className="material-symbols-outlined text-2xl -mt-2.5">{t.icon}</span>
        <span className="absolute bottom-1.5 text-[9px] leading-none font-bold tracking-widest opacity-70">{t.label}</span>
      </div>
    ))}
  </div>
);

/** Drag-depth tracking shared by both shapes. */
function useDragDepth(initial = false) {
  const depth = React.useRef(initial ? 1 : 0);
  const [dragging, setDragging] = React.useState(initial);
  const reset = React.useCallback(() => {
    depth.current = 0;
    setDragging(false);
  }, []);
  const handlers = {
    onDragEnter: (e: React.DragEvent) => {
      e.preventDefault();
      depth.current += 1;
      setDragging(true);
    },
    onDragLeave: (e: React.DragEvent) => {
      e.preventDefault();
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    },
    onDragOver: (e: React.DragEvent) => e.preventDefault(),
  };
  return { dragging, reset, handlers };
}

interface PanelProps {
  /** The resting headline. */
  title: string;
  isUploading: boolean;
  onBrowse: () => void;
  onDrop: (e: React.DragEvent) => void;
  onYoutube: () => void;
  onYoutubeHover?: () => void;
}

export const VaultDropzone: React.FC<PanelProps> = ({ title, isUploading, onBrowse, onDrop, onYoutube, onYoutubeHover }) => {
  const { dragging, reset, handlers } = useDragDepth();

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label="Add books: drop files here or press Enter to browse"
      onClick={onBrowse}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onBrowse();
        }
      }}
      {...handlers}
      onDrop={(e) => {
        reset();
        onDrop(e);
      }}
      data-dragging={dragging || undefined}
      className={cn(
        "cc-vault-dropzone cc-drop-beam group relative rounded-2xl border-2 border-dashed p-12 flex flex-col items-center justify-center text-center cursor-pointer",
        "transition-[border-color,background-color] duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
        dragging
          ? "border-transparent bg-primary/[0.06]"
          : "border-outline-variant/30 bg-surface-container-low hover:border-primary/40 hover:bg-surface-container-high",
      )}
    >
      <FileTiles fanned={dragging} />

      <h3 className="cc-dropzone-title text-xl font-headline font-bold text-primary mb-1">
        {isUploading ? "Uploading…" : dragging ? "Drop to add to your Vault" : title}
      </h3>
      <p className="cc-dropzone-hint text-on-surface-variant text-sm mb-6">
        Drop a PDF, EPUB, HTML, DOC or TXT (up to 50MB) — or drag in a YouTube link.
      </p>

      <div className="cc-dropzone-actions flex items-center gap-3 flex-wrap justify-center">
        <button
          type="button"
          className="flex items-center gap-2 px-8 py-3 bg-primary-container text-on-primary-container font-bold rounded-xl active:scale-95 transition-transform disabled:opacity-60"
          onClick={(e) => {
            e.stopPropagation();
            onBrowse();
          }}
          disabled={isUploading}
        >
          <span className="material-symbols-outlined text-xl" aria-hidden>upload</span>
          Browse files
        </button>
        <button
          type="button"
          className="flex items-center gap-2 px-8 py-3 bg-surface-container-high text-foreground font-bold rounded-xl border border-outline-variant/20 hover:bg-surface-container-highest active:scale-95 transition-all"
          onClick={(e) => {
            e.stopPropagation();
            onYoutube();
          }}
          onMouseEnter={onYoutubeHover}
        >
          <span className="material-symbols-outlined text-xl" aria-hidden>smart_display</span>
          From YouTube
        </button>
      </div>
    </div>
  );
};

/** True when a drag carries something the Vault can take: files or a link.
 *  Dragging a book card or text inside the page must not raise the overlay. */
export function dragCarriesBooks(e: React.DragEvent | DragEvent): boolean {
  const types = Array.from(e.dataTransfer?.types ?? []);
  return types.includes("Files") || types.includes("text/uri-list");
}

/**
 * Whole-window drop target, mounted while a drag is over the Vault. The Vault
 * mounts it on its own dragenter; it unmounts itself when the drag leaves the
 * window, is cancelled, or lands.
 */
export const VaultDropOverlay: React.FC<{
  onDrop: (e: React.DragEvent) => void;
  onClose: () => void;
}> = ({ onDrop, onClose }) => {
  // Mounted mid-drag: the enter that opened it fired on the element below, so
  // count it here, or the overlay's first child-leave would close it.
  const { dragging, reset, handlers } = useDragDepth(true);
  React.useEffect(() => {
    if (!dragging) onClose();
  }, [dragging, onClose]);
  React.useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    // A drag cancelled outside the window sends no dragleave here.
    window.addEventListener("dragend", onClose);
    return () => {
      window.removeEventListener("keydown", esc);
      window.removeEventListener("dragend", onClose);
    };
  }, [onClose]);

  return (
    <div
      {...handlers}
      onDrop={(e) => {
        reset();
        onDrop(e);
      }}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-background/70 p-6 backdrop-blur-sm motion-safe:animate-in motion-safe:fade-in-0"
    >
      <div
        data-dragging
        className="cc-drop-beam pointer-events-none relative flex w-full max-w-xl flex-col items-center rounded-2xl border-2 border-transparent bg-surface-container-low px-10 py-14 text-center shadow-2xl"
      >
        <FileTiles fanned />
        <h3 className="text-2xl font-headline font-bold text-primary mb-1">Drop to add to your Vault</h3>
        <p className="text-sm text-on-surface-variant">PDF, EPUB, HTML, DOC or TXT — or a YouTube link</p>
      </div>
    </div>
  );
};

export default VaultDropzone;
