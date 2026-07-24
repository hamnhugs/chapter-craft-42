import { fetchSplatById, getSignedSplatUrl } from "@/lib/splatGen";
import { storeGeneratedImage, type ChatImageRef } from "@/lib/imageGen";

// Multi-view stills from a stored Gaussian splat, rendered CLIENT-SIDE on a
// hidden canvas. This is the honest splat->video path: no production API
// animates a static splat in mid-2026, so the splat's contribution to video is
// a geometry-consistent multi-view identity pack ("splat-derived multi-view
// identity lock"), fed into image-conditioned generation.
//
// Hard constraints respected here:
//   - Browsers cap live WebGL contexts (~16/page, ~8 Android) and kill the
//     oldest silently — so exactly ONE hidden context, created lazily and
//     reused for every capture job (the visible viewer keeps its own slot via
//     splatViewerHost; together that's 2 contexts, bounded).
//   - Spark has an open GPU-memory-on-dispose report (#237) — so one SplatMesh
//     slot, disposed per job, renderer kept alive.
//   - Reading the drawing buffer is only safe in the same task as the render,
//     so the renderer uses preserveDrawingBuffer and captures synchronously
//     via toDataURL right after each render.
//
// "Front" convention: single-image reconstructors (TripoSplat) build the model
// in the input camera's frame, so the hero image's viewpoint is azimuth 0 by
// construction. Splat files carry no orientation metadata — frontAzimuthDeg is
// the persisted user correction, applied on top.

export const SPLAT_VIEWS = ["front", "three_quarter", "side", "back", "three_quarter_left", "side_left"] as const;
export type SplatViewName = (typeof SPLAT_VIEWS)[number];

const VIEW_AZIMUTH_DEG: Record<SplatViewName, number> = {
  front: 0,
  three_quarter: 45,
  side: 90,
  back: 180,
  three_quarter_left: -45,
  side_left: -90,
};

/** The evidence-backed default pack: front / 3-4 / side / back. The back view
 *  is the highest-value member (turnarounds hallucinate without it). */
export const DEFAULT_VIEW_SET: SplatViewName[] = ["front", "three_quarter", "side", "back"];

interface HiddenRig {
  renderer: any;
  scene: any;
  camera: any;
  spark: any;
  canvas: HTMLCanvasElement;
  size: number;
}

let rig: HiddenRig | null = null;
let busy = false;

/** Tear the rig down so the next job rebuilds it. Used on context loss —
 *  a hidden, never-in-DOM canvas is a prime eviction candidate when the
 *  browser hits its context cap. */
function scrapRig(): void {
  if (!rig) return;
  try { rig.renderer.dispose?.(); } catch { /* going away regardless */ }
  rig = null;
}

async function ensureRig(size: number): Promise<HiddenRig> {
  const THREE: any = await import("three");
  const spk: any = await import("@sparkjsdev/spark");
  // A lost context renders no-ops silently — rebuild instead of reusing.
  if (rig && rig.renderer.getContext()?.isContextLost?.()) scrapRig();
  if (rig && rig.size === size) return rig;
  if (rig) {
    // Resize in place — never a second context.
    rig.renderer.setSize(size, size, false);
    rig.camera.aspect = 1;
    rig.camera.updateProjectionMatrix();
    rig.size = size;
    return rig;
  }
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  canvas.addEventListener("webglcontextlost", (e) => {
    // Don't restore in place; let the next job start clean.
    try { (e as Event).preventDefault?.(); } catch { /* best effort */ }
    scrapRig();
  });
  // Spark docs: antialias must be OFF for splats. preserveDrawingBuffer makes
  // same-task toDataURL capture reliable; the cost is per-frame, which is
  // irrelevant for an offline renderer that draws N frames per job.
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(size, size, false);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 1000);
  const spark = new spk.SparkRenderer({ renderer });
  scene.add(spark);
  rig = { renderer, scene, camera, spark, canvas, size };
  return rig;
}

/** A lost context (or a mesh that failed to draw) produces a fully transparent
 *  capture WITHOUT throwing. Refuse it: a blank "reference image" silently
 *  poisons every downstream identity-locked generation. */
async function assertNonBlank(dataUrl: string): Promise<void> {
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("Rendered view could not be decoded."));
    img.src = dataUrl;
  });
  const c = document.createElement("canvas");
  c.width = 32; c.height = 32;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) return; // can't verify — don't block on the verifier itself
  ctx.drawImage(img, 0, 0, 32, 32);
  const px = ctx.getImageData(0, 0, 32, 32).data;
  let visible = 0;
  for (let i = 3; i < px.length; i += 4) if (px[i] > 8) visible++;
  if (visible < px.length / 4 * 0.01) {
    throw new Error("The rendered view came out blank (GPU context was likely lost). Close other 3D views and try again.");
  }
}

export interface RenderedView {
  view: SplatViewName;
  azimuthDeg: number;
  image: ChatImageRef;
}

/** Render turntable stills from a stored splat and save each as an image
 *  attachment (so they get image_ids usable as reference packs). Free — runs
 *  on the user's GPU, no API spend. */
export async function renderSplatViews(opts: {
  splatId: string;
  views?: string[];
  /** Square output size in px (512-1024). */
  resolution?: number;
  /** Which azimuth is "front" (master correction). Default 0. */
  frontAzimuthDeg?: number;
  /** Caption stem for the stored images. */
  promptStem?: string;
}): Promise<RenderedView[]> {
  if (typeof document === "undefined") throw new Error("Splat view rendering needs a browser.");
  // Claim the slot BEFORE any await — two overlapping calls would otherwise
  // both pass the check and interleave meshes on the shared scene, silently
  // capturing frames that contain both objects.
  if (busy) throw new Error("A splat render is already running — wait for it to finish.");
  busy = true;
  let mesh: any = null;
  try {
    const row = await fetchSplatById(opts.splatId);
    if (!row) throw new Error("That 3D splat could not be found.");
    if (row.status !== "completed" || !row.storage_path) {
      throw new Error("That splat isn't finished yet — wait for it to complete first.");
    }
    if (row.format === "glb") {
      throw new Error("This asset is a GLB mesh, not a Gaussian splat — view rendering currently supports splat/PLY assets.");
    }

    const requested = (opts.views && opts.views.length > 0 ? opts.views : DEFAULT_VIEW_SET)
      .map((v) => String(v).trim().toLowerCase())
      .filter((v): v is SplatViewName => (SPLAT_VIEWS as readonly string[]).includes(v));
    if (requested.length === 0) {
      throw new Error(`No valid views requested. Valid views: ${SPLAT_VIEWS.join(", ")}.`);
    }

    const size = Math.min(1024, Math.max(512, Math.round(opts.resolution || 768)));
    const url = await getSignedSplatUrl(row.storage_path);
    if (!url) throw new Error("Could not load the splat file.");

    const res = await fetch(url);
    if (!res.ok) throw new Error(`Could not load the 3D file (HTTP ${res.status}).`);
    const buf = await res.arrayBuffer();

    const spk: any = await import("@sparkjsdev/spark");
    const r = await ensureRig(size);

    // Load from bytes with an explicit fileType — Spark only content-sniffs
    // .ply/.spz (same rule the visible viewer follows).
    mesh = new spk.SplatMesh({
      fileBytes: new Uint8Array(buf),
      fileType: row.format === "ply" ? "ply" : "splat",
      fileName: `a.${row.format === "ply" ? "ply" : "splat"}`,
    });
    if (mesh.initialized && typeof mesh.initialized.then === "function") {
      await mesh.initialized;
    }
    r.scene.add(mesh);

    // Same framing convention as the interactive viewer (TripoSplat outputs
    // are roughly normalized around the origin): fixed distance + elevation.
    const distance = 2.6;
    const pitch = 0.15;
    const target: [number, number, number] = [0, 0, 0];
    const frontAz = Number(opts.frontAzimuthDeg) || 0;

    const out: RenderedView[] = [];
    const stem = (opts.promptStem || row.prompt || "3D asset").slice(0, 140);
    for (const view of requested) {
      const azimuthDeg = frontAz + VIEW_AZIMUTH_DEG[view];
      const yaw = (azimuthDeg * Math.PI) / 180;
      const cp = Math.cos(pitch);
      r.camera.position.set(
        target[0] + distance * cp * Math.sin(yaw),
        target[1] + distance * Math.sin(pitch),
        target[2] + distance * cp * Math.cos(yaw),
      );
      r.camera.lookAt(target[0], target[1], target[2]);
      // Await the sort for this camera pose, then render + capture in the
      // same task so the drawing buffer is guaranteed intact.
      await r.spark.update({ scene: r.scene, camera: r.camera });
      r.renderer.render(r.scene, r.camera);
      const dataUrl = r.canvas.toDataURL("image/png");
      // A lost GPU context yields transparent captures without throwing —
      // refuse them rather than storing blank "identity references".
      await assertNonBlank(dataUrl);
      const viewLabel = view.replace(/_/g, " ");
      const image = await storeGeneratedImage({
        prompt: `${stem} — ${viewLabel} view`,
        caption: `${viewLabel} view rendered from the 3D splat (turntable, azimuth ${azimuthDeg}°). Geometry-consistent reference for identity-locked video.`,
        model: "splat-turntable",
        dataUrl,
        mime: "image/png",
        sourceImageId: row.source_image_id || null,
      });
      out.push({ view, azimuthDeg, image });
    }
    return out;
  } finally {
    // One mesh slot: always dispose the mesh; keep the renderer/context for
    // the next job (creating contexts per job trips the browser cap).
    try {
      if (mesh && rig) rig.scene.remove(mesh);
      mesh?.dispose?.();
    } catch { /* disposing best-effort */ }
    busy = false;
  }
}
