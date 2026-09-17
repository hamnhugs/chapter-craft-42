-- Chat cost settings (client: src/hooks/useChatSettings.ts).
--   utility_model: model for background text jobs such as the rolling
--     conversation summary. NULL = automatic cheap model on the chat
--     model's provider.
--   studio_tools: whether the production-studio tool pack (video, 3D,
--     masters, blueprints, stage plans, scenes, ledger) rides on chat
--     requests: 'auto' (once a conversation turns to studio work),
--     'always', or 'off'.
-- Both are optional columns: the client strips them from saves until this
-- migration is applied.
ALTER TABLE public.user_settings
  ADD COLUMN IF NOT EXISTS utility_model text,
  ADD COLUMN IF NOT EXISTS studio_tools text NOT NULL DEFAULT 'auto';

ALTER TABLE public.user_settings DROP CONSTRAINT IF EXISTS user_settings_studio_tools_known;
ALTER TABLE public.user_settings
  ADD CONSTRAINT user_settings_studio_tools_known CHECK (studio_tools IN ('auto', 'always', 'off')) NOT VALID;
