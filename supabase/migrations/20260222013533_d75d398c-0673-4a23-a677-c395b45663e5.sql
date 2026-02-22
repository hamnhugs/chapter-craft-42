
-- Create api_keys table
CREATE TABLE public.api_keys (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  key_value text NOT NULL UNIQUE,
  label text NOT NULL DEFAULT 'Default',
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  revoked_at timestamp with time zone
);

-- Enable RLS
ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;

-- Users can manage their own keys
CREATE POLICY "Users can read own api keys"
  ON public.api_keys FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own api keys"
  ON public.api_keys FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own api keys"
  ON public.api_keys FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own api keys"
  ON public.api_keys FOR DELETE
  USING (auth.uid() = user_id);

-- Index for fast key lookups by the edge function (using service role)
CREATE INDEX idx_api_keys_key_value ON public.api_keys (key_value) WHERE revoked_at IS NULL;
