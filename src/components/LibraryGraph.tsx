import React, { useEffect, useMemo, useRef, useState } from "react";
import ForceGraph3D from "react-force-graph-3d";
import { BookDocument } from "@/types/library";
import { BOOK_CATEGORIES } from "@/lib/autoTag";

// 3D mind map of the library. Loaded lazily (React.lazy in Library.tsx) so
// the three.js chunk (~300KB gzip) is only fetched when the user toggles the
// graph on — it never weighs down the initial bundle.
//
// Graph shape (Obsidian-style clustering without custom forces): one hub node
// per category, one node per tag shared by 2+ books, one node per book.
// Books link to their category hub and their shared tags, so the force layout
// naturally pulls same-category/same-tag books into visible clusters — the
// hubs ARE the clustering mechanism.

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

// One stable hue per category (golden-angle spacing keeps neighbors distinct).
const categoryColor = (category: string): string => {
  const idx = Math.max(0, (BOOK_CATEGORIES as readonly string[]).indexOf(category));
  return `hsl(${(idx * 137.5) % 360}, 62%, 58%)`;
};

const TAG_COLOR = "hsl(40, 45%, 62%)";
const UNTAGGED = "uncategorized";

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

const LibraryGraph: React.FC<{
  books: BookDocument[];
  onOpenBook: (bookId: string) => void;
}> = ({ books, onOpenBook }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [webgl] = useState(hasWebGL);

  // The canvas can't auto-fill its parent — measure it (and re-measure on
  // resize/rotation).
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
      categories.set(b.category || UNTAGGED, (categories.get(b.category || UNTAGGED) || 0) + 1);
    }

    for (const [cat, count] of categories) {
      nodes.push({
        id: `cat:${cat}`,
        name: `${cat} (${count})`,
        kind: "category",
        color: cat === UNTAGGED ? "hsl(0, 0%, 55%)" : categoryColor(cat),
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
      const cat = b.category || UNTAGGED;
      nodes.push({
        id: `book:${b.id}`,
        name: b.title,
        kind: "book",
        bookId: b.id,
        color: cat === UNTAGGED ? "hsl(0, 0%, 75%)" : categoryColor(cat),
        val: 2,
      });
      links.push({ source: `book:${b.id}`, target: `cat:${cat}` });
      for (const t of b.tags || []) {
        if (sharedTags.has(t)) links.push({ source: `book:${b.id}`, target: `tag:${t}` });
      }
    }

    return { nodes, links };
  }, [books]);

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
    <div
      ref={containerRef}
      role="img"
      aria-label={`Mind map of ${books.length} books across ${new Set(books.map((b) => b.category || UNTAGGED)).size} categories`}
      className="relative w-full h-[60vh] min-h-[420px] rounded-2xl overflow-hidden bg-surface-container-low border border-outline-variant/10"
    >
      {size.width > 0 && (
        <ForceGraph3D
          width={size.width}
          height={size.height}
          graphData={graphData}
          backgroundColor="rgba(0,0,0,0)"
          nodeLabel={(n: any) => `<div style="font-family:Inter,system-ui,sans-serif;font-size:12px;padding:2px 6px;background:rgba(20,18,14,0.92);border-radius:6px;color:#f5efe6">${String(n.name).replace(/</g, "&lt;")}</div>`}
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
          // On touch, node-drag fights one-finger camera rotation.
          enableNodeDrag={!("ontouchstart" in window)}
          onNodeClick={(n: any) => {
            if (n.kind === "book" && n.bookId) onOpenBook(n.bookId);
          }}
        />
      )}
      <p className="absolute bottom-2 left-3 text-[11px] text-on-surface-variant/70 pointer-events-none select-none">
        drag to rotate · scroll/pinch to zoom · click a book to open it
      </p>
    </div>
  );
};

export default LibraryGraph;
