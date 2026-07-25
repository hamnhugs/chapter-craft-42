# Identity-locked video: architecture, SOP, and P3 roadmap

How Chapter Craft animates a locked master asset (character or prop) without
identity drift. Written 2026-07 alongside the identity-video implementation;
the assistant-facing SOP lives in `buildChatSystemPrompt.ts` and the tool
schemas in `chatTools.ts` — this doc is the human-readable companion plus the
deliberately-deferred P3 items.

## The core doctrine (evidence-backed)

1. **Identity lives in images, never in prose.** Multi-image reference packs >
   single first-frame image > text descriptions, in that order (ARGUS, Mv2ID,
   Phantom ablations). A "character bible" paragraph cannot hold a face or a
   body plan across clips.
2. **Prompt = one short tag + motion + camera.** With any identity input
   attached, the text prompt carries ONE discriminative tag ("the
   teal-and-white cartoon robot") plus motion and camera only. Long appearance
   prose *fights* the image conditioning. This mirrors Runway/Wan/Sora's own
   guidance verbatim ("identity lives in the reference, action lives in the
   prompt").
3. **One motion verb per clip, 5–8 s, re-anchor every shot.** Drift compounds
   in autoregressive extension, not single short shots. Long sequences are
   many short clips, each conditioned from the same master, stitched later.
4. **Negatives are artifact suppression, not an identity tool.** Descriptive
   noun lists ("extra limbs, new panels"), routed to the model's
   negative-prompt parameter where one exists (Kling/Veo/Wan), silently
   impossible elsewhere — which is why the QC gate exists.
5. **The back view is the highest-value reference.** Back views are
   underdetermined from a front hero; turnarounds hallucinate without one.
   `render_splat_views` exists largely for this reason.
6. **Honesty rule: the splat is never animated.** No production API animates a
   static Gaussian splat (mid-2026). The splat contributes geometry-consistent
   turntable stills; video always comes from image conditioning on those. Say
   "splat-derived multi-view identity lock", never "animates the splat".

## Provider map (who does what, billed where)

| Capability | Route | Billing |
|---|---|---|
| Text-to-video | OpenRouter `/api/v1/videos` | OpenRouter key |
| First-frame conditioning (`frame_images`) | OpenRouter — 16 of 17 models (not sora-2-pro) | OpenRouter key |
| Multi-image reference packs (`input_references`) | OpenRouter — curated list (Seedance 2.0, Wan 2.7, Grok ≤7, Happyhorse, Hailuo) | OpenRouter key |
| Negative prompt / identity strength | OpenRouter `provider.options.<slug>.parameters`, gated on live `allowed_passthrough_parameters` | — |
| Motion transfer (driving video → master appearance) | fal: `fal-ai/wan-motion` (default, pose retargeting) or Kling v3 motion-control (premium, proportion-preserving) | fal key |
| Cheap identity drafts (flat $0.10–0.30/clip) | fal: `fal-ai/vidu/q2/reference-to-video` | fal key |
| Splat → multi-view stills | client-side (hidden Spark renderer), free | — |
| Consistency QC | client-side (DINOv2-small via transformers.js, lazy ~25–45 MB) | — |

Two verification notes for maintenance:
- The `provider.options` slug is documented only for Veo (`google-vertex`).
  The others in `VENDOR_SLUGS` (videoCatalog.ts) are best-known OpenRouter
  provider slugs; a wrong slug is a documented **silent no-op**, never an
  error. Verify with one cheap real call per vendor when convenient.
- Reference-capable models have NO structured discovery flag — the curated
  list in videoCatalog.ts must be revisited when the catalog changes.

## Data model

`video_generations` gains (all nullable; pre-migration rows stay valid):
`provider`, `source_image_ids`, `source_splat_id`, `master_id`,
`condition_mode`, `motion_mode`, `motion_video_id`, `identity_scale`,
`assembly_instruction`, `negative_constraints`, `lock_palette`, `qc`.
fal jobs share the table with `job_id = 'fal:<request_id>'`.

`master_assets` is the bundle: hero + view pack + splat + tech pack +
assembly tag + negatives + banned traits + palette + style lock +
front_azimuth_deg + cached ref embeddings. The tech pack is deliberately
NOT injected into prompts (doctrine #2); it feeds the Asset Factory neuron
and future QC checklists.

## QC gate (advisory, never blocking)

After an identity-conditioned clip completes, VideoBubble runs (lazily):
- **Reference similarity**: DINOv2 cosine, each sampled frame vs the best
  match in the pack (mean AND min — min catches transient morphs).
- **Temporal consistency**: the VBench subject-consistency formula.
- **Palette drift**: k-means dominant colors vs `lock_palette`, CIEDE2000,
  area-weighted.
Thresholds are a versioned config in `videoQc.ts` (`QC_THRESHOLDS`) —
starting values come from published anchors and MUST be recalibrated against
real accepted/rejected clips. Scores land in `video_generations.qc` and the
chip UI; a red verdict warns and suggests a retry with higher
`identity_scale` — it never deletes a paid clip.

## Pre-flight & stall triage (hardened 2026-07-24 after the first live runs)

Every submit path pre-flights its conditioning media BEFORE spending:

- Signed URLs for anything a provider will fetch are minted FRESH (full 24h
  TTL). The render cache can hand out a URL minutes from expiry, and
  providers fetch references at **dequeue** time, not submit time — an
  expired reference is the classic submits-fine-then-stalls-in-pending job.
- Each URL is then HEAD-probed (GET fallback, each with its own deadline)
  from the browser for status, content-type, and size
  (`preflightRemoteMedia`, videoGen.ts). Only our OWN storage URLs can
  block the call ("nothing was submitted or billed") — the app provably
  fetches those same URLs elsewhere, so any failure is real. A user-supplied
  `image_url` only ever warns: hotlink protection and CORS routinely fail a
  browser probe while the provider's server-side fetch succeeds. An absent
  Content-Length is treated as unknown, never as empty.

422 classes the client now prevents instead of surfacing:

- Vidu Q2's draft `duration` is a hard `"4" | "8"` string enum — requests
  are snapped BEFORE pricing and the snap is reported (`snapDraftDuration`).
  Aspect ratios outside {16:9, 9:16, 1:1} are dropped with a note.
- OpenRouter `aspect_ratio` / `generate_audio` are validated against the
  live catalog exactly like duration/resolution always were. Core request
  fields hard-fail upstream when unsupported — they are NOT silent no-ops
  like passthrough params — so unsupported values are dropped-and-reported.

Stall triage, in order:

1. The generating card labels the job **queued** vs **rendering**. Queued
   forever = provider backlog or an unfetchable reference (pre-flight makes
   the second nearly impossible now); rendering forever = provider-side
   generation trouble.
2. `pollVideo` reads each field top-level-first with a `{data:{...}}`
   fallback (the submit response already came both ways) and maps terminal
   synonyms: error/cancelled/expired/rejected → failed, succeeded →
   completed. Anything ambiguous — unknown status, error envelope on a 200 —
   keeps polling: one ambiguous payload must never persist "failed" on a
   possibly-still-rendering paid clip. The bubble's 15-min watchdog bounds a
   genuine unrecognized-terminal stall and stops WATCHING, never fails the row.
3. Submit 4xx surfaces the provider's actual message (`extractApiError`)
   plus model/conditioning context — never a bare "HTTP 422".

## P3 — documented only, deliberately not built

1. **LoRA / adapter identity** (`adapter_id` on generate_video): export the
   master pack (hero + views + turntable renders), train a subject LoRA on a
   hosted trainer (fal exposes Wan/Hunyuan-video LoRA trainers), register the
   resulting `adapter_id` on the master, and pass it to LoRA-capable
   endpoints. Highest identity ceiling; costs training time + money per
   character; wait until a user actually hits the multi-ref quality ceiling.
2. **Native 4D splat animation**: no production API exists (SC-GS/4DGS lines
   are per-scene research; DCC tools are artist-driven). Revisit if a
   splat-to-4D API ships; the `splat_id` plumbing already isolates where it
   would slot in.
3. **`generate_character_sheet(image_id)`**: auto-build the 4-view pack from a
   hero image alone (CharacterGen-style canonical A-pose views) via the
   existing image-edit path, prioritizing the back view, then `lock_master_asset`
   with the results. Today this works manually: `edit_image` ("same robot,
   seen directly from behind, neutral pose, plain background") × 3, then lock.
4. **Turntable VIDEO export** (WebCodecs → MP4): only needed if a provider
   accepts non-human turntables as driving/reference video (Kling motion
   control requires a human driver, so this was cut from v1).
5. **QC v2**: escalate amber verdicts to a multimodal judge (4 keyframes + hero
   → the user's own OpenRouter model), VBench-2.0 style. Also: persist ref
   embeddings on `master_assets.ref_embeddings` (column already exists).
6. **DB-level monthly quota for fal-billed video**: fal video currently has the
   per-call confirm gate plus a client-side one-in-flight cap
   (`hasInFlightFalVideo`, cross-tab, age-bounded — same rail as splats). A
   server-side monthly trigger like `enforce_splat_quota` (with a
   `video_monthly_quota` setting) is the remaining backstop against a runaway
   loop from a leaked key; add it if fal video usage grows.

## Acceptance tests (manual, need real keys)

1. Same `image_id` + "slow turntable" twice → same silhouette/palette both runs.
2. `master_id` + walk prompt → walk, no head/torso redesign.
3. 4-view pack + wave → wave only, no new body plan.
4. `negative_constraints: ["antenna", "tracks"]` honored across 3 retries
   (on Kling/Veo/Wan; reported as not-applicable elsewhere).
5. `splat_id` → auto-rendered views → clip matches splat style better than text.
6. Pure text with no identity inputs → unchanged behavior (back-compat).
7. sora-2-pro + `image_id` → clean refusal listing capable models, no spend.
8. Assistant, asked to "animate the robot master", calls list_master_assets →
   generate_video(master_id), and reports mode/scale/QC.
