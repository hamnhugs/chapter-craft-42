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
 */

const TILES = [
  { icon: "picture_as_pdf", label: "PDF", idle: "translate(-78%,-50%) rotate(-8deg)", active: "translate(-150%,-46%) rotate(-16deg) scale(1.08)" },
  { icon: "menu_book", label: "EPUB", idle: "translate(-50%,-50%)", active: "translate(-50%,-62%) scale(1.18)" },
  { icon: "description", label: "DOC", idle: "translate(-22%,-50%) rotate(8deg)", active: "translate(50%,-46%) rotate(16deg) scale(1.08)" },
];

interface Props {
  isUploading: boolean;
  onBrowse: () => void;
  onDrop: (e: React.DragEvent) => void;
  onYoutube: () => void;
  onYoutubeHover?: () => void;
}

export const VaultDropzone: React.FC<Props> = ({ isUploading, onBrowse, onDrop, onYoutube, onYoutubeHover }) => {
  const depth = React.useRef(0);
  const [dragging, setDragging] = React.useState(false);

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
      onDragEnter={(e) => {
        e.preventDefault();
        depth.current += 1;
        setDragging(true);
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setDragging(false);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        depth.current = 0;
        setDragging(false);
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
      {/* Fanned file tiles */}
      <div className="cc-dropzone-icon relative mb-5 h-16 w-40" aria-hidden>
        {TILES.map((t, i) => (
          <div
            key={t.label}
            className={cn(
              "absolute left-1/2 top-1/2 grid size-14 place-items-center rounded-xl border border-outline-variant/20 bg-surface-container-high text-on-surface-variant shadow-sm",
              "transition-[transform,color,background-color,box-shadow] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
              i === 1 && "z-10",
              dragging
                ? "bg-surface-container-highest text-primary shadow-lg shadow-black/25"
                : "group-hover:text-primary",
            )}
            style={{ transform: dragging ? t.active : t.idle }}
          >
            <span className="material-symbols-outlined text-2xl -mt-2.5">{t.icon}</span>
            <span className="absolute bottom-1.5 text-[9px] leading-none font-bold tracking-widest opacity-70">{t.label}</span>
          </div>
        ))}
      </div>

      <h3 className="cc-dropzone-title text-xl font-headline font-bold text-primary mb-1">
        {isUploading ? "Uploading…" : dragging ? "Drop to add to your Vault" : "Drop PDF or EPUB"}
      </h3>
      <p className="cc-dropzone-hint text-on-surface-variant text-sm mb-6">
        Max file size 50MB. Supports PDF, EPUB, HTML, DOC, TXT — or drag in a YouTube link.
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

export default VaultDropzone;
