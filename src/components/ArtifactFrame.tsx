import React, { useCallback, useEffect, useRef } from "react";
import { buildArtifactDoc, ARTIFACT_FRAME_PATH, type Artifact } from "@/lib/artifacts";

/**
 * Renders a model-authored artifact in an isolated frame.
 *
 * The document is delivered by postMessage to a STATIC same-origin host page
 * (public/artifact-frame.html) rather than via `srcDoc`. srcdoc is a local
 * scheme and inherits the embedder's CSP, so once the app gained its own
 * policy every scripted artifact rendered dead — CSS applied, JavaScript
 * silently blocked, no error surfaced. The host page carries its own policy
 * instead, which keeps artifact scripting working without loosening the app's.
 *
 * Isolation is unchanged: sandbox="allow-scripts" without allow-same-origin
 * (opaque origin — no cookies, storage, or parent access) plus the host page's
 * connect-src 'none' (scripts may run, but have nowhere to send anything).
 */
const ArtifactFrame: React.FC<{ artifact: Artifact; title?: string; className?: string }> = ({ artifact, title, className }) => {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const docRef = useRef("");
  docRef.current = buildArtifactDoc(artifact);

  const send = useCallback(() => {
    const win = frameRef.current?.contentWindow;
    if (!win) return;
    win.postMessage({ type: "artifact", doc: docRef.current }, "*");
  }, []);

  // The frame announces itself when its bootstrap runs; onLoad is the fallback
  // for the case where that message races ahead of this listener.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frameRef.current?.contentWindow) return;
      if ((e.data as { type?: string } | null)?.type === "artifact-frame-ready") send();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [send]);

  return (
    <iframe
      ref={frameRef}
      // Remount on content change: the host page writes the document once.
      key={`${artifact.kind}-${artifact.content.length}-${artifact.title}`}
      title={title || artifact.title}
      src={new URL(ARTIFACT_FRAME_PATH, document.baseURI).href}
      onLoad={send}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      className={className || "w-full h-full border-0"}
    />
  );
};

export default ArtifactFrame;
