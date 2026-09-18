-- Variable system prompts, phases 2-3: routing, context bindings, proposals.
--
-- Idempotent and purely ADDITIVE. Until it is applied the client
-- feature-detects (42703 / PGRST204 / PGRST205) and behaves exactly as it does
-- today: one active prompt, switched by hand. Nothing here changes an existing
-- row's meaning.
--
-- The shape deliberately mirrors Smart Filing, which already routes memories
-- into neurons and has earned its thresholds in production:
--   routing_decisions          -> prompt_routing_decisions
--   incubator_entries          -> prompt_incubator_turns
--   wiki_proposals             -> prompt_proposals
-- Same columns, same status vocabularies, same propose -> approve ->
-- user_corrected -> auto-pause loop. A reader who knows one knows the other.

-- ---------------------------------------------------------------------------
-- 1. prompt_presets: what to match on, what to bind, where it came from
-- ---------------------------------------------------------------------------

ALTER TABLE public.prompt_presets
  -- What the router matches the user's turn AGAINST. Deliberately separate
  -- from `body`: the instructions ("write like a hard-nosed critic") and the
  -- trigger ("when the user asks for feedback on their own prose") are
  -- different texts, and embedding the instructions would match on style words
  -- that say nothing about when the prompt is wanted.
  ADD COLUMN IF NOT EXISTS when_to_use text NOT NULL DEFAULT '',
  -- vector(768), NOT halfvec(1536): this must live in the same space as
  -- knowledge_entries.embedding, because the router reuses the query vector
  -- that knowledge-retrieve already computed for that column. Comparing a
  -- vector from one model against another is noise that merely looks like a
  -- score, so the model id is stamped alongside it and a mismatch re-embeds.
  ADD COLUMN IF NOT EXISTS embedding vector(768),
  ADD COLUMN IF NOT EXISTS embedding_model text,
  -- Opt-in per prompt. A prompt with routing off is still switchable by hand;
  -- it simply never competes for a turn on its own.
  ADD COLUMN IF NOT EXISTS routing_enabled boolean NOT NULL DEFAULT false,
  -- Per-prompt tunables, defaulted to Smart Filing's production values.
  ADD COLUMN IF NOT EXISTS confident_threshold real NOT NULL DEFAULT 0.78,
  ADD COLUMN IF NOT EXISTS novelty_threshold real NOT NULL DEFAULT 0.55,
  -- Context bindings. Switching to a prompt can also load its neurons and
  -- narrow its tools, so one switch changes the whole working setup rather
  -- than only the wording. NULL/empty = inherit whatever is already loaded.
  ADD COLUMN IF NOT EXISTS neuron_ids uuid[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS book_id uuid,
  -- Tool bindings may only ever NARROW the roster. Granting stays with the
  -- existing permission gates, which this column must never be able to reach.
  ADD COLUMN IF NOT EXISTS tool_permissions jsonb,
  -- Provenance, shown on the card: a prompt the assistant drafted and the user
  -- approved must never be indistinguishable from one the user wrote.
  ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'user',
  ADD COLUMN IF NOT EXISTS approved_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'prompt_presets_origin_check'
  ) THEN
    ALTER TABLE public.prompt_presets
      ADD CONSTRAINT prompt_presets_origin_check CHECK (origin IN ('user', 'assistant'));
  END IF;
END $$;

COMMENT ON COLUMN public.prompt_presets.when_to_use IS
  'Natural-language description of the requests this prompt is FOR. Embedded and matched against the user turn by the router; never sent to the model as instructions.';
COMMENT ON COLUMN public.prompt_presets.tool_permissions IS
  'Optional subset of chat tools this prompt narrows to. NEVER a grant: the roster is intersected with the user''s existing permissions, so a prompt can only ever take tools away.';

CREATE INDEX IF NOT EXISTS prompt_presets_routing_idx
  ON public.prompt_presets (user_id) WHERE routing_enabled;

-- ---------------------------------------------------------------------------
-- 2. prompt_routing_decisions — every decision, so accuracy is measurable
--
-- A copy of public.routing_decisions. `user_corrected` is what the Undo button
-- on a reply's prompt receipt writes, and what the auto-pause reads: a router
-- the user keeps overruling stops routing instead of arguing.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.prompt_routing_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  -- Similarity scores only. The turn itself is NOT stored here: it is already
  -- in chat_messages, and a second copy under a different retention rule is a
  -- liability with no reader.
  s_max real, s_active real, s_2nd real, novelty real,
  proposed_prompt_id uuid REFERENCES public.prompt_presets(id) ON DELETE SET NULL,
  proposed_action text NOT NULL,
  final_prompt_id uuid REFERENCES public.prompt_presets(id) ON DELETE SET NULL,
  user_corrected boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prompt_routing_decisions_action_check
    CHECK (proposed_action IN ('keep', 'switch', 'plain', 'propose_new'))
);

CREATE INDEX IF NOT EXISTS prompt_routing_decisions_user_idx
  ON public.prompt_routing_decisions (user_id, created_at DESC);

ALTER TABLE public.prompt_routing_decisions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'prompt_routing_decisions' AND policyname = 'Users can read own prompt routing decisions') THEN
    CREATE POLICY "Users can read own prompt routing decisions" ON public.prompt_routing_decisions
      FOR SELECT TO authenticated USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'prompt_routing_decisions' AND policyname = 'Users can insert own prompt routing decisions') THEN
    CREATE POLICY "Users can insert own prompt routing decisions" ON public.prompt_routing_decisions
      FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'prompt_routing_decisions' AND policyname = 'Users can update own prompt routing decisions') THEN
    CREATE POLICY "Users can update own prompt routing decisions" ON public.prompt_routing_decisions
      FOR UPDATE TO authenticated USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'prompt_routing_decisions' AND policyname = 'Users can delete own prompt routing decisions') THEN
    CREATE POLICY "Users can delete own prompt routing decisions" ON public.prompt_routing_decisions
      FOR DELETE TO authenticated USING (auth.uid() = user_id);
  END IF;
END $$;

-- PostgREST reaches these as `authenticated`, so the role needs table
-- privileges as well as a policy: RLS narrows what a grant allows, it does
-- not confer one. Explicit rather than relying on the project's default
-- privileges, which are configuration and not part of this file.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.prompt_routing_decisions TO authenticated;
GRANT ALL ON public.prompt_routing_decisions TO service_role;

-- ---------------------------------------------------------------------------
-- 3. prompt_incubator_turns — evidence that a prompt is MISSING
--
-- A turn the router could not place (nothing scored above novelty_threshold)
-- parks here. When enough of them cluster, prompt-incubator-sweep drafts ONE
-- proposal. This is why the assistant needs no chat tool to suggest a prompt:
-- the suggestion is earned from accumulated evidence, not asked for on a whim.
--
-- `gist` is the first ~200 characters of the turn. That is not a new
-- disclosure — chat_messages already persists the full transcript under the
-- same RLS — but it IS separately deletable, and it expires.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.prompt_incubator_turns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  gist text NOT NULL DEFAULT '',
  embedding vector(768),
  embedding_model text,
  status text NOT NULL DEFAULT 'pending',
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prompt_incubator_turns_status_check
    CHECK (status IN ('pending', 'clustered', 'expired', 'promoted', 'dismissed'))
);

CREATE INDEX IF NOT EXISTS prompt_incubator_turns_user_status_idx
  ON public.prompt_incubator_turns (user_id, status);
CREATE INDEX IF NOT EXISTS prompt_incubator_turns_expires_idx
  ON public.prompt_incubator_turns (expires_at) WHERE status = 'pending';

ALTER TABLE public.prompt_incubator_turns ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'prompt_incubator_turns' AND policyname = 'Users can read own prompt incubator') THEN
    CREATE POLICY "Users can read own prompt incubator" ON public.prompt_incubator_turns
      FOR SELECT TO authenticated USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'prompt_incubator_turns' AND policyname = 'Users can insert own prompt incubator') THEN
    CREATE POLICY "Users can insert own prompt incubator" ON public.prompt_incubator_turns
      FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'prompt_incubator_turns' AND policyname = 'Users can update own prompt incubator') THEN
    CREATE POLICY "Users can update own prompt incubator" ON public.prompt_incubator_turns
      FOR UPDATE TO authenticated USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'prompt_incubator_turns' AND policyname = 'Users can delete own prompt incubator') THEN
    CREATE POLICY "Users can delete own prompt incubator" ON public.prompt_incubator_turns
      FOR DELETE TO authenticated USING (auth.uid() = user_id);
  END IF;
END $$;

-- PostgREST reaches these as `authenticated`, so the role needs table
-- privileges as well as a policy: RLS narrows what a grant allows, it does
-- not confer one. Explicit rather than relying on the project's default
-- privileges, which are configuration and not part of this file.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.prompt_incubator_turns TO authenticated;
GRANT ALL ON public.prompt_incubator_turns TO service_role;

-- ---------------------------------------------------------------------------
-- 4. prompt_proposals — drafted by the assistant, inert until approved
--
-- THE SAFETY PROPERTY: a proposal lives ONLY here. The prompt builder reads
-- prompt_presets and nothing else, so no text the assistant writes can reach
-- the model until the user presses Approve and a row is created over there.
-- That is why this feature needs none of the SECURITY DEFINER / GUC / immutable
-- -row apparatus the Tool and Program Foundries need: there is no draft state
-- on the live table to escalate out of.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.prompt_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  proposed_name text NOT NULL,
  proposed_body text NOT NULL DEFAULT '',
  when_to_use text NOT NULL DEFAULT '',
  rationale text NOT NULL DEFAULT '',
  sample_gists text[] NOT NULL DEFAULT '{}',
  member_turn_ids uuid[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prompt_proposals_status_check
    CHECK (status IN ('pending', 'accepted', 'dismissed', 'expired'))
);

CREATE INDEX IF NOT EXISTS prompt_proposals_user_status_idx
  ON public.prompt_proposals (user_id, status);

ALTER TABLE public.prompt_proposals ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'prompt_proposals' AND policyname = 'Users can read own prompt proposals') THEN
    CREATE POLICY "Users can read own prompt proposals" ON public.prompt_proposals
      FOR SELECT TO authenticated USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'prompt_proposals' AND policyname = 'Users can insert own prompt proposals') THEN
    CREATE POLICY "Users can insert own prompt proposals" ON public.prompt_proposals
      FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'prompt_proposals' AND policyname = 'Users can update own prompt proposals') THEN
    CREATE POLICY "Users can update own prompt proposals" ON public.prompt_proposals
      FOR UPDATE TO authenticated USING (auth.uid() = user_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'prompt_proposals' AND policyname = 'Users can delete own prompt proposals') THEN
    CREATE POLICY "Users can delete own prompt proposals" ON public.prompt_proposals
      FOR DELETE TO authenticated USING (auth.uid() = user_id);
  END IF;
END $$;

-- PostgREST reaches these as `authenticated`, so the role needs table
-- privileges as well as a policy: RLS narrows what a grant allows, it does
-- not confer one. Explicit rather than relying on the project's default
-- privileges, which are configuration and not part of this file.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.prompt_proposals TO authenticated;
GRANT ALL ON public.prompt_proposals TO service_role;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'prompt_proposals_updated_at') THEN
    CREATE TRIGGER prompt_proposals_updated_at
      BEFORE UPDATE ON public.prompt_proposals
      FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 5. user_settings: the two global switches
-- ---------------------------------------------------------------------------

ALTER TABLE public.user_settings
  -- Master switch. OFF = today's behaviour exactly; the router never runs.
  ADD COLUMN IF NOT EXISTS prompt_routing_enabled boolean NOT NULL DEFAULT false,
  -- PRISM (arXiv 2603.18507): expert personas reliably improve alignment-style
  -- tasks and reliably DAMAGE factual recall (MMLU 68.0% under a persona vs
  -- 71.6% plain). So when a turn is dominated by memory retrieval, the router
  -- keeps a plain voice instead of wearing a persona over the top of it.
  ADD COLUMN IF NOT EXISTS prompt_plain_on_recall boolean NOT NULL DEFAULT true;
