-- Gemini as a third provider, plus Lean Mode (budget-aware capability tiers).
--
-- gemini_api_key is CLIENT-READ, unlike nvidia_api_key: Gemini's API is
-- CORS-open, so the browser calls it directly and genuinely needs the key.
-- Same posture as inworld_api_key, which is already both client-read and
-- server-read. (nvidia_api_key stays write-only — its relay reads it.)
--
-- lean_mode lives on the row rather than in localStorage so it is readable
-- BY SERVER CODE. Nothing server-side consults it yet: durable background
-- jobs (book digestion, figure extraction, wiki ops) still spend when
-- queued, and the Settings copy says so. Wiring those functions to this
-- column is the follow-up this column exists to make possible.
--   'full'      — nothing blocked (default; today's behaviour)
--   'lean'      — video + 3D generation off (dollars per artifact)
--   'chat_only' — also image generation/editing and paid web search off
--
-- Idempotent.

ALTER TABLE public.user_settings ADD COLUMN IF NOT EXISTS gemini_api_key TEXT;
-- Tavily: the free web-search backend (1,000 searches/month, no card).
-- Client-read, like the Burplexity token it sits beside.
ALTER TABLE public.user_settings ADD COLUMN IF NOT EXISTS tavily_api_key TEXT;
ALTER TABLE public.user_settings ADD COLUMN IF NOT EXISTS lean_mode TEXT NOT NULL DEFAULT 'full';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_settings_lean_mode_check'
  ) THEN
    ALTER TABLE public.user_settings
      ADD CONSTRAINT user_settings_lean_mode_check
      CHECK (lean_mode IN ('full', 'lean', 'chat_only'));
  END IF;
END $$;

COMMENT ON COLUMN public.user_settings.lean_mode IS
  'Budget tier: full | lean (no video/3D) | chat_only (also no image gen or paid search). Read by edge functions before spending the user''s keys.';
