// Notebooks inside notebooks.
//
// Where a notebook sits is stored on the notebook itself, as one tag:
// `in:<parent id>`. The `wikis.tags` column has been there since the first
// migration and nothing else writes it, so nesting needs no server change —
// the same choice Workspace filing made with `meta.wikiId`. A tag that points
// at a notebook that no longer exists is simply ignored (the notebook shows at
// the top level), so a delete can never strand anything out of sight.
//
// Everything here is pure: lists in, trees out.

import type { Wiki } from "@/lib/wikisApi";

export const PARENT_TAG_PREFIX = "in:";

/** Notebook → notebook → notebook. Three levels is where a tree stops being
 *  something you can hold in your head (docs/onboarding-and-notebooks.md). */
export const MAX_NOTEBOOK_DEPTH = 3;

type Nestable = Pick<Wiki, "id" | "name" | "tags">;

export function parentIdOf(wiki: Pick<Wiki, "tags">): string | null {
  const tag = (wiki.tags || []).find((t) => t.startsWith(PARENT_TAG_PREFIX));
  return tag ? tag.slice(PARENT_TAG_PREFIX.length) || null : null;
}

/** The tags with the parent set to `parentId` (null = top level). Other tags
 *  are left exactly as they were. */
export function withParent(tags: string[] | null | undefined, parentId: string | null): string[] {
  const rest = (tags || []).filter((t) => !t.startsWith(PARENT_TAG_PREFIX));
  return parentId ? [...rest, `${PARENT_TAG_PREFIX}${parentId}`] : rest;
}

export interface NotebookNode<W extends Nestable = Nestable> {
  wiki: W;
  /** 1 for a top-level notebook. */
  depth: number;
  parent: NotebookNode<W> | null;
  children: NotebookNode<W>[];
}

export interface NotebookTree<W extends Nestable = Nestable> {
  roots: NotebookNode<W>[];
  byId: Map<string, NotebookNode<W>>;
}

const byName = (a: { wiki: Nestable }, b: { wiki: Nestable }) =>
  a.wiki.name.localeCompare(b.wiki.name, undefined, { numeric: true, sensitivity: "base" });

/**
 * Build the tree. Order is by name at every level: a list you navigate by
 * position has to keep its positions, which "most recent first" never does.
 *
 * A notebook lands at the top level when its parent is missing, is itself, or
 * would close a loop — bad data degrades to a flat list, never to a notebook
 * nobody can find.
 */
export function buildNotebookTree<W extends Nestable>(wikis: W[]): NotebookTree<W> {
  const byId = new Map<string, NotebookNode<W>>();
  for (const wiki of wikis) byId.set(wiki.id, { wiki, depth: 1, parent: null, children: [] });

  const roots: NotebookNode<W>[] = [];
  for (const node of byId.values()) {
    const pid = parentIdOf(node.wiki);
    const parent = pid && pid !== node.wiki.id ? byId.get(pid) : undefined;
    // Walking up from the would-be parent must never arrive back at this node.
    let loops = false;
    for (let p = parent, hops = 0; p; p = parentIdOf(p.wiki) ? byId.get(parentIdOf(p.wiki)!) : undefined) {
      if (p === node || ++hops > byId.size) { loops = true; break; }
    }
    if (parent && !loops) {
      node.parent = parent;
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const settle = (nodes: NotebookNode<W>[], depth: number) => {
    nodes.sort(byName);
    for (const n of nodes) {
      n.depth = depth;
      settle(n.children, depth + 1);
    }
  };
  settle(roots, 1);
  return { roots, byId };
}

/** Ancestors from the top level down to the notebook's own parent. */
export function ancestorsOf<W extends Nestable>(tree: NotebookTree<W>, id: string): NotebookNode<W>[] {
  const out: NotebookNode<W>[] = [];
  for (let p = tree.byId.get(id)?.parent ?? null; p; p = p.parent) out.unshift(p);
  return out;
}

/** Levels in the subtree rooted here, counting the node itself. */
export function heightOf(node: NotebookNode): number {
  return 1 + node.children.reduce((h, c) => Math.max(h, heightOf(c)), 0);
}

/** Every notebook under this one, at any depth. */
export function descendantsOf<W extends Nestable>(node: NotebookNode<W>): NotebookNode<W>[] {
  return node.children.flatMap((c) => [c, ...descendantsOf(c)]);
}

/**
 * Why `id` can't go inside `parentId` — or null when it can. `id` null asks
 * about a notebook that doesn't exist yet.
 */
export function whyCannotNest(tree: NotebookTree, id: string | null, parentId: string | null): string | null {
  if (!parentId) return null;
  const parent = tree.byId.get(parentId);
  if (!parent) return "That notebook no longer exists.";
  const node = id ? tree.byId.get(id) : undefined;
  if (node) {
    if (node === parent) return "A notebook can't go inside itself.";
    if (descendantsOf(node).includes(parent)) return "That notebook is already inside this one.";
  }
  if (parent.depth + (node ? heightOf(node) : 1) > MAX_NOTEBOOK_DEPTH) {
    return `Notebooks nest ${MAX_NOTEBOOK_DEPTH} levels deep at most.`;
  }
  return null;
}

/** The rows a tree shows, top to bottom, skipping what is folded away. */
export function visibleRows<W extends Nestable>(
  tree: NotebookTree<W>,
  collapsed: ReadonlySet<string>,
): NotebookNode<W>[] {
  const out: NotebookNode<W>[] = [];
  const walk = (nodes: NotebookNode<W>[]) => {
    for (const n of nodes) {
      out.push(n);
      if (!collapsed.has(n.wiki.id)) walk(n.children);
    }
  };
  walk(tree.roots);
  return out;
}

/** Every notebook in tree order — what a "put it inside" picker lists. */
export function allRows<W extends Nestable>(tree: NotebookTree<W>): NotebookNode<W>[] {
  return visibleRows(tree, new Set());
}

/** "Parent › Child" — the notebook's place, for search results and pickers. */
export function pathLabel(tree: NotebookTree, id: string): string {
  const node = tree.byId.get(id);
  if (!node) return "";
  return [...ancestorsOf(tree, id), node].map((n) => n.wiki.name).join(" › ");
}

/** Notebooks whose name contains the query, in tree order. */
export function matchNotebooks<W extends Nestable>(tree: NotebookTree<W>, query: string): NotebookNode<W>[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return allRows(tree).filter((n) => n.wiki.name.toLowerCase().includes(q));
}
