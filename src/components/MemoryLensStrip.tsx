import React, { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import GeneratedImage from "@/components/GeneratedImage";
import { getRecallStates, recordShown, recordRequested, setSuppressed, wasRecentlyRecorded, type MemoryImageCandidate } from "@/lib/memoryLens";
import { getSignedImageUrl } from "@/lib/imageGen";

/**
 * Memory Lens UI.
 *
 * LensImageFrame wraps any chat image card and records a REAL display: the
 * card must be ≥50% visible for ≥1s with the document visible and hands-free
 * inactive before recall state advances — a reply spoken to a pocketed phone
 * consumes nothing, so the first look is never wasted. Memory-linked images
 * get a "don't show again" control (two-step; undo lives in Settings).
 *
 * MemoryChips renders repeat-recall images as small tap-to-expand chips (the
 * Slack-collapsed-unfurl convention; never the same image twice in a session).
 */

const recordedThisTab = new Set<string>();

interface FrameProps {
  imageId: string;
  /** memory-linked → offers the suppress control */
  memoryLinked: boolean;
  handsFreeActive: boolean;
  children: React.ReactNode;
}

export const LensImageFrame: React.FC<FrameProps> = ({ imageId, memoryLinked, handsFreeActive, children }) => {
  const ref = useRef<HTMLDivElement | null>(null);
  const handsFreeRef = useRef(handsFreeActive);
  handsFreeRef.current = handsFreeActive;
  const [confirming, setConfirming] = useState(false);
  const [suppressed, setSuppressedLocal] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || recordedThisTab.has(imageId)) return;
    let dwellTimer: number | null = null;
    let done = false;
    const record = async () => {
      if (done || recordedThisTab.has(imageId)) return;
      done = true;
      recordedThisTab.add(imageId);
      try {
        const st = (await getRecallStates([imageId])).get(imageId) || null;
        if (!wasRecentlyRecorded(st)) await recordShown(imageId);
      } catch { /* best effort */ }
      obs.disconnect();
    };
    const obs = new IntersectionObserver(
      (entries) => {
        const e = entries[0];
        const eligible = e.isIntersecting && e.intersectionRatio >= 0.5 && !document.hidden && !handsFreeRef.current;
        if (eligible && dwellTimer === null) {
          dwellTimer = window.setTimeout(() => { void record(); }, 1000);
        } else if (!eligible && dwellTimer !== null) {
          window.clearTimeout(dwellTimer);
          dwellTimer = null;
        }
      },
      { threshold: [0, 0.5, 1] },
    );
    obs.observe(el);
    return () => {
      if (dwellTimer !== null) window.clearTimeout(dwellTimer);
      obs.disconnect();
    };
  }, [imageId]);

  if (suppressed) {
    return (
      <div className="text-xs text-on-surface-variant italic px-1 py-2">
        Image hidden from auto-recall — undo in Settings → Memory Lens.
      </div>
    );
  }

  return (
    <div ref={ref} className="relative group/lens">
      {children}
      {memoryLinked && (
        <div className="absolute top-1.5 right-1.5 opacity-0 group-hover/lens:opacity-100 focus-within:opacity-100 transition-opacity">
          {confirming ? (
            <div className="flex items-center gap-1 rounded-lg bg-surface-container-highest/95 border border-outline-variant/30 px-2 py-1 text-[11px]">
              <span className="text-on-surface-variant">Never auto-show this image again?</span>
              <button
                onClick={async () => {
                  setConfirming(false);
                  setSuppressedLocal(true);
                  await setSuppressed(imageId, true);
                  toast.success("Image muted — undo in Settings → Memory Lens");
                }}
                className="font-bold text-destructive px-1"
              >Mute</button>
              <button onClick={() => setConfirming(false)} className="text-on-surface-variant px-1">Keep</button>
            </div>
          ) : (
            <button
              onClick={() => setConfirming(true)}
              title="Don't show this image automatically again"
              aria-label="Don't show this image automatically again"
              className="p-1 rounded-lg bg-surface-container-highest/80 text-on-surface-variant hover:text-destructive"
            >
              <span className="material-symbols-outlined text-base leading-none">visibility_off</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
};

interface ChipsProps {
  chips: MemoryImageCandidate[];
  handsFreeActive: boolean;
}

const Chip: React.FC<{ c: MemoryImageCandidate; handsFreeActive: boolean }> = ({ c, handsFreeActive }) => {
  const [thumb, setThumb] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    let alive = true;
    getSignedImageUrl(c.storagePath).then((u) => { if (alive) setThumb(u); }).catch(() => { /* chip stays textual */ });
    return () => { alive = false; };
  }, [c.storagePath]);

  if (expanded) {
    return (
      <div className="w-full">
        <LensImageFrame imageId={c.imageId} memoryLinked handsFreeActive={handsFreeActive}>
          <GeneratedImage key={c.imageId} storagePath={c.storagePath} alt={c.prompt} caption={`From your memory: ${c.entryTitle}`} resizable />
        </LensImageFrame>
      </div>
    );
  }
  return (
    <button
      onClick={() => { setExpanded(true); void recordRequested(c.imageId); }}
      title={`From your memory: ${c.entryTitle} — tap to view`}
      className="flex items-center gap-2 rounded-full bg-surface-container-high/70 border border-outline-variant/20 pl-1 pr-3 py-1 hover:border-primary-container/50 transition-colors max-w-[16rem]"
    >
      {thumb ? (
        <img src={thumb} alt="" className="w-6 h-6 rounded-full object-cover" loading="lazy" />
      ) : (
        <span className="material-symbols-outlined text-base text-on-surface-variant">image</span>
      )}
      <span className="text-xs text-on-surface-variant truncate">{c.entryTitle || "memory image"}</span>
    </button>
  );
};

export const MemoryChips: React.FC<ChipsProps> = ({ chips, handsFreeActive }) => {
  if (!chips || chips.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 mt-1">
      <span className="material-symbols-outlined text-sm text-on-surface-variant" title="Images attached to memories this reply drew on">photo_library</span>
      {chips.slice(0, 4).map((c) => <Chip key={c.imageId} c={c} handsFreeActive={handsFreeActive} />)}
    </div>
  );
};
