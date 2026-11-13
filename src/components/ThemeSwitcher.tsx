import React from "react";
import { Check, Palette } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTheme } from "@/context/ThemeContext";

const ThemeSwitcher: React.FC = () => {
  const { themeId, setThemeId, themes, face, facePref, setFacePref } = useTheme();
  const living = themes.find((t) => t.id === themeId)?.living;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          aria-label="Choose theme"
          title="Choose theme"
          className="text-primary hover:bg-primary/10 transition-all duration-200 p-2 rounded-lg active:scale-95 flex items-center gap-2"
        >
          <Palette className="w-5 h-5" />
        </button>
      </DropdownMenuTrigger>
      {/* Six themes outgrow a short window (956x506 is a real one): the menu
          takes the height Radix measures as free and scrolls inside it. */}
      <DropdownMenuContent align="end" className="w-80 max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto">
        <DropdownMenuLabel>Theme</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {/* A living theme has faces; this is where one is pinned. */}
        {living && (
          <>
            <div role="radiogroup" aria-label="Light" className="flex gap-1 p-1">
              {[["auto", living.autoLabel] as const, ...Object.entries(living.faces).map(([id, f]) => [id, f.label] as const)].map(([id, label]) => {
                const on = facePref === id;
                return (
                  <button
                    key={id}
                    data-no-sticker
                    role="radio"
                    aria-checked={on}
                    onClick={() => setFacePref(id)}
                    className={`flex-1 px-2 py-1.5 rounded-md text-xs font-medium transition-colors ${
                      on ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-surface-container-high"
                    }`}
                  >
                    {label}
                    {id === "auto" && on && face && <span className="opacity-70"> · {living.faces[face]?.label.toLowerCase()}</span>}
                  </button>
                );
              })}
            </div>
            <DropdownMenuSeparator />
          </>
        )}
        {themes.map((t) => {
          const active = t.id === themeId;
          return (
            <DropdownMenuItem
              key={t.id}
              onSelect={(e) => {
                e.preventDefault();
                setThemeId(t.id);
              }}
              className="flex items-start gap-3 py-2 cursor-pointer"
            >
              <div className="flex shrink-0 mt-0.5 rounded-md overflow-hidden border border-border">
                {t.swatch.map((c, i) => (
                  <span
                    key={i}
                    style={{ background: c }}
                    className="w-4 h-6 block"
                  />
                ))}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-sm">{t.name}</span>
                  {active && <Check className="w-3.5 h-3.5 text-primary" />}
                </div>
                <p className="text-xs text-muted-foreground leading-snug line-clamp-2" title={t.description}>
                  {t.description}
                </p>
              </div>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export default ThemeSwitcher;
