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
 * The Showcase: every book in the library as a full profile, with the whole
 * library on a rail beside it.
 *
 * The other three views answer "which book?" — shelves for browsing, list for
 * scanning, mind map for structure. None of them answers "what *is* this
 * book?", because the app had no such surface: the summary, its model
 * attribution, the chapter gists, provenance, shelves and the locally
 * remembered reading position were spread across four components and shown a
 * few at a time.
 *
 * This shipped first as a self-advancing reel with an animated backdrop, and
 * both had to go. The motion was unwanted, and worse, it was what made the
 * Vault unusable: a 20Hz timer re-rendered the entire rail while the backdrop
 * read its inputs back off the document with getComputedStyle sixty times a
 * second. It is now entirely user-driven — nothing moves unless something is
 * clicked — which removed the timer, the animation frames, and with them the
 * reason the tab locked up.
 *
 * The season is still not painted on top of it. Everything seasonal is a
 * derived value the theme layer computes (src/lib/seasonTheme.ts), so the view
 * is the current theme in the current week of the year, and nothing in this
 * file branches on which season it is.
 */

/** Rail rows rendered at once. Matches LibraryShelves' GRID_PAGE_SIZE idea:
 *  a library can hold thousands of books and the DOM should not. */
const RAIL_PAGE = 50;
/** Which book the reader was last looking at, so switching views comes back. */
const SELECTED_KEY = "vault_showcase_book";

const SOURCE_CHIP: Record<string, { icon: string; label: string }> = {
  user: { icon: "person", label: "Yours" },
  assistant: { icon: "auto_awesome", label: "Written in-app" },
  youtube: { icon: "smart_display", label: "Transcript" },
};

/**
 * Where the year is, drawn. The view's colours come from a single angle, and
 * this is that angle made visible — so it can be asked why it looks the way it
 * does and answer, rather than just looking moody.
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
      <img src={profile.coverImageUrl} alt="" loading="lazy" decoding="async" className="w-full h-full object-cover" />
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
  // Restored from the last visit rather than reset to the top. Switching to
  // the mind map and back used to lose the reader's place every time.
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    try { return localStorage.getItem(SELECTED_KEY); } catch { return null; }
  });
  const [shown, setShown] = useState(RAIL_PAGE);
  const railRef = useRef<HTMLDivElement | null>(null);

  const shelfNames = useMemo(() => new Map(shelves.map((s) => [s.id, s.name])), [shelves]);

  const profiles = useMemo(
    () => books.map((book) => bookProfile({ book, shelfNames, lastPage: loadLastPage(book.id) })),
    [books, shelfNames],
  );

  /**
   * Cover gradients, computed on demand and cached.
   *
   * Each one runs a gamut-mapping bisection per stop, so doing all of them up
   * front is real work on a large library — and pointless, since the rail only
   * ever renders a page at a time. Keyed by the book's id hash so re-sorting
   * cannot restain a book, which is the bug the grid's index-based version has.
   *
   * Derived here rather than read back from --season-glow on the document:
   * ThemeContext publishes that variable from an effect, which lands after
   * this render, so a DOM read would take the unseasoned accent on first paint
   * and keep it for the rest of the session.
   */
  const gradientOf = useMemo(() => {
    const theme = getTheme(themeId);
    const bg = hslTripletToOklch(theme.tokens["--background"] ?? "") ?? { l: 0.2, c: 0, h: 0 };
    const accent = hslTripletToOklch(theme.tokens["--accent"] ?? "") ?? { l: 0.7, c: 0.1, h: 0 };
    const glow = seasonal ? seasonalTheme(theme, season).glow : accent;
    const cache = new Map<number, [string, string]>();
    return (seed: number): [string, string] => {
      let hit = cache.get(seed);
      if (!hit) { hit = coverGradient(seed, glow, bg.l); cache.set(seed, hit); }
      return hit;
    };
  }, [themeId, seasonal, season]);

  const count = profiles.length;
  const selectedIndex = useMemo(() => {
    const i = profiles.findIndex((p) => p.id === selectedId);
    return i >= 0 ? i : 0;
  }, [profiles, selectedId]);
  const active = profiles[selectedIndex];

  const select = useCallback((next: number) => {
    if (count === 0) return;
    const i = ((next % count) + count) % count;
    const id = profiles[i].id;
    setSelectedId(id);
    try { localStorage.setItem(SELECTED_KEY, id); } catch { /* private mode */ }
    // Keep a selection made with the arrows inside the paged rail.
    setShown((s) => (i + 1 > s ? Math.min(count, i + RAIL_PAGE) : s));
  }, [count, profiles]);

  // Make sure the remembered book is on screen when the view opens, without
  // yanking the page: `nearest` does nothing when it is already visible.
  useEffect(() => {
    const row = railRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    row?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowRight") { e.preventDefault(); select(selectedIndex + 1); }
    else if (e.key === "ArrowUp" || e.key === "ArrowLeft") { e.preventDefault(); select(selectedIndex - 1); }
    else if (e.key === "Home") { e.preventDefault(); select(0); }
    else if (e.key === "End") { e.preventDefault(); select(count - 1); }
  };

  if (count === 0 || !active) return null;

  const visible = profiles.slice(0, shown);

  return (
    <section
      role="region"
      aria-label="Book profiles"
      onKeyDown={onKeyDown}
      className="relative overflow-hidden rounded-2xl border border-outline-variant/10 bg-surface-container-low"
    >
      {seasonal && <SeasonAmbience />}

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
            {selectedIndex + 1} of {count}
            {seasonal && season.hemisphere === "south" ? " · southern hemisphere" : ""}
          </p>
        </div>

        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => select(selectedIndex - 1)}
            aria-label="Previous book"
            className="cc-tap-44 w-9 h-9 rounded-lg flex items-center justify-center text-on-surface-variant hover:text-primary hover:bg-surface-container-high transition-colors"
          >
            <span className="material-symbols-outlined text-lg" aria-hidden>chevron_left</span>
          </button>
          <button
            onClick={() => select(selectedIndex + 1)}
            aria-label="Next book"
            className="cc-tap-44 w-9 h-9 rounded-lg flex items-center justify-center text-on-surface-variant hover:text-primary hover:bg-surface-container-high transition-colors"
          >
            <span className="material-symbols-outlined text-lg" aria-hidden>chevron_right</span>
          </button>
        </div>
      </header>

      <div className="relative grid lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        {/* ---- Stage: one whole profile ---- */}
        <div className="p-4 sm:p-6 lg:border-r border-outline-variant/10" aria-live="polite" aria-atomic="true">
          <div className="flex flex-col sm:flex-row gap-5">
            <Cover profile={active} stops={gradientOf(active.seed)} titled className="w-28 sm:w-36 aspect-[3/4] shrink-0 shadow-lg" />

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
                  No summary yet — generating a catalog for this book would add one.
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

        {/* ---- Rail: the library, a page at a time ---- */}
        <div ref={railRef} className="max-h-[22rem] lg:max-h-[30rem] overflow-y-auto">
          <ul className="divide-y divide-outline-variant/10">
            {visible.map((p, i) => {
              const isActive = i === selectedIndex;
              return (
                <li key={p.id}>
                  <button
                    data-active={isActive}
                    aria-current={isActive ? "true" : undefined}
                    onClick={() => select(i)}
                    onDoubleClick={() => onOpenBook(p.id)}
                    className={`w-full text-left flex items-center gap-3 px-4 py-2.5 transition-colors ${
                      isActive ? "bg-surface-container-high" : "hover:bg-surface-container-high/50"
                    }`}
                  >
                    <Cover profile={p} stops={gradientOf(p.seed)} className="w-7 h-10 shrink-0" />
                    <span className="min-w-0 flex-1">
                      <span className={`block text-xs truncate ${isActive ? "text-primary font-bold" : "text-foreground"}`}>
                        {highlight ? highlight(p.title) : p.title}
                      </span>
                      <span className="block text-[10px] text-on-surface-variant truncate">
                        {p.category && <span className="capitalize">{p.category} · </span>}
                        {p.progress ? `${p.progress.pct}% read` : p.stats[0]?.value ? `${p.stats[0].value} ${p.stats[0].label}` : "—"}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {shown < count && (
            <button
              onClick={() => setShown((s) => Math.min(count, s + RAIL_PAGE))}
              className="w-full px-4 py-3 text-xs font-semibold text-primary hover:bg-surface-container-high transition-colors"
            >
              Show {Math.min(RAIL_PAGE, count - shown)} more ({count - shown} left)
            </button>
          )}
        </div>
      </div>
    </section>
  );
};

export default LibraryShowcase;
