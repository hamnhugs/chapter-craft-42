// Theme registry. Each theme defines HSL token overrides applied to :root
// via the ThemeProvider, plus optional fonts loaded from Google Fonts.

export type ThemeId = "bookworm-studio" | "dexters-lab" | "fruit-stripe" | "aurora" | "desolate-lab";

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
  /**
   * How much seasonal drift this theme will tolerate, 0..1.
   *
   * The season never introduces a colour of its own — it rotates the theme's
   * own emphasis tokens a bounded distance toward warm or cool (see
   * src/lib/seasonTheme.ts). This number scales that distance, because the
   * themes do not have equal appetite for it. A theme whose identity is a
   * rainbow can swing; a theme whose identity is one signal hue in a grey
   * facility cannot, and lying about that would cost it the thing that makes
   * it itself. Omitted or 0 means the theme opts out entirely.
   */
  seasonalAmplitude?: number;
  // HSL strings (e.g. "38 100% 83%") for CSS variables
  tokens: Record<string, string>;
}

export const THEMES: ThemeDef[] = [
  {
    id: "bookworm-studio",
    name: "Bookworm Studio",
    description: "The house theme — Las Vegas after dark: desert-night indigo, Strip neon, and a live Vegas sky.",
    // The palette is the Las Vegas keyboard theme's: night-sky indigo, the
    // dusk run from purple to orange, and the Strip's marquee neon. A desert
    // year really does swing from cold blue winters to burnt-orange summers,
    // so the accents may lean with it — the indigo night underneath may not.
    seasonalAmplitude: 0.55,
    swatch: ["#0d0b26", "#ff3d9a", "#ffc94d"],
    fonts: {
      headline: "'Bricolage Grotesque', 'Plus Jakarta Sans', system-ui, sans-serif",
      body: "'Plus Jakarta Sans', system-ui, sans-serif",
      // Neon-sign script, used for the wordmark only (see index.css).
      display: "'Yellowtail', 'Bricolage Grotesque', cursive",
      label: "'Plus Jakarta Sans', system-ui, sans-serif",
      googleFontsHref:
        "https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400..800&family=Plus+Jakarta+Sans:wght@300;400;500;600;700&family=Yellowtail&family=JetBrains+Mono:wght@400;500;600&display=swap",
    },
    tokens: {
      // Desert night #0d0b26
      "--background": "244 55% 10%",
      // Marquee-bulb white, a touch of lavender #f4f0ff
      "--foreground": "255 100% 97%",
      // Card #17143a
      "--card": "246 49% 15%",
      "--card-foreground": "255 100% 97%",
      "--popover": "245 52% 13%",
      "--popover-foreground": "255 100% 97%",
      // Marquee gold #ffc94d — the Strip's bulbs
      "--primary": "42 100% 65%",
      "--primary-foreground": "244 55% 10%",
      // Ice-cyan tint #c9f6ff
      "--secondary": "190 100% 89%",
      "--secondary-foreground": "244 55% 10%",
      "--muted": "246 40% 18%",
      // Muted text #c3bde0
      "--muted-foreground": "251 35% 81%",
      // Strip magenta #ff3d9a (ink on it: white fails contrast)
      "--accent": "331 100% 62%",
      "--accent-foreground": "244 63% 7%",
      // Sunset coral #ff8a73
      "--destructive": "9 100% 73%",
      "--destructive-foreground": "244 63% 7%",
      // Hairline #2e2963
      "--border": "245 41% 28%",
      "--input": "246 49% 15%",
      // Neon cyan #2ee6ff
      "--ring": "187 100% 59%",
      "--radius": "0.875rem",
      "--surface-container-lowest": "243 63% 6%",
      "--surface-container-low": "245 50% 12%",
      "--surface-container": "246 49% 15%",
      "--surface-container-high": "245 45% 20%",
      "--surface-container-highest": "245 42% 25%",
      "--outline": "250 22% 60%",
      "--outline-variant": "245 35% 30%",
      "--on-surface-variant": "251 35% 81%",
      // Dusk violet #6a35d9 — deep enough for white text (6.7:1)
      "--primary-container": "263 68% 53%",
      "--on-primary-container": "0 0% 100%",
      "--secondary-container": "246 40% 22%",
      "--on-secondary-container": "190 100% 89%",
      "--error-container": "345 70% 30%",
      "--on-error-container": "9 100% 92%",
      "--tertiary": "187 100% 59%",
      "--tertiary-container": "263 68% 53%",
      "--primary-fixed-dim": "42 100% 65%",
      "--viewer-bg": "244 55% 10%",
      "--toolbar-bg": "243 63% 6%",
      "--book-spine": "331 100% 62%",
      "--sidebar-background": "243 63% 6%",
      "--sidebar-foreground": "255 100% 97%",
      "--sidebar-primary": "42 100% 65%",
      "--sidebar-primary-foreground": "244 55% 10%",
      "--sidebar-accent": "246 49% 15%",
      "--sidebar-accent-foreground": "255 100% 97%",
      "--sidebar-border": "245 41% 22%",
      "--sidebar-ring": "187 100% 59%",
    },
  },
  {
    id: "dexters-lab",
    name: "Dexter's Laboratory",
    description: "Prismatic Lab — a boy genius's secret lab: violet glass-brutalism, holo prisms, and a brainwave monitor that watches you read.",
    // The secret laboratory behind the bookcase: a violet bunker of glass
    // panels in thick cartoon ink, lit by its instruments — cyan scope
    // phosphor, lemon lamps, magenta alarms (see index.css, PRISMATIC LAB).
    // Neon on violet: the magenta can lean coral or plum without stopping
    // being the lab's magenta.
    seasonalAmplitude: 0.7,
    swatch: ["#1a0b2e", "#bd00ff", "#00eefc"],
    fonts: {
      // Cut-corner tech capitals for headings; Space Grotesk stays for reading.
      headline: "'Chakra Petch', 'Space Grotesk', system-ui, sans-serif",
      body: "'Space Grotesk', system-ui, sans-serif",
      // Chunky cartoon title-card capitals, used for the wordmark only.
      display: "'Bungee', 'Chakra Petch', system-ui, sans-serif",
      // Readouts and console labels.
      label: "'JetBrains Mono', ui-monospace, monospace",
      googleFontsHref:
        "https://fonts.googleapis.com/css2?family=Bungee&family=Chakra+Petch:wght@500;600;700&family=Space+Grotesk:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700;800&display=swap",
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
    description: "Five-flavour gum wrapper — paper white, ink black, mid-century candy stripes and a wrapper that turns with the hour.",
    // A mid-century rainbow already contains every season; it takes the full
    // swing without anyone noticing a rule was applied.
    seasonalAmplitude: 1,
    swatch: ["#FBFAF6", "#E63946", "#F4C95D"],
    fonts: {
      // Fraunces with its SOFT axis up reads like 1950s packaging type —
      // chewy, warm, a little wonky (see index.css for the axis settings).
      headline: "'Fraunces', Georgia, serif",
      // Figtree: a friendly geometric that stays calm at reading length.
      body: "'Figtree', 'Inter', system-ui, sans-serif",
      // Shrikhand — fat retro italic, the gum-wrapper wordmark only.
      display: "'Shrikhand', 'Fraunces', Georgia, serif",
      label: "'Figtree', 'Inter', system-ui, sans-serif",
      googleFontsHref:
        "https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght,SOFT,WONK@0,9..144,300..900,0..100,0..1;1,9..144,300..900,0..100,0..1&family=Figtree:ital,wght@0,300..900;1,300..900&family=Shrikhand&family=JetBrains+Mono:wght@400;500;600&display=swap",
    },
    tokens: {
      // Paper White #FBFAF6
      "--background": "48 33% 97%",
      // Ink Black #111111 — 18.1:1 on paper
      "--foreground": "0 0% 7%",
      "--card": "0 0% 100%",
      "--card-foreground": "0 0% 7%",
      "--popover": "0 0% 100%",
      "--popover-foreground": "0 0% 7%",
      // Cherry Ink #C11F2D. The brand cherry #E63946 holds only 4.2:1 under
      // white text and 4.0:1 as text on paper, so the TOKEN is a press-ink
      // deepening of it: white on it 6.0:1, it on paper 5.7:1, on the
      // stripe-gray surface 4.8:1. #E63946 stays for stripes and edges.
      "--primary": "355 72% 44%",
      "--primary-foreground": "0 0% 100%",
      // Stripe Gray #E8E6DF
      "--secondary": "45 17% 89%",
      "--secondary-foreground": "0 0% 7%",
      "--muted": "45 17% 92%",
      // Soft Charcoal #2A2A2A
      "--muted-foreground": "0 0% 16%",
      // Burnt Tangerine #A8470F. The accent is used as TEXT ~40 times
      // (text-accent), and lemon on paper is 1.6:1, so the accent is the
      // mid-century burnt orange: 5.6:1 on paper, white on it 5.9:1. Lemon
      // lives on in the skin (selection, stickers, highlights) as a fill.
      "--accent": "22 84% 36%",
      "--accent-foreground": "0 0% 100%",
      "--destructive": "355 72% 44%",
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
      // Cherry Ink again — white on it 6.0:1 (user bubbles, Add-books fills)
      "--primary-container": "355 72% 44%",
      "--on-primary-container": "0 0% 100%",
      "--secondary-container": "45 60% 90%",
      "--on-secondary-container": "0 0% 7%",
      "--tertiary": "110 44% 35%",
      "--tertiary-container": "105 45% 88%",
      "--primary-fixed-dim": "355 72% 44%",
      "--viewer-bg": "48 33% 97%",
      "--toolbar-bg": "0 0% 100%",
      "--book-spine": "355 78% 56%",
      "--sidebar-background": "48 33% 97%",
      "--sidebar-foreground": "0 0% 7%",
      "--sidebar-primary": "355 72% 44%",
      "--sidebar-primary-foreground": "0 0% 100%",
      "--sidebar-accent": "45 17% 92%",
      "--sidebar-accent-foreground": "0 0% 7%",
      "--sidebar-border": "0 0% 7%",
      "--sidebar-ring": "355 78% 56%",
    },
  },
  {
    id: "aurora",
    name: "Aurora",
    description: "Polar night under liquid glass — frosted slate, Instrument Serif, and live northern lights that follow tonight's sky.",
    // The aurora is the year's own clock: it burns brightest at the equinoxes
    // and the long winter nights. The accent may lean with the season, but
    // only so far — pulled much further warm, oxygen green turns to olive.
    seasonalAmplitude: 0.6,
    swatch: ["#0a0e1a", "#6ff0c0", "#b9a6ff"],
    fonts: {
      headline: "'Instrument Serif', 'Newsreader', Georgia, serif",
      body: "'Instrument Sans', 'Inter', system-ui, sans-serif",
      // The wordmark: Instrument Serif, roman + an aurora-lit italic.
      display: "'Instrument Serif', 'Newsreader', Georgia, serif",
      label: "'Instrument Sans', 'Inter', system-ui, sans-serif",
      googleFontsHref:
        "https://fonts.googleapis.com/css2?family=Instrument+Sans:ital,wdth,wght@0,75..100,400..700;1,75..100,400..700&family=Instrument+Serif:ital@0;1&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500;600&display=swap",
    },
    // Ratios are against the canvas #0a0e19 unless noted.
    tokens: {
      // Polar night #0a0e19
      "--background": "229 43% 7%",
      // Frost white #f2f5fc — 18.6:1
      "--foreground": "222 60% 97%",
      // Frosted slate #141c2f (the skin lays glass over it)
      "--card": "225 40% 13%",
      "--card-foreground": "222 60% 97%",
      "--popover": "226 42% 11%",
      "--popover-foreground": "222 60% 97%",
      // Primary is frost: header icons, the wordmark fallback, light buttons
      "--primary": "222 60% 97%",
      "--primary-foreground": "229 43% 7%",
      // Mist #d4dbeb — inactive nav; 5.2:1 even over a full-storm aurora
      "--secondary": "222 35% 88%",
      "--secondary-foreground": "229 43% 7%",
      "--muted": "226 36% 15%",
      // Muted text #aab5cc — 8.9:1 on the canvas, 7.6:1 on a card
      "--muted-foreground": "221 25% 73%",
      // Oxygen green #6cf0c8 — the aurora's own line (557.7nm). 14:1.
      // Leaned a touch toward teal so the cover tones derived from it
      // (seasonTheme.coverTones, ±48°) run green→teal rather than olive.
      "--accent": "162 81% 68%",
      "--accent-foreground": "229 43% 7%",
      // Coral frost #f98b8b, ink on it 8.4:1
      "--destructive": "0 90% 76%",
      "--destructive-foreground": "229 43% 7%",
      // Hairline #263150
      "--border": "224 35% 23%",
      "--input": "226 42% 11%",
      "--ring": "162 81% 68%",
      "--radius": "1rem",
      "--surface-container-lowest": "229 50% 5%",
      "--surface-container-low": "227 40% 10%",
      "--surface-container": "225 40% 13%",
      "--surface-container-high": "224 36% 17%",
      "--surface-container-highest": "223 32% 21%",
      "--outline": "222 20% 58%",
      "--outline-variant": "224 30% 26%",
      "--on-surface-variant": "221 30% 82%",
      // Deep aurora violet #4a40a1 — white on it 8.6:1
      "--primary-container": "246 43% 44%",
      "--on-primary-container": "0 0% 100%",
      "--secondary-container": "200 45% 18%",
      // Ice cyan #b8f0ff on the container — 11:1
      "--on-secondary-container": "193 100% 86%",
      "--error-container": "350 55% 26%",
      "--on-error-container": "0 100% 92%",
      // Violet #b9a6ff
      "--tertiary": "253 100% 83%",
      "--tertiary-container": "246 43% 44%",
      "--primary-fixed-dim": "162 81% 68%",
      "--viewer-bg": "229 43% 7%",
      "--toolbar-bg": "229 50% 5%",
      "--book-spine": "162 81% 68%",
      "--sidebar-background": "229 50% 5%",
      "--sidebar-foreground": "222 60% 97%",
      "--sidebar-primary": "162 81% 68%",
      "--sidebar-primary-foreground": "229 43% 7%",
      "--sidebar-accent": "225 40% 13%",
      "--sidebar-accent-foreground": "222 60% 97%",
      "--sidebar-border": "224 35% 20%",
      "--sidebar-ring": "162 81% 68%",
    },
  },
  {
    id: "desolate-lab",
    name: "Desolate Lab",
    description: "A sealed research annex — light-absorbing blacks, instrument grays, one signal red, and live facility telemetry.",
    // One hue in the whole facility is the entire premise. It may breathe by a
    // few degrees across the year; it may not become a second colour.
    seasonalAmplitude: 0.18,
    swatch: ["#131313", "#e5e2e1", "#cf6959"],
    // A four-voice type system, each with one job: a stencil face sprayed on
    // the annex door (wordmark only), Space Grotesk for headings, IBM Plex
    // Sans — an engineering-manual face — for anything read at length, and
    // JetBrains Mono for every label, readout and control.
    fonts: {
      headline: "'Space Grotesk', system-ui, sans-serif",
      body: "'IBM Plex Sans', 'Space Grotesk', system-ui, sans-serif",
      display: "'Big Shoulders Stencil Display', 'Space Grotesk', system-ui, sans-serif",
      label: "'JetBrains Mono', ui-monospace, monospace",
      googleFontsHref:
        "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=IBM+Plex+Sans:ital,wght@0,400;0,500;0,600;1,400&family=Big+Shoulders+Stencil+Display:wght@700;800&family=JetBrains+Mono:wght@400;500;600&display=swap",
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
      // Signal red (CRITICAL_DEPLETION) — the only hue in the facility.
      // #cf6959: lifted from the old #af584b (3.8:1) so text-accent clears
      // AA — 5.2:1 on the base, 4.8:1 on a panel. Fills carry charcoal ink
      // (5.2:1); the deep lamp red #9b483b lives in index.css for big fills.
      "--accent": "8 55% 58%",
      "--accent-foreground": "0 0% 7%",
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

export const DEFAULT_THEME: ThemeId = "bookworm-studio";

export function getTheme(id: ThemeId): ThemeDef {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}
