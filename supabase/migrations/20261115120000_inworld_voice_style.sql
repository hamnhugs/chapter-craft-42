-- How the Inworld voice performs, alongside which voice it is. All three are
-- read by the client and sent with each read-aloud request; these columns
-- only persist the choice across devices. Idempotent and additive.
--   inworld_model      '' = inworld-tts-2 (flagship) · 'inworld-tts-2-flash'
--   inworld_delivery   STABLE · BALANCED · CREATIVE
--   inworld_direction  '' = plain · 'auto' = the voice decides · else a
--                      written direction ("speak like a warm storyteller…")
ALTER TABLE public.user_settings
  ADD COLUMN IF NOT EXISTS inworld_model TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS inworld_delivery TEXT NOT NULL DEFAULT 'BALANCED',
  ADD COLUMN IF NOT EXISTS inworld_direction TEXT NOT NULL DEFAULT '';
