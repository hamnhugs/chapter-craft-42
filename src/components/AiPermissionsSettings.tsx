import React from "react";
import { Switch } from "@/components/ui/switch";
import { useChatSettings } from "@/hooks/useChatSettings";
import { PERMISSION_GROUPS } from "@/lib/toolPermissions";
import { Disclosure, Group, Row } from "@/components/settings/SettingsUI";

// Per-tool toggles for the AI's chat capabilities. The user is fully in
// control — every tool defaults to ON, but they can disable any combination.
// The toggle data AND the enforcement map live in lib/toolPermissions.ts:
// executeChatTool blocks any mapped tool whose permission is explicitly
// `false` at one choke point, and permissionCoverage.test.ts fails when a
// toggle and its enforcement drift apart. This component only renders.
//
// ~50 switches is too many to show at once, so the page leads with the one
// question most people actually have — "may the AI delete things?" — as a
// single control, and folds each group behind a row that says how many of
// its tools are on.

const GROUPS = PERMISSION_GROUPS;
const DELETE_IDS = GROUPS.flatMap((g) => g.items.filter((it) => it.danger).map((it) => it.id));

const AiPermissionsSettings: React.FC = () => {
  const { chatToolPermissions, setChatToolPermission, setChatToolPermissions } = useChatSettings();
  const isAllowed = (id: string) => chatToolPermissions[id] !== false;
  const deletesOn = DELETE_IDS.filter(isAllowed).length;
  const setAllDeletes = (allowed: boolean) => {
    const next = { ...chatToolPermissions };
    for (const id of DELETE_IDS) next[id] = allowed;
    setChatToolPermissions(next);
  };

  return (
    <div className="space-y-6">
      <Group footer="Turned-off tools are refused when the AI tries them, and it's told to ask you instead.">
        <Row
          label="Deleting things"
          description={
            deletesOn === DELETE_IDS.length
              ? "Allowed — the AI can delete after you confirm."
              : deletesOn === 0
                ? "Blocked everywhere — the AI can't delete anything."
                : `${deletesOn} of ${DELETE_IDS.length} delete actions allowed.`
          }
        >
          <Switch
            checked={deletesOn > 0}
            onCheckedChange={(v) => setAllDeletes(v)}
            aria-label="Allow the AI to delete things"
          />
        </Row>
      </Group>

      <Group title="Tools by area">
        {GROUPS.map((g) => {
          const on = g.items.filter((it) => isAllowed(it.id)).length;
          return (
            <Disclosure
              key={g.group}
              label={g.group}
              summary={on === g.items.length ? `All ${g.items.length} on` : `${on} of ${g.items.length} on`}
            >
              <ul className="-mx-4 divide-y divide-outline-variant/10">
                {g.items.map((it) => (
                  <li key={it.id}>
                    <Row label={it.label} description={it.description} danger={it.danger}>
                      <Switch
                        checked={isAllowed(it.id)}
                        onCheckedChange={(v) => setChatToolPermission(it.id, v)}
                        aria-label={it.label}
                      />
                    </Row>
                  </li>
                ))}
              </ul>
            </Disclosure>
          );
        })}
      </Group>
    </div>
  );
};

export default AiPermissionsSettings;
