import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BookDocument } from "@/types/library";
import { bookProfile, BookProfile } from "@/lib/bookProfile";
import { categoryColor } from "@/lib/categoryColors";
import { coverGradient, seasonalTheme } from "@/lib/seasonTheme";
import { describeSeason } from "@/lib/season";
import { hslTripletToOklch } from "@/lib/oklch";
import { loadLastPage } from "@/hooks/useReaderPrefs";
import { useTheme } from "@/context/ThemeContext";
import { getTheme } from "@/lib/themes";
import SeasonAmbience from "@/components/SeasonAmbience";

/**
 * The Showcase: every book in the library as a full profile, played as a reel.
 *
 * The other three views answer "which book?" — shelves for browsing, list for
 * scanning, mind map for structure. None of them answers "what *is* this
 * book?", because the app had no such surface: the summary, its model
 * attribution, the chapter gists, provenance, shelves and the locally
 * remembered reading position were spread across four components and shown a
 * few at a time. This view puts a whole profile on screen at once and moves
 * through the library on its own, so a library you stopped knowing the shape
 * of can be re-met by leaving it running.
 *
 * The season is not painted on top of it. Everything seasonal here is a CSS
 * variable the theme layer publishes (src/lib/seasonTheme.ts), so the reel is
 * the current theme in the current week of the year, and there is no branch in
 * this file on which season it is.
 *
 * Auto-advance carries obligations and they are met explicitly: an always-
 * visible pause control, pause on hover and on keyboard focus, arrow-key and
 * space bindings, no advancing at all under prefers-reduced-motion, and a live
 * region that stays quiet while the reel is driving itself and speaks when the
 * reader is (WCAG 2.2.2).
 */

/** Long enough to read a summary, short enough that the reel feels alive. */
const ADVANCE_MS = 7000;
const REDUCE_QUERY = "(prefers-reduced-motion: reduce)";

function readReduced(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  try { return window.matchMedia(REDUCE_QUERY).matches; } catch { return false; }
}

const SOURCE_CHIP: Record<string, { icon: string; label: string }> = {
  user: { icon: "person", label: "Yours" },
  assistant: { icon: "auto_awesome", label: "Written in-app" },
  youtube: { icon: "smart_display", label: "Transcript" },
};

/**
 * Where the year is, drawn. The reel's colours and drift come from a single
 * angle, and this is that angle made visible — so the view can be asked why it
 * looks the way it does and answer, rather than just looking moody.
 */
const YearRing: React.FC<{ angle: number; season: string }> = ({ angle, season }) => {
  const R = 12, C = 16;
  // 12 o'clock is the December solstice; the year runs clockwise from there.
  const pt = (a: number, r: number) => [C + Math.sin(a) * r, C - Math.cos(a) * r] as const;
  const [mx, my] = pt(angle, R);
  // The filled arc runs from the last turning point to now, so the ring shows
  // how far into *this* season we are and not just where the year is.
  const from = Math.floor(angle / (Math.PI / 2)) * (Math.PI / 2);
  const [ax, ay] = pt(from, R);
  const large = angle - from > Math.PI ? 1 : 0;
  return (
    <svg
      viewBox="0 0 32 32"
      className="w-8 h-8 shrink-0"
      role="img"
      aria-label={`${season}, ${Math.round((angle / (Math.PI * 2)) * 100)}% through the year`}
    >
      <circle cx={C} cy={C} r={R} fill="none" stroke="hsl(var(--outline-variant))" strokeWidth="1.5" opacity="0.45" />
      {[0, 1, 2, 3].map((q) => {
        const [x1, y1] = pt((q * Math.PI) / 2, R - 2.5);
        const [x2, y2] = pt((q * Math.PI) / 2, R + 2);
        return <line key={q} x1={x1} y1={y1} x2={x2} y2={y2} stroke="hsl(var(--outline-variant))" strokeWidth="1.3" />;
      })}
      {angle - from > 0.02 && (
        <path
          d={`M ${ax} ${ay} A ${R} ${R} 0 ${large} 1 ${mx} ${my}`}
          fill="none"
          stroke="hsl(var(--season-glow))"
          strokeWidth="2.5"
          strokeLinecap="round"
          opacity="0.85"
        />
      )}
      <circle cx={mx} cy={my} r="3" fill="hsl(var(--season-glow))" />
    </svg>
  );
};

const Cover: React.FC<{
  profile: BookProfile;
  stops: [string, string];
  /** Placeholder covers carry their title at stage size; at rail size it would
   *  only be noise, so the glyph stands alone there. */
  titled?: boolean;
  className?: string;
}> = ({ profile, stops, titled = false, className = "" }) => (
  <div
    className={`relative overflow-hidden rounded-xl bg-surface-container-highest ${className}`}
    style={profile.coverImageUrl ? undefined : { backgroundImage: `linear-gradient(145deg, ${stops[0]}, ${stops[1]})` }}
  >
    {profile.coverImageUrl ? (
      <img src={profile.coverImageUrl} alt="" className="w-full h-full object-cover" />
    ) : titled ? (
      <div className="absolute inset-0 flex flex-col justify-between p-3">
        <span className="material-symbols-outlined text-[1.1rem] text-foreground/35" aria-hidden>
          {profile.source === "youtube" ? "smart_display" : "auto_stories"}
        </span>
        <span className="min-w-0">
          <span className="block w-6 h-px bg-foreground/25 mb-1.5" aria-hidden />
          <span className="block font-display text-[0.8rem] leading-tight text-foreground/70 line-clamp-4">
            {profile.title}
          </span>
        </span>
      </div>
    ) : (
      // A <span> with the Material Symbols class does not obey flex centring —
      // the font's own display rule wins — so the box has to be the flex box.
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="material-symbols-outlined text-[1.5rem] text-foreground/25" aria-hidden>
          {profile.source === "youtube" ? "smart_display" : "auto_stories"}
        </span>
      </div>
    )}
  </div>
);

const LibraryShowcase: React.FC<{
  books: BookDocument[];
  shelves: { id: string; name: string }[];
  onOpenBook: (bookId: string) => void;
  highlight?: (text: string) => React.ReactNode;
}> = ({ books, shelves, onOpenBook, highlight }) => {
  const { season, seasonal, themeId } = useTheme();
  const [index, setIndex] = useState(0);
  const [reduced, setReduced] = useState(readReduced);
  // Auto-advance is the default, but never under reduced motion — there it
  // waits to be driven.
  const [playing, setPlaying] = useState(() => !readReduced());
  const [hovered, setHovered] = useState(false);
  const railRef = useRef<HTMLDivElement | null>(null);
  const [elapsed, setElapsed] = useState(0);

  const shelfNames = useMemo(() => new Map(shelves.map((s) => [s.id, s.name])), [shelves]);

  const profiles = useMemo(
    () => books.map((book) => bookProfile({ book, shelfNames, lastPage: loadLastPage(book.id) })),
    [books, shelfNames],
  );

  // Cover gradients follow the theme's seasonal accent, so a cover-less book
  // belongs to the palette it is sitting in rather than to the fixed brown the
  // grid uses.
  //
  // Derived here rather than read back from --season-glow on the document:
  // ThemeContext publishes that variable from an effect, which lands *after*
  // this render, so a DOM read would take the unseasoned accent on first paint
  // and — because nothing in the dependency list would then change — keep it
  // for the rest of the session. Same input, computed directly.
  const gradients = useMemo(() => {
    const theme = getTheme(themeId);
    const bg = hslTripletToOklch(theme.tokens["--background"] ?? "") ?? { l: 0.2, c: 0, h: 0 };
    const accent = hslTripletToOklch(theme.tokens["--accent"] ?? "") ?? { l: 0.7, c: 0.1, h: 0 };
    const glow = seasonal ? seasonalTheme(theme, season).glow : accent;
    return profiles.map((p) => coverGradient(p.seed, glow, bg.l));
  }, [profiles, themeId, seasonal, season]);

  const count = profiles.length;
  const safeIndex = count === 0 ? 0 : Math.min(index, count - 1);
  const active = profiles[safeIndex];

  // A single book is not a reel; do not animate a progress bar toward nothing.
  const advancing = playing && !reduced && !hovered && count > 1;

  const go = useCallback((next: number) => {
    setIndex((i) => (count === 0 ? 0 : ((next % count) + count) % count));
    setElapsed(0);
  }, [count]);

  useEffect(() => { if (index >= count && count > 0) setIndex(0); }, [count, index]);

  // Drive the reel and its progress bar off one interval rather than a CSS
  // animation, so pausing freezes the bar exactly where the timer is.
  useEffect(() => {
    if (!advancing) return;
    const STEP = 50;
    const id = window.setInterval(() => {
      setElapsed((e) => {
        const next = e + STEP;
        if (next >= ADVANCE_MS) {
          setIndex((i) => (i + 1) % count);
          return 0;
        }
        return next;
      });
    }, STEP);
    return () => window.clearInterval(id);
  }, [advancing, count]);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    let mq: MediaQueryList;
    try { mq = window.matchMedia(REDUCE_QUERY); } catch { return; }
    const onChange = () => { setReduced(mq.matches); if (mq.matches) setPlaying(false); };
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);

  // Keep the rail's current row in view as the reel moves under it.
  useEffect(() => {
    const row = railRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    row?.scrollIntoView({ block: "nearest", behavior: reduced ? "auto" : "smooth" });
  }, [safeIndex, reduced]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowRight") { e.preventDefault(); go(safeIndex + 1); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); go(safeIndex - 1); }
    else if (e.key === " " || e.key === "Spacebar") { e.preventDefault(); setPlaying((p) => !p); }
  };

  if (count === 0 || !active) return null;

  const pct = advancing ? (elapsed / ADVANCE_MS) * 100 : 0;

  return (
    <section
      role="region"
      aria-roledescription="carousel"
      aria-label="Book profiles"
      tabIndex={0}
      onKeyDown={onKeyDown}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setHovered(false); }}
      className="relative overflow-hidden rounded-2xl border border-outline-variant/10 bg-surface-container-low outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
    >
      {seasonal && <SeasonAmbience running={advancing} />}

      {/* A wash of the season's own hue, behind everything and under the text. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.10]"
        style={{ background: "radial-gradient(120% 90% at 15% 0%, hsl(var(--season-glow)) 0%, transparent 60%)" }}
      />

      <header className="relative flex items-center gap-3 px-4 sm:px-6 py-3 border-b border-outline-variant/10">
        <YearRing angle={season.angle} season={season.season} />
        <div className="min-w-0">
          <p className="font-headline text-sm font-bold text-foreground leading-tight first-letter:uppercase">
            {seasonal ? describeSeason(season) : "Showcase"}
          </p>
          <p className="text-[11px] text-on-surface-variant">
            {count} {count === 1 ? "book" : "books"}
            {seasonal && season.hemisphere === "south" ? " · southern hemisphere" : ""}
          </p>
        </div>

        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => go(safeIndex - 1)}
            aria-label="Previous book"
            className="cc-tap-44 w-9 h-9 rounded-lg flex items-center justify-center text-on-surface-variant hover:text-primary hover:bg-surface-container-high transition-colors"
          >
            <span className="material-symbols-outlined text-lg" aria-hidden>chevron_left</span>
          </button>
          <button
            onClick={() => setPlaying((p) => !p)}
            aria-label={playing ? "Pause the showcase" : "Play the showcase"}
            aria-pressed={playing}
            className="cc-tap-44 w-9 h-9 rounded-lg flex items-center justify-center text-on-surface-variant hover:text-primary hover:bg-surface-container-high transition-colors"
          >
            <span className="material-symbols-outlined text-lg" aria-hidden>{playing ? "pause" : "play_arrow"}</span>
          </button>
          <button
            onClick={() => go(safeIndex + 1)}
            aria-label="Next book"
            className="cc-tap-44 w-9 h-9 rounded-lg flex items-center justify-center text-on-surface-variant hover:text-primary hover:bg-surface-container-high transition-colors"
          >
            <span className="material-symbols-outlined text-lg" aria-hidden>chevron_right</span>
          </button>
        </div>
      </header>

      <div className="relative grid lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        {/* ---- Stage: one whole profile ---- */}
        <div
          className="p-4 sm:p-6 lg:border-r border-outline-variant/10"
          aria-live={advancing ? "off" : "polite"}
          aria-atomic="true"
        >
          <div
            key={active.id}
            className="flex flex-col sm:flex-row gap-5 motion-safe:animate-[cc-season-enter_520ms_cubic-bezier(0.22,1,0.36,1)]"
          >
            <Cover profile={active} stops={gradients[safeIndex]} titled className="w-28 sm:w-36 aspect-[3/4] shrink-0 shadow-lg" />

            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5 mb-2">
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-surface-container-high text-[10px] text-on-surface-variant">
                  <span className="material-symbols-outlined text-[13px]" aria-hidden>
                    {SOURCE_CHIP[active.source]?.icon ?? "book"}
                  </span>
                  {SOURCE_CHIP[active.source]?.label ?? "Book"}
                </span>
                {active.category && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-surface-container-high text-[10px] text-on-surface-variant capitalize">
                    <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: categoryColor(active.category) }} aria-hidden />
                    {active.category}
                  </span>
                )}
                {active.shelves.slice(0, 2).map((s) => (
                  <span key={s} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-surface-container-high text-[10px] text-on-surface-variant">
                    <span className="material-symbols-outlined text-[13px]" aria-hidden>shelves</span>{s}
                  </span>
                ))}
              </div>

              <h3 className="font-display text-2xl sm:text-3xl font-bold text-foreground leading-tight line-clamp-2">
                {highlight ? highlight(active.title) : active.title}
              </h3>

              {active.summary ? (
                <p className="mt-2 text-sm text-on-surface-variant line-clamp-3">{active.summary}</p>
              ) : (
                <p className="mt-2 text-sm text-on-surface-variant/70 italic">
                  No summary yet — generate a catalog to give this book one.
                </p>
              )}
              {active.summary && active.summaryModel && (
                <p className="mt-1 text-[10px] text-on-surface-variant/60">AI summary · {active.summaryModel}</p>
              )}

              {/* Stats — pages, chapters, how far in you are, when it arrived. */}
              <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-1">
                {active.stats.map((s) => (
                  <div key={s.label} className="flex items-baseline gap-1.5">
                    <dt className="sr-only">{s.label}</dt>
                    <dd className="text-sm font-semibold text-foreground tabular-nums">{s.value}</dd>
                    <span className="text-[11px] text-on-surface-variant">{s.label}</span>
                  </div>
                ))}
              </dl>

              {active.progress && (
                <div className="mt-2 h-1 rounded-full bg-surface-container-highest overflow-hidden max-w-[16rem]">
                  <div className="h-full rounded-full bg-primary/70" style={{ width: `${active.progress.pct}%` }} />
                </div>
              )}

              {active.highlights.length > 0 && (
                <ul className="mt-3 space-y-1 border-l-2 border-outline-variant/20 pl-3">
                  {active.highlights.map((h, i) => (
                    <li key={`${h.name}-${i}`} className="text-[11px] leading-snug">
                      <span className="text-foreground/80 font-medium">{h.name}</span>
                      {h.gist && <span className="text-on-surface-variant"> — {h.gist}</span>}
                    </li>
                  ))}
                </ul>
              )}

              {active.tags.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1">
                  {active.tags.slice(0, 5).map((t) => (
                    <span key={t} className="px-1.5 py-0.5 rounded-full bg-surface-container-highest text-on-surface-variant text-[10px]">#{t}</span>
                  ))}
                </div>
              )}

              <button
                onClick={() => onOpenBook(active.id)}
                className="mt-4 px-5 py-2 rounded-lg bg-primary/15 text-primary font-bold text-sm hover:bg-primary hover:text-on-primary-container transition-all active:scale-95"
              >
                Open
              </button>
            </div>
          </div>
        </div>

        {/* ---- Rail: the whole library, always visible ---- */}
        <div ref={railRef} className="max-h-[22rem] lg:max-h-[30rem] overflow-y-auto">
          <ul className="divide-y divide-outline-variant/10">
            {profiles.map((p, i) => {
              const isActive = i === safeIndex;
              return (
                <li key={p.id}>
                  <button
                    data-active={isActive}
                    aria-current={isActive ? "true" : undefined}
                    onClick={() => go(i)}
                    onDoubleClick={() => onOpenBook(p.id)}
                    className={`relative w-full text-left flex items-center gap-3 px-4 py-2.5 transition-colors ${
                      isActive ? "bg-surface-container-high" : "hover:bg-surface-container-high/50"
                    }`}
                  >
                    <Cover profile={p} stops={gradients[i]} className="w-7 h-10 shrink-0" />
                    <span className="min-w-0 flex-1">
                      <span className={`block text-xs truncate ${isActive ? "text-primary font-bold" : "text-foreground"}`}>
                        {highlight ? highlight(p.title) : p.title}
                      </span>
                      <span className="block text-[10px] text-on-surface-variant truncate">
                        {p.category && <span className="capitalize">{p.category} · </span>}
                        {p.progress ? `${p.progress.pct}% read` : p.stats[0]?.value ? `${p.stats[0].value} ${p.stats[0].label}` : "—"}
                      </span>
                    </span>
                    {isActive && (
                      <span aria-hidden className="absolute left-0 bottom-0 h-0.5 bg-primary/60 transition-[width] duration-75 ease-linear" style={{ width: `${pct}%` }} />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </section>
  );
};

export default LibraryShowcase;
