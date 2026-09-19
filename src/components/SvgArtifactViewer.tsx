import React, { useState } from "react";
import { toast } from "sonner";
import { type Artifact } from "@/lib/artifacts";
import ArtifactFrame from "@/components/ArtifactFrame";
import { downloadSheetSvg, downloadSheetPdf } from "@/lib/blueprint/raster";

/**
 * Zoomable viewer for SVG workspace items (technical sheets especially).
 *
 * A 1000-unit-wide multi-view turnaround is illegible squeezed into a phone
 * panel, so this adds zoom — but the sandboxed ArtifactFrame stays the render
 * mechanism untouched. Its document already styles svg{max-width:100%}, which
 * means "zoom" is simply widening the frame's container: the SVG rescales to
 * fill it. The widened container lives inside an overflow-x-auto wrapper so
 * the sideways overflow is contained here and the page body never scrolls
 * horizontally. Vertical scrolling stays inside the frame's own document,
 * exactly as it behaves today at 100%.
 */

/**
 * Zoom stops. "100%" means "the frame is exactly the panel's width", so zoom
 * is RELATIVE TO THE PANEL, not to the sheet. That is fine at 360px and
 * actively hostile once the panel is resizable: at a 900px panel a 1000-unit
 * turnaround renders 2.5x larger than it used to, and with a floor of 100%
 * there was no way back out — widening the panel could only ever magnify.
 * The two stops below 100 are what makes dragging wider a net win for SVG
 * instead of a forced magnification.
 */
export const ZOOM_STEPS = [50, 75, 100, 150, 200, 300];

/** Index of the 100% stop — the default, unchanged from before the floor
 *  was added. */
export const ZOOM_DEFAULT_INDEX = 2;

const SvgArtifactViewer: React.FC<{ title: string; content: string }> = ({ title, content }) => {
  const [zoomIdx, setZoomIdx] = useState(ZOOM_DEFAULT_INDEX);
  // PDF export rasterises then lazy-loads jspdf; guard against double-clicks.
  const [exporting, setExporting] = useState(false);

  const zoom = ZOOM_STEPS[zoomIdx];
  const filenameBase = title.trim().replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "sheet";

  const handleDownloadSvg = () => {
    downloadSheetSvg(content, filenameBase);
    toast.success("SVG downloaded");
  };

  const handleDownloadPdf = async () => {
    setExporting(true);
    try {
      await downloadSheetPdf(content, filenameBase);
      toast.success("PDF downloaded");
    } catch (e) {
      // jspdf is a dynamic import (fails offline), and an SVG without a
      // viewBox can't be sized for a page — both land here, not just bugs.
      toast.error("PDF export failed", {
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setExporting(false);
    }
  };

  const btn =
    "inline-flex items-center justify-center h-8 w-8 rounded-lg text-on-surface-variant hover:bg-surface-container-high transition-colors disabled:opacity-40 disabled:pointer-events-none";

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Toolbar: zoom on the left, export on the right */}
      <div className="flex items-center gap-1 px-3 py-1.5 border-b border-outline-variant/10 shrink-0">
        <button
          onClick={() => setZoomIdx((i) => Math.max(0, i - 1))}
          disabled={zoomIdx === 0}
          title="Zoom out"
          className={btn}
        >
          <span className="material-symbols-outlined text-[20px]">zoom_out</span>
        </button>
        <span className="w-11 text-center text-[11px] font-semibold tabular-nums text-on-surface-variant select-none">
          {zoom}%
        </span>
        <button
          onClick={() => setZoomIdx((i) => Math.min(ZOOM_STEPS.length - 1, i + 1))}
          disabled={zoomIdx === ZOOM_STEPS.length - 1}
          title="Zoom in"
          className={btn}
        >
          <span className="material-symbols-outlined text-[20px]">zoom_in</span>
        </button>
        <div className="ml-auto flex items-center gap-1">
          <button onClick={handleDownloadSvg} title="Download SVG" className={btn}>
            <span className="material-symbols-outlined text-[20px]">download</span>
          </button>
          <button onClick={handleDownloadPdf} disabled={exporting} title="Download PDF" className={btn}>
            <span className="material-symbols-outlined text-[20px]">picture_as_pdf</span>
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-x-auto bg-white">
        {/* minWidth keeps the frame filling the panel at 100% on any screen —
            but it is applied ONLY at >= 100%. Left unconditional it would
            clamp every zoom-out back to full width, so the readout would say
            "50%" while nothing moved. `mx-auto` centres the sheet in the
            leftover space below 100%; at >= 100% there is none, so it is a
            no-op and the >= 100% behaviour is exactly what it always was. */}
        <div
          className="h-full mx-auto"
          style={{ width: `${zoom}%`, minWidth: zoom >= 100 ? "100%" : undefined }}
        >
          <ArtifactFrame
            title={title}
            artifact={{ title, kind: "svg", content } as Artifact}
          />
        </div>
      </div>
    </div>
  );
};

export default SvgArtifactViewer;
