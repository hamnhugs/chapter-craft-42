import React from "react";
import { useApp } from "@/context/AppContext";
import PdfViewer from "@/components/PdfViewer";
import Library from "@/components/Library";
import ChatPanel from "@/components/ChatPanel";
import WikiPanel from "@/components/WikiPanel";
import VoiceChat from "@/components/VoiceChat";

const tabs = [
  { id: "library" as const, icon: "library_books", label: "Library" },
  { id: "viewer" as const, icon: "auto_stories", label: "Reader" },
  { id: "chat" as const, icon: "forum", label: "Chat" },
  { id: "wiki" as const, icon: "menu_book", label: "Wiki" },
  { id: "voice" as const, icon: "settings_voice", label: "Voice" },
];

const Index: React.FC = () => {
  const { activeTab, setActiveTab, getActiveBook, signOut } = useApp();
  const activeBook = getActiveBook();

  return (
    <div className="flex flex-col h-screen bg-background">
      {/* Top App Bar */}
      <header className="sticky top-0 w-full flex items-center justify-between px-6 py-4 bg-background/80 backdrop-blur-xl z-50 shadow-[0px_4px_20px_rgba(0,0,0,0.04),0px_10px_40px_rgba(0,0,0,0.08)]">
        <div className="flex items-center gap-3">
          <span className="material-symbols-outlined text-accent text-2xl">menu_book</span>
          <span className="font-headline font-bold text-3xl tracking-tight text-primary">Chapter Craft</span>
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

        <button
          onClick={signOut}
          className="text-primary hover:bg-primary/10 transition-all duration-200 px-4 py-2 rounded-lg font-body font-medium text-sm active:scale-95"
        >
          Sign out
        </button>
      </header>

      {/* Content */}
      <div className="flex-1 overflow-hidden pb-20 md:pb-0">
        {activeTab === "library" ? (
          <Library />
        ) : activeTab === "chat" ? (
          <ChatPanel />
        ) : activeTab === "wiki" ? (
          <WikiPanel />
        ) : activeTab === "voice" ? (
          <VoiceChat />
        ) : (
          <PdfViewer />
        )}
      </div>

      {/* Mobile Bottom Nav */}
      <nav className="md:hidden fixed bottom-0 w-full z-50 flex justify-around items-center px-4 pb-6 pt-2 bg-background/70 backdrop-blur-md shadow-2xl shadow-black rounded-t-2xl">
        {tabs.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex flex-col items-center justify-center p-2 transition-all duration-200 ${
                isActive
                  ? "bg-accent text-on-primary-container rounded-xl scale-105"
                  : "text-secondary hover:text-primary active:scale-90"
              }`}
            >
              <span
                className="material-symbols-outlined"
                style={isActive ? { fontVariationSettings: "'FILL' 1" } : undefined}
              >
                {tab.icon}
              </span>
              <span className="font-body text-[10px] font-semibold uppercase tracking-widest mt-1">
                {tab.label}
              </span>
            </button>
          );
        })}
      </nav>
    </div>
  );
};

export default Index;
