ALTER TABLE public.user_settings
ADD COLUMN IF NOT EXISTS hands_free_tts_rate numeric NOT NULL DEFAULT 1.0;