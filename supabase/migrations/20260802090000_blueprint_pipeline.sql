-- Vector Blueprint Pipeline.
--
-- ONE authoritative definition per asset, with every drawing DERIVED from it.
-- master_assets.tech_pack_text stays exactly as it is: it holds prose written
-- for a human, and the QC checklist still reads it. The new `blueprint` column
-- holds the machine-readable twin — parts, joints, attach points, proportions
-- in head-units, palette roles — that geometry.ts can project and validate.
-- Neither replaces the other; a master may have one, both, or neither.
--
-- WHY JSONB AND NOT COLUMNS. The blueprint is validated by a zod schema plus a
-- structural pass in the client (referential integrity between parts, attach
-- points and palette roles is not expressible in a table constraint anyway),
-- and its shape will move as the renderer learns new primitives. A versioned
-- document with a checked `version` key is the honest representation.
--
-- Idempotent: safe to re-run.

-- ── B1: the blueprint document ──────────────────────────────────────────────

ALTER TABLE public.master_assets ADD COLUMN IF NOT EXISTS blueprint JSONB;

COMMENT ON COLUMN public.master_assets.blueprint IS
  'Structured tech pack (Blueprint v1): parts, attach points, joints, landmarks, palette roles, costume layers, marks. Sizes are in head-units and attach points are normalized 0..1 on a face, so the document carries no absolute coordinates. Views are projected from it, never drawn independently. NULL means this master is prose-only.';

-- Only ever store a document that names its own version — an unversioned blob
-- is unreadable the first time the schema moves.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'master_assets_blueprint_versioned'
  ) THEN
    ALTER TABLE public.master_assets
      ADD CONSTRAINT master_assets_blueprint_versioned
      CHECK (blueprint IS NULL OR (blueprint ? 'version' AND blueprint ? 'kind'));
  END IF;
END $$;

-- Finding a master by asset kind is the one query the sheet UI needs that the
-- existing indexes don't serve.
CREATE INDEX IF NOT EXISTS idx_master_assets_blueprint_kind
  ON public.master_assets ((blueprint ->> 'kind'))
  WHERE blueprint IS NOT NULL;

-- ── B4: scenes ──────────────────────────────────────────────────────────────
--
-- The app has chapters and it has characters, and nothing in between. This is
-- the missing layer: one location's set geometry, blocking, camera setups and
-- shot list. `plan` holds the whole document (see scene.ts) because it is one
-- coherent drawing rather than a set of independently queried rows — the same
-- reasoning as master_assets.blueprint.
--
-- book_id / chapter_index are optional: a scene may be pinned to a point in the
-- manuscript, or exist on its own while the story is still moving.

CREATE TABLE IF NOT EXISTS public.production_scenes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL DEFAULT '',
  book_id       UUID,
  chapter_index INTEGER,
  -- Asset Factory neuron documenting this scene, mirroring master_assets.
  entry_id      UUID REFERENCES public.knowledge_entries(id) ON DELETE SET NULL,
  plan          JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_production_scenes_user_name
  ON public.production_scenes(user_id, lower(name));
CREATE INDEX IF NOT EXISTS idx_production_scenes_user
  ON public.production_scenes(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_production_scenes_book
  ON public.production_scenes(book_id, chapter_index)
  WHERE book_id IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'production_scenes_plan_versioned'
  ) THEN
    ALTER TABLE public.production_scenes
      ADD CONSTRAINT production_scenes_plan_versioned
      CHECK (plan ? 'version' AND plan ? 'extent');
  END IF;
END $$;

ALTER TABLE public.production_scenes ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.production_scenes TO authenticated;
GRANT ALL ON public.production_scenes TO service_role;

DROP POLICY IF EXISTS "Users can view own scenes" ON public.production_scenes;
CREATE POLICY "Users can view own scenes"
ON public.production_scenes FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own scenes" ON public.production_scenes;
CREATE POLICY "Users can insert own scenes"
ON public.production_scenes FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own scenes" ON public.production_scenes;
CREATE POLICY "Users can update own scenes"
ON public.production_scenes FOR UPDATE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own scenes" ON public.production_scenes;
CREATE POLICY "Users can delete own scenes"
ON public.production_scenes FOR DELETE USING (auth.uid() = user_id);

COMMENT ON COLUMN public.production_scenes.plan IS
  'Scene document v1: extent, walls, props, blocking, cameras (focal length + sensor format), lights, shots. Coverage is DERIVED from this — which subjects a setup actually sees is computed from the optics, never asserted. Shot numbers step by 10 so an insert becomes 0015 rather than renumbering the sequence.';

-- ── B5: let the server honour the retired paywall ───────────────────────────
--
-- OPEN_ACCESS = true retires the paywall in the browser: the UI treats every
-- signed-in user as Pro and unlocks all five neurons. The database never got
-- the message — accessible_wiki_ids() still grants every wiki only to an admin
-- or a row in `subscribers`, and a RESTRICTIVE policy hides the rest. The
-- result is the worst kind of mismatch: the app lets you load five neurons and
-- the database silently returns nothing from four of them, which presents as
-- the assistant forgetting things rather than as a permission error.
--
-- `app_open_access()` is the single switch. Flip it back to false here and in
-- src/lib/openAccess.ts together if billing ever resumes.

CREATE OR REPLACE FUNCTION public.app_open_access()
RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE
AS $$ SELECT true $$;

COMMENT ON FUNCTION public.app_open_access() IS
  'Server-side mirror of OPEN_ACCESS in src/lib/openAccess.ts. While true, entitlement gates in RLS behave as if every signed-in user is subscribed. Change both together.';

CREATE OR REPLACE FUNCTION public.accessible_wiki_ids(uid UUID)
RETURNS SETOF UUID
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT w.id FROM public.wikis w
  WHERE w.user_id = uid
    AND (
      public.app_open_access()
      OR public.has_role(uid, 'admin'::public.app_role)
      OR (SELECT COALESCE(bool_or(s.subscribed), false)
            FROM public.subscribers s WHERE s.user_id = uid)
      OR w.id = (SELECT w2.id FROM public.wikis w2
                  WHERE w2.user_id = uid
                  ORDER BY w2.created_at ASC, w2.id ASC
                  LIMIT 1)
    );
$$;
