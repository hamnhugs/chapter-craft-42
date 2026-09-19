import React, { useState, useRef, useEffect } from "react";

// Collapsed presentation for media on RESTORED chat messages (history loaded
// from the database). Reopening an old transcript must not eagerly re-sign
// every image URL and re-poll every video/splat job — so restored media shows
// as a compact card, and expanding it mounts the exact live component
// (GeneratedImage / VideoBubble / SplatBubble), which renders the media just
// as it appeared at generation. Live messages pass restored=false and render
// children untouched.

const KIND_META = {
  image: { icon: "image", one: "image", many: "images" },
  video: { icon: "movie", one: "video clip", many: "video clips" },
  splat: { icon: "3d_rotation", one: "3D model", many: "3D models" },
} as const;

const MediaReveal: React.FC<{
  restored?: boolean;
  kind: keyof typeof KIND_META;
  count: number;
  /** Prompt of the first item — gives the collapsed card a recognizable name. */
  label?: string;
  children: React.ReactNode;
}> = ({ restored, kind, count, label, children }) => {
  const [open, setOpen] = useState(false);
  const showRef = useRef<HTMLButtonElement | null>(null);
  const hideRef = useRef<HTMLButtonElement | null>(null);
  const wasOpenRef = useRef(false);
  // The toggle button unmounts on each flip — without a hand-off, keyboard
  // focus falls to <body> and a keyboard user loses their place.
  useEffect(() => {
    if (open) {
      wasOpenRef.current = true;
      hideRef.current?.focus({ preventScroll: true });
    } else if (wasOpenRef.current) {
      showRef.current?.focus({ preventScroll: true });
    }
  }, [open]);
  if (!restored) return <>{children}</>;
  const meta = KIND_META[kind];
  const what = count === 1 ? `1 ${meta.one}` : `${count} ${meta.many}`;

  if (!open) {
    return (
      <button
        ref={showRef}
        onClick={() => setOpen(true)}
        aria-expanded={false}
        aria-label={`Show ${what}${label ? `: ${label.slice(0, 80)}` : ""}`}
        className="group/reveal flex items-center gap-2.5 w-full max-w-sm text-left rounded-xl bg-surface-container-high/60 border border-outline-variant/20 px-3 py-2.5 my-1 hover:border-primary-container/50 transition-colors"
      >
        <span className="material-symbols-outlined text-primary-container text-xl shrink-0">{meta.icon}</span>
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-medium text-foreground truncate">{what}</span>
          {label && <span className="block text-[11px] text-on-surface-variant truncate">{label}</span>}
        </span>
        <span className="material-symbols-outlined text-on-surface-variant group-hover/reveal:text-primary text-lg shrink-0">expand_more</span>
      </button>
    );
  }

  return (
    <div className="my-1">
      <button
        ref={hideRef}
        onClick={() => setOpen(false)}
        aria-expanded={true}
        className="mb-1 inline-flex items-center gap-1 text-[10px] font-medium text-on-surface-variant hover:text-primary transition-colors"
      >
        <span className="material-symbols-outlined text-[13px] leading-none">expand_less</span>
        Hide {count === 1 ? meta.one : meta.many}
      </button>
      {children}
    </div>
  );
};

export default MediaReveal;
