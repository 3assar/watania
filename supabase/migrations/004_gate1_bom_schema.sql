-- 004_gate1_bom_schema.sql
-- Date: 2026-06-28
-- Gate 1 — BOM normalization (issue 2.6 / M2 / L1). Built & verified on Tester first.
-- Source of truth (decision 2026-06-28): these tables. moulds.material_recipe becomes
-- read-only legacy/provenance; product_overrides.bom_json retired after dual-read.
-- Security model: anon = SELECT only; all writes via the service-role /api/mutate proxy.
--
-- Shape: part (bom_components) -> recipes (default + named alternatives, each on/off-able,
-- all editable) -> materials. Colours sit at the part level. Recipes are deliberately
-- flexible: a part can carry alternative recipes (material-out swaps, quality tweaks) and
-- they can be edited freely — past work orders snapshot what they used, so history is safe.

CREATE TABLE IF NOT EXISTS units_of_measure (
  id        smallserial PRIMARY KEY,
  code      text NOT NULL UNIQUE,
  name_en   text NOT NULL,
  kind      text NOT NULL CHECK (kind IN ('mass','count','ratio')),
  to_base_g numeric
);

CREATE TABLE IF NOT EXISTS materials (
  id           smallserial PRIMARY KEY,
  name_ar      text NOT NULL UNIQUE,
  name_en      text,
  polymer_type text,
  grade        text,
  modifier     text,
  active       boolean NOT NULL DEFAULT true,
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS colours (
  id         serial PRIMARY KEY,
  name_ar    text NOT NULL UNIQUE,
  name_en    text,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One component per mould (the part that mould produces).
CREATE TABLE IF NOT EXISTS bom_components (
  id            serial PRIMARY KEY,
  mould_id      integer NOT NULL REFERENCES moulds(id) ON DELETE CASCADE,
  product_id    varchar REFERENCES products(id),
  part_weight_g numeric,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (mould_id)
);

-- Multiple recipes per component: one default + named alternatives. Editable; retire via active=false.
CREATE TABLE IF NOT EXISTS bom_recipes (
  id                serial PRIMARY KEY,
  bom_component_id  integer NOT NULL REFERENCES bom_components(id) ON DELETE CASCADE,
  name              text NOT NULL DEFAULT 'Standard',
  is_default        boolean NOT NULL DEFAULT false,
  active            boolean NOT NULL DEFAULT true,
  source_recipe_raw text,            -- original freetext provenance (the seeded default)
  note              text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
-- At most one default recipe per component.
CREATE UNIQUE INDEX IF NOT EXISTS bom_recipe_one_default ON bom_recipes(bom_component_id) WHERE is_default;

-- The mix for a recipe, as relative parts (ratio_qty). qty_explicit=false => quantity was
-- not written in the source freetext and defaulted to 1 (pure / "1 part").
CREATE TABLE IF NOT EXISTS bom_recipe_materials (
  id            serial PRIMARY KEY,
  bom_recipe_id integer NOT NULL REFERENCES bom_recipes(id) ON DELETE CASCADE,
  material_id   smallint NOT NULL REFERENCES materials(id),
  ratio_qty     numeric NOT NULL,
  qty_explicit  boolean NOT NULL DEFAULT true,
  position      integer NOT NULL DEFAULT 1,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bom_component_colours (
  id               serial PRIMARY KEY,
  bom_component_id integer NOT NULL REFERENCES bom_components(id) ON DELETE CASCADE,
  colour_id        integer NOT NULL REFERENCES colours(id),
  UNIQUE (bom_component_id, colour_id)
);

CREATE INDEX IF NOT EXISTS bom_comp_product_idx ON bom_components(product_id);
CREATE INDEX IF NOT EXISTS bom_recipe_comp_idx  ON bom_recipes(bom_component_id);
CREATE INDEX IF NOT EXISTS brm_recipe_idx       ON bom_recipe_materials(bom_recipe_id);
CREATE INDEX IF NOT EXISTS brm_material_idx     ON bom_recipe_materials(material_id);
CREATE INDEX IF NOT EXISTS bcc_comp_idx         ON bom_component_colours(bom_component_id);
CREATE INDEX IF NOT EXISTS bcc_colour_idx       ON bom_component_colours(colour_id);

-- Security: reduce anon to SELECT-only on every new table (Supabase default also grants
-- write + TRUNCATE/REFERENCES/TRIGGER; none REST-reachable but revoke for hygiene).
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['units_of_measure','materials','colours','bom_components','bom_recipes','bom_recipe_materials','bom_component_colours']
  LOOP
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.%I FROM anon', t);
    EXECUTE format('GRANT SELECT ON public.%I TO anon', t);
  END LOOP;
END $$;
