import React from "react";
import { BookOpen, Library as LibraryIcon, LogOut } from "lucide-react";
import { useApp } from "@/context/AppContext";
import PdfViewer from "@/components/PdfViewer";
import Library from "@/components/Library";

const Index: React.FC = () => {
  const { activeTab, setActiveTab, getActiveBook, signOut } = useApp();
  const activeBook = getActiveBook();

  return (
    <div className="flex flex-col h-screen bg-background">
      {/* Tab bar */}
      <div className="flex items-center border-b border-border bg-viewer-toolbar px-2">
        <TabButton
          active={activeTab === "library"}
          onClick={() => setActiveTab("library")}
          icon={<LibraryIcon className="w-4 h-4" />}
          label="Library"
        />
        <TabButton
          active={activeTab === "viewer"}
          onClick={() => setActiveTab("viewer")}
          icon={<BookOpen className="w-4 h-4" />}
          label={activeBook ? activeBook.title : "Reader"}
        />
        <div className="ml-auto">
          <button onClick={signOut} className="flex items-center gap-1.5 px-3 py-2 text-xs text-muted-foreground hover:text-foreground transition-colors" title="Sign out">
            <LogOut className="w-3.5 h-3.5" />
            <span>Sign out</span>
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {activeTab === "library" ? <Library /> : <PdfViewer />}
      </div>
    </div>
  );
};

const TabButton: React.FC<{
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}> = ({ active, onClick, icon, label }) => (
  <button
    onClick={onClick}
    className={`flex items-center gap-2 px-4 py-3 text-sm font-body font-medium border-b-2 transition-colors max-w-[200px] truncate ${
      active
        ? "border-primary text-foreground"
        : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"
    }`}
  >
    {icon}
    <span className="truncate">{label}</span>
  </button>
);

export default Index;
