## Goal
Move the Inworld TTS API key off the client by proxying all Inworld calls through a Supabase edge function. Persist the key in `user_settings` instead of localStorage.

## Steps

### 1. Database migration
Add `inworld_api_key TEXT DEFAULT ''` to `public.user_settings`. No RLS changes needed (existing policies already cover it).

### 2. New edge function: `supabase/functions/inworld-tts/index.ts`
- Deployed with `verify_jwt = false` (Lovable default); validate JWT in code using `SUPABASE_URL` + anon key by calling `supabase.auth.getUser(token)`.
- CORS preflight handled.
- Route on `req.method` + URL path:
  - `GET …/inworld-tts/voices` → fetch `https://api.inworld.ai/v1/tts/voices` with `Authorization: Basic <key>`, return JSON.
  - `POST …/inworld-tts` → validate `{ text, voice_id, model? }` with Zod, forward to `https://api.inworld.ai/v1/tts/synthesize` with `output_format: "mp3"`, `delivery_mode: "BALANCED"`, return raw MP3 with `Content-Type: audio/mpeg`.
- Load `inworld_api_key` from `user_settings` for the authenticated user using the service role client. Error JSON `{ error }` on missing key / bad auth / upstream failure (preserve upstream status code where reasonable).
- Add `[functions.inworld-tts]` block in `supabase/config.toml` only if needed (not required since default is fine).

### 3. Update `src/lib/inworldTts.ts`
- Remove `authHeader` helper.
- Keep `fetchInworldVoices(apiKey)` and `synthesizeSpeech(text, apiKey, voiceId, model)` signatures unchanged for caller compatibility — but ignore the `apiKey` arg (key now lives server-side).
- Internally: get the current session JWT via `supabase.auth.getSession()`, then `fetch(\`${SUPABASE_URL}/functions/v1/inworld-tts…\`, { headers: { Authorization: \`Bearer ${jwt}\`, apikey: <publishable> } })`. Use the `inworld-tts/voices` sub-route for voice listing.
- Return `ArrayBuffer` for synth, JSON list for voices, same as today.

### 4. Update `src/hooks/useChatSettings.ts`
- Add `inworldApiKey: string` to the `ChatSettings` interface, defaults, load, and debounced upsert payload (`inworld_api_key`).
- Expose a `setInworldApiKey(key: string)` setter.

### 5. Update `src/components/VoiceChat.tsx`
- Read Inworld API key from `useChatSettings().inworldApiKey`; fall back to existing localStorage value only if DB value is empty (one-time migration), then write through to DB.
- Save changes via `setInworldApiKey()` (already debounced). Keep localStorage write for backward compatibility or remove — recommend keeping a mirror write so nothing else relying on it breaks, but treat DB as source of truth.

### 6. Deploy
Deploy `inworld-tts` via the edge-function deploy tool after files land.

## Technical notes
- Inside the edge function, validate the user with: `const supabase = createClient(SUPABASE_URL, SERVICE_ROLE); const { data: { user } } = await supabase.auth.getUser(jwtFromHeader);` then query `user_settings` with service role filtered by `user.id`.
- Inworld key is forwarded verbatim as `Authorization: Basic <key>` — matches current client behavior for already-base64 keys. Raw keys are encoded as `btoa(\`${key}:\`)` inside the function (mirroring the removed client helper) so existing stored keys keep working.
- MP3 response is returned as `new Response(await upstream.arrayBuffer(), { headers: { ...corsHeaders, 'Content-Type': 'audio/mpeg' } })`.

## Out of scope
No UI redesign of the VoiceChat settings panel; only the storage source changes.
