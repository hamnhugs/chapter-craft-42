-- Transcript persistence for artifacts and tool events.
--
-- Artifacts (blueprint sheets, stage plans, model-authored pages) and the
-- tool-event chips (including FAILURE chips like "Blueprint rejected") were
-- rendered from tool-call arguments and marked display-only — chat_messages
-- had no column for either, so on reload the transcript showed the model
-- describing a sheet next to nothing, and the audit trail of what failed was
-- gone. The content survived only in the Workspace panel.
--
-- `artifacts` holds an array of {title, kind, content} (same shape the
-- ArtifactSchema validates); `tool_events` holds an array of
-- {name, summary, ok}. Both nullable — old rows simply have neither.
--
-- Idempotent: safe to re-run. Apply via Lovable chat prompt.

ALTER TABLE public.chat_messages ADD COLUMN IF NOT EXISTS artifacts JSONB;
ALTER TABLE public.chat_messages ADD COLUMN IF NOT EXISTS tool_events JSONB;

COMMENT ON COLUMN public.chat_messages.artifacts IS
  'Array of {title, kind: html|svg, content} artifacts rendered with this assistant message, so the transcript survives reload. Content is size-capped client-side (ARTIFACT_MAX_CONTENT).';
COMMENT ON COLUMN public.chat_messages.tool_events IS
  'Array of {name, summary, ok} tool-event chips for this assistant message — the audit trail of what the assistant did (and what failed), which used to vanish on reload.';
