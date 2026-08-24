import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ForceGraph3D from "react-force-graph-3d";
import SpriteText from "three-spritetext";
import { BookDocument } from "@/types/library";
import { categoryColor, UNCATEGORIZED } from "@/lib/categoryColors";
import { librarySounds } from "@/lib/soundEngine";

// 3D mind map of the library. Loaded lazily (React.lazy in Library.tsx) so
// the three.js chunk (~300KB gzip) is only fetched when the user toggles the
// graph on — it never weighs down the initial bundle.
//
// Graph shape (Obsidian-style clustering without custom forces): one hub node
// per category, one node per tag shared by 2+ books, one node per book.
// Books link to their category hub and their shared tags, so the force layout
// naturally pulls same-category/same-tag books into visible clusters — the
// hubs ARE the clustering mechanism.
//
// Labels are billboarded text sprites (three-spritetext) attached to each
// node via nodeThreeObjectExtend — the canonical react-force-graph pattern
// for always-visible labels. The default `nodeLabel` tooltip is pinned to the
// pointer (it hides under the cursor on desktop), so it's disabled while
// sprite labels are on and offset away from the pointer when they're off.

interface GraphNode {
  id: string;
  name: string;
  kind: "book" | "category" | "tag";
  bookId?: string;
  color: string;
  val: number;
}

interface GraphLink {
  source: string;
  target: string;
}

const TAG_COLOR = "hsl(40, 45%, 62%)";
const LABELS_KEY = "vault_graph_labels";
const SOUND_KEY = "vault_graph_sound";

function hasWebGL(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return !!(
      canvas.getContext("webgl2") ||
      // Reject blacklisted-GPU software rendering — a 3D graph at 4fps is
      // worse than no graph.
      canvas.getContext("webgl", { failIfMajorPerformanceCaveat: true })
    );
  } catch {
    return false;
  }
}

/** Small round overlay button used by the graph toolbar. */
const GraphButton: React.FC<{
  icon: string;
  title: string;
  pressed?: boolean;
  onClick: () => void;
}> = ({ icon, title, pressed, onClick }) => (
  <button
    onClick={onClick}
    title={title}
    aria-label={title}
    aria-pressed={pressed}
    className={`cc-tap-44 w-9 h-9 rounded-full flex items-center justify-center border shadow-sm transition-all ${
      pressed
        ? "bg-primary/20 text-primary border-primary/30"
        : "bg-surface-container-highest/90 text-on-surface-variant border-outline-variant/20 hover:text-primary"
    }`}
  >
    <span className="material-symbols-outlined text-lg" aria-hidden>{icon}</span>
  </button>
);

const LibraryGraph: React.FC<{
  books: BookDocument[];
  onOpenBook: (bookId: string) => void;
}> = ({ books, onOpenBook }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const fgRef = useRef<any>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [webgl] = useState(hasWebGL);
  const [expanded, setExpanded] = useState(false);
  const [showLabels, setShowLabels] = useState(
    () => localStorage.getItem(LABELS_KEY) !== "0", // default ON
  );
  const [soundOn, setSoundOn] = useState(
    () => localStorage.getItem(SOUND_KEY) === "1", // default OFF (WCAG: no surprise audio)
  );
  const soundRef = useRef(soundOn);
  const hoverIdRef = useRef<string | null>(null);
  const fittedRef = useRef(false);
  const interactedRef = useRef(false);

  useEffect(() => {
    localStorage.setItem(LABELS_KEY, showLabels ? "1" : "0");
  }, [showLabels]);

  useEffect(() => {
    localStorage.setItem(SOUND_KEY, soundOn ? "1" : "0");
    soundRef.current = soundOn;
    if (!soundOn) librarySounds.suspend();
  }, [soundOn]);

  // The canvas can't auto-fill its parent — measure it (and re-measure on
  // resize/rotation/expand).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () =>
      setSize({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Expanded mode: Escape closes, page scroll locks behind the overlay, and
  // the camera re-fits once the canvas has its new size.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [expanded]);

  useEffect(() => {
    const t = setTimeout(() => {
      try { fgRef.current?.zoomToFit(500, 60); } catch { /* no-op */ }
    }, 350);
    return () => clearTimeout(t);
  }, [expanded]);

  // Don't burn GPU/battery while the tab is hidden.
  useEffect(() => {
    const onVis = () => {
      try {
        if (document.hidden) fgRef.current?.pauseAnimation();
        else fgRef.current?.resumeAnimation();
      } catch { /* no-op */ }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  const graphData = useMemo(() => {
    const nodes: GraphNode[] = [];
    const links: GraphLink[] = [];

    // Tag nodes only for tags shared by 2+ books — singleton tags create no
    // edges, only visual noise (folksonomy vocabularies are power-law: a few
    // heavy tags carry the structure).
    const tagCounts = new Map<string, number>();
    for (const b of books) {
      for (const t of b.tags || []) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
    }
    const sharedTags = new Set(
      [...tagCounts.entries()].filter(([, n]) => n >= 2).map(([t]) => t),
    );

    const categories = new Map<string, number>();
    for (const b of books) {
      categories.set(b.category || UNCATEGORIZED, (categories.get(b.category || UNCATEGORIZED) || 0) + 1);
    }

    for (const [cat, count] of categories) {
      nodes.push({
        id: `cat:${cat}`,
        name: `${cat} (${count})`,
        kind: "category",
        color: categoryColor(cat),
        val: 6 + Math.min(10, count * 1.5),
      });
    }

    for (const tag of sharedTags) {
      nodes.push({
        id: `tag:${tag}`,
        name: `#${tag} (${tagCounts.get(tag)})`,
        kind: "tag",
        color: TAG_COLOR,
        val: 3 + Math.min(6, (tagCounts.get(tag) || 0)),
      });
    }

    for (const b of books) {
      const cat = b.category || UNCATEGORIZED;
      nodes.push({
        id: `book:${b.id}`,
        name: b.title,
        kind: "book",
        bookId: b.id,
        color: categoryColor(cat),
        val: 2,
      });
      links.push({ source: `book:${b.id}`, target: `cat:${cat}` });
      for (const t of b.tags || []) {
        if (sharedTags.has(t)) links.push({ source: `book:${b.id}`, target: `tag:${t}` });
      }
    }

    return { nodes, links };
  }, [books]);

  // Billboarded label sprite, extending (not replacing) the node sphere.
  // Tiered by node importance: categories largest + bold, tags medium, book
  // titles smallest and truncated (full title shows in the side/open action).
  const nodeObject = useCallback((n: any) => {
    const raw = String(n.name);
    const text = n.kind === "book" && raw.length > 24 ? raw.slice(0, 23).trimEnd() + "…" : raw;
    const sprite = new SpriteText(text);
    sprite.color = n.color;
    sprite.textHeight = n.kind === "category" ? 5 : n.kind === "tag" ? 3.4 : 2.7;
    if (n.kind === "category") sprite.fontWeight = "700";
    // Float the label above the sphere instead of intersecting it.
    (sprite as any).center.y = -0.8;
    // Standard fix for sprite transparency punching holes through geometry.
    ((sprite as any).material as any).depthWrite = false;
    return sprite;
  }, []);

  const handleEngineStop = useCallback(() => {
    if (fittedRef.current) return;
    fittedRef.current = true;
    try {
      fgRef.current?.zoomToFit(600, 60);
      const controls = fgRef.current?.controls();
      if (controls) {
        controls.enableDamping = true;
        controls.dampingFactor = 0.08;
        // Gentle rotation until first touch — motion is the strongest depth
        // cue a monoscopic 3D graph has (Ware & Mitchell).
        if (!interactedRef.current) {
          controls.autoRotate = true;
          controls.autoRotateSpeed = 0.4;
        }
      }
    } catch { /* no-op */ }
  }, []);

  const handlePointerDown = useCallback(() => {
    interactedRef.current = true;
    try {
      const controls = fgRef.current?.controls();
      if (controls) controls.autoRotate = false;
    } catch { /* no-op */ }
    if (soundRef.current) librarySounds.gust();
  }, []);

  if (!webgl) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-on-surface-variant text-center px-6">
        <span className="material-symbols-outlined text-5xl mb-3 opacity-30">view_in_ar</span>
        <p className="font-headline text-lg">3D view isn't available on this device</p>
        <p className="text-sm mt-1">Your browser doesn't support hardware-accelerated WebGL.</p>
      </div>
    );
  }

  return (
    <div className={expanded ? "fixed inset-0 z-[100] bg-background p-2 sm:p-4 flex" : undefined}>
      <div
        ref={containerRef}
        role="img"
        aria-label={`Mind map of ${books.length} books across ${new Set(books.map((b) => b.category || UNCATEGORIZED)).size} categories`}
        onPointerDown={handlePointerDown}
        className={`relative w-full overflow-hidden bg-surface-container-low border border-outline-variant/10 ${
          expanded ? "h-full rounded-xl" : "h-[60vh] min-h-[min(420px,60dvh)] rounded-2xl"
        }`}
      >
        {size.width > 0 && (
          <ForceGraph3D
            ref={fgRef}
            width={size.width}
            height={size.height}
            graphData={graphData}
            backgroundColor="rgba(0,0,0,0)"
            controlType="orbit"
            // Sprite labels make the cursor-pinned tooltip redundant; when
            // labels are off, the tooltip is offset away from the pointer so
            // it can't hide behind the cursor.
            nodeLabel={
              showLabels
                ? () => ""
                : (n: any) =>
                    `<div style="transform:translate(14px,-30px);font-family:Inter,system-ui,sans-serif;font-size:12px;padding:2px 6px;background:rgba(20,18,14,0.92);border-radius:6px;color:#f5efe6;pointer-events:none">${String(n.name).replace(/</g, "&lt;")}</div>`
            }
            nodeThreeObject={showLabels ? nodeObject : undefined}
            nodeThreeObjectExtend={true}
            nodeColor={(n: any) => n.color}
            nodeVal={(n: any) => n.val}
            nodeOpacity={0.9}
            linkColor={() => "rgba(200,190,170,0.35)"}
            linkWidth={0.6}
            linkOpacity={0.4}
            // Settle fast then stop ticking — saves mobile battery, and the
            // graph appears mostly laid out instead of exploding into place.
            warmupTicks={60}
            cooldownTicks={120}
            onEngineStop={handleEngineStop}
            // On touch, node-drag fights one-finger camera rotation.
            enableNodeDrag={!("ontouchstart" in window)}
            onNodeHover={(n: any) => {
              const id = n?.id ?? null;
              if (id && id !== hoverIdRef.current && soundRef.current) librarySounds.hover();
              hoverIdRef.current = id;
            }}
            onNodeClick={(n: any) => {
              if (n.kind === "book" && n.bookId) {
                if (soundRef.current) librarySounds.open();
                onOpenBook(n.bookId);
              } else if (soundRef.current) {
                librarySounds.chirp();
              }
            }}
          />
        )}

        {/* Graph toolbar */}
        <div className="absolute top-3 right-3 flex flex-col gap-2">
          <GraphButton
            icon={expanded ? "close_fullscreen" : "open_in_full"}
            title={expanded ? "Exit expanded view (Esc)" : "Expand mind map"}
            pressed={expanded}
            onClick={() => {
              if (soundRef.current) librarySounds.thunder();
              setExpanded((v) => !v);
            }}
          />
          <GraphButton
            icon={showLabels ? "label" : "label_off"}
            title={showLabels ? "Hide node titles" : "Show node titles"}
            pressed={showLabels}
            onClick={() => setShowLabels((v) => !v)}
          />
          <GraphButton
            icon={soundOn ? "volume_up" : "volume_off"}
            title={soundOn ? "Turn off sounds" : "Turn on chime, storm & bird sounds"}
            pressed={soundOn}
            onClick={() => {
              // Confirm audibly inside this same user gesture — the
              // AudioContext can only be created/resumed during one.
              if (!soundOn) librarySounds.open();
              setSoundOn((v) => !v);
            }}
          />
        </div>

        <p className="absolute bottom-2 left-3 text-[11px] text-on-surface-variant/70 pointer-events-none select-none">
          drag to rotate · scroll/pinch to zoom · click a book to open it
        </p>
      </div>
    </div>
  );
};

export default LibraryGraph;
