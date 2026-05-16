import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import { DEFAULT_THEME, getTheme, THEMES, ThemeId } from "@/lib/themes";

interface ThemeContextValue {
  themeId: ThemeId;
  setThemeId: (id: ThemeId) => void;
  themes: typeof THEMES;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

const STORAGE_KEY = "cc-theme";

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

function applyTheme(id: ThemeId) {
  const theme = getTheme(id);
  const root = document.documentElement;
  for (const [k, v] of Object.entries(theme.tokens)) {
    root.style.setProperty(k, v);
  }
  root.setAttribute("data-theme", id);
  if (theme.fonts) {
    root.style.setProperty("--font-headline", theme.fonts.headline);
    root.style.setProperty("--font-body", theme.fonts.body);
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

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [themeId, setThemeIdState] = useState<ThemeId>(() => readStored());

  useEffect(() => {
    applyTheme(themeId);
    try { localStorage.setItem(STORAGE_KEY, themeId); } catch {}
  }, [themeId]);

  const setThemeId = useCallback((id: ThemeId) => setThemeIdState(id), []);

  return (
    <ThemeContext.Provider value={{ themeId, setThemeId, themes: THEMES }}>
      {children}
    </ThemeContext.Provider>
  );
};

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
