import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * The camera, inside the app.
 *
 * The first version opened the phone's own camera app for every page. That
 * gives the sharpest still, but it sends the browser to the background, and
 * Android is free to throw a backgrounded tab away: the reader took a photo
 * and came back to a reloaded app, on the wrong tab, with the photo gone.
 * A live preview in the page never leaves the page, so there is nothing to
 * reload — and it turns three taps a page (open, shutter, confirm) into one.
 *
 * It stays open between shots: snap, turn the page, snap. Pages are read in
 * the background while the next one is being framed.
 *
 * The phone's camera app is still one tap away ("Use the phone's camera"),
 * and is what a browser without a usable camera API falls back to.
 */

const PREF_KEY = "cc_paper_camera";

export function inPageCameraUsable(): boolean {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) return false;
  try { return localStorage.getItem(PREF_KEY) !== "native"; } catch { return true; }
}
function preferNative(on: boolean) {
  try { if (on) localStorage.setItem(PREF_KEY, "native"); else localStorage.removeItem(PREF_KEY); } catch { /* private mode */ }
}

type ImageCaptureLike = { takePhoto: () => Promise<Blob> };
type TorchTrack = Omit<MediaStreamTrack, "getCapabilities"> & { getCapabilities?: () => { torch?: boolean } };

const PaperCamera: React.FC<{
  open: boolean;
  onClose: () => void;
  /** A photo was taken. The caller owns it from here (and disposes of it). */
  onPhoto: (file: File) => void;
  /** Hand over to the phone's camera app instead. */
  onUseNative: () => void;
  /** Photos still being read, for the "reading 2…" line. */
  busy: number;
  /** Pages in the book so far. */
  pages: number;
  /** Something worth saying over the preview ("p. 47 added"). */
  note?: string | null;
}> = ({ open, onClose, onPhoto, onUseNative, busy, pages, note }) => {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const [state, setState] = useState<"starting" | "live" | "denied" | "failed">("starting");
  const [torch, setTorch] = useState<"off" | "on" | null>(null);
  const [flash, setFlash] = useState(false);
  const [taking, setTaking] = useState(false);

  const stop = useCallback(() => {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    if (video.current) video.current.srcObject = null;
  }, []);

  const start = useCallback(async () => {
    stop();
    setState("starting");
    setTorch(null);
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        audio: false,
        // Ask for the most the back camera will give: the words have to
        // survive being read off a still frame.
        video: { facingMode: { ideal: "environment" }, width: { ideal: 3840 }, height: { ideal: 2160 } },
      });
      stream.current = s;
      const v = video.current;
      if (!v) { s.getTracks().forEach((t) => t.stop()); return; }
      v.srcObject = s;
      await v.play().catch(() => undefined);
      const track = s.getVideoTracks()[0] as unknown as TorchTrack | undefined;
      try { if (track?.getCapabilities?.().torch) setTorch("off"); } catch { /* not reported */ }
      setState("live");
    } catch (e) {
      const name = (e as DOMException)?.name;
      setState(name === "NotAllowedError" || name === "SecurityError" ? "denied" : "failed");
    }
  }, [stop]);

  // The camera is held only while this is open AND the app is in front.
  useEffect(() => {
    if (!open) { stop(); return; }
    void start();
    const onVisibility = () => { if (document.hidden) stop(); else void start(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => { document.removeEventListener("visibilitychange", onVisibility); stop(); };
  }, [open, start, stop]);

  const toggleTorch = async () => {
    const track = stream.current?.getVideoTracks()[0];
    if (!track || torch === null) return;
    const next = torch === "on" ? "off" : "on";
    try {
      await track.applyConstraints({ advanced: [{ torch: next === "on" } as MediaTrackConstraintSet] });
      setTorch(next);
    } catch { setTorch(null); }
  };

  const take = async () => {
    const v = video.current;
    const track = stream.current?.getVideoTracks()[0];
    if (!v || !track || taking || state !== "live") return;
    setTaking(true);
    setFlash(true);
    window.setTimeout(() => setFlash(false), 160);
    try { navigator.vibrate?.(12); } catch { /* not supported */ }
    let blob: Blob | null = null;
    // A real still where the browser can take one (Chrome on Android): the
    // sensor's full resolution, not a frame of the preview.
    const IC = (window as unknown as { ImageCapture?: new (t: MediaStreamTrack) => ImageCaptureLike }).ImageCapture;
    if (IC) {
      try {
        blob = await Promise.race([
          new IC(track).takePhoto(),
          new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error("slow")), 3500)),
        ]);
      } catch { blob = null; }
    }
    if (!blob && v.videoWidth > 0) {
      const canvas = document.createElement("canvas");
      canvas.width = v.videoWidth; canvas.height = v.videoHeight;
      canvas.getContext("2d")?.drawImage(v, 0, 0);
      blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
      canvas.width = canvas.height = 0;
    }
    setTaking(false);
    if (blob) onPhoto(new File([blob], "page.jpg", { type: blob.type || "image/jpeg" }));
  };

  const useNative = (remember: boolean) => {
    if (remember) preferNative(true);
    onClose();
    onUseNative();
  };

  if (!open) return null;
  return createPortal(
    <div className="cc-cam" role="dialog" aria-modal="true" aria-label="Camera">
      <video ref={video} className="cc-cam-video" playsInline muted autoPlay />
      {flash && <div className="cc-cam-flash" aria-hidden />}
      {state === "live" && <div className="cc-cam-frame" aria-hidden />}

      <div className="cc-cam-top">
        <button type="button" className="cc-cam-btn" onClick={onClose} aria-label="Close the camera">
          <span className="material-symbols-outlined" aria-hidden>close</span>
        </button>
        <span className="cc-cam-status" aria-live="polite">
          {note ?? (busy > 0 ? `Reading ${busy} page${busy === 1 ? "" : "s"}…` : pages > 0 ? `${pages} page${pages === 1 ? "" : "s"} in the book` : "Fit the whole page in the frame")}
        </span>
        {torch !== null ? (
          <button type="button" className="cc-cam-btn" onClick={() => void toggleTorch()} aria-pressed={torch === "on"} aria-label="Light">
            <span className="material-symbols-outlined" aria-hidden>{torch === "on" ? "flashlight_on" : "flashlight_off"}</span>
          </button>
        ) : <span className="w-12" />}
      </div>

      {state !== "live" && (
        <div className="cc-cam-msg">
          {state === "starting" ? (
            <p>Starting the camera…</p>
          ) : (
            <>
              <p className="font-bold text-lg">
                {state === "denied" ? "The camera is blocked for this site" : "The camera would not start"}
              </p>
              <p className="text-sm opacity-80">
                {state === "denied"
                  ? "Allow it in your browser's site settings, or use the phone's camera app instead."
                  : "Another app may be using it. You can use the phone's camera app instead."}
              </p>
              <button type="button" className="cc-btn3d" data-tone="accent" onClick={() => useNative(state === "denied")}>
                <span className="material-symbols-outlined" aria-hidden>photo_camera</span> Use the phone's camera
              </button>
              <button type="button" className="cc-cam-link" onClick={() => void start()}>Try again</button>
            </>
          )}
        </div>
      )}

      <div className="cc-cam-bottom">
        <button type="button" className="cc-cam-link" onClick={() => useNative(false)}>Use the phone's camera</button>
        <button type="button" className="cc-cam-shutter" onClick={() => void take()} disabled={state !== "live" || taking} aria-label="Take the photo">
          <span aria-hidden />
        </button>
        <button type="button" className="cc-cam-done" onClick={onClose}>Done</button>
      </div>
    </div>,
    document.body,
  );
};

export default PaperCamera;
