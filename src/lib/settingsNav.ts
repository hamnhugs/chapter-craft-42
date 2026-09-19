// Deep-link channel into the Settings tab. Any tab can request that a
// particular section scrolls into view the next time SettingsPanel mounts.
// Lives in its own tiny module so callers (ChatPanel, WikiPanel, …) don't
// statically import SettingsPanel and defeat its lazy chunk.

let pendingSection: string | null = null;

export function requestSettingsSection(id: string) {
  pendingSection = id;
}

export function consumeSettingsSection(): string | null {
  const s = pendingSection;
  pendingSection = null;
  return s;
}
