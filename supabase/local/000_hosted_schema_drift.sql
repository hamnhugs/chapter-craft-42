-- LOCAL EDITION ONLY (applied by scripts/local-up.sh, never pushed).
--
-- Columns the hosted database has but no migration creates: they were added
-- outside the migration history. Found by diffing src/integrations/supabase/
-- types.ts (generated from the hosted schema) against a clean local replay
-- of supabase/migrations. Without them the app's explicit column lists fail:
-- settings don't load, and knowledge entries can't be listed.
--
-- The app selects these columns but doesn't branch on their values, so the
-- defaults only need to satisfy the NOT NULLs types.ts shows. Idempotent.
--
-- Also absent locally and NOT recreated, because no code references them:
-- tables subject_progress, wiki_log, wiki_questions; trigger functions
-- validate_wiki_log_operation(), validate_knowledge_entry_enums().

alter table public.user_settings
  add column if not exists custom_system_prompt text,
  add column if not exists burplexity_api_token text;

alter table public.knowledge_entries
  add column if not exists folder text not null default '',
  add column if not exists is_index boolean not null default false,
  add column if not exists maturity text not null default 'note',
  add column if not exists pending_changes jsonb not null default '[]'::jsonb,
  add column if not exists subject text;

notify pgrst, 'reload schema';
