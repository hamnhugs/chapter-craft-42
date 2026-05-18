ALTER TABLE public.user_settings
  ADD COLUMN IF NOT EXISTS inworld_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS inworld_voice_id text NOT NULL DEFAULT '';