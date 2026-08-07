import React, { useCallback, useEffect, useMemo, useRef } from "react";
import { artifactFrameKey, buildArtifactDoc, ARTIFACT_FRAME_PATH, type Artifact } from "@/lib/artifacts";

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

  // buildArtifactDoc concatenates the whole artifact — up to
  // ARTIFACT_MAX_CONTENT (400,000 chars) — and this used to run in the RENDER
  // BODY, so every single re-render allocated a fresh ~400 KB string and threw
  // it away. That was survivable while the panel had a fixed width. It is not
  // once a drag handle can re-render this subtree once per pointermove: 60
  // string allocations of that size per second of drag. Memoized on exactly
  // the three fields buildArtifactDoc reads, so the doc is rebuilt only when
  // the artifact genuinely changes.
  const { kind, content } = artifact;
  const artifactTitle = artifact.title;
  const doc = useMemo(
    () => buildArtifactDoc({ kind, content, title: artifactTitle }),
    [kind, content, artifactTitle],
  );

  // send() must keep a STABLE identity — it is the [send] dependency of the
  // listener effect below and the iframe's onLoad handler, and a new identity
  // would re-subscribe the message listener on every doc change. So the
  // document reaches it through a ref rather than through its closure.
  const docRef = useRef(doc);
  useEffect(() => {
    docRef.current = doc;
  }, [doc]);

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
      // The key is a function of the ARTIFACT ONLY — see artifactFrameKey for
      // why no layout input may ever be folded in.
      key={artifactFrameKey(artifact)}
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
