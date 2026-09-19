import React from "react";
import { useChatSettings } from "@/hooks/useChatSettings";
import { PERMISSION_GROUPS } from "@/lib/toolPermissions";

// Per-tool toggles for the AI's chat capabilities. The user is fully in
// control — every tool defaults to ON, but they can disable any combination.
// The toggle data AND the enforcement map live in lib/toolPermissions.ts:
// executeChatTool blocks any mapped tool whose permission is explicitly
// `false` at one choke point, and permissionCoverage.test.ts fails when a
// toggle and its enforcement drift apart. This component only renders.

const GROUPS = PERMISSION_GROUPS;

const AiPermissionsSettings: React.FC = () => {
  const { chatToolPermissions, setChatToolPermission } = useChatSettings();
  const isAllowed = (id: string) => chatToolPermissions[id] !== false;
  return (
    <section className="p-3 md:p-4 rounded-xl bg-surface-container-low flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h3 className="text-sm font-bold text-foreground">AI Tool Permissions</h3>
        <p className="text-xs text-on-surface-variant">
          Decide exactly which actions the AI is allowed to take on your behalf. Disabled tools
          will be refused at runtime and the AI will be told to ask you instead.
        </p>
      </header>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {GROUPS.map((g) => (
          <div key={g.group} className="rounded-lg border border-outline-variant/15 p-3 bg-surface-container-high/40">
            <p className="text-[11px] font-semibold uppercase tracking-widest text-on-surface-variant mb-2">{g.group}</p>
            <ul className="flex flex-col gap-2">
              {g.items.map((it) => {
                const on = isAllowed(it.id);
                return (
                  <li key={it.id} className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className={`text-sm font-medium ${it.danger ? "text-red-300" : "text-foreground"}`}>{it.label}</p>
                      <p className="text-[11px] text-on-surface-variant leading-snug">{it.description}</p>
                    </div>
                    <button
                      role="switch"
                      aria-checked={on}
                      onClick={() => setChatToolPermission(it.id, !on)}
                      className={`shrink-0 mt-0.5 w-9 h-5 rounded-full transition-colors ${on ? (it.danger ? "bg-red-500/70" : "bg-primary") : "bg-surface-container-highest"}`}
                    >
                      <span className={`block w-4 h-4 m-0.5 rounded-full bg-white transition-transform ${on ? "translate-x-4" : ""}`} />
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
};

export default AiPermissionsSettings;
