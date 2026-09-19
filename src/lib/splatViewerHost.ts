// Exactly one live splat viewer, app-wide.
//
// Two independent reasons this is a hard rule rather than a preference:
//   1. Browsers cap live WebGL contexts per page (~16 desktop, ~8 Android) and
//      silently kill the oldest with only a console warning — a transcript of
//      activated bubbles would start blanking earlier ones at random.
//   2. Spark's dispose() has an open upstream report of not fully releasing GPU
//      memory. Keeping one context bounds the worst case.
//
// Held in a module singleton rather than React state so it survives re-renders
// and works across sibling components that share no ancestor.

let active: { id: string; release: () => void } | null = null;

/** Take the viewer slot. Any other live viewer is torn down first.
 *
 *  Compares the release CALLBACK, not just the id: the same splat can legitimately
 *  appear in two chat bubbles (generate_splat then show_splat), and those two
 *  mounts share a row id. Keying on id alone would let the second mount skip
 *  teardown and leave two live WebGL contexts. */
export function claimViewer(id: string, release: () => void): void {
  if (active && active.release !== release) {
    const prev = active;
    active = null; // clear first so a re-entrant release() can't loop
    try { prev.release(); } catch { /* the previous viewer is going away anyway */ }
  }
  active = { id, release };
}

/** Give up the slot without invoking the release callback — for a viewer that
 *  is already tearing itself down (unmount). Matched on the same per-mount
 *  callback used to claim it, so one bubble can't release another's slot when
 *  both render the same splat. */
export function releaseViewer(release: () => void): void {
  if (active?.release === release) active = null;
}

export function activeViewerId(): string | null {
  return active?.id ?? null;
}
