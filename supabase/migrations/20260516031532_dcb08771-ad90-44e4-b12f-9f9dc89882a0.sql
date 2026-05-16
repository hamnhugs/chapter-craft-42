ALTER TABLE public.user_settings
ADD COLUMN IF NOT EXISTS auto_read_replies boolean NOT NULL DEFAULT false;