import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { DEFAULT_THEME, getTheme, THEMES, ThemeId } from "@/lib/themes";
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
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

const STORAGE_KEY = "cc-theme";
const SEASON_KEY = "cc-seasonal";
const HEMISPHERE_KEY = "cc-hemisphere";

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

function applyTheme(id: ThemeId, seasonVars: Record<string, string>) {
  const theme = getTheme(id);
  const root = document.documentElement;
  for (const k of appliedKeys) root.style.removeProperty(k);

  // Theme first, season second: the seasonal pass rewrites a few of the
  // theme's own emphasis tokens in place, so it has to land after them.
  const merged = { ...theme.tokens, ...seasonVars };
  appliedKeys = Object.keys(merged);
  for (const [k, v] of Object.entries(merged)) root.style.setProperty(k, v);

  root.setAttribute("data-theme", id);
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

  useEffect(() => {
    const vars = seasonal ? seasonalTheme(getTheme(themeId), season).vars : {};
    applyTheme(themeId, vars);
    document.documentElement.setAttribute("data-season", seasonal ? season.season : "off");
    try { localStorage.setItem(STORAGE_KEY, themeId); } catch { /* private mode */ }
  }, [themeId, seasonal, season]);

  const setThemeId = useCallback((id: ThemeId) => setThemeIdState(id), []);

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
    }),
    [themeId, setThemeId, season, seasonal, setSeasonal, hemispherePref, setHemispherePref],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
};

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
