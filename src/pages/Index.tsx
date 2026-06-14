import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useApp } from "@/context/AppContext";
import PdfViewer from "@/components/PdfViewer";
import Library from "@/components/Library";
import ChatPanel from "@/components/ChatPanel";
import WikiPanel from "@/components/WikiPanel";
import WikiLibrary from "@/components/WikiLibrary";
import WikiQuickSwitcher from "@/components/WikiQuickSwitcher";
import VideoTranscript from "@/components/VideoTranscript";
import ThemeSwitcher from "@/components/ThemeSwitcher";
import ConflictNotifier from "@/components/ConflictNotifier";
import StripeBar from "@/components/fruit-stripe/StripeBar";
import PricingDialog, { PlanBadgeButton } from "@/components/PricingDialog";
import SetupWizard from "@/components/SetupWizard";
import AdBanner from "@/components/ads/AdBanner";
import AdInterstitial from "@/components/ads/AdInterstitial";
import WelcomeGate from "@/components/WelcomeGate";
import LoadNeuronDialog from "@/components/LoadNeuronDialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useTheme } from "@/context/ThemeContext";
import { useVisitTracker } from "@/hooks/useVisitTracker";
import { useIsAdmin } from "@/hooks/useIsAdmin";
import { useAutoSleepCycle } from "@/hooks/useAutoSleepCycle";

// Admin-only surface: lazy so regular users never download it.
const AdminPanel = React.lazy(() => import("@/components/AdminPanel"));

// Navigation — Craft Workshop theme
// Workflow reads left-to-right: Vault → Read → Counsel (intake & processing)
//                                  then → Neuron → ​BRAIN (knowledge building)
//
// Adaptive navigation (Material 3 window size classes + Apple HIG + NN/g):
//  - Mobile  (<md):   bottom bar — 3 primary tabs + a "More" sheet
//  - Tablet  (md–lg): left icon rail with ALL destinations visible (M3 medium
//                     class; rail sits on the edge where two-handed tablet
//                     thumbs rest — no hidden "More" overflow on big screens)
//  - Desktop (lg+):   top nav with icon + label buttons and a sliding pill
//                     active indicator (measured offsets + CSS transition)
const tabs = [
  { id: "library" as const, icon: "archive", label: "Vault" },
  { id: "viewer" as const, icon: "auto_stories", label: "Read" },
  { id: "chat" as const, icon: "psychology", label: "Counsel" },
  { id: "wiki" as const, icon: "menu_book", label: "Neuron" },
  { id: "wikis" as const, icon: "collections_bookmark", label: "​BRAIN" },
  { id: "video" as const, icon: "smart_display", label: "Reel" },
];

// The "admin" tab is appended at runtime for admin accounts only. Existing
// tab IDs must never change; adding a new one is safe.
const ADMIN_TAB = { id: "admin" as const, icon: "admin_panel_settings", label: "Admin" };

type NavTabId = (typeof tabs)[number]["id"] | typeof ADMIN_TAB.id;
type NavTab = { id: NavTabId; icon: string; label: string };

const PRIMARY_IDS = ["library", "viewer", "chat"] as const;
const primaryTabs = PRIMARY_IDS.map((id) => tabs.find((t) => t.id === id)!);

// Zone separator index: intake tools (Vault/Read/Counsel) | knowledge building
const ZONE_SPLIT = 3;

/**
 * Desktop top navigation (lg+). Icon + label buttons; a pill slides behind the
 * active item via measured offsets + a CSS transition (no animation library).
 */
const DesktopNav: React.FC<{
  tabs: NavTab[];
  activeTab: string;
  setActiveTab: (id: NavTabId) => void;
  viewerLabel: string;
  neuronLabel: string;
}> = ({ tabs, activeTab, setActiveTab, viewerLabel, neuronLabel }) => {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [pill, setPill] = useState<{ left: number; width: number } | null>(null);

  useLayoutEffect(() => {
    const el = refs.current[activeTab];
    setPill(el ? { left: el.offsetLeft, width: el.offsetWidth } : null);
  }, [activeTab, viewerLabel, neuronLabel]);

  useEffect(() => {
    const measure = () => {
      const el = refs.current[activeTab];
      setPill(el ? { left: el.offsetLeft, width: el.offsetWidth } : null);
    };
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [activeTab]);

  return (
    <nav aria-label="Main navigation" className="relative hidden lg:flex items-center gap-1">
      {pill && (
        <span
          aria-hidden
          className="absolute top-1/2 -translate-y-1/2 h-9 rounded-full bg-accent/10 ring-1 ring-accent/20 transition-all duration-200 ease-out"
          style={{ left: pill.left, width: pill.width }}
        />
      )}
      {tabs.map((tab, index) => {
        const isActive = activeTab === tab.id;
        return (
          <React.Fragment key={tab.id}>
            {index === ZONE_SPLIT && (
              <span className="w-px h-5 mx-2 bg-border/60 flex-shrink-0" aria-hidden />
            )}
            <button
              ref={(el) => {
                refs.current[tab.id] = el;
              }}
              onClick={() => setActiveTab(tab.id)}
              aria-current={isActive ? "page" : undefined}
              className={`relative z-10 flex items-center gap-2 h-9 px-3.5 rounded-full font-body text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/60 ${
                isActive
                  ? "text-accent font-semibold"
                  : "text-secondary font-medium hover:text-primary hover:bg-muted/50"
              }`}
            >
              <span
                className="material-symbols-outlined text-[20px]"
                style={isActive ? { fontVariationSettings: "'FILL' 1" } : undefined}
              >
                {tab.icon}
              </span>
              <span className="truncate max-w-[160px]">
                {tab.id === "viewer" ? viewerLabel : tab.id === "wiki" ? neuronLabel : tab.label}
              </span>
            </button>
          </React.Fragment>
        );
      })}
    </nav>
  );
};

/**
 * Tablet navigation rail (md–lg). Vertically centered, edge-flush, all
 * destinations visible with icon + label, ≥48px touch targets.
 */
const TabletRail: React.FC<{
  tabs: NavTab[];
  activeTab: string;
  setActiveTab: (id: NavTabId) => void;
}> = ({ tabs, activeTab, setActiveTab }) => (
  <nav
    aria-label="Main navigation"
    className="hidden md:flex lg:hidden w-20 shrink-0 flex-col items-center justify-center gap-1 border-r border-border/60 bg-background/85 backdrop-blur-xl py-4"
  >
    {tabs.map((tab, index) => {
      const isActive = activeTab === tab.id;
      return (
        <React.Fragment key={tab.id}>
          {index === ZONE_SPLIT && <span className="my-1.5 h-px w-8 bg-border/70" aria-hidden />}
          <button
            onClick={() => setActiveTab(tab.id)}
            aria-label={tab.label}
            aria-current={isActive ? "page" : undefined}
            className={`group flex w-16 flex-col items-center justify-center gap-0.5 rounded-2xl py-2 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/60 ${
              isActive ? "" : "hover:bg-muted/40"
            }`}
          >
            <span className="relative flex h-8 w-14 items-center justify-center">
              {isActive && <span className="absolute inset-0 rounded-full bg-accent/15" aria-hidden />}
              <span
                className={`material-symbols-outlined relative text-[22px] transition-transform duration-150 group-active:scale-90 ${
                  isActive ? "text-accent" : "text-secondary"
                }`}
                style={isActive ? { fontVariationSettings: "'FILL' 1" } : undefined}
              >
                {tab.icon}
              </span>
            </span>
            <span
              className={`font-body text-[11px] leading-none font-medium ${
                isActive ? "text-accent" : "text-muted-foreground"
              }`}
            >
              {tab.label}
            </span>
          </button>
        </React.Fragment>
      );
    })}
  </nav>
);

const Index: React.FC = () => {
  const { activeTab, setActiveTab, getActiveBook, signOut, activeWiki } = useApp();
  const { isAdmin } = useIsAdmin();
  useAutoSleepCycle();
  const [moreOpen, setMoreOpen] = useState(false);
  const visibleTabs: NavTab[] = isAdmin ? [...tabs, ADMIN_TAB] : tabs;
  const moreTabs = visibleTabs.filter((t) => !PRIMARY_IDS.includes(t.id as any));
  const moreActive = moreTabs.some((t) => t.id === activeTab);
  const activeBook = getActiveBook();
  const { themeId } = useTheme();
  const isFruitStripe = themeId === "fruit-stripe";
  useVisitTracker();

  const viewerLabel = activeBook?.title || tabs.find((t) => t.id === "viewer")!.label;
  // Like the Read tab, the Neuron tab takes on the loaded wiki's name
  // (CSS-truncated in the nav, same as the book title).
  const neuronLabel = activeWiki?.name || tabs.find((t) => t.id === "wiki")!.label;

  return (
    <div className="flex flex-col h-screen bg-background">
      {/* Top App Bar */}
      <header data-app-header className="sticky top-0 w-full flex items-center justify-between px-6 py-4 bg-background/80 backdrop-blur-xl z-50 shadow-[0px_4px_20px_rgba(0,0,0,0.04),0px_10px_40px_rgba(0,0,0,0.08)]">
        <div className="flex items-center gap-3">
          <span className="material-symbols-outlined text-accent text-2xl">menu_book</span>
          <span data-wordmark className="font-display font-bold text-3xl tracking-tight text-primary">​</span>
        </div>

        {/* Desktop nav (lg+) — tablet uses the left rail instead */}
        <DesktopNav tabs={visibleTabs} activeTab={activeTab} setActiveTab={setActiveTab} viewerLabel={viewerLabel} neuronLabel={neuronLabel} />

        <div className="flex items-center gap-2">
          {activeWiki && (
            <button
              onClick={() => setActiveTab("wikis")}
              title={`Active neuron: ${activeWiki.name} — press ⌘K to switch`}
              className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-accent/10 hover:bg-accent/20 transition-colors text-xs font-body font-medium text-accent max-w-[180px] truncate"
            >
              <span
                className="w-2 h-2 rounded-full flex-shrink-0"
                style={{ backgroundColor: activeWiki.cover_color || "#7C3AED" }}
                aria-hidden
              />
              <span className="truncate">{activeWiki.name}</span>
            </button>
          )}
          <PlanBadgeButton />
          <ConflictNotifier />
          <ThemeSwitcher />
          <button
            onClick={signOut}
            className="text-primary hover:bg-primary/10 transition-all duration-200 px-4 py-2 rounded-lg font-body font-medium text-sm active:scale-95"
          >
            Sign out
          </button>
        </div>
      </header>
      {isFruitStripe && <StripeBar thickness={4} />}
      <AdBanner />

      {/* Tablet rail + content */}
      <div className="flex flex-1 overflow-hidden">
        <TabletRail tabs={visibleTabs} activeTab={activeTab} setActiveTab={setActiveTab} />

        <div className="flex-1 overflow-hidden pb-20 md:pb-0">
          {activeTab === "library" ? (
            <Library />
          ) : activeTab === "chat" ? (
            <ChatPanel />
          ) : activeTab === "wiki" ? (
            <WikiPanel />
          ) : activeTab === "wikis" ? (
            <WikiLibrary />
          ) : activeTab === "video" ? (
            <VideoTranscript />
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

      {/* Mobile Bottom Nav */}
      <nav
        data-mobile-nav
        aria-label="Main navigation"
        className="md:hidden fixed bottom-0 inset-x-0 z-50 border-t border-border/60 bg-background/85 backdrop-blur-xl"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <div className="grid grid-cols-4 h-16">
          {primaryTabs.map((tab) => {
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                aria-label={tab.label}
                aria-current={isActive ? "page" : undefined}
                className="group relative flex flex-col items-center justify-center gap-0.5 outline-none focus-visible:ring-2 focus-visible:ring-accent/60 rounded-md"
              >
                <span className="relative flex items-center justify-center h-8 w-14">
                  {isActive && (
                    <span className="absolute inset-0 rounded-full bg-accent/15" aria-hidden />
                  )}
                  <span
                    className={`material-symbols-outlined relative text-[22px] transition-transform duration-150 group-active:scale-90 ${
                      isActive ? "text-accent" : "text-secondary"
                    }`}
                    style={isActive ? { fontVariationSettings: "'FILL' 1" } : undefined}
                  >
                    {tab.icon}
                  </span>
                </span>
                <span
                  className={`font-body text-[11px] leading-none font-medium ${
                    isActive ? "text-accent" : "text-muted-foreground"
                  }`}
                >
                  {tab.label}
                </span>
              </button>
            );
          })}

          <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
            <SheetTrigger asChild>
              <button
                aria-label="More tabs"
                aria-current={moreActive ? "page" : undefined}
                className="group relative flex flex-col items-center justify-center gap-0.5 outline-none focus-visible:ring-2 focus-visible:ring-accent/60 rounded-md"
              >
                <span className="relative flex items-center justify-center h-8 w-14">
                  {moreActive && (
                    <span className="absolute inset-0 rounded-full bg-accent/15" aria-hidden />
                  )}
                  <span
                    className={`material-symbols-outlined relative text-[22px] transition-transform duration-150 group-active:scale-90 ${
                      moreActive ? "text-accent" : "text-secondary"
                    }`}
                    style={moreActive ? { fontVariationSettings: "'FILL' 1" } : undefined}
                  >
                    more_horiz
                  </span>
                </span>
                <span
                  className={`font-body text-[11px] leading-none font-medium ${
                    moreActive ? "text-accent" : "text-muted-foreground"
                  }`}
                >
                  More
                </span>
              </button>
            </SheetTrigger>
            <SheetContent
              side="bottom"
              className="rounded-t-3xl border-t border-border/60 bg-background/95 backdrop-blur-xl pb-[calc(env(safe-area-inset-bottom)+1.5rem)]"
            >
              <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-muted-foreground/30" />
              <SheetHeader className="text-left">
                <SheetTitle className="font-display text-xl">More</SheetTitle>
              </SheetHeader>
              <div className="mt-4 grid grid-cols-3 gap-3">
                {moreTabs.map((tab) => {
                  const isActive = activeTab === tab.id;
                  return (
                    <button
                      key={tab.id}
                      onClick={() => {
                        setActiveTab(tab.id);
                        setMoreOpen(false);
                      }}
                      className={`flex flex-col items-center justify-center gap-2 h-24 rounded-2xl border bg-card transition-colors active:scale-95 ${
                        isActive
                          ? "border-accent/60 ring-1 ring-accent/40 bg-accent/10"
                          : "border-border/60 hover:bg-muted/40"
                      }`}
                    >
                      <span
                        className={`material-symbols-outlined text-[26px] ${
                          isActive ? "text-accent" : "text-secondary"
                        }`}
                        style={isActive ? { fontVariationSettings: "'FILL' 1" } : undefined}
                      >
                        {tab.icon}
                      </span>
                      <span
                        className={`font-body text-[12px] font-medium ${
                          isActive ? "text-accent" : "text-foreground"
                        }`}
                      >
                        {tab.label}
                      </span>
                    </button>
                  );
                })}
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </nav>
      <WikiQuickSwitcher />
      <LoadNeuronDialog />
      <PricingDialog />
      <WelcomeGate />
      <SetupWizard />
      <AdInterstitial />
    </div>
  );
};

export default Index;
