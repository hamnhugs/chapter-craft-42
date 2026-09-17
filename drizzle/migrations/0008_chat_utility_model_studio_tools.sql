ALTER TABLE public.user_settings
  ADD COLUMN IF NOT EXISTS utility_model text,
  ADD COLUMN IF NOT EXISTS studio_tools text NOT NULL DEFAULT 'auto';

ALTER TABLE public.user_settings DROP CONSTRAINT IF EXISTS user_settings_studio_tools_known;
ALTER TABLE public.user_settings
  ADD CONSTRAINT user_settings_studio_tools_known CHECK (studio_tools IN ('auto', 'always', 'off')) NOT VALID;