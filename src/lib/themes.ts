// Theme registry. Each theme defines HSL token overrides applied to :root
// via the ThemeProvider, plus optional fonts loaded from Google Fonts.

export type ThemeId = "dexters-lab" | "fruit-stripe" | "aurora" | "desolate-lab";

export interface ThemeDef {
  id: ThemeId;
  name: string;
  description: string;
  swatch: [string, string, string]; // 3 hex preview colors for the dropdown
  fonts?: {
    headline: string; // CSS font-family value (UI headings)
    body: string;
    display?: string; // optional wordmark/hero font; falls back to headline
    label?: string; // optional label/mono font; falls back to body
    googleFontsHref?: string; // <link href=...> to load
  };
  // HSL strings (e.g. "38 100% 83%") for CSS variables
  tokens: Record<string, string>;
}

export const THEMES: ThemeDef[] = [
  {
    id: "dexters-lab",
    name: "Dexter's Laboratory",
    description: "Prismatic Lab — deep violet glass-brutalism with holo-gradient accents.",
    swatch: ["#1a0b2e", "#bd00ff", "#00eefc"],
    fonts: {
      headline: "'Space Grotesk', system-ui, sans-serif",
      body: "'Space Grotesk', system-ui, sans-serif",
      display: "'Space Grotesk', system-ui, sans-serif",
      googleFontsHref:
        "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&display=swap",
    },
    tokens: {
      // Deep violet canvas #1a0b2e
      "--background": "265 61% 11%",
      // On-surface #eddcff
      "--foreground": "270 100% 93%",
      // Card #27183b
      "--card": "265 42% 16%",
      "--card-foreground": "270 100% 93%",
      "--popover": "265 51% 13%",
      "--popover-foreground": "270 100% 93%",
      // Primary #ecb2ff (light prismatic lavender)
      "--primary": "286 100% 85%",
      // On-primary #520071
      "--primary-foreground": "284 100% 22%",
      // Secondary #d3fbff (icy cyan tint)
      "--secondary": "186 100% 91%",
      "--secondary-foreground": "265 61% 11%",
      "--muted": "265 35% 18%",
      // Muted text #d4c0d7
      "--muted-foreground": "291 18% 80%",
      // Accent → magenta pop #e7006e
      "--accent": "331 100% 45%",
      "--accent-foreground": "0 0% 100%",
      // Destructive #ffb4ab
      "--destructive": "5 100% 84%",
      "--destructive-foreground": "356 100% 21%",
      // Deep-violet ink #150629
      "--border": "265 73% 9%",
      "--input": "265 42% 16%",
      // Ring cyan #00eefc
      "--ring": "184 100% 49%",
      "--surface-container-lowest": "265 73% 9%",
      "--surface-container-low": "266 45% 15%",
      "--surface-container": "265 42% 16%",
      "--surface-container-high": "264 35% 21%",
      "--surface-container-highest": "263 28% 25%",
      // Outline #9d8ba0
      "--outline": "292 9% 59%",
      // Outline-variant #514255
      "--outline-variant": "289 13% 30%",
      "--on-surface-variant": "291 18% 80%",
      // Primary-container → vivid violet #bd00ff
      "--primary-container": "284 100% 50%",
      "--on-primary-container": "0 0% 100%",
      "--viewer-bg": "265 61% 11%",
      "--toolbar-bg": "265 73% 9%",
      // Book spine violet
      "--book-spine": "284 100% 50%",
    },
  },
  {
    id: "fruit-stripe",
    name: "Fruit Stripe",
    description: "Paper white & ink black with mid-century rainbow accents.",
    swatch: ["#FBFAF6", "#E63946", "#F4C95D"],
    fonts: {
      headline: "'Inter Tight', 'Inter', system-ui, sans-serif",
      body: "'Inter', system-ui, sans-serif",
      display: "'DM Serif Display', Georgia, serif",
      googleFontsHref:
        "https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=Inter:wght@300;400;500;600;700&family=Inter+Tight:wght@500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap",
    },
    tokens: {
      // Paper White #FBFAF6
      "--background": "48 33% 97%",
      // Ink Black #111111
      "--foreground": "0 0% 7%",
      "--card": "0 0% 100%",
      "--card-foreground": "0 0% 7%",
      "--popover": "0 0% 100%",
      "--popover-foreground": "0 0% 7%",
      // Cherry Red #E63946
      "--primary": "355 78% 56%",
      "--primary-foreground": "0 0% 100%",
      // Stripe Gray #E8E6DF
      "--secondary": "45 17% 89%",
      "--secondary-foreground": "0 0% 7%",
      "--muted": "45 17% 92%",
      // Soft Charcoal #2A2A2A
      "--muted-foreground": "0 0% 16%",
      // Lemon Yellow #F4C95D
      "--accent": "44 86% 66%",
      "--accent-foreground": "0 0% 7%",
      "--destructive": "355 78% 56%",
      "--destructive-foreground": "0 0% 100%",
      // Ink Black borders
      "--border": "0 0% 7%",
      "--input": "0 0% 100%",
      "--ring": "355 78% 56%",
      "--surface-container-lowest": "0 0% 100%",
      "--surface-container-low": "48 33% 97%",
      "--surface-container": "45 17% 95%",
      "--surface-container-high": "45 17% 92%",
      "--surface-container-highest": "45 17% 89%",
      "--outline": "0 0% 7%",
      "--outline-variant": "0 0% 16%",
      "--on-surface-variant": "0 0% 16%",
      "--primary-container": "355 78% 56%",
      "--on-primary-container": "0 0% 100%",
      "--viewer-bg": "48 33% 97%",
      "--toolbar-bg": "0 0% 100%",
      "--book-spine": "355 78% 56%",
    },
  },
  {
    id: "aurora",
    name: "Aurora",
    description: "Liquid-glass slate with a hue-cycling chromatic accent. Apple-Vision-OS frosted glass.",
    swatch: ["#0e1426", "#9bb4ff", "#f3a7c4"],
    fonts: {
      headline: "'Instrument Serif', 'Newsreader', Georgia, serif",
      body: "'Inter', system-ui, sans-serif",
      display: "'Instrument Serif', 'Newsreader', Georgia, serif",
      googleFontsHref:
        "https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Instrument+Serif:ital@0;1&family=JetBrains+Mono:wght@400;500;600&display=swap",
    },
    tokens: {
      // Deep slate-navy canvas
      "--background": "230 35% 7%",
      // Warm cream
      "--foreground": "220 30% 95%",
      "--card": "230 30% 13%",
      "--card-foreground": "220 30% 95%",
      "--popover": "230 35% 11%",
      "--popover-foreground": "220 30% 95%",
      "--primary": "220 30% 95%",
      "--primary-foreground": "230 35% 7%",
      "--secondary": "220 20% 75%",
      "--secondary-foreground": "230 35% 7%",
      "--muted": "230 30% 13%",
      "--muted-foreground": "220 18% 70%",
      // Peach pop (overridden by the @property hue cycle where supported)
      "--accent": "340 85% 70%",
      "--accent-foreground": "230 35% 7%",
      "--destructive": "10 90% 70%",
      "--destructive-foreground": "0 0% 100%",
      "--border": "225 25% 22%",
      "--input": "230 30% 13%",
      "--ring": "340 85% 70%",
      "--surface-container-lowest": "230 35% 5%",
      "--surface-container-low": "230 30% 9%",
      "--surface-container": "230 30% 11%",
      "--surface-container-high": "230 28% 14%",
      "--surface-container-highest": "230 25% 18%",
      "--outline": "225 25% 55%",
      "--outline-variant": "225 25% 22%",
      "--on-surface-variant": "220 22% 80%",
      "--primary-container": "340 85% 70%",
      "--on-primary-container": "230 35% 7%",
      "--viewer-bg": "230 35% 7%",
      "--toolbar-bg": "230 30% 9%",
      "--book-spine": "340 85% 70%",
    },
  },
  {
    id: "desolate-lab",
    name: "Desolate Lab",
    description: "Isolated terminal — light-absorbing blacks, technical grays, one signal red.",
    swatch: ["#131313", "#e5e2e1", "#b0564a"],
    fonts: {
      headline: "'Space Grotesk', system-ui, sans-serif",
      body: "'Space Grotesk', system-ui, sans-serif",
      display: "'Space Grotesk', system-ui, sans-serif",
      label: "'JetBrains Mono', ui-monospace, monospace",
      googleFontsHref:
        "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap",
    },
    tokens: {
      // Base charcoal #131313
      "--background": "0 0% 7%",
      // On-surface #e5e2e1
      "--foreground": "20 7% 89%",
      // Panel #1c1b1b (surface-container-low)
      "--card": "0 3% 11%",
      "--card-foreground": "20 7% 89%",
      "--popover": "0 0% 5%",
      "--popover-foreground": "20 7% 89%",
      // Primary: pure white — reserved for critical text & high-impact triggers
      "--primary": "0 0% 100%",
      "--primary-foreground": "180 5% 11%",
      // Secondary container #494949 → dark steel for the app
      "--secondary": "0 0% 16%",
      "--secondary-foreground": "20 7% 89%",
      "--muted": "0 3% 11%",
      // Outline #8e9192
      "--muted-foreground": "195 2% 56%",
      // Signal red (CRITICAL_DEPLETION) — the only hue in the facility
      "--accent": "8 40% 49%",
      "--accent-foreground": "0 0% 100%",
      // Error #ffb4ab
      "--destructive": "4 100% 84%",
      "--destructive-foreground": "357 100% 21%",
      // 1px structural borders #2a2a2a
      "--border": "0 0% 16%",
      "--input": "0 3% 11%",
      // Focus ring: white
      "--ring": "0 0% 100%",
      // Sharp: every corner in the lab is 0px
      "--radius": "0rem",
      "--surface-container-lowest": "0 0% 5%",
      "--surface-container-low": "0 3% 11%",
      "--surface-container": "0 2% 12%",
      "--surface-container-high": "0 0% 16%",
      "--surface-container-highest": "60 2% 21%",
      "--outline": "195 2% 56%",
      // Outline-variant #444748
      "--outline-variant": "210 3% 27%",
      "--on-surface-variant": "210 4% 78%",
      "--primary-container": "0 0% 89%",
      "--on-primary-container": "180 5% 11%",
      // Secondary container #494949 / on #b9b8b8
      "--secondary-container": "0 0% 29%",
      "--on-secondary-container": "0 0% 73%",
      // Error container #93000a / on #ffdad6
      "--error-container": "353 100% 29%",
      "--on-error-container": "5 100% 92%",
      "--tertiary": "0 0% 100%",
      "--tertiary-container": "20 7% 89%",
      "--primary-fixed-dim": "240 1% 78%",
      "--viewer-bg": "0 0% 7%",
      "--toolbar-bg": "0 0% 5%",
      "--book-spine": "195 2% 56%",
      // Sidebar rail — same tonal ladder
      "--sidebar-background": "0 0% 5%",
      "--sidebar-foreground": "20 7% 89%",
      "--sidebar-primary": "0 0% 100%",
      "--sidebar-primary-foreground": "180 5% 11%",
      "--sidebar-accent": "0 0% 16%",
      "--sidebar-accent-foreground": "20 7% 89%",
      "--sidebar-border": "0 0% 16%",
      "--sidebar-ring": "0 0% 100%",
    },
  },
];

export const DEFAULT_THEME: ThemeId = "dexters-lab";

export function getTheme(id: ThemeId): ThemeDef {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}
