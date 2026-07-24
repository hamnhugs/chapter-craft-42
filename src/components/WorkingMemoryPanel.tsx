import React, { useMemo, useState } from "react";
import { useChat } from "@/context/ChatContext";

// Working memory (Phase / Wave 1 of the brain-accurate memory plan): surface the
// brain's L1 "focus of attention" — a small, capacity-limited buffer of what the
// assistant is actively holding for THIS conversation (the memories it has drawn
// on), with LRU fade and a pin-to-keep gate. Purely client-side + session-scoped.
// Working-memory capacity is genuinely contested (Cowan ~4; not a hard slot), so
// this cap is a soft, tunable heuristic — not a claim about a fixed limit.
const CAP = 7;
const PIN_KEY = "wm-pins";

const WorkingMemoryPanel: React.FC = () => {
  const { messages } = useChat();
  const [open, setOpen] = useState(false);
  const [pins, setPins] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(sessionStorage.getItem(PIN_KEY) || "[]")); } catch { return new Set(); }
  });

  const togglePin = (id: string) => setPins((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    try { sessionStorage.setItem(PIN_KEY, JSON.stringify([...next])); } catch { /* private mode */ }
    return next;
  });

  // Distinct memories the assistant drew on this session, newest-first.
  const allSeen = useMemo(() => {
    const map = new Map<string, string>();
    for (let i = messages.length - 1; i >= 0; i--) {
      const um = messages[i].usedMemories;
      if (!um) continue;
      for (const m of um) if (!map.has(m.id)) map.set(m.id, m.title);
    }
    return map;
  }, [messages]);

  // Focus = pinned (kept) first, then most-recent, capped. New arrivals evict the
  // oldest unpinned — the "fade" of working memory.
  const focus = useMemo(() => {
    const entries = [...allSeen];
    const pinned = entries.filter(([id]) => pins.has(id)).map(([id, title]) => ({ id, title, pinned: true }));
    const rest = entries.filter(([id]) => !pins.has(id)).map(([id, title]) => ({ id, title, pinned: false }));
    return [...pinned, ...rest].slice(0, Math.max(CAP, pinned.length));
  }, [allSeen, pins]);

  if (focus.length === 0) return null;

  return (
    <div className="mx-auto max-w-3xl w-full mb-3">
      <div className="rounded-xl border border-outline-variant/15 bg-surface-container-low/60">
        <button
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="w-full flex items-center gap-2 px-3 py-2 text-left"
        >
          <span className="material-symbols-outlined text-[16px] text-primary" aria-hidden>psychology</span>
          <span className="text-xs font-semibold text-foreground">Working memory</span>
          <span className="text-[11px] text-on-surface-variant">· {focus.length} in focus</span>
          <span
            className="material-symbols-outlined text-[18px] text-on-surface-variant ml-auto transition-transform"
            style={{ transform: open ? "rotate(180deg)" : undefined }}
            aria-hidden
          >
            expand_more
          </span>
        </button>
        {open && (
          <div className="px-3 pb-3">
            <p className="text-[11px] text-on-surface-variant/70 mb-2 leading-relaxed">
              What the assistant is actively holding for this conversation — a small, capacity-limited focus that fades
              as new memories come in. Pin one to keep it.
            </p>
            <div className="flex flex-wrap gap-1.5">
              {focus.map((m) => (
                <span
                  key={m.id}
                  className={`group inline-flex items-center gap-1 pl-2.5 pr-1 py-1 rounded-full text-[11px] text-foreground max-w-[240px] ${m.pinned ? "bg-primary/12 ring-1 ring-primary/25" : "bg-surface-container-high"}`}
                >
                  <span aria-hidden className={`w-1.5 h-1.5 rounded-full shrink-0 ${m.pinned ? "bg-primary" : "bg-primary/50"}`} />
                  <span className="truncate">{m.title}</span>
                  <button
                    onClick={() => togglePin(m.id)}
                    aria-label={m.pinned ? `Unpin ${m.title}` : `Pin ${m.title}`}
                    aria-pressed={m.pinned}
                    title={m.pinned ? "Keep in focus (pinned)" : "Pin to keep in focus"}
                    className="shrink-0 rounded-full p-0.5 text-on-surface-variant hover:text-primary opacity-60 hover:opacity-100 transition-opacity"
                  >
                    <span className="material-symbols-outlined text-[14px]" style={m.pinned ? { fontVariationSettings: "'FILL' 1" } : undefined} aria-hidden>
                      keep
                    </span>
                  </button>
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default WorkingMemoryPanel;
