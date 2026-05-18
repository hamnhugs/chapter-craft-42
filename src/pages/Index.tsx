import React, { useState } from "react";
import { useApp } from "@/context/AppContext";
import PdfViewer from "@/components/PdfViewer";
import Library from "@/components/Library";
import ChatPanel from "@/components/ChatPanel";
import WikiPanel from "@/components/WikiPanel";
import WikiLibrary from "@/components/WikiLibrary";
import WikiQuickSwitcher from "@/components/WikiQuickSwitcher";
import VoiceChat from "@/components/VoiceChat";
import AutoChapterize from "@/components/AutoChapterize";
import VideoTranscript from "@/components/VideoTranscript";
import ThemeSwitcher from "@/components/ThemeSwitcher";
import ConflictNotifier from "@/components/ConflictNotifier";
import StripeBar from "@/components/fruit-stripe/StripeBar";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useTheme } from "@/context/ThemeContext";

const tabs = [
  { id: "library" as const, icon: "library_books", label: "Library" },
  { id: "viewer" as const, icon: "auto_stories", label: "Reader" },
  { id: "chapterize" as const, icon: "auto_fix_high", label: "Chapterize" },
  { id: "chat" as const, icon: "forum", label: "Chat" },
  { id: "wiki" as const, icon: "menu_book", label: "Wiki" },
  { id: "wikis" as const, icon: "collections_bookmark", label: "Wikis" },
  { id: "video" as const, icon: "smart_display", label: "Video" },
  { id: "voice" as const, icon: "settings_voice", label: "Voice" },
];

const PRIMARY_IDS = ["library", "viewer", "chapterize", "chat"] as const;
const primaryTabs = PRIMARY_IDS.map((id) => tabs.find((t) => t.id === id)!);
const moreTabs = tabs.filter((t) => !PRIMARY_IDS.includes(t.id as any));

const Index: React.FC = () => {
  const { activeTab, setActiveTab, getActiveBook, signOut, activeWiki } = useApp();
  const [moreOpen, setMoreOpen] = useState(false);
  const moreActive = moreTabs.some((t) => t.id === activeTab);
  const activeBook = getActiveBook();
  const { themeId } = useTheme();
  const isFruitStripe = themeId === "fruit-stripe";

  return (
    <div className="flex flex-col h-screen bg-background">
      {/* Top App Bar */}
      <header data-app-header className="sticky top-0 w-full flex items-center justify-between px-6 py-4 bg-background/80 backdrop-blur-xl z-50 shadow-[0px_4px_20px_rgba(0,0,0,0.04),0px_10px_40px_rgba(0,0,0,0.08)]">
        <div className="flex items-center gap-3">
          <span className="material-symbols-outlined text-accent text-2xl">menu_book</span>
          <span data-wordmark className="font-display font-bold text-3xl tracking-tight text-primary">​</span>
        </div>

        {/* Desktop nav */}
        <nav className="hidden md:flex items-center gap-8">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`font-body font-medium text-sm transition-colors ${
                activeTab === tab.id
                  ? "text-accent border-b-2 border-accent pb-1"
                  : "text-secondary hover:text-primary"
              }`}
            >
              {tab.id === "viewer" && activeBook ? activeBook.title : tab.label}
            </button>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          {activeWiki && (
            <button
              onClick={() => setActiveTab("wikis")}
              title={`Active wiki: ${activeWiki.name} — press ⌘K to switch`}
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

      {/* Content */}
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
        ) : activeTab === "voice" ? (
          <VoiceChat />
        ) : activeTab === "chapterize" ? (
          <AutoChapterize />
        ) : (
          <PdfViewer />
        )}
      </div>

      {/* Mobile Bottom Nav */}
      <nav
        data-mobile-nav
        className="md:hidden fixed bottom-0 inset-x-0 z-50 border-t border-border/60 bg-background/85 backdrop-blur-xl"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <div className="grid grid-cols-5 h-16">
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
    </div>
  );
};

export default Index;
