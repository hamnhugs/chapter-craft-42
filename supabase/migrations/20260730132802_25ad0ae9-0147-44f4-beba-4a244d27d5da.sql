-- Max sentences per assistant reply (0 = off). The cap itself is enforced
-- client-side (prompt steering + stream truncation in ChatContext); this
-- column only persists the user's setting across devices. Idempotent.
ALTER TABLE public.user_settings
  ADD COLUMN IF NOT EXISTS max_reply_sentences INTEGER DEFAULT 0;