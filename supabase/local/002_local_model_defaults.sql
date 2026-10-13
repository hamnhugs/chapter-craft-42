-- LOCAL EDITION ONLY (applied by scripts/local-up.sh, never pushed).
--
-- The hosted column defaults name cloud models, and the settings row is
-- created server-side at sign-up, so they win over the app's own defaults
-- (src/hooks/useChatSettings.ts). Point them at the models on this computer
-- and the local Piper voice. Must match useChatSettings.ts DEFAULT_* values.
alter table public.user_settings
  alter column selected_model      set default 'ollama:hf.co/unsloth/Qwen3-4B-Instruct-2507-GGUF:Q6_K',
  alter column vision_model        set default 'ollama:qwen3.5:4b',
  alter column deep_research_model set default 'ollama:qwen3:8b',
  alter column saved_models        set default
    '["ollama:hf.co/unsloth/Qwen3-4B-Instruct-2507-GGUF:Q6_K","ollama:qwen3.5:4b","ollama:qwen3:8b"]'::jsonb,
  alter column inworld_enabled     set default true,
  alter column inworld_voice_id    set default 'piper:en_US-lessac-medium';

-- Rows made before this ran that were never customised: still on the hosted
-- default model and holding no cloud key of any kind. Imported accounts with
-- their own keys/models are left exactly as they are.
update public.user_settings set
  selected_model      = 'ollama:hf.co/unsloth/Qwen3-4B-Instruct-2507-GGUF:Q6_K',
  vision_model        = coalesce(vision_model, 'ollama:qwen3.5:4b'),
  deep_research_model = 'ollama:qwen3:8b',
  saved_models        = '["ollama:hf.co/unsloth/Qwen3-4B-Instruct-2507-GGUF:Q6_K","ollama:qwen3.5:4b","ollama:qwen3:8b"]'::jsonb,
  inworld_enabled     = true,
  inworld_voice_id    = 'piper:en_US-lessac-medium'
where selected_model = 'google/gemini-2.5-flash'
  and saved_models = '["google/gemini-2.5-flash"]'::jsonb
  and coalesce(openrouter_api_key, '') = '' and coalesce(nvidia_api_key, '') = ''
  and coalesce(gemini_api_key, '') = '' and coalesce(inworld_api_key, '') = '';

-- Rows still on the previous local default (2026-10-12, Q4_K_M) and its model
-- list move to Q6_K (docs/local-ai/results/2026-10-13-accuracy-speed.txt).
-- Anything the user picked themselves is left alone.
update public.user_settings set
  selected_model = 'ollama:hf.co/unsloth/Qwen3-4B-Instruct-2507-GGUF:Q6_K',
  saved_models   = '["ollama:hf.co/unsloth/Qwen3-4B-Instruct-2507-GGUF:Q6_K","ollama:qwen3.5:4b","ollama:qwen3:8b"]'::jsonb
where selected_model = 'ollama:qwen3:4b-instruct-2507-q4_K_M'
  and saved_models = '["ollama:qwen3:4b-instruct-2507-q4_K_M","ollama:qwen3.5:4b","ollama:qwen3:8b"]'::jsonb;
