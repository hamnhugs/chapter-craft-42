import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ForceGraph3D from "react-force-graph-3d";
import SpriteText from "three-spritetext";
import * as THREE from "three";
import { KnowledgeEntry, MemoryGraphEdge, KnowledgeConflict } from "@/lib/knowledgeApi";
import { librarySounds } from "@/lib/soundEngine";

// 3D mind map of the knowledge entries inside a neuron — modeled on how real
// neurons render: each entry is a soma with an additive-blended glow, edges
// are axons, and react-force-graph's directional particles are the action
// potentials travelling down them. Glow is done with radial-gradient sprites
// rather than an UnrealBloomPass because postprocessing imports fight the
// graph lib's bundled three version (react-force-graph#558) — sprites are
// cheaper and version-proof.
//
// Visual encoding (per InfoVis practice: one channel per variable):
//   hue        → entry type (Okabe-Ito colorblind-safe palette; red is
//                RESERVED for conflicts so alarm color never means "category")
//   size       → hub-ness (connection count, sqrt-scaled)
//   glow       → confidence (brighter soma = more trusted memory)
//   pulse      → open conflict: a slow ~0.6Hz red halo throb — well under
//                WCAG 2.3.1's three-flashes-per-second limit, replaced by a
//                static red ring under prefers-reduced-motion
//   particles  → edge weight (stronger association = more, faster signals)

const TYPE_COLORS: Record<string, string> = {
  concept: "#56B4E9",
  entity: "#009E73",
  synthesis: "#CC79A7",
  fact: "#F0E442",
  comparison: "#E69F00",
  summary: "#0072B2",
};
const FALLBACK_COLOR = "#BBBBBB";
const CONFLICT_COLOR = "#D55E00";

const LABELS_KEY = "neuron_graph_labels";
const SOUND_KEY = "neuron_graph_sound";

interface EntryNode {
  id: string;
  name: string;
  entryType: string;
  color: string;
  val: number;
  confidence: number;
  degree: number;
  conflicted: boolean;
  tags: string[];
  /** Source neuron name in merged multi-neuron views (tooltip only — color stays type-coded). */
  neuron?: string;
}

interface EntryLink {
  source: string;
  target: string;
  relationship: string;
  weight: number;
  conflict: boolean;
}

function hasWebGL(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return !!(
      canvas.getContext("webgl2") ||
      canvas.getContext("webgl", { failIfMajorPerformanceCaveat: true })
    );
  } catch {
    return false;
  }
}

// Shared radial-gradient texture for every glow sprite (built once).
let glowTexture: THREE.Texture | null = null;
function getGlowTexture(): THREE.Texture {
  if (glowTexture) return glowTexture;
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, "rgba(255,255,255,0.9)");
  g.addColorStop(0.35, "rgba(255,255,255,0.3)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  glowTexture = new THREE.CanvasTexture(c);
  return glowTexture;
}

function makeGlowSprite(color: string, opacity: number, scale: number): THREE.Sprite {
  const mat = new THREE.SpriteMaterial({
    map: getGlowTexture(),
    color,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.setScalar(scale);
  // Decorative only: a sprite's raycast hits its whole billboard quad — even
  // the transparent corners — which would balloon the node's hover/click area
  // ~5x and steal clicks from neighbours in dense clusters. Opt out entirely.
  sprite.raycast = () => { /* not interactive */ };
  return sprite;
}

/** Edge color by relationship semantics (hover state handled separately). */
function relationColor(rel: string): string {
  const r = (rel || "").toLowerCase();
  if (/contradict|conflict|oppos|refut/.test(r)) return "rgba(213,94,0,0.75)";
  if (/support|extend|confirm|elaborat|example|similar/.test(r)) return "rgba(0,158,115,0.55)";
  if (/cause|lead|influenc|result|depend|applies/.test(r)) return "rgba(230,159,0,0.55)";
  return "rgba(200,190,170,0.35)";
}

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
    className={`w-9 h-9 rounded-full flex items-center justify-center border shadow-sm transition-all ${
      pressed
        ? "bg-primary/20 text-primary border-primary/30"
        : "bg-surface-container-highest/90 text-on-surface-variant border-outline-variant/20 hover:text-primary"
    }`}
  >
    <span className="material-symbols-outlined text-lg" aria-hidden>{icon}</span>
  </button>
);

const EntryNeuronGraph: React.FC<{
  entries: KnowledgeEntry[];
  edges: MemoryGraphEdge[];
  conflicts: KnowledgeConflict[];
  onOpen: (entry: KnowledgeEntry) => void;
  /** entry id → neuron name, for merged loaded-set views (shown in tooltips). */
  neuronNameByEntry?: Record<string, string>;
}> = ({ entries, edges, conflicts, onOpen, neuronNameByEntry }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const fgRef = useRef<any>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [webgl] = useState(hasWebGL);
  const [expanded, setExpanded] = useState(false);
  const [showLabels, setShowLabels] = useState(() => localStorage.getItem(LABELS_KEY) !== "0");
  const [soundOn, setSoundOn] = useState(() => localStorage.getItem(SOUND_KEY) === "1"); // default OFF — no surprise audio
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [reducedMotion] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const soundRef = useRef(soundOn);
  const hoverIdRef = useRef<string | null>(null);
  const fittedRef = useRef(false);
  const interactedRef = useRef(false);
  // Conflict halos registered by the node factory; one RAF loop throbs them all.
  const pulseMatsRef = useRef<Map<string, THREE.SpriteMaterial>>(new Map());

  useEffect(() => { localStorage.setItem(LABELS_KEY, showLabels ? "1" : "0"); }, [showLabels]);
  useEffect(() => {
    localStorage.setItem(SOUND_KEY, soundOn ? "1" : "0");
    soundRef.current = soundOn;
    if (!soundOn) librarySounds.suspend();
  }, [soundOn]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Expanded mode: Escape closes, page scroll locked behind the overlay.
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setExpanded(false); };
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
      try { fgRef.current?.zoomToFit(500, 70); } catch { /* no-op */ }
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
    const idSet = new Set(entries.map((e) => e.id));

    // Open conflicts drive the alarm channel.
    const conflictedIds = new Set<string>();
    for (const c of conflicts) {
      if (c.status !== "open") continue;
      if (idSet.has(c.entry_a)) conflictedIds.add(c.entry_a);
      if (idSet.has(c.entry_b)) conflictedIds.add(c.entry_b);
    }

    // Real memory-graph edges between visible entries.
    const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
    const links: EntryLink[] = [];
    const linkedPairs = new Set<string>();
    const degree = new Map<string, number>();
    for (const e of edges) {
      if (!idSet.has(e.source_entry_id) || !idSet.has(e.target_entry_id)) continue;
      if (e.source_entry_id === e.target_entry_id) continue;
      const key = pairKey(e.source_entry_id, e.target_entry_id);
      if (linkedPairs.has(key)) continue; // one line per pair keeps the map readable
      linkedPairs.add(key);
      const weight = Number((e as any).weight) || 1;
      links.push({
        source: e.source_entry_id,
        target: e.target_entry_id,
        relationship: e.relationship || "relates to",
        weight,
        conflict: false,
      });
      degree.set(e.source_entry_id, (degree.get(e.source_entry_id) || 0) + 1);
      degree.set(e.target_entry_id, (degree.get(e.target_entry_id) || 0) + 1);
    }

    // Open conflicts appear as red synapses: recolor the real edge if one
    // exists, otherwise add a synthetic link so the pair is visibly at war.
    for (const c of conflicts) {
      if (c.status !== "open" || !idSet.has(c.entry_a) || !idSet.has(c.entry_b)) continue;
      const key = pairKey(c.entry_a, c.entry_b);
      if (linkedPairs.has(key)) {
        const l = links.find((x) => pairKey(x.source, x.target) === key);
        if (l) l.conflict = true;
      } else {
        linkedPairs.add(key);
        links.push({ source: c.entry_a, target: c.entry_b, relationship: c.kind || "conflict", weight: 2, conflict: true });
        degree.set(c.entry_a, (degree.get(c.entry_a) || 0) + 1);
        degree.set(c.entry_b, (degree.get(c.entry_b) || 0) + 1);
      }
    }

    const nodes: EntryNode[] = entries.map((e) => {
      const deg = degree.get(e.id) || 0;
      return {
        id: e.id,
        name: e.title,
        entryType: e.entry_type,
        color: TYPE_COLORS[e.entry_type] || FALLBACK_COLOR,
        // Size = hub-ness only (sqrt so hubs don't dwarf leaves); a whisper of
        // vibrancy so recently-recalled memories sit a little larger.
        val: 2 + Math.min(10, Math.sqrt(deg) * 2.4) + (e.vibrancy ? e.vibrancy * 1.5 : 0),
        confidence: typeof e.confidence === "number" ? e.confidence : 0.7,
        degree: deg,
        conflicted: conflictedIds.has(e.id),
        tags: e.tags || [],
        neuron: neuronNameByEntry?.[e.id],
      };
    });

    return { nodes, links };
  }, [entries, edges, conflicts, neuronNameByEntry]);

  // One RAF loop throbs every registered conflict halo (~0.6Hz sine). The
  // simulation may be asleep but the brain keeps breathing.
  const hasConflicts = useMemo(
    () => graphData.nodes.some((n) => n.conflicted),
    [graphData.nodes],
  );
  useEffect(() => {
    if (reducedMotion || !hasConflicts) return;
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (document.hidden) return;
      const t = performance.now() / 1000;
      let i = 0;
      pulseMatsRef.current.forEach((mat) => {
        // Per-halo phase offset so the alarm feels organic, not metronomic.
        const phase = (i++ % 7) * 0.9;
        mat.opacity = 0.28 + 0.22 * (1 + Math.sin(t * Math.PI * 2 * 0.6 + phase)) * 0.5;
      });
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [reducedMotion, hasConflicts]);

  // Focus + context: hovering lights the neighbourhood, the rest recedes.
  const neighbours = useMemo(() => {
    if (!hoverId) return null;
    const set = new Set<string>([hoverId]);
    for (const l of graphData.links) {
      const s = typeof l.source === "object" ? (l.source as any).id : l.source;
      const t = typeof l.target === "object" ? (l.target as any).id : l.target;
      if (s === hoverId) set.add(t);
      if (t === hoverId) set.add(s);
    }
    return set;
  }, [hoverId, graphData.links]);

  const touchesHover = useCallback((l: any) => {
    if (!hoverId) return false;
    const s = typeof l.source === "object" ? l.source.id : l.source;
    const t = typeof l.target === "object" ? l.target.id : l.target;
    return s === hoverId || t === hoverId;
  }, [hoverId]);

  // Soma glow + (optional) billboarded title + conflict halo, attached on top
  // of the default sphere so hit-testing keeps working (nodeThreeObjectExtend).
  const nodeObject = useCallback((n: any) => {
    const group = new THREE.Group();

    // Glow: brightness encodes confidence.
    const glowScale = (2 + n.val) * 2.6;
    group.add(makeGlowSprite(n.color, 0.16 + 0.38 * n.confidence, glowScale));

    if (n.conflicted) {
      const halo = makeGlowSprite(CONFLICT_COLOR, reducedMotion ? 0.5 : 0.35, glowScale * 1.55);
      pulseMatsRef.current.set(n.id, halo.material as THREE.SpriteMaterial);
      group.add(halo);
    }

    if (showLabels) {
      const raw = `${n.conflicted ? "⚠ " : ""}${n.name}`;
      const text = raw.length > 26 ? raw.slice(0, 25).trimEnd() + "…" : raw;
      const label = new SpriteText(text);
      label.color = n.conflicted ? "#ffb59a" : n.color;
      label.textHeight = n.degree >= 4 ? 3.6 : n.degree >= 2 ? 3 : 2.6;
      if (n.conflicted) label.fontWeight = "700";
      (label as any).center.y = -0.9;
      ((label as any).material as any).depthWrite = false;
      group.add(label);
    }
    return group;
  }, [showLabels, reducedMotion]);

  const handleEngineStop = useCallback(() => {
    if (fittedRef.current) return;
    fittedRef.current = true;
    try {
      fgRef.current?.zoomToFit(600, 60);
      const controls = fgRef.current?.controls();
      if (controls) {
        controls.enableDamping = true;
        controls.dampingFactor = 0.08;
        if (!interactedRef.current && !reducedMotion) {
          controls.autoRotate = true;
          controls.autoRotateSpeed = 0.35;
        }
      }
    } catch { /* no-op */ }
  }, [reducedMotion]);

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
        <span className="material-symbols-outlined text-5xl mb-3 opacity-30">neurology</span>
        <p className="font-headline text-lg">3D view isn't available on this device</p>
        <p className="text-sm mt-1">Your browser doesn't support hardware-accelerated WebGL. Switch to the list view above to browse entries.</p>
      </div>
    );
  }

  const conflictCount = graphData.nodes.filter((n) => n.conflicted).length;
  const typesInView = Array.from(new Set(graphData.nodes.map((n) => n.entryType)));

  return (
    <div className={expanded ? "fixed inset-0 z-[100] bg-background p-2 sm:p-4 flex" : undefined}>
      <div
        ref={containerRef}
        role="img"
        aria-label={`Mind map of ${graphData.nodes.length} knowledge entr${graphData.nodes.length === 1 ? "y" : "ies"} with ${graphData.links.length} connection${graphData.links.length === 1 ? "" : "s"}${conflictCount ? `, ${conflictCount} in conflict` : ""}. Click an entry to open it.`}
        onPointerDown={handlePointerDown}
        className={`relative w-full overflow-hidden bg-surface-container-low border border-outline-variant/10 ${
          expanded ? "h-full rounded-xl" : "h-[62vh] min-h-[440px] rounded-2xl"
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
            nodeLabel={(n: any) =>
              `<div style="transform:translate(14px,-34px);font-family:Inter,system-ui,sans-serif;font-size:12px;padding:4px 9px;background:rgba(20,18,14,0.92);border-radius:6px;color:#f5efe6;pointer-events:none;max-width:260px">${
                String(n.name).replace(/</g, "&lt;")
              }<br/><span style="opacity:0.75;text-transform:capitalize">${n.entryType} · ${Math.round(n.confidence * 100)}% confidence${n.conflicted ? " · ⚠ conflict" : ""}${n.neuron ? ` · ${String(n.neuron).replace(/</g, "&lt;")}` : ""}</span></div>`
            }
            nodeThreeObject={nodeObject}
            nodeThreeObjectExtend={true}
            nodeColor={(n: any) => (!neighbours || neighbours.has(n.id) ? n.color : "rgba(120,115,105,0.25)")}
            nodeVal={(n: any) => n.val}
            nodeOpacity={0.92}
            linkColor={(l: any) =>
              touchesHover(l)
                ? "rgba(236,210,160,0.95)"
                : hoverId
                  ? "rgba(200,190,170,0.07)"
                  : l.conflict
                    ? "rgba(213,94,0,0.85)"
                    : relationColor(l.relationship)
            }
            linkWidth={(l: any) => (touchesHover(l) ? 1.8 : l.conflict ? 1.4 : 0.6)}
            linkOpacity={0.55}
            linkLabel={(l: any) =>
              `<div style="transform:translate(14px,-30px);font-family:Inter,system-ui,sans-serif;font-size:11px;padding:3px 8px;background:rgba(20,18,14,0.92);border-radius:6px;color:#f5efe6;pointer-events:none;text-transform:capitalize">${String(l.relationship || "").replace(/_/g, " ").replace(/</g, "&lt;")}${l.conflict ? " ⚠" : ""}</div>`
            }
            // Action potentials: conflicted synapses fire hard and fast.
            linkDirectionalParticles={(l: any) =>
              reducedMotion ? 0 : l.conflict ? 4 : Math.min(3, 1 + Math.floor((l.weight || 1) / 2))
            }
            linkDirectionalParticleSpeed={(l: any) =>
              l.conflict ? 0.012 : 0.004 + Math.min(0.006, (l.weight || 1) * 0.0012)
            }
            linkDirectionalParticleWidth={(l: any) => (touchesHover(l) ? 2.4 : l.conflict ? 2 : 1.4)}
            linkDirectionalParticleColor={(l: any) => (l.conflict ? CONFLICT_COLOR : "#ecd2a0")}
            warmupTicks={reducedMotion ? 180 : 60}
            cooldownTicks={reducedMotion ? 0 : 120}
            onEngineStop={handleEngineStop}
            enableNodeDrag={!("ontouchstart" in window)}
            onNodeHover={(n: any) => {
              const id = n?.id ?? null;
              if (id && id !== hoverIdRef.current && soundRef.current) librarySounds.hover();
              hoverIdRef.current = id;
              setHoverId(id);
            }}
            onNodeClick={(n: any) => {
              const entry = entries.find((e) => e.id === n.id);
              if (!entry) return;
              if (soundRef.current) librarySounds.open();
              onOpen(entry);
            }}
          />
        )}

        {/* Toolbar */}
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
            title={showLabels ? "Hide entry titles" : "Show entry titles"}
            pressed={showLabels}
            onClick={() => setShowLabels((v) => !v)}
          />
          <GraphButton
            icon={soundOn ? "volume_up" : "volume_off"}
            title={soundOn ? "Turn off sounds" : "Turn on ambient sounds"}
            pressed={soundOn}
            onClick={() => {
              if (!soundOn) librarySounds.open();
              setSoundOn((v) => !v);
            }}
          />
        </div>

        {/* Legend — color must never carry meaning alone. */}
        <div className="absolute top-3 left-3 flex flex-col gap-1 text-[10px] text-on-surface-variant/85 bg-surface-container-highest/70 backdrop-blur-sm rounded-lg px-2.5 py-2 pointer-events-none select-none max-w-[180px]">
          <span className="font-bold uppercase tracking-widest text-on-surface-variant">Entry types</span>
          <div className="flex flex-wrap gap-x-2.5 gap-y-0.5">
            {typesInView.map((t) => (
              <span key={t} className="inline-flex items-center gap-1 capitalize">
                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: TYPE_COLORS[t] || FALLBACK_COLOR }} aria-hidden />
                {t}
              </span>
            ))}
          </div>
          {conflictCount > 0 && (
            <span className="inline-flex items-center gap-1 mt-0.5" style={{ color: "#ff9b6b" }}>
              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: CONFLICT_COLOR }} aria-hidden />
              {reducedMotion ? "red ring" : "pulsing red"} = conflict ({conflictCount})
            </span>
          )}
          <span className="mt-0.5">glow = confidence · size = connections</span>
        </div>

        <p className="absolute bottom-2 left-3 text-[11px] text-on-surface-variant/70 pointer-events-none select-none">
          drag to rotate · scroll/pinch to zoom · hover to trace links · click an entry to open it
        </p>
      </div>
    </div>
  );
};

// Memoized: WikiPanel re-renders often (spinners, shared settings store); the
// graph should only re-render when its own data actually changes.
export default React.memo(EntryNeuronGraph);
