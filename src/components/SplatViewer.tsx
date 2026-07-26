import React, { useCallback, useEffect, useRef, useState } from "react";
import { claimViewer, releaseViewer } from "@/lib/splatViewerHost";
import MediaFrame, { exitAnyFullscreen, SPLAT_FRAME_DEFAULT, SPLAT_FRAME_MIN } from "@/components/MediaFrame";
import type { SplatFormat } from "@/lib/splatCatalog";

// The live 3D viewer. This module is code-split (imported via React.lazy from
// SplatBubble) because @sparkjsdev/spark is ~1.78 MB gzipped — it must never
// reach a user who doesn't ask for 3D.
//
// three.js and Spark are pulled in with dynamic import() inside the effect
// rather than static imports for the same reason: a static import (including a
// type-only one Vite fails to elide) would fold them into the main chunk.
//
// Orbit control is hand-rolled instead of using three's OrbitControls because
// this viewer lives inside a scrolling chat transcript and needs gesture
// arbitration OrbitControls doesn't do — see the pointer handlers below.

interface Props {
  id: string;
  url: string;
  format: SplatFormat;
  posterUrl: string | null;
  label: string;
  onExit: () => void;
}

/** Movement in px before a touch gesture commits to scrolling or orbiting. */
const GESTURE_SLOP = 8;
const MIN_DISTANCE = 0.6;
const MAX_DISTANCE = 12;
const KEY_STEP = (5 * Math.PI) / 180; // 5° per arrow press

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const pinchDistance = (pts: Map<number, { x: number; y: number }>): number => {
  const [a, b] = [...pts.values()];
  return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
};

const SplatViewer: React.FC<Props> = ({ id, url, format, posterUrl, label, onExit }) => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  // Held in a ref so the scene effect does NOT depend on the callback's
  // identity. A parent re-render creates a new onExit; if the effect depended
  // on it, every re-render would destroy the WebGL context, re-download the
  // splat and re-import Spark.
  const onExitRef = useRef(onExit);
  useEffect(() => { onExitRef.current = onExit; }, [onExit]);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [hint, setHint] = useState("");
  // Fullscreen changes who owns gestures (see arbitration below), so the
  // pointer/wheel handlers read it from a ref while the UI reads state.
  const [expanded, setExpanded] = useState(false);
  const expandedRef = useRef(false);
  const handleExpandedChange = useCallback((v: boolean) => {
    expandedRef.current = v;
    setExpanded(v);
  }, []);

  // Orbit state lives in a ref so the render loop reads it without re-rendering.
  const orbit = useRef({ yaw: 0.6, pitch: 0.15, distance: 2.6, target: [0, 0, 0] as [number, number, number] });
  const teardownRef = useRef<(() => void) | null>(null);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showHint = useCallback((text: string) => {
    setHint(text);
    if (hintTimer.current) clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => setHint(""), 1500);
  }, []);

  // ── Scene lifecycle ───────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    const abort = new AbortController();
    let raf = 0;
    let renderer: any = null;
    let scene: any = null;
    let camera: any = null;
    let spark: any = null;
    let mesh: any = null;
    let resizeObs: ResizeObserver | null = null;
    let visibilityObs: IntersectionObserver | null = null;
    let visible = true;
    let posterDone = false;

    const teardown = () => {
      // Order matters. Spark will not cancel its own in-flight fetches, and the
      // WebGL context must be released explicitly or the browser keeps it.
      try { abort.abort(); } catch { /* noop */ }
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      try { resizeObs?.disconnect(); } catch { /* noop */ }
      try { visibilityObs?.disconnect(); } catch { /* noop */ }
      resizeObs = null;
      visibilityObs = null;
      try { if (mesh && scene) scene.remove(mesh); } catch { /* noop */ }
      try { mesh?.dispose?.(); } catch { /* noop */ }
      try { spark?.dispose?.(); } catch { /* noop */ }
      try { scene?.clear?.(); } catch { /* noop */ }
      try { renderer?.dispose?.(); } catch { /* noop */ }
      try { renderer?.forceContextLoss?.(); } catch { /* noop */ }
      try {
        if (renderer?.domElement) {
          renderer.domElement.width = 1;
          renderer.domElement.height = 1;
        }
      } catch { /* noop */ }
      try { hostRef.current?.replaceChildren(); } catch { /* noop */ }
      mesh = null; spark = null; scene = null; camera = null; renderer = null;
    };
    teardownRef.current = teardown;

    // Taking the slot tears down whatever else was live. This callback doubles
    // as this mount's unique slot token.
    const releaseSelf = () => { teardown(); onExitRef.current(); };
    claimViewer(id, releaseSelf);

    void (async () => {
      try {
        const host = hostRef.current;
        if (!host) return;

        const res = await fetch(url, { signal: abort.signal });
        if (!res.ok) throw new Error(`Could not load the 3D file (HTTP ${res.status}).`);
        const buf = await res.arrayBuffer();
        if (cancelled) return;

        const THREE: any = await import("three");
        if (cancelled) return;

        const width = host.clientWidth || 320;
        const height = host.clientHeight || 256;

        // Spark's docs are explicit: antialias must be OFF for splats — MSAA
        // doesn't improve Gaussian rendering and significantly hurts
        // performance. A GLB is a normal mesh and does want it.
        renderer = new THREE.WebGLRenderer({ antialias: format === "glb", alpha: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        renderer.setSize(width, height, false);
        host.replaceChildren(renderer.domElement);
        renderer.domElement.style.width = "100%";
        renderer.domElement.style.height = "100%";
        renderer.domElement.style.display = "block";

        scene = new THREE.Scene();
        camera = new THREE.PerspectiveCamera(50, width / height, 0.01, 1000);

        if (format === "glb") {
          // Mesh escape hatch — the fallback provider returns a GLB alongside
          // its splat, and three already ships this loader.
          const { GLTFLoader }: any = await import("three/examples/jsm/loaders/GLTFLoader.js");
          if (cancelled) return;
          const gltf: any = await new Promise((resolve, reject) =>
            new GLTFLoader().parse(buf, "", resolve, reject),
          );
          mesh = gltf.scene;
          scene.add(mesh);
          scene.add(new THREE.AmbientLight(0xffffff, 1.4));
          const key = new THREE.DirectionalLight(0xffffff, 1.6);
          key.position.set(2, 3, 2);
          scene.add(key);
          // Frame the model from its bounds.
          const box = new THREE.Box3().setFromObject(mesh);
          const size = box.getSize(new THREE.Vector3());
          const center = box.getCenter(new THREE.Vector3());
          const radius = Math.max(size.x, size.y, size.z) || 1;
          orbit.current.target = [center.x, center.y, center.z];
          orbit.current.distance = radius * 2.2;
        } else {
          const spk: any = await import("@sparkjsdev/spark");
          if (cancelled) return;
          // Spark 2.x no longer auto-injects a renderer — it must be
          // constructed and added to the scene explicitly.
          spark = new spk.SparkRenderer({ renderer });
          scene.add(spark);
          // Load from bytes, never from a URL: Spark only content-sniffs .ply
          // and .spz, so a .splat needs an explicit fileType, and passing a url
          // makes it ignore that hint. Bytes also keep the fetch abortable.
          mesh = new spk.SplatMesh({
            fileBytes: new Uint8Array(buf),
            fileType: format === "ply" ? "ply" : "splat",
            fileName: `a.${format === "ply" ? "ply" : "splat"}`,
          });
          if (mesh.initialized && typeof mesh.initialized.then === "function") {
            await mesh.initialized;
          }
          if (cancelled) return;
          scene.add(mesh);
        }

        const applyCamera = () => {
          const { yaw, pitch, distance, target } = orbit.current;
          const cp = Math.cos(pitch);
          camera.position.set(
            target[0] + distance * cp * Math.sin(yaw),
            target[1] + distance * Math.sin(pitch),
            target[2] + distance * cp * Math.cos(yaw),
          );
          camera.lookAt(target[0], target[1], target[2]);
        };

        const resize = () => {
          const w = host.clientWidth || width;
          const h = host.clientHeight || height;
          if (!renderer || !camera || w === 0 || h === 0) return;
          renderer.setSize(w, h, false);
          camera.aspect = w / h;
          camera.updateProjectionMatrix();
        };
        resizeObs = new ResizeObserver(resize);
        resizeObs.observe(host);

        const loop = () => {
          if (cancelled || !renderer) { raf = 0; return; }
          // Scrolled out of the transcript: stop burning GPU and battery. The
          // observer below restarts the loop when it comes back into view.
          if (!visible) { raf = 0; return; }
          applyCamera();
          renderer.render(scene, camera);
          if (!posterDone) {
            posterDone = true;
            setReady(true);
            // No canvas capture here on purpose: reading the drawing buffer
            // would require preserveDrawingBuffer, which costs on EVERY frame
            // for a one-time thumbnail. fal's background-removed composite is
            // already stored as the poster at finalize time.
          }
          raf = requestAnimationFrame(loop);
        };

        visibilityObs = new IntersectionObserver((entries) => {
          const nowVisible = entries.some((en) => en.isIntersecting);
          if (nowVisible === visible) return;
          visible = nowVisible;
          if (visible && !raf && !cancelled) raf = requestAnimationFrame(loop);
        });
        visibilityObs.observe(host);

        raf = requestAnimationFrame(loop);
      } catch (e: any) {
        if (cancelled || e?.name === "AbortError") return;
        setError(e?.message || "This 3D model could not be displayed.");
      }
    })();

    return () => {
      cancelled = true;
      releaseViewer(releaseSelf);
      teardown();
      teardownRef.current = null;
      if (hintTimer.current) clearTimeout(hintTimer.current);
    };
    // Deliberately excludes onExit (held in a ref above): rebuilding the scene
    // on a callback identity change would be catastrophic, not merely wasteful.
  }, [id, url, format]);

  // ── Gesture arbitration ───────────────────────────────────────────────
  // A 3D canvas inside a scrolling transcript must not eat vertical scroll.
  // CSS `touch-action: pan-y` does NOT solve this — model-viewer reimplemented
  // it in JS precisely because the iOS behaviour is unusable. So the direction
  // of the first few pixels of movement decides who owns the gesture: mostly
  // vertical scrolls the page, mostly horizontal orbits the model.
  // A Set of live pointer ids rather than a counter: a pointerup that never
  // arrives (pointer released outside the window) would desync a counter and
  // leave the viewer permanently believing a gesture is in progress.
  // Fullscreen flips the contract: there is no page left to scroll, so a
  // single pointer always orbits (vertical included) and two pointers pinch
  // the model's zoom instead of the browser's page zoom.
  const drag = useRef({
    mode: "undecided" as "undecided" | "page" | "orbit" | "pinch",
    x: 0,
    y: 0,
    ids: new Set<number>(),
    pts: new Map<number, { x: number; y: number }>(),
    pinchDist: 0,
  });

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === "mouse" && e.button !== 0) return; // right/middle click
    const d = drag.current;
    d.ids.add(e.pointerId);
    d.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (expandedRef.current) {
      if (d.ids.size >= 2) {
        d.mode = "pinch";
        d.pinchDist = pinchDistance(d.pts);
      } else {
        d.mode = "orbit";
        d.x = e.clientX;
        d.y = e.clientY;
      }
      try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* noop */ }
      return;
    }
    // Multi-touch always belongs to the browser (pinch-zoom).
    if (d.ids.size > 1) { d.mode = "page"; return; }
    // Touch has to wait and see which way the finger goes; mouse and pen are
    // unambiguous, so they orbit immediately AND capture immediately — without
    // capture, releasing outside the canvas never fires pointerup here and the
    // drag would never end.
    if (e.pointerType === "touch") {
      d.mode = "undecided";
    } else {
      d.mode = "orbit";
      try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* noop */ }
    }
    d.x = e.clientX;
    d.y = e.clientY;
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d.ids.has(e.pointerId)) return;
    d.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (d.mode === "pinch") {
      if (d.ids.size < 2) return;
      e.preventDefault();
      const dist = pinchDistance(d.pts);
      if (d.pinchDist > 0 && dist > 0) {
        const o = orbit.current;
        o.distance = Math.max(MIN_DISTANCE, Math.min(MAX_DISTANCE, o.distance * (d.pinchDist / dist)));
      }
      d.pinchDist = dist;
      return;
    }
    if (d.ids.size > 1) return;
    // A mouse with no button held is a stale drag (button released off-window).
    if (e.pointerType === "mouse" && e.buttons === 0) {
      d.ids.delete(e.pointerId);
      d.pts.delete(e.pointerId);
      d.mode = "undecided";
      return;
    }
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;

    if (d.mode === "undecided") {
      if (Math.hypot(dx, dy) < GESTURE_SLOP) return;
      d.mode = Math.abs(dy) > Math.abs(dx) ? "page" : "orbit";
      if (d.mode === "orbit") {
        try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* noop */ }
      }
      d.x = e.clientX;
      d.y = e.clientY;
      return;
    }
    if (d.mode === "page") return; // never preventDefault — let the page scroll

    e.preventDefault();
    orbit.current.yaw -= dx * 0.008;
    orbit.current.pitch = Math.max(-1.4, Math.min(1.4, orbit.current.pitch + dy * 0.006));
    d.x = e.clientX;
    d.y = e.clientY;
  };

  const endPointer = (e: React.PointerEvent) => {
    const d = drag.current;
    d.ids.delete(e.pointerId);
    d.pts.delete(e.pointerId);
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* noop */ }
    if (d.mode === "pinch") {
      if (d.ids.size >= 2) { d.pinchDist = pinchDistance(d.pts); return; }
      const [rest] = [...d.pts.values()];
      if (d.ids.size === 1 && rest && expandedRef.current) {
        // One finger lifted mid-pinch — hand the survivor to orbit smoothly.
        d.mode = "orbit";
        d.x = rest.x;
        d.y = rest.y;
        return;
      }
      d.mode = "undecided";
      d.pinchDist = 0;
      return;
    }
    if (d.ids.size === 0) d.mode = "undecided";
  };

  // Wheel must be a native non-passive listener: React's onWheel is passive in
  // some browsers, and preventDefault() there is a no-op.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onWheel = (e: WheelEvent) => {
      // Fullscreen has no transcript to protect — plain scroll zooms. Inline,
      // zoom needs Ctrl (trackpad pinch arrives with ctrlKey set, so this
      // covers both) and a bare wheel keeps scrolling the chat.
      if (expandedRef.current || e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const o = orbit.current;
        o.distance = Math.max(MIN_DISTANCE, Math.min(MAX_DISTANCE, o.distance * (1 + e.deltaY * 0.0015)));
      } else {
        showHint("Ctrl + scroll to zoom");
        // Deliberately not prevented — the transcript keeps scrolling.
      }
    };
    host.addEventListener("wheel", onWheel, { passive: false });
    return () => host.removeEventListener("wheel", onWheel);
  }, [showHint]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const o = orbit.current;
    switch (e.key) {
      case "ArrowLeft":  o.yaw -= KEY_STEP; break;
      case "ArrowRight": o.yaw += KEY_STEP; break;
      case "ArrowUp":    o.pitch = Math.min(1.4, o.pitch + KEY_STEP); break;
      case "ArrowDown":  o.pitch = Math.max(-1.4, o.pitch - KEY_STEP); break;
      case "+": case "=": o.distance = Math.max(MIN_DISTANCE, o.distance * 0.9); break;
      case "-": case "_": o.distance = Math.min(MAX_DISTANCE, o.distance * 1.1); break;
      // While fullscreen, Escape only leaves fullscreen (the browser or
      // MediaFrame's own listener handles it) — it must not also close 3D.
      case "Escape": if (expandedRef.current) return; onExit(); return;
      default: return;
    }
    e.preventDefault();
  };

  const resetView = () => {
    orbit.current.yaw = 0.6;
    orbit.current.pitch = 0.15;
    orbit.current.distance = format === "glb" ? orbit.current.distance : 2.6;
  };

  if (error) {
    return (
      <div className="rounded-xl bg-surface-container-high/60 border border-destructive/30 p-3 max-w-sm">
        <div className="flex items-center gap-2 text-xs text-destructive">
          <span className="material-symbols-outlined text-base">error</span>
          <span className="font-medium">Couldn't show this in 3D</span>
        </div>
        <p className="text-[11px] text-on-surface-variant mt-1 break-words">{error}</p>
        {posterUrl && (
          <img src={posterUrl} alt={label} className="mt-2 rounded-lg max-h-48 w-auto" />
        )}
        <button
          onClick={onExit}
          className="mt-2 text-[11px] font-medium text-primary hover:underline"
        >
          Back to preview
        </button>
      </div>
    );
  }

  return (
    <MediaFrame
      kind="splat"
      label={label}
      defaultSize={SPLAT_FRAME_DEFAULT}
      minSize={SPLAT_FRAME_MIN}
      className="rounded-xl overflow-hidden border border-outline-variant/20 bg-black/40"
      onExpandedChange={handleExpandedChange}
      controlsTopRight={
        <>
          <button
            onClick={resetView}
            title="Reset view"
            aria-label="Reset view"
            className="grid h-7 w-7 place-items-center rounded-full bg-black/60 text-white/90 hover:bg-black/80 backdrop-blur-sm transition-colors"
          >
            <span className="material-symbols-outlined text-[15px]">restart_alt</span>
          </button>
          <button
            // Closing 3D while fullscreen would rip the fullscreen element out
            // of the DOM — leave fullscreen first, then exit to the poster.
            onClick={() => { exitAnyFullscreen(); onExit(); }}
            title="Close 3D view"
            aria-label="Close 3D view"
            className="grid h-7 w-7 place-items-center rounded-full bg-black/60 text-white/90 hover:bg-black/80 backdrop-blur-sm transition-colors"
          >
            <span className="material-symbols-outlined text-[15px]">close</span>
          </button>
        </>
      }
    >
      <div
        ref={hostRef}
        role="img"
        aria-label={`Interactive 3D model: ${label}. Drag or use arrow keys to rotate; pinch, Ctrl+scroll, or plus and minus to zoom.`}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onLostPointerCapture={endPointer}
        onKeyDown={onKeyDown}
        // A hint only — the JS arbitration above is what actually works on iOS.
        // Fullscreen turns it off entirely: every gesture belongs to the model.
        style={{ touchAction: expanded ? "none" : "pan-y" }}
        className="h-full w-full cursor-grab active:cursor-grabbing outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset"
      />

      {!ready && (
        <div className="absolute inset-0 grid place-items-center pointer-events-none">
          {posterUrl
            ? <img src={posterUrl} alt="" className="h-full w-full object-contain opacity-40" />
            : <span className="text-[11px] text-white/70">Loading 3D…</span>}
        </div>
      )}

      {hint && (
        <div className="absolute inset-x-0 bottom-10 grid place-items-center pointer-events-none">
          <span className="rounded-full bg-black/70 px-2.5 py-1 text-[11px] text-white/90 backdrop-blur-sm">
            {hint}
          </span>
        </div>
      )}

      {!prefersReducedMotion() && (
        <span
          className="absolute bottom-2 left-2 text-[10px] text-white/50 pointer-events-none select-none"
          style={expanded ? { bottom: "calc(0.5rem + env(safe-area-inset-bottom))", left: "calc(0.5rem + env(safe-area-inset-left))" } : undefined}
        >
          {expanded ? "drag to rotate · pinch to zoom" : "drag to rotate"}
        </span>
      )}
    </MediaFrame>
  );
};

export default SplatViewer;
