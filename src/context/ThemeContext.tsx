import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { DEFAULT_THEME, faceTokens, getTheme, THEMES, ThemeId } from "@/lib/themes";
import { hoursNow } from "@/components/themes/scriptoriumHours";
import { detectHemisphere, Hemisphere, seasonAt, SeasonState } from "@/lib/season";
import { seasonalTheme } from "@/lib/seasonTheme";

/** "auto" infers the hemisphere from the clock; the other two override it. */
export type HemispherePref = "auto" | Hemisphere;

interface ThemeContextValue {
  themeId: ThemeId;
  setThemeId: (id: ThemeId) => void;
  themes: typeof THEMES;
  /** Where the year is, recomputed as the date rolls over. */
  season: SeasonState;
  /** Whether the season is allowed to tint the theme at all. */
  seasonal: boolean;
  setSeasonal: (on: boolean) => void;
  hemispherePref: HemispherePref;
  setHemispherePref: (p: HemispherePref) => void;
  /** The face a living theme is wearing now; null on a theme with one face. */
  face: string | null;
  /** "auto" follows the theme's clock; anything else pins that face. */
  facePref: string;
  setFacePref: (p: string) => void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

const STORAGE_KEY = "cc-theme";
const SEASON_KEY = "cc-seasonal";
const HEMISPHERE_KEY = "cc-hemisphere";
/** Per theme, so pinning the candle in one living theme says nothing about another. */
const faceKey = (id: ThemeId) => `cc-face:${id}`;

function loadGoogleFont(href: string) {
  if (!href) return;
  const id = "theme-google-font";
  let link = document.getElementById(id) as HTMLLinkElement | null;
  if (!link) {
    link = document.createElement("link");
    link.id = id;
    link.rel = "stylesheet";
    document.head.appendChild(link);
  }
  if (link.href !== href) link.href = href;
}

// Tracks inline properties set by the previous theme so switching themes
// never leaves stale overrides (e.g. desolate-lab's --radius: 0) behind.
// Seasonal variables go through the same bookkeeping, which is what lets the
// season be switched off cleanly: drop its keys and the theme's own token
// values, written in the same pass, are simply what remains.
let appliedKeys: string[] = [];

function applyTheme(id: ThemeId, face: string | null, extraVars: Record<string, string>) {
  const theme = getTheme(id);
  const root = document.documentElement;
  for (const k of appliedKeys) root.style.removeProperty(k);

  // Theme first, then its face, season and live variables last: the seasonal
  // pass rewrites a few of the theme's own emphasis tokens in place, so it
  // has to land after them.
  const merged = { ...faceTokens(theme, face), ...extraVars };
  appliedKeys = Object.keys(merged);
  for (const [k, v] of Object.entries(merged)) root.style.setProperty(k, v);

  root.setAttribute("data-theme", id);
  if (face) root.setAttribute("data-face", face);
  else root.removeAttribute("data-face");
  if (theme.fonts) {
    root.style.setProperty("--font-headline", theme.fonts.headline);
    root.style.setProperty("--font-body", theme.fonts.body);
    root.style.setProperty("--font-display", theme.fonts.display ?? theme.fonts.headline);
    root.style.setProperty("--font-label", theme.fonts.label ?? theme.fonts.body);
    if (theme.fonts.googleFontsHref) loadGoogleFont(theme.fonts.googleFontsHref);
  }
}

function readStored(): ThemeId {
  if (typeof window === "undefined") return DEFAULT_THEME;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw && THEMES.some((t) => t.id === raw)) return raw as ThemeId;
  // Migrate legacy "dark"/"light" values
  return DEFAULT_THEME;
}

function readSeasonal(): boolean {
  if (typeof window === "undefined") return true;
  // On by default. The effect is bounded by construction — it cannot move
  // lightness, so it cannot hurt legibility — and a feature nobody ever sees
  // because it shipped switched off is not a feature.
  return localStorage.getItem(SEASON_KEY) !== "off";
}

function readFacePref(id: ThemeId): string {
  const faces = getTheme(id).living?.faces;
  if (!faces || typeof window === "undefined") return "auto";
  const raw = localStorage.getItem(faceKey(id));
  return raw && raw in faces ? raw : "auto";
}

/**
 * Run a change to the look of the whole app as one view transition: the new
 * look opens outward from wherever the reader last pressed, like light let
 * into a room (index.css, "theme turn"). `change` must commit synchronously,
 * hence the flushSync at the call sites. Without the API, or with reduced
 * motion, it is just the change.
 */
let lastPress = { x: 0.5, y: 0.25 };
function turn(change: () => void) {
  const doc = document as Document & {
    startViewTransition?: (cb: () => void) => { finished: Promise<void> };
  };
  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  if (typeof doc.startViewTransition !== "function" || reduceMotion) { change(); return; }
  const root = document.documentElement;
  root.style.setProperty("--turn-x", `${(lastPress.x * 100).toFixed(1)}%`);
  root.style.setProperty("--turn-y", `${(lastPress.y * 100).toFixed(1)}%`);
  root.classList.add("cc-theme-turn");
  const done = () => root.classList.remove("cc-theme-turn");
  doc.startViewTransition(() => flushSync(change)).finished.then(done, done);
}

function readHemisphere(): HemispherePref {
  if (typeof window === "undefined") return "auto";
  const raw = localStorage.getItem(HEMISPHERE_KEY);
  return raw === "north" || raw === "south" ? raw : "auto";
}

/** ms until the next local midnight, clamped so a bad clock cannot spin us. */
function msUntilNextLocalMidnight(now: Date): number {
  const next = new Date(now);
  next.setHours(24, 0, 0, 0);
  const delta = next.getTime() - now.getTime();
  return Math.min(Math.max(delta, 1000), 86_400_000);
}

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [themeId, setThemeIdState] = useState<ThemeId>(() => readStored());
  const [seasonal, setSeasonalState] = useState<boolean>(() => readSeasonal());
  const [hemispherePref, setHemispherePrefState] = useState<HemispherePref>(() => readHemisphere());
  // The instant the season is computed from. Advanced at local midnight and
  // whenever the tab comes back, because a laptop that slept through three
  // weeks should not still be rendering the day it was closed.
  const [now, setNow] = useState<number>(() => Date.now());
  const [facePref, setFacePrefState] = useState<string>(() => readFacePref(readStored()));
  // A living theme's own clock, by the minute. Kept apart from `now` so the
  // five themes that have one face never re-render on it.
  const [minute, setMinute] = useState<number>(() => hoursNow().getTime());

  const hemisphere: Hemisphere = useMemo(
    () => (hemispherePref === "auto" ? detectHemisphere(new Date(now)) : hemispherePref),
    [hemispherePref, now],
  );

  const season = useMemo(() => seasonAt(now, hemisphere), [now, hemisphere]);

  useEffect(() => {
    const tick = () => setNow(Date.now());
    let timer = window.setTimeout(function roll() {
      tick();
      timer = window.setTimeout(roll, msUntilNextLocalMidnight(new Date()));
    }, msUntilNextLocalMidnight(new Date()));
    const onVisible = () => { if (document.visibilityState === "visible") tick(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const living = getTheme(themeId).living;
  const live = useMemo(
    () => (living ? living.at(new Date(minute), hemisphere) : null),
    [living, minute, hemisphere],
  );
  const face = live ? (facePref === "auto" ? live.face : facePref) : null;

  // Where the reader last pressed, as a fraction of the viewport: the point a
  // theme turn opens from.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      lastPress = { x: e.clientX / window.innerWidth, y: e.clientY / window.innerHeight };
    };
    window.addEventListener("pointerdown", onDown, { capture: true, passive: true });
    return () => window.removeEventListener("pointerdown", onDown, { capture: true });
  }, []);

  // The minute hand. If the coming minute changes the face — the candle being
  // lit at dusk — the change is made as a turn, so it is seen to happen.
  const faceRef = useRef(face);
  faceRef.current = face;
  useEffect(() => {
    if (!living) return;
    const tick = () => {
      const t = hoursNow();
      const next = living.at(t, hemisphere).face;
      const flips = facePref === "auto" && next !== faceRef.current && document.visibilityState === "visible";
      if (flips) turn(() => setMinute(t.getTime()));
      else setMinute(t.getTime());
    };
    tick();
    const id = window.setInterval(tick, 60_000);
    const onVisible = () => { if (document.visibilityState === "visible") tick(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [living, hemisphere, facePref]);

  // Layout effect, not a passive one: a theme turn snapshots the page the
  // moment its callback returns, so the tokens have to be on :root by then.
  useLayoutEffect(() => {
    const theme = getTheme(themeId);
    // The season tints the face actually showing, not the base one.
    const worn = { ...theme, tokens: faceTokens(theme, face) };
    const vars = seasonal ? seasonalTheme(worn, season).vars : {};
    applyTheme(themeId, face, { ...vars, ...(live?.vars ?? {}) });
    document.documentElement.setAttribute("data-season", seasonal ? season.season : "off");
    try { localStorage.setItem(STORAGE_KEY, themeId); } catch { /* private mode */ }
  }, [themeId, face, live, seasonal, season]);

  const setThemeId = useCallback((id: ThemeId) => {
    turn(() => {
      setThemeIdState(id);
      setFacePrefState(readFacePref(id));
    });
  }, []);

  const setFacePref = useCallback((p: string) => {
    turn(() => setFacePrefState(p));
    try { localStorage.setItem(faceKey(themeId), p); } catch { /* private mode */ }
  }, [themeId]);

  const setSeasonal = useCallback((on: boolean) => {
    setSeasonalState(on);
    try { localStorage.setItem(SEASON_KEY, on ? "on" : "off"); } catch { /* private mode */ }
  }, []);

  const setHemispherePref = useCallback((p: HemispherePref) => {
    setHemispherePrefState(p);
    try { localStorage.setItem(HEMISPHERE_KEY, p); } catch { /* private mode */ }
  }, []);

  const value = useMemo(
    () => ({
      themeId, setThemeId, themes: THEMES,
      season, seasonal, setSeasonal, hemispherePref, setHemispherePref,
      face, facePref, setFacePref,
    }),
    [themeId, setThemeId, season, seasonal, setSeasonal, hemispherePref, setHemispherePref, face, facePref, setFacePref],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
