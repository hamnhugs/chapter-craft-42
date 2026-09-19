ALTER TABLE public.user_settings ADD COLUMN IF NOT EXISTS nvidia_api_key TEXT;
ALTER TABLE public.user_settings ADD COLUMN IF NOT EXISTS nvidia_key_last4 TEXT;