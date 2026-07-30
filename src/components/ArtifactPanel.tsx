import React from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import ArtifactFrame from "@/components/ArtifactFrame";
import { type Artifact } from "@/lib/artifacts";

// Renders a model-authored HTML/SVG artifact in an isolated frame (see
// ArtifactFrame for the delivery mechanism). Isolation: sandbox="allow-scripts"
// WITHOUT allow-same-origin → the frame gets an opaque origin (can't read the
// parent DOM, cookies, or storage), and its CSP blocks all network
// (connect-src 'none'). Scripts may run but have nowhere to send data.
const ArtifactPanel: React.FC<{ artifact: Artifact | null; onClose: () => void }> = ({ artifact, onClose }) => {
  return (
    <Sheet open={!!artifact} onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent side="right" className="w-full sm:max-w-2xl p-0 flex flex-col gap-0">
        <SheetHeader className="px-4 py-3 border-b border-outline-variant/10 shrink-0">
          <SheetTitle className="text-left flex items-center gap-2 text-base">
            <span className="material-symbols-outlined text-primary-container">deployed_code</span>
            <span className="truncate">{artifact?.title || "Artifact"}</span>
            <span className="ml-1 text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">{artifact?.kind}</span>
          </SheetTitle>
        </SheetHeader>
        <div className="flex-1 min-h-0 bg-white">
          {artifact && (
            <ArtifactFrame artifact={artifact} />
          )}
        </div>
        <div className="px-4 py-2 border-t border-outline-variant/10 shrink-0 text-[10px] text-on-surface-variant">
          Sandboxed preview · no network or page access
        </div>
      </SheetContent>
    </Sheet>
  );
};

export default ArtifactPanel;
