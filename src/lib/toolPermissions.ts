// The single source of truth for per-tool AI permissions.
//
// History, and why this file exists: the settings screen shipped 19 toggles
// and claimed the executor enforced all of them, but each executor case
// carried its own hand-written gate — 9 had one, 10 did not, and 3 more
// permissions were enforced in code with no toggle to reach them. This file
// makes the claim structural: the UI renders PERMISSION_GROUPS, the executor
// enforces TOOL_PERMISSION at ONE choke point, and a coverage test fails the
// build when the two drift apart.
//
// Semantics: every permission defaults to ALLOWED; only an explicit `false`
// in user_settings.chat_tool_permissions blocks. Free/read-only tools
// (list_*, get_*, show_*, search) deliberately have no entry — a permission
// nobody would ever turn off is noise, not control.

export interface PermItem {
  id: string;
  label: string;
  description: string;
  danger?: boolean;
}

export interface PermGroup {
  group: string;
  items: PermItem[];
}

/** Tool name → permission id. Most are 1:1; grouped permissions (one toggle
 *  covering sibling tools) are deliberate and the label says so. */
export const TOOL_PERMISSION: Record<string, string> = {
  // Memory (neurons)
  create_memory_entry: "create_memory_entry",
  update_memory_entry: "update_memory_entry",
  supersede_memory_entry: "supersede_memory_entry",
  delete_memory_entry: "delete_memory_entry",
  link_memory_entries: "link_memory_entries",
  // Wikis (neurons)
  switch_wiki: "switch_wiki",
  create_wiki: "create_wiki",
  delete_wiki: "delete_wiki",
  // Library
  set_active_book: "set_active_book",
  isolate_chapter: "isolate_chapter",
  rename_chapter: "rename_chapter",
  delete_chapter: "delete_chapter",
  // Images
  generate_image: "generate_image",
  edit_image: "edit_image",
  save_image_to_memory: "save_image_to_memory",
  delete_image: "delete_image",
  delete_image_memory: "delete_image_memory",
  // Video & 3D
  generate_video: "generate_video",
  generate_splat: "generate_splat",
  delete_video: "delete_video",
  delete_splat: "delete_splat",
  // Workspace
  create_artifact: "create_artifact",
  // Research
  web_search: "web_search",
  // Production
  lock_master_asset: "lock_master_asset",
  delete_master_asset: "delete_master_asset",
  lock_scene: "save_scene",
  delete_scene: "delete_scene",
  accept_generation: "production_ledger",
  reject_generation: "production_ledger",
};

/** Permissions enforced INSIDE an executor branch rather than at the tool
 *  boundary — drawing a sheet is free and ungated, but the branch of
 *  create_blueprint_sheet that overwrites a master, and the branch of
 *  create_stage_plan that writes a scene row, each check one of these. The
 *  coverage test knows this list so a branch permission still requires a UI
 *  toggle. */
export const BRANCH_PERMISSIONS: Record<string, string> = {
  save_blueprint_to_master: "create_blueprint_sheet (save_to_master branch)",
  save_scene: "create_stage_plan (save branch) and lock_scene",
};

/** What the settings screen renders. Ids here MUST appear in TOOL_PERMISSION
 *  values or BRANCH_PERMISSIONS keys — the coverage test enforces it. */
export const PERMISSION_GROUPS: PermGroup[] = [
  {
    group: "Memory (Neurons)",
    items: [
      { id: "create_memory_entry", label: "Create memory entries", description: "Let the AI add new notes to your active neuron." },
      { id: "update_memory_entry", label: "Edit memory entries", description: "Let the AI rewrite existing entries (typo/phrasing fixes)." },
      { id: "supersede_memory_entry", label: "Supersede memory entries", description: "Let the AI retire an outdated entry and write its corrected replacement, keeping the old version in history. Also disabled when editing is off." },
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
      { id: "delete_chapter", label: "Delete chapters", description: "Allow the AI to remove chapters from a book after you confirm.", danger: true },
    ],
  },
  {
    group: "Images",
    items: [
      { id: "generate_image", label: "Generate images", description: "Allow the AI to create new images. Uses your API key." },
      { id: "edit_image", label: "Edit images", description: "Allow the AI to modify existing images. Uses your API key." },
      { id: "save_image_to_memory", label: "Save images to memory", description: "Let the AI file an uploaded or generated image into your neurons as a memory entry." },
      { id: "delete_image", label: "Delete images", description: "Allow the AI to permanently delete generated or uploaded images after you confirm.", danger: true },
      { id: "delete_image_memory", label: "Delete uploaded image memories", description: "Allow the AI to delete the memory record (caption/search data) of an uploaded picture after you confirm. Removing the picture itself is covered by Delete images.", danger: true },
    ],
  },
  {
    group: "Video & 3D",
    items: [
      { id: "generate_video", label: "Generate video", description: "Allow the AI to create video clips. The most expensive tool in the app — uses your API key." },
      { id: "generate_splat", label: "Generate 3D models", description: "Allow the AI to create 3D splats. Uses your fal.ai key." },
      { id: "delete_video", label: "Delete videos", description: "Allow the AI to permanently delete generated videos after you confirm.", danger: true },
      { id: "delete_splat", label: "Delete 3D models", description: "Allow the AI to permanently delete generated splats after you confirm.", danger: true },
    ],
  },
  {
    group: "Production",
    items: [
      { id: "lock_master_asset", label: "Create master assets", description: "Allow the AI to lock a character/prop bundle as a master asset." },
      { id: "save_blueprint_to_master", label: "Save blueprints to masters", description: "Allow the AI to attach or replace a master's structured blueprint. Replacing an existing blueprint always asks you first." },
      { id: "save_scene", label: "Save production scenes", description: "Allow the AI to save stage plans and lock/unlock shot lists." },
      { id: "production_ledger", label: "Accept / reject takes", description: "Allow the AI to record verdicts on generations in the production ledger." },
      { id: "delete_scene", label: "Delete scenes", description: "Allow the AI to permanently delete a saved scene after you confirm.", danger: true },
      { id: "delete_master_asset", label: "Delete master assets", description: "Allow the AI to permanently delete a master asset after you confirm.", danger: true },
    ],
  },
  {
    group: "Workspace",
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

/** The standard refusal for a permission the user has switched off. Terminal
 *  (retriable: false) — retrying a permission refusal only burns tokens. */
export function permissionRefusal(toolName: string, permissionId: string) {
  return {
    error: `Tool '${toolName}' is disabled in the user's AI permissions ('${permissionId}' is off). Do not retry — ask the user to enable it in Settings → AI permissions.`,
    retriable: false,
  };
}
