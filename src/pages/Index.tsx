import React, { useEffect } from "react";
import { useApp } from "@/context/AppContext";
import PdfViewer from "@/components/PdfViewer";
import Library from "@/components/Library";
import ChatPanel from "@/components/ChatPanel";
import WikiPanel from "@/components/WikiPanel";
import WikiLibrary from "@/components/WikiLibrary";
import WikiQuickSwitcher from "@/components/WikiQuickSwitcher";
import ThemeSwitcher from "@/components/ThemeSwitcher";
import ConflictNotifier from "@/components/ConflictNotifier";
import StripeBar from "@/components/fruit-stripe/StripeBar";
import HeaderArt from "@/components/themes/HeaderArt";
import PricingDialog, { PlanBadgeButton } from "@/components/PricingDialog";
import SetupWizard from "@/components/SetupWizard";
import AdBanner from "@/components/ads/AdBanner";
import AdInterstitial from "@/components/ads/AdInterstitial";
import WelcomeGate from "@/components/WelcomeGate";
import LoadNeuronDialog from "@/components/LoadNeuronDialog";
import ChainDialog from "@/components/ChainDialog";
import { useTheme } from "@/context/ThemeContext";
import { useVisitTracker } from "@/hooks/useVisitTracker";
import { useIsAdmin } from "@/hooks/useIsAdmin";
import { useAutoSleepCycle } from "@/hooks/useAutoSleepCycle";

// Admin-only surface: lazy so regular users never download it.
const AdminPanel = React.lazy(() => import("@/components/AdminPanel"));
// Settings: visited rarely (a small minority of users ever change settings —
// Nielsen's "power of defaults"), so its chunk shouldn't weigh down startup.
const SettingsPanel = React.lazy(() => import("@/components/SettingsPanel"));

// Navigation — the arena shell.
//
// One bottom dock on every screen size: four big tabs — the things you
// collect, home (Counsel), the reader and the things you make. It replaced three different navigations (a desktop top bar,
// a tablet rail, a phone bar with a "More" sheet) — one layout to learn, the
// same place for everything on every device.
//
// Settings and Admin are not destinations you visit all day, so they live in
// the top bar instead of taking a dock slot.
//
// Existing tab IDs must never change.
const DOCK_TABS = [
  { id: "library" as const, icon: "style", label: "Library" },
  { id: "chat" as const, icon: "psychology", label: "Counsel" },
  { id: "viewer" as const, icon: "auto_stories", label: "Read" },
  // "wiki" (one open notebook) and "wikis" (the list) are two views of ONE
  // destination: the dock shows only "Notebooks" and lights up for both.
  { id: "wikis" as const, icon: "menu_book", label: "Notebooks" },
];

type DockTabId = (typeof DOCK_TABS)[number]["id"];

/**
 * The dock. It keeps the `data-mobile-nav` hook and the active-pill markup of
 * the phone bar it grew out of, because that is what every theme's own
 * styling in index.css targets — so each theme dresses the dock for free.
 * Geometry (height, the active tab's lift, the short-window layout) is in
 * styles/arena.css.
 */
const ArenaDock: React.FC<{
  activeTab: string;
  onSelect: (id: DockTabId) => void;
}> = ({ activeTab, onSelect }) => {
  // Everything that must clear the dock (the page, floating reader chips,
  // toasts) reads its height from --cc-dock-h, which only exists while a
  // dock is on screen.
  useEffect(() => {
    document.documentElement.classList.add("cc-has-dock");
    return () => document.documentElement.classList.remove("cc-has-dock");
  }, []);
  return (
    <nav
      data-mobile-nav
      aria-label="Main navigation"
      className="cc-dock fixed bottom-0 inset-x-0 z-50 border-t border-border/60 bg-background/85 backdrop-blur-xl"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <div className="cc-dock-row mx-auto flex max-w-3xl items-stretch px-1">
        {DOCK_TABS.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => onSelect(tab.id)}
              aria-label={tab.label}
              aria-current={isActive ? "page" : undefined}
              className="cc-dock-tab group"
            >
              <span className="cc-dock-icon relative flex items-center justify-center h-8 w-14">
                {isActive && <span className="absolute inset-0 rounded-full bg-accent/15" aria-hidden />}
                <span
                  className={`material-symbols-outlined relative text-[22px] ${isActive ? "text-accent" : "text-secondary"}`}
                  style={isActive ? { fontVariationSettings: "'FILL' 1" } : undefined}
                >
                  {tab.icon}
                </span>
              </span>
              <span
                className={`cc-dock-label font-body text-[11px] leading-none font-medium ${
                  isActive ? "text-accent" : "text-muted-foreground"
                }`}
              >
                {tab.label}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
};

const Index: React.FC = () => {
  const { activeTab, setActiveTab, signOut, activeWiki, activeWikis } = useApp();
  const { isAdmin } = useIsAdmin();
  useAutoSleepCycle();
  // One "Notebooks" destination: it lights up for the list and for an open
  // notebook, and always lands on the list.
  const dockActiveTab = activeTab === "wiki" ? "wikis" : activeTab;
  const { themeId } = useTheme();
  const isFruitStripe = themeId === "fruit-stripe";
  useVisitTracker();

  const barButton =
    "text-primary hover:bg-primary/10 transition-all duration-200 p-2 rounded-lg active:scale-95 flex items-center";

  return (
    <div className="flex flex-col h-app bg-background">
      {/* Top App Bar */}
      <header data-app-header className="cc-app-bar sticky top-0 w-full flex items-center justify-between gap-2 px-3 sm:px-6 py-2 bg-background/80 backdrop-blur-xl z-50 shadow-[0px_4px_20px_rgba(0,0,0,0.04),0px_10px_40px_rgba(0,0,0,0.08)]">
        {/* Each theme's living backdrop behind the bar's contents (Bookworm Studio: the live Vegas sky). */}
        <HeaderArt themeId={themeId} />
        {/* The wordmark gives way first: on a narrow phone it clips rather
            than sliding under the buttons. */}
        <div className="flex items-center gap-3 min-w-0 overflow-hidden">
          <span className="material-symbols-outlined text-accent text-2xl shrink-0">menu_book</span>
          <span data-wordmark className="font-display font-bold text-2xl tracking-tight text-primary">​</span>
        </div>

        <div className="flex items-center gap-1 sm:gap-2 shrink-0">
          {activeWiki && (
            <button
              onClick={() => setActiveTab("wiki")}
              title={
                activeWikis.length > 1
                  ? `Counsel is using: ${activeWikis.map((w) => w.name).join(", ")} — press ⌘K to switch`
                  : `Counsel is using: ${activeWiki.name} — press ⌘K to switch`
              }
              className="hidden md:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-accent/10 hover:bg-accent/20 transition-colors text-xs font-body font-medium text-accent max-w-[200px] truncate"
            >
              {/* One dot per loaded neuron, overlapping — primary first. */}
              <span className="flex items-center flex-shrink-0" aria-hidden>
                {(activeWikis.length > 0 ? activeWikis : [activeWiki]).slice(0, 5).map((w, i) => (
                  <span
                    key={w.id}
                    className="w-2 h-2 rounded-full ring-1 ring-background"
                    style={{ backgroundColor: w.cover_color || "#7C3AED", marginLeft: i === 0 ? 0 : -3 }}
                  />
                ))}
              </span>
              <span className="truncate">{activeWiki.name}</span>
              {activeWikis.length > 1 && (
                <span className="flex-shrink-0 font-bold">+{activeWikis.length - 1}</span>
              )}
            </button>
          )}
          <PlanBadgeButton />
          <ConflictNotifier />
          {/* Themes are also in Settings → Appearance; the bar drops the
              shortcut where there is no room for it. */}
          <span className="hidden sm:contents"><ThemeSwitcher /></span>
          {isAdmin && (
            <button
              onClick={() => setActiveTab("admin")}
              aria-label="Admin"
              title="Admin"
              aria-current={activeTab === "admin" ? "page" : undefined}
              className={barButton}
            >
              <span className="material-symbols-outlined text-[22px]" style={activeTab === "admin" ? { fontVariationSettings: "'FILL' 1" } : undefined}>admin_panel_settings</span>
            </button>
          )}
          <button
            onClick={() => setActiveTab("settings")}
            aria-label="Settings"
            title="Settings"
            aria-current={activeTab === "settings" ? "page" : undefined}
            className={barButton}
          >
            <span className="material-symbols-outlined text-[22px]" style={activeTab === "settings" ? { fontVariationSettings: "'FILL' 1" } : undefined}>settings</span>
          </button>
          <button onClick={signOut} aria-label="Sign out" title="Sign out" className={barButton}>
            <span className="material-symbols-outlined text-[22px]">logout</span>
          </button>
        </div>
      </header>
      {isFruitStripe && <StripeBar thickness={4} />}
      <AdBanner />

      {/* The page. `cc-dock-clearance` pads it by the dock's real height plus
          the home-indicator inset (styles/arena.css) — a flat padding once
          covered only the bar and let a phone's home indicator hide the
          bottom of the chat composer under a bar that swallowed the taps. */}
      <div className="flex flex-1 overflow-hidden">
        <div className="flex-1 overflow-hidden cc-dock-clearance">
          {activeTab === "library" ? (
            <Library />
          ) : activeTab === "chat" ? (
            <ChatPanel />
          ) : activeTab === "wiki" ? (
            <WikiPanel />
          ) : activeTab === "wikis" ? (
            <WikiLibrary />
          ) : activeTab === "settings" ? (
            <React.Suspense
              fallback={
                <div className="flex items-center justify-center h-full text-muted-foreground">
                  Loading…
                </div>
              }
            >
              <SettingsPanel />
            </React.Suspense>
          ) : activeTab === "admin" ? (
            <React.Suspense
              fallback={
                <div className="flex items-center justify-center h-full text-muted-foreground">
                  Loading…
                </div>
              }
            >
              <AdminPanel />
            </React.Suspense>
          ) : (
            <PdfViewer />
          )}
        </div>
      </div>

      <ArenaDock activeTab={dockActiveTab} onSelect={setActiveTab} />
      <WikiQuickSwitcher />
      <LoadNeuronDialog />
      <ChainDialog />
      <PricingDialog />
      <WelcomeGate />
      <SetupWizard />
      <AdInterstitial />
    </div>
  );
};

export default Index;
