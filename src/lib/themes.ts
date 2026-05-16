// Theme registry. Each theme defines HSL token overrides applied to :root
// via the ThemeProvider, plus optional fonts loaded from Google Fonts.

export type ThemeId = "amber-editorial" | "dexters-lab" | "fruit-stripe";

export interface ThemeDef {
  id: ThemeId;
  name: string;
  description: string;
  swatch: [string, string, string]; // 3 hex preview colors for the dropdown
  fonts?: {
    headline: string; // CSS font-family value (UI headings)
    body: string;
    display?: string; // optional wordmark/hero font; falls back to headline
    googleFontsHref?: string; // <link href=...> to load
  };
  // HSL strings (e.g. "38 100% 83%") for CSS variables
  tokens: Record<string, string>;
}

export const THEMES: ThemeDef[] = [
  {
    id: "amber-editorial",
    name: "Amber Editorial",
    description: "Warm cream & amber on charcoal. Default reading aesthetic.",
    swatch: ["#131313", "#ffe2ab", "#ffb800"],
    fonts: {
      headline: "'Newsreader', Georgia, serif",
      body: "'Inter', system-ui, sans-serif",
      googleFontsHref:
        "https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,600;0,6..72,700;0,6..72,800;1,6..72,400;1,6..72,600;1,6..72,700&display=swap",
    },
    tokens: {
      "--background": "0 0% 7.5%",
      "--foreground": "20 4% 89%",
      "--card": "0 0% 16.5%",
      "--card-foreground": "20 4% 89%",
      "--popover": "0 0% 12.5%",
      "--popover-foreground": "20 4% 89%",
      "--primary": "38 100% 83%",
      "--primary-foreground": "30 100% 13%",
      "--secondary": "58 22% 71%",
      "--secondary-foreground": "60 33% 8%",
      "--muted": "0 0% 16.5%",
      "--muted-foreground": "36 18% 67%",
      "--accent": "43 100% 50%",
      "--accent-foreground": "30 100% 13%",
      "--destructive": "6 75% 84%",
      "--destructive-foreground": "0 100% 2%",
      "--border": "30 15% 20%",
      "--input": "0 0% 16.5%",
      "--ring": "43 100% 50%",
      "--surface-container-lowest": "0 0% 5.5%",
      "--surface-container-low": "0 0% 11%",
      "--surface-container": "0 0% 12.5%",
      "--surface-container-high": "0 0% 16.5%",
      "--surface-container-highest": "0 0% 20.8%",
      "--outline": "30 15% 54%",
      "--outline-variant": "30 20% 25.5%",
      "--on-surface-variant": "36 18% 74%",
      "--primary-container": "43 100% 50%",
      "--on-primary-container": "30 100% 21.5%",
      "--viewer-bg": "0 0% 7.5%",
      "--toolbar-bg": "0 0% 11%",
      "--book-spine": "43 100% 50%",
    },
  },
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
];

export const DEFAULT_THEME: ThemeId = "amber-editorial";

export function getTheme(id: ThemeId): ThemeDef {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}
