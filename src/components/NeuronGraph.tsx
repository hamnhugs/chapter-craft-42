import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ForceGraph3D from "react-force-graph-3d";
import SpriteText from "three-spritetext";
import { supabase } from "@/integrations/supabase/client";
import { WikiWithStats } from "@/lib/wikisApi";
import { librarySounds } from "@/lib/soundEngine";

// 3D mind map of the BRAIN: one node per neuron (wiki), connections from the
// knowledge graph itself. Loaded lazily (React.lazy in WikiLibrary) so the
// three.js chunk is shared with the Vault graph and never weighs down the
// initial bundle.
//
// Edges come from three real relationships, strongest first:
//   pointer — an entry in one neuron explicitly points at another wiki
//             (knowledge_entries.linked_wiki_id, e.g. meta-wiki hubs)
//   bridge  — an entry shared from its native neuron into another via
//             entry_bridges (one fact living in two minds)
//   tag     — the two neurons share a tag (weak, thematic kinship)
//
// "Animated connections": react-force-graph's directional particles — little
// light pulses travelling along each link like signals down an axon. More
// shared knowledge = more, faster pulses. Disabled under
// prefers-reduced-motion (WCAG 2.3.3), where the laid-out graph still renders.

interface NeuronNode {
  id: string;
  name: string;
  color: string;
  val: number;
  locked: boolean;
  isActive: boolean;
  entryCount: number;
}

interface NeuronLink {
  source: string;
  target: string;
  kinds: string[];
  strength: number; // pointer/bridge count + shared-tag count
}

const LABELS_KEY = "brain_graph_labels";
const SOUND_KEY = "brain_graph_sound";
const LOCKED_COLOR = "hsl(30, 6%, 45%)";

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

/** Cross-neuron connections derived from the knowledge graph (RLS-scoped). */
function useNeuronConnections(wikiIds: string[]) {
  const [links, setLinks] = useState<Map<string, { kinds: Set<string>; strength: number }>>(new Map());

  useEffect(() => {
    if (wikiIds.length < 2) { setLinks(new Map()); return; }
    let cancelled = false;
    (async () => {
      const pairs = new Map<string, { kinds: Set<string>; strength: number }>();
      const idSet = new Set(wikiIds);
      const bump = (a: string, b: string, kind: string, w = 1) => {
        if (a === b || !idSet.has(a) || !idSet.has(b)) return;
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        const cur = pairs.get(key) || { kinds: new Set<string>(), strength: 0 };
        cur.kinds.add(kind);
        cur.strength += w;
        pairs.set(key, cur);
      };

      try {
        // Pointer entries: wiki A holds an entry that links to wiki B.
        const { data: pointers } = await supabase
          .from("knowledge_entries")
          .select("wiki_id, linked_wiki_id")
          .not("linked_wiki_id", "is", null)
          .limit(2000);
        for (const p of (pointers as any[]) || []) {
          if (p.wiki_id && p.linked_wiki_id) bump(p.wiki_id, p.linked_wiki_id, "pointer", 2);
        }

        // Bridges: an entry native to wiki A shared into wiki B.
        const { data: bridges } = await supabase
          .from("entry_bridges" as any)
          .select("entry_id, wiki_id")
          .limit(2000);
        const bridgeRows = ((bridges as any[]) || []).filter((b) => b.entry_id && b.wiki_id);
        if (bridgeRows.length > 0) {
          const entryIds = Array.from(new Set(bridgeRows.map((b) => b.entry_id))).slice(0, 1000);
          const { data: natives } = await supabase
            .from("knowledge_entries")
            .select("id, wiki_id")
            .in("id", entryIds);
          const nativeWiki = new Map(((natives as any[]) || []).map((e) => [e.id, e.wiki_id]));
          for (const b of bridgeRows) {
            const home = nativeWiki.get(b.entry_id);
            if (home) bump(home, b.wiki_id, "bridge", 2);
          }
        }
      } catch {
        /* graph still renders with tag links only */
      }
      if (!cancelled) setLinks(pairs);
    })();
    return () => { cancelled = true; };
  }, [wikiIds.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  return links;
}

const NeuronGraph: React.FC<{
  wikis: WikiWithStats[];
  lockedIds: Set<string>;
  activeWikiId: string | null;
  onSelect: (wiki: WikiWithStats) => void;
}> = ({ wikis, lockedIds, activeWikiId, onSelect }) => {
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
  const fittedRef = useRef(false);
  const interactedRef = useRef(false);

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

  const connectionPairs = useNeuronConnections(useMemo(() => wikis.map((w) => w.id), [wikis]));

  const graphData = useMemo(() => {
    const nodes: NeuronNode[] = wikis.map((w) => {
      const locked = lockedIds.has(w.id);
      return {
        id: w.id,
        name: w.name,
        color: locked ? LOCKED_COLOR : w.cover_color,
        // Area encodes entry count (sqrt so big neurons don't dwarf the rest).
        val: 3 + Math.min(14, Math.sqrt(w.entry_count || 0) * 2) + (w.id === activeWikiId ? 3 : 0),
        locked,
        isActive: w.id === activeWikiId,
        entryCount: w.entry_count || 0,
      };
    });

    const linkMap = new Map<string, NeuronLink>();
    // Knowledge-derived connections (pointers + bridges).
    for (const [key, v] of connectionPairs) {
      const [a, b] = key.split("|");
      linkMap.set(key, { source: a, target: b, kinds: Array.from(v.kinds), strength: v.strength });
    }
    // Shared tags — weak thematic links between neurons.
    for (let i = 0; i < wikis.length; i++) {
      for (let j = i + 1; j < wikis.length; j++) {
        const shared = wikis[i].tags.filter((t) => wikis[j].tags.includes(t)).length;
        if (shared === 0) continue;
        const a = wikis[i].id, b = wikis[j].id;
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        const cur = linkMap.get(key);
        if (cur) {
          if (!cur.kinds.includes("tag")) cur.kinds.push("tag");
          cur.strength += shared;
        } else {
          linkMap.set(key, { source: a, target: b, kinds: ["tag"], strength: shared });
        }
      }
    }
    return { nodes, links: Array.from(linkMap.values()) };
  }, [wikis, lockedIds, activeWikiId, connectionPairs]);

  // Neighbours of the hovered neuron — everything else dims (focus+context).
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

  const nodeObject = useCallback((n: any) => {
    const raw = `${n.locked ? "🔒 " : ""}${n.name}${n.isActive ? " ●" : ""}`;
    const text = raw.length > 28 ? raw.slice(0, 27).trimEnd() + "…" : raw;
    const sprite = new SpriteText(text);
    sprite.color = n.color;
    sprite.textHeight = n.isActive ? 4.6 : 3.8;
    if (n.isActive) sprite.fontWeight = "700";
    (sprite as any).center.y = -1.1;
    ((sprite as any).material as any).depthWrite = false;
    return sprite;
  }, []);

  const handleEngineStop = useCallback(() => {
    if (fittedRef.current) return;
    fittedRef.current = true;
    try {
      fgRef.current?.zoomToFit(600, 70);
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
        <p className="text-sm mt-1">Your browser doesn't support hardware-accelerated WebGL. The grid views above still show everything.</p>
      </div>
    );
  }

  const connectionCount = graphData.links.length;

  return (
    <div className={expanded ? "fixed inset-0 z-[100] bg-background p-2 sm:p-4 flex" : undefined}>
      <div
        ref={containerRef}
        role="img"
        aria-label={`Mind map of ${wikis.length} neuron${wikis.length === 1 ? "" : "s"} with ${connectionCount} connection${connectionCount === 1 ? "" : "s"}. Click a neuron to open it.`}
        onPointerDown={handlePointerDown}
        className={`relative w-full overflow-hidden bg-surface-container-low border border-outline-variant/10 ${
          expanded ? "h-full rounded-xl" : "h-[60vh] min-h-[420px] rounded-2xl"
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
              `<div style="transform:translate(14px,-30px);font-family:Inter,system-ui,sans-serif;font-size:12px;padding:3px 8px;background:rgba(20,18,14,0.92);border-radius:6px;color:#f5efe6;pointer-events:none">${String(n.name).replace(/</g, "&lt;")} — ${n.entryCount} entr${n.entryCount === 1 ? "y" : "ies"}${n.locked ? " (locked)" : ""}${n.isActive ? " (active)" : ""}</div>`
            }
            nodeThreeObject={showLabels ? nodeObject : undefined}
            nodeThreeObjectExtend={true}
            nodeColor={(n: any) => (!neighbours || neighbours.has(n.id) ? n.color : "rgba(120,115,105,0.25)")}
            nodeVal={(n: any) => n.val}
            nodeOpacity={0.92}
            // Hover: the neighbourhood stays lit, everything else fades.
            linkColor={(l: any) => (touchesHover(l) ? "rgba(236,210,160,0.9)" : hoverId ? "rgba(200,190,170,0.08)" : "rgba(200,190,170,0.3)")}
            linkWidth={(l: any) => (touchesHover(l) ? 1.6 : 0.7)}
            linkOpacity={0.5}
            // The "alive" part: signal pulses travelling along each connection.
            // Stronger connections fire more, faster pulses.
            linkDirectionalParticles={(l: any) => (reducedMotion ? 0 : Math.min(4, 1 + Math.floor((l.strength || 1) / 2)))}
            linkDirectionalParticleSpeed={(l: any) => 0.004 + Math.min(0.008, (l.strength || 1) * 0.0015)}
            linkDirectionalParticleWidth={(l: any) => (touchesHover(l) ? 2.6 : 1.6)}
            warmupTicks={reducedMotion ? 180 : 60}
            cooldownTicks={reducedMotion ? 0 : 120}
            onEngineStop={handleEngineStop}
            enableNodeDrag={!("ontouchstart" in window)}
            onNodeHover={(n: any) => {
              const id = n?.id ?? null;
              if (id && id !== hoverId && soundRef.current) librarySounds.hover();
              setHoverId(id);
            }}
            onNodeClick={(n: any) => {
              const wiki = wikis.find((w) => w.id === n.id);
              if (!wiki) return;
              if (soundRef.current) librarySounds.open();
              onSelect(wiki);
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
            title={showLabels ? "Hide neuron names" : "Show neuron names"}
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

        {/* Legend */}
        <div className="absolute top-3 left-3 flex flex-col gap-1 text-[10px] text-on-surface-variant/80 bg-surface-container-highest/70 backdrop-blur-sm rounded-lg px-2.5 py-2 pointer-events-none select-none">
          <span className="font-bold uppercase tracking-widest text-on-surface-variant">Connections</span>
          <span>{reducedMotion ? "Lines" : "Pulses"} = shared knowledge between neurons</span>
          <span>Bigger neuron = more entries</span>
        </div>

        <p className="absolute bottom-2 left-3 text-[11px] text-on-surface-variant/70 pointer-events-none select-none">
          drag to rotate · scroll/pinch to zoom · hover to trace connections · click a neuron to open it
        </p>
      </div>
    </div>
  );
};

export default NeuronGraph;
