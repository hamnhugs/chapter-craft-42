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
  const { themeId, setThemeId, themes } = useTheme();

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
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel>Theme</DropdownMenuLabel>
        <DropdownMenuSeparator />
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
                <p className="text-xs text-muted-foreground leading-snug">
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
