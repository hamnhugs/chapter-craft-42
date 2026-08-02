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
