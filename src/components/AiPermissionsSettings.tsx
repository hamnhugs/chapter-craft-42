import React from "react";
import { useChatSettings } from "@/hooks/useChatSettings";

// Per-tool toggles for the AI's chat capabilities. The user is fully in
// control — every tool defaults to ON, but they can disable any combination.
// The chatTools executor reads `user_settings.chat_tool_permissions` at
// runtime and blocks any tool whose value is explicitly `false`.

interface PermItem { id: string; label: string; description: string; danger?: boolean }

const GROUPS: { group: string; items: PermItem[] }[] = [
  {
    group: "Memory (Neurons)",
    items: [
      { id: "create_memory_entry", label: "Create memory entries", description: "Let the AI add new notes to your active neuron." },
      { id: "update_memory_entry", label: "Edit memory entries", description: "Let the AI rewrite existing entries." },
      { id: "delete_memory_entry", label: "Delete memory entries", description: "Let the AI permanently remove entries.", danger: true },
      { id: "link_memory_entries", label: "Link / unlink entries", description: "Let the AI create or remove relationships between entries." },
    ],
  },
  {
    group: "Wikis (Neurons)",
    items: [
      { id: "switch_wiki", label: "Switch active wiki", description: "Allow the AI to change which neuron is in focus." },
      { id: "create_wiki", label: "Create new wikis", description: "Allow the AI to spin up new neurons." },
      { id: "delete_wiki", label: "Delete wikis", description: "Allow the AI to permanently delete a neuron after you confirm.", danger: true },
    ],
  },
  {
    group: "Library",
    items: [
      { id: "set_active_book", label: "Switch active book", description: "Allow the AI to open a different book in your library." },
      { id: "isolate_chapter", label: "Isolate chapter context", description: "Allow narrowing focus to one chapter." },
      { id: "rename_chapter", label: "Rename chapters", description: "Allow the AI to rename chapters." },
      { id: "delete_chapter", label: "Delete chapters", description: "Allow the AI to remove chapters from a book.", danger: true },
    ],
  },
  {
    group: "Images",
    items: [
      { id: "generate_image", label: "Generate images", description: "Allow the AI to create new images." },
      { id: "edit_image", label: "Edit images", description: "Allow the AI to modify existing images." },
      { id: "save_image_to_memory", label: "Save images to memory", description: "Let the AI file an uploaded or generated image into your neurons as a memory entry." },
      { id: "delete_image", label: "Delete images", description: "Allow the AI to permanently delete generated or uploaded images after you confirm.", danger: true },
      { id: "delete_image_memory", label: "Delete uploaded image memories", description: "Allow the AI to delete the memory record (caption/search data) of an uploaded picture after you confirm. Removing the picture itself is covered by Delete images.", danger: true },
    ],
  },
  {
    group: "Generation",
    items: [
      { id: "create_artifact", label: "Create artifacts", description: "Allow the AI to publish code/markdown artifacts to the workspace." },
    ],
  },
  {
    group: "Research",
    items: [
      { id: "web_search", label: "Web search", description: "Allow the AI to perform web searches." },
    ],
  },
];

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
