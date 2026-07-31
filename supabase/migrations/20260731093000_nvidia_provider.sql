-- NVIDIA provider: BYOK key columns for the nvidia-chat relay function.
--
-- nvidia_api_key is WRITE-ONLY from the app's point of view: the client
-- writes it once (together with nvidia_key_last4 for display) and never
-- copies it back into UI state; the full key is read server-side by the
-- nvidia-chat edge function under the caller's own RLS. It is deliberately
-- excluded from the client's debounced full-row settings upsert so an
-- unrelated settings save can never clobber it.
--
-- Column names are chosen so neither is a substring of the other — the
-- client's missing-column retry convention matches by substring.
--
-- Idempotent.

ALTER TABLE public.user_settings ADD COLUMN IF NOT EXISTS nvidia_api_key TEXT;
ALTER TABLE public.user_settings ADD COLUMN IF NOT EXISTS nvidia_key_last4 TEXT;
