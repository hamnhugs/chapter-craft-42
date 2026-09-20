import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BookDocument } from "@/types/library";
import { bookProfile, BookProfile } from "@/lib/bookProfile";
import { categoryColor } from "@/lib/categoryColors";
import { coverTones, seasonalTheme, type CoverTones } from "@/lib/seasonTheme";
import { ART_H, ART_W, coverArt } from "@/lib/coverArt";
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

/** Season names in the order the year angle meets them. Labels only — nothing
 *  here or anywhere in this file asks which one it currently is. */
const QUARTERS = ["Winter", "Spring", "Summer", "Autumn"] as const;

/**
 * The year, as the header's bottom rule.
 *
 * It used to be a 32px dial in the corner, which nobody could read and which
 * explained nothing. The view's colours all come from one angle, so the angle
 * is now the most structural line in the header: the rule under it IS the
 * year, left edge to right, quartered at the solstices and equinoxes, filled
 * from the last turning point to today, with a marker at today — and the
 * header's one light (SeasonAmbience) stands on that marker. Asked why it
 * looks the way it does, the view can point.
 */
const YearBand: React.FC<{ frac: number; label: string }> = ({ frac, label }) => {
  const q = Math.min(3, Math.floor(frac * 4));
  return (
    <div role="img" aria-label={label} className="absolute inset-x-0 bottom-0 h-px bg-outline-variant/25">
      {/* This season so far. */}
      <span
        aria-hidden
        className="absolute bottom-0 h-[2px] rounded-full"
        style={{ left: `${q * 25}%`, width: `${Math.max(0, frac * 100 - q * 25)}%`, background: "hsl(var(--season-glow))", opacity: 0.75 }}
      />
      {QUARTERS.map((name, i) => (
        <span key={name} aria-hidden className="absolute bottom-0" style={{ left: `${i * 25}%` }}>
          <span className="absolute bottom-0 left-0 w-px h-[7px] bg-outline-variant/60" />
          <span
            className={`absolute bottom-[9px] left-[6px] text-[9px] font-semibold uppercase tracking-[0.14em] whitespace-nowrap ${
              i === q ? "text-foreground/70" : "text-on-surface-variant/45"
            }`}
          >
            {name}
          </span>
        </span>
      ))}
      <span
        aria-hidden
        className="absolute -bottom-[4px] w-[9px] h-[9px] -ml-[4.5px] rounded-full ring-2 ring-surface-container-low"
        style={{ left: `${frac * 100}%`, background: "hsl(var(--season-glow))" }}
      />
    </div>
  );
};

const TONE_FALLBACK: CoverTones = { ground: "transparent", figure: "currentColor", accent: "currentColor", ink: "currentColor" };

/**
 * A book's face. A real cover image when there is one; otherwise a generated
 * one (src/lib/coverArt.ts), printed in tones the theme layer supplies.
 *
 * At stage size the generated cover carries its title in a band under the art,
 * the way a paperback series does. At rail size the band stays and the title
 * goes: twenty-eight pixels of type is texture, not a title.
 */
const Cover: React.FC<{
  profile: BookProfile;
  tones: CoverTones;
  titled?: boolean;
  className?: string;
}> = ({ profile, tones, titled = false, className = "" }) => {
  const art = useMemo(() => (profile.coverImageUrl ? null : coverArt(profile.seed)), [profile.coverImageUrl, profile.seed]);
  const t = tones ?? TONE_FALLBACK;
  return (
    <div
      className={`relative overflow-hidden bg-surface-container-highest ${titled ? "rounded-md" : "rounded-[3px]"} ${className}`}
      style={art ? { backgroundColor: t.ground } : undefined}
    >
      {!art ? (
        <img src={profile.coverImageUrl!} alt="" loading="lazy" decoding="async" className="w-full h-full object-cover" />
      ) : (
        <>
          <svg
            viewBox={`0 0 ${ART_W} ${ART_H}`}
            preserveAspectRatio="xMidYMid slice"
            className="absolute inset-x-0 top-0 w-full h-[65%]"
            aria-hidden
          >
            {art.shapes.map((sh, i) =>
              sh.k === "circle" ? <circle key={i} cx={sh.cx} cy={sh.cy} r={sh.r} fill={t[sh.tone]} />
              : sh.k === "rect" ? <rect key={i} x={sh.x} y={sh.y} width={sh.w} height={sh.h} fill={t[sh.tone]} />
              : <path key={i} d={sh.d} fill={t[sh.tone]} />,
            )}
          </svg>
          {/* The rule between art and title band — the series' one constant. */}
          <span aria-hidden className="absolute inset-x-0 top-[65%] h-px" style={{ backgroundColor: t.ink, opacity: 0.22 }} />
          {titled && (
            <span
              className="absolute inset-x-0 bottom-0 h-[35%] px-3.5 pt-3 font-display font-bold text-[0.9rem] leading-[1.15] line-clamp-3"
              // Some themes set display type as a gradient clipped to the text.
              // A cover is printed in its own ink, whatever the page is doing.
              style={{ color: t.ink, WebkitTextFillColor: t.ink, backgroundImage: "none", textShadow: "none", textTransform: "none" }}
            >
              {profile.title}
            </span>
          )}
        </>
      )}
      {/* A spine: one hairline of shade down the binding edge. The only
          concession to the object being a book rather than a tile. */}
      <span aria-hidden className="absolute inset-y-0 left-0 w-[2.5%] min-w-[1px] bg-black/15" />
    </div>
  );
};

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
   * Cover tones, computed on demand and cached.
   *
   * Each one runs a gamut-mapping bisection per tone, so doing all of them up
   * front is real work on a large library — and pointless, since the rail only
   * ever renders a page at a time. Keyed by the book's id hash so re-sorting
   * cannot restain a book, which is the bug the grid's index-based version has.
   *
   * Derived here rather than read back from --season-glow on the document:
   * ThemeContext publishes that variable from an effect, which lands after
   * this render, so a DOM read would take the unseasoned accent on first paint
   * and keep it for the rest of the session.
   */
  const tonesOf = useMemo(() => {
    const theme = getTheme(themeId);
    const bg = hslTripletToOklch(theme.tokens["--background"] ?? "") ?? { l: 0.2, c: 0, h: 0 };
    const accent = hslTripletToOklch(theme.tokens["--accent"] ?? "") ?? { l: 0.7, c: 0.1, h: 0 };
    const glow = seasonal ? seasonalTheme(theme, season).glow : accent;
    const cache = new Map<number, CoverTones>();
    return (seed: number): CoverTones => {
      let hit = cache.get(seed);
      if (!hit) { hit = coverTones(seed, glow, bg.l); cache.set(seed, hit); }
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

  const yearFrac = season.angle / (Math.PI * 2);
  const [seasonName, ...turning] = describeSeason(season).split(" · ");
  const resume = active.progress && active.progress.page > 1 ? active.progress : null;

  return (
    <section
      role="region"
      aria-label="Book profiles"
      onKeyDown={onKeyDown}
      className="relative overflow-hidden rounded-2xl border border-outline-variant/15 bg-surface-container-low"
    >
      {/* ---- Header: where the year is, and where you are in the library ---- */}
      <header className="relative flex items-end gap-4 px-5 sm:px-8 pt-5 pb-9">
        {seasonal && <SeasonAmbience at={yearFrac} />}
        <div className="relative min-w-0">
          <p className="font-display text-xl sm:text-2xl font-bold text-foreground leading-none first-letter:uppercase">
            {seasonal ? seasonName : "Showcase"}
          </p>
          {seasonal && (
            <p className="mt-1.5 text-xs text-on-surface-variant first-letter:uppercase">
              {turning.join(" · ")}
              {season.hemisphere === "south" ? " · southern hemisphere" : ""}
            </p>
          )}
        </div>

        <div className="relative ml-auto flex items-center gap-1">
          <p className="mr-2 text-xs text-on-surface-variant tabular-nums">
            <span className="text-foreground font-semibold">{selectedIndex + 1}</span> of {count}
          </p>
          <button
            onClick={() => select(selectedIndex - 1)}
            aria-label="Previous book"
            className="cc-tap-44 w-9 h-9 rounded-full flex items-center justify-center border border-outline-variant/20 text-on-surface-variant hover:text-foreground hover:border-outline-variant/50 transition-colors"
          >
            <span className="material-symbols-outlined text-lg" aria-hidden>chevron_left</span>
          </button>
          <button
            onClick={() => select(selectedIndex + 1)}
            aria-label="Next book"
            className="cc-tap-44 w-9 h-9 rounded-full flex items-center justify-center border border-outline-variant/20 text-on-surface-variant hover:text-foreground hover:border-outline-variant/50 transition-colors"
          >
            <span className="material-symbols-outlined text-lg" aria-hidden>chevron_right</span>
          </button>
        </div>

        {seasonal
          ? <YearBand frac={yearFrac} label={`${describeSeason(season)}, ${Math.round(yearFrac * 100)}% through the year`} />
          : <div aria-hidden className="absolute inset-x-0 bottom-0 h-px bg-outline-variant/25" />}
      </header>

      <div className="relative grid lg:grid-cols-[minmax(0,1.75fr)_minmax(0,1fr)]">
        {/* ---- Stage: one whole profile ---- */}
        <div className="p-5 sm:p-8 lg:border-r border-outline-variant/15" aria-live="polite" aria-atomic="true">
          <div className="flex flex-col sm:flex-row gap-6 sm:gap-8">
            <Cover
              profile={active}
              tones={tonesOf(active.seed)}
              titled
              className="w-36 sm:w-44 aspect-[3/4] shrink-0 self-start shadow-[0_12px_32px_-12px_rgba(0,0,0,0.55)]"
            />

            <div className="min-w-0 flex-1">
              {/* What kind of thing this is — set as one quiet line, not as a
                  row of pills. Pills are for things you can press. */}
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-on-surface-variant">
                <span>{SOURCE_CHIP[active.source]?.label ?? "Book"}</span>
                {active.category && (
                  <>
                    <span aria-hidden className="w-1 h-1 rounded-full" style={{ backgroundColor: categoryColor(active.category) }} />
                    <span className="text-foreground/80">{active.category}</span>
                  </>
                )}
                {active.shelves.slice(0, 2).map((sh) => (
                  <React.Fragment key={sh}>
                    <span aria-hidden className="w-1 h-1 rounded-full bg-outline-variant" />
                    <span>{sh}</span>
                  </React.Fragment>
                ))}
              </p>

              <h3 className="mt-2.5 font-display text-[1.75rem] sm:text-4xl font-bold text-foreground leading-[1.08] tracking-tight line-clamp-3 text-balance">
                {highlight ? highlight(active.title) : active.title}
              </h3>

              {active.summary ? (
                <p className="mt-4 max-w-[62ch] text-[15px] leading-relaxed text-on-surface-variant line-clamp-4">{active.summary}</p>
              ) : (
                <p className="mt-4 text-sm text-on-surface-variant/70 italic">
                  No summary yet — generating a catalog for this book would add one.
                </p>
              )}
              {active.summary && active.summaryModel && (
                <p className="mt-1.5 text-[10px] uppercase tracking-[0.1em] text-on-surface-variant/55">AI summary · {active.summaryModel}</p>
              )}

              {/* Stats — pages, chapters, how far in you are, when it arrived.
                  A ruled row of figures, the way a title page sets them. */}
              <dl className="mt-6 grid grid-cols-2 sm:flex border-y border-outline-variant/15 sm:divide-x divide-outline-variant/15">
                {active.stats.map((st) => (
                  <div key={st.label} className="flex-1 min-w-0 py-3 pr-4 sm:px-4 sm:first:pl-0">
                    <dd className="font-display text-lg sm:text-xl font-bold text-foreground tabular-nums leading-none whitespace-nowrap">{st.value}</dd>
                    <dt className="mt-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-on-surface-variant">{st.label}</dt>
                    {/* The bar lives in the cell it measures. Run under the
                        whole row it read as an underline on "pages". */}
                    {st.label === "read" && active.progress && (
                      <div
                        className="mt-2 h-[3px] rounded-full bg-outline-variant/25 overflow-hidden"
                        role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={active.progress.pct}
                        aria-label="Reading progress"
                      >
                        <div className="h-full rounded-full bg-primary" style={{ width: `${active.progress.pct}%` }} />
                      </div>
                    )}
                  </div>
                ))}
              </dl>

              {active.highlights.length > 0 && (
                <div className="mt-6">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-on-surface-variant/70">Contents</p>
                  <ol className="mt-2 space-y-1.5">
                    {active.highlights.map((h, i) => (
                      <li key={`${h.name}-${i}`} className="flex gap-3 text-[13px] leading-snug">
                        <span className="w-4 shrink-0 text-right tabular-nums text-on-surface-variant/50">{i + 1}</span>
                        <span className="min-w-0">
                          <span className="text-foreground/90 font-medium">{h.name}</span>
                          {h.gist && <span className="text-on-surface-variant"> — {h.gist}</span>}
                        </span>
                      </li>
                    ))}
                  </ol>
                </div>
              )}

              <div className="mt-7 flex flex-wrap items-center gap-x-5 gap-y-3">
                <button
                  onClick={() => onOpenBook(active.id)}
                  className="inline-flex items-center gap-2 px-6 py-2.5 rounded-full bg-primary text-primary-foreground font-bold text-sm hover:opacity-90 transition-opacity active:scale-[0.98]"
                >
                  {resume ? "Continue" : "Open"}
                  {resume && <span className="font-medium opacity-75 tabular-nums">p. {resume.page}</span>}
                  <span className="material-symbols-outlined text-base" aria-hidden>arrow_forward</span>
                </button>
                {active.tags.length > 0 && (
                  <p className="text-xs text-on-surface-variant/80">
                    {active.tags.slice(0, 5).map((t) => <span key={t} className="mr-2.5">#{t}</span>)}
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* ---- Rail: the library, a page at a time ----
            On a wide screen it is pinned to the stage's height rather than
            given one of its own, so the two columns always end together. */}
        <div className="relative border-t lg:border-t-0 border-outline-variant/15 min-h-[18rem]">
          <div ref={railRef} className="max-h-[24rem] lg:max-h-none lg:absolute lg:inset-0 overflow-y-auto">
            <p className="sticky top-0 z-10 px-5 py-2.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-on-surface-variant/70 bg-surface-container-low/95 backdrop-blur-sm border-b border-outline-variant/10">
              Library
            </p>
            <ul>
              {visible.map((p, i) => {
                const isActive = i === selectedIndex;
                return (
                  <li key={p.id}>
                    <button
                      data-active={isActive}
                      aria-current={isActive ? "true" : undefined}
                      onClick={() => select(i)}
                      onDoubleClick={() => onOpenBook(p.id)}
                      className={`relative w-full text-left flex items-center gap-3.5 px-5 py-2.5 transition-colors ${
                        isActive ? "bg-surface-container-high" : "hover:bg-surface-container-high/50"
                      }`}
                    >
                      {isActive && <span aria-hidden className="absolute left-0 inset-y-2 w-[3px] rounded-r-full bg-primary" />}
                      <Cover profile={p} tones={tonesOf(p.seed)} className="w-[30px] h-10 shrink-0" />
                      <span className="min-w-0 flex-1">
                        <span className={`block text-[13px] leading-snug truncate ${isActive ? "text-foreground font-semibold" : "text-foreground/85"}`}>
                          {highlight ? highlight(p.title) : p.title}
                        </span>
                        <span className="block mt-0.5 text-[11px] text-on-surface-variant truncate">
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
                onClick={() => setShown((sh) => Math.min(count, sh + RAIL_PAGE))}
                className="w-full px-5 py-3 text-xs font-semibold text-primary hover:bg-surface-container-high transition-colors"
              >
                Show {Math.min(RAIL_PAGE, count - shown)} more ({count - shown} left)
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
};

export default LibraryShowcase;
