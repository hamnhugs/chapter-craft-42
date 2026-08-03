-- API key hashing (audit finding: CRITICAL).
--
-- api_keys.key_value stored every external-API key in PLAINTEXT and indexed
-- it, so any read of the table (or a backup of it) yielded working
-- credentials for chapters-api. This migration moves the table to
-- store-the-digest-only: `key_hash` (SHA-256 hex, unique) is what the edge
-- function looks up, `key_prefix` (first 10 chars) is the only fragment the
-- UI ever shows again, and the plaintext column is dropped outright.
-- Existing keys keep working because their digests are derived from the
-- plaintext BEFORE it is dropped.
--
-- Idempotent: safe to re-run. Apply via Lovable chat prompt.

-- digest() lives in the extensions schema on Supabase.
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

ALTER TABLE public.api_keys ADD COLUMN IF NOT EXISTS key_hash TEXT;
ALTER TABLE public.api_keys ADD COLUMN IF NOT EXISTS key_prefix TEXT;

-- Backfill digests from the plaintext while it still exists. The UPDATE is
-- wrapped in EXECUTE so this block still parses on a re-run after key_value
-- has been dropped.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'api_keys' AND column_name = 'key_value'
  ) THEN
    EXECUTE $sql$
      UPDATE public.api_keys
      SET key_hash = encode(extensions.digest(key_value, 'sha256'), 'hex'),
          key_prefix = left(key_value, 10)
      WHERE key_hash IS NULL AND key_value IS NOT NULL
    $sql$;
  END IF;
END $$;

-- Unique across ALL rows (not just unrevoked ones like the old partial
-- index): two keys may never share a digest, revoked or not.
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_key_hash
  ON public.api_keys (key_hash);

-- Drop the plaintext. The explicit lookup index goes first; the implicit
-- UNIQUE-constraint index falls away with the column itself.
DROP INDEX IF EXISTS public.idx_api_keys_key_value;
ALTER TABLE public.api_keys DROP COLUMN IF EXISTS key_value;
