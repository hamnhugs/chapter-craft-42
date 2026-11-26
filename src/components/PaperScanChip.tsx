import React, { useCallback, useRef, useState } from "react";
import PaperCamera, { inPageCameraUsable } from "@/components/PaperCamera";
import { cameraTrip } from "@/lib/paperSession";
import { toast } from "sonner";
import { usePaperScan, type ScanEvent } from "@/hooks/usePaperScan";
import { paperProgressLabel } from "@/lib/paperBook";
import { PROBLEM_COPY } from "@/lib/pagePhoto";

/**
 * "Snap the next page" inside Chat.
 *
 * Talking about a paper book and adding to it are one sitting: the reader
 * asks about page 47, turns the page, and wants page 48 in the conversation
 * without walking back to the Read tab. This is the desk's shutter, alone,
 * above the composer — shown only while Chat has an unfinished paper book
 * loaded. The page lands in the book, and Chat reads the book.
 */
const PaperScanChip: React.FC<{ bookId: string; title: string }> = ({ bookId, title }) => {
  const input = useRef<HTMLInputElement>(null);
  const onEvent = useCallback((e: ScanEvent) => {
    if (e.type === "pages") toast.success(`Added ${e.labels.join(" and ")}. Chat can read ${e.count === 1 ? "it" : "them"} now.`);
    else toast.success("Cover added");
  }, []);
  const scan = usePaperScan({ bookId, onEvent });
  const trouble = scan.shots.find((s) => s.status === "warn" || s.status === "failed");
  const working = scan.busy > 0 || scan.saveState === "saving";
  const [camOpen, setCamOpen] = useState(false);
  const native = () => { cameraTrip.begin(false); input.current?.click(); };
  // The camera inside the app where there is one: leaving for the phone's
  // camera app can make the phone reload this page (see PaperCamera).
  const snap = () => {
    const touch = !!window.matchMedia?.("(pointer: coarse)").matches;
    if (touch && inPageCameraUsable()) setCamOpen(true);
    else native();
  };

  return (
    <div className="cc-paper-chip" data-trouble={trouble ? true : undefined}>
      <PaperCamera
        open={camOpen}
        onClose={() => setCamOpen(false)}
        onPhoto={(file) => scan.addPhotos([file])}
        onUseNative={native}
        busy={scan.busy}
        pages={scan.pages.length}
        note={trouble ? "A photo needs a look. Tap Done to see it." : null}
      />
      <input
        ref={input}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          cameraTrip.end();
          if (files.length > 0) scan.addPhotos(files);
        }}
      />
      {trouble ? (
        <>
          <span className="min-w-0 flex-1 truncate">
            {trouble.status === "warn" && trouble.problem ? PROBLEM_COPY[trouble.problem].title : trouble.message}
          </span>
          {trouble.status === "warn" && <button type="button" onClick={() => scan.useAnyway(trouble.id)}>Use anyway</button>}
          {trouble.status === "failed" && trouble.retryable && <button type="button" onClick={() => scan.retryShot(trouble.id)}>Try again</button>}
          <button type="button" data-strong onClick={() => { scan.discardShot(trouble.id); snap(); }}>Retake</button>
          <button type="button" aria-label="Dismiss" onClick={() => scan.discardShot(trouble.id)}>
            <span className="material-symbols-outlined" aria-hidden>close</span>
          </button>
        </>
      ) : (
        <button type="button" data-main disabled={scan.loadState !== "ready"} onClick={snap} title={`Add the next page of ${title}`}>
          <span className={`material-symbols-outlined ${working ? "animate-spin" : ""}`} aria-hidden>{working ? "progress_activity" : "photo_camera"}</span>
          <span className="truncate">
            {scan.busy > 0 ? (scan.batch.total > 1 ? `Reading ${Math.min(scan.batch.total, scan.batch.done + 1)} of ${scan.batch.total}…` : "Reading the page…") : scan.saveState === "error" ? "Not saved. Tap to snap again" : "Snap the next page"}
          </span>
          <span className="cc-paper-chip-meta truncate">{title} · {paperProgressLabel(scan.meta)}</span>
        </button>
      )}
    </div>
  );
};

export default PaperScanChip;
