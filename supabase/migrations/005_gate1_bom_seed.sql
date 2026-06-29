-- 005_gate1_bom_seed.sql
-- Date: 2026-06-28
-- Seeds the Gate 1 BOM tables by parsing moulds.material_recipe + moulds.colours IN-DATABASE,
-- mirroring the verified Python parser (GATE1_RECIPE_VERIFICATION.md). Verified on Tester:
-- 24 materials, 122 colours used, 550 components, 550 default recipes, 1052 material links,
-- 1503 colour links, 0 components without a default, 0 default recipes without materials.
-- Decoder ring: مخفف=Homopolymer, مركز=Copolymer, trailing number = grade, صافي = "pure"
-- (dropped as a standalone material), كسر صافي merged into كسر, أبيض colour merged into
-- أبيض 14, recipe "70 صافي" ruled by user = مركز 70 ×1. The seeded freetext becomes each
-- part's default 'Standard' recipe; alternatives are added later via the app.
-- Idempotent on masters (ON CONFLICT); run once against empty BOM tables.

-- 1. Units
INSERT INTO units_of_measure (code,name_en,kind,to_base_g) VALUES
  ('g','Gram','mass',1),('kg','Kilogram','mass',1000),('bag','Bag (25 kg)','mass',25000),
  ('pc','Piece','count',NULL),('part','Part (ratio)','ratio',NULL)
ON CONFLICT (code) DO NOTHING;

-- 2. Materials master — distinct parsed names (merge كسر صافي→كسر, drop lone صافي, + override target مركز 70)
WITH all_tokens AS (
  SELECT btrim(translate(
           regexp_replace(regexp_replace(regexp_replace(
             regexp_replace(btrim(tk.tok), '^[0-9]+\s*', ''),
             '([؀-ۿ])([0-9])','\1 \2','g'),'([0-9])([؀-ۿ])','\1 \2','g'),'\s+',' ','g'),
           E'‎‏','')) AS name_norm
  FROM moulds mo
  CROSS JOIN LATERAL regexp_split_to_table(mo.material_recipe, '[\\+]+') WITH ORDINALITY AS tk(tok,ord)
  WHERE mo.material_recipe IS NOT NULL AND btrim(mo.material_recipe) <> ''
    AND btrim(mo.material_recipe) <> '70 صافي' AND btrim(tk.tok) <> ''
),
mat_names AS (
  SELECT DISTINCT CASE WHEN name_norm='كسر صافي' THEN 'كسر' ELSE name_norm END AS name_ar
  FROM all_tokens WHERE name_norm <> '' AND name_norm <> 'صافي'
  UNION SELECT 'مركز 70'
)
INSERT INTO materials (name_ar, polymer_type, grade, modifier)
SELECT name_ar,
  CASE
    WHEN name_ar LIKE 'مخفف%' THEN 'Homopolymer'
    WHEN name_ar LIKE 'مركز%' THEN 'Copolymer'
    WHEN name_ar LIKE 'كسر شنطة%' THEN 'Polyethylene (regrind)'
    WHEN name_ar LIKE 'كسر%' THEN 'Regrind'
    WHEN name_ar LIKE 'خامة شنطة%' THEN 'Polyethylene'
    WHEN name_ar LIKE 'خامة زجاج%' THEN 'Glass-filled'
    WHEN name_ar LIKE 'مجفف%' THEN 'Drier'
    WHEN name_ar LIKE 'خليط%' THEN 'Blend'
    WHEN name_ar LIKE 'شفاف%' THEN 'Transparent'
    WHEN name_ar LIKE 'مخرز%' THEN 'Other'
  END,
  substring(name_ar from '([0-9]+)'),
  NULLIF(btrim(concat_ws('/',
    CASE WHEN name_ar LIKE '%ناشف%' THEN 'dry' END,
    CASE WHEN name_ar LIKE '%فايبر%' THEN 'fiber' END,
    CASE WHEN name_ar LIKE '%صافي%' THEN 'pure' END)),'')
FROM mat_names
ON CONFLICT (name_ar) DO NOTHING;

-- 3. Colours master — distinct normalized colours used by moulds (أبيض→أبيض 14, drop ''/'0')
INSERT INTO colours (name_ar)
SELECT DISTINCT CASE WHEN nm='أبيض' THEN 'أبيض 14' ELSE nm END
FROM (
  SELECT btrim(translate(
           regexp_replace(regexp_replace(regexp_replace(
             col.raw,'([؀-ۿ])([0-9])','\1 \2','g'),'([0-9])([؀-ۿ])','\1 \2','g'),'\s+',' ','g'),
           E'‎‏','')) AS nm
  FROM moulds mo
  CROSS JOIN LATERAL jsonb_array_elements_text(mo.colours) AS col(raw)
  WHERE mo.colours IS NOT NULL AND jsonb_typeof(mo.colours)='array'
) x
WHERE nm <> '' AND nm <> '0'
ON CONFLICT (name_ar) DO NOTHING;

-- 4. bom_components — one per mould with a recipe
INSERT INTO bom_components (mould_id, product_id)
SELECT id, product_id FROM moulds
WHERE material_recipe IS NOT NULL AND btrim(material_recipe) <> ''
ON CONFLICT (mould_id) DO NOTHING;

-- 5. Default 'Standard' recipe per component (keeps original freetext as provenance)
INSERT INTO bom_recipes (bom_component_id, name, is_default, source_recipe_raw)
SELECT bc.id, 'Standard', true, mo.material_recipe
FROM bom_components bc JOIN moulds mo ON mo.id = bc.mould_id
WHERE NOT EXISTS (SELECT 1 FROM bom_recipes r WHERE r.bom_component_id = bc.id AND r.is_default);

-- 6. Recipe materials — parse source_recipe_raw, position-renumber after drops
WITH parsed AS (
  SELECT br.id AS recipe_id, tk.ord,
    NULLIF(substring(btrim(tk.tok) from '^[0-9]+'),'')::int AS lead_qty,
    btrim(translate(regexp_replace(regexp_replace(regexp_replace(
       regexp_replace(btrim(tk.tok),'^[0-9]+\s*',''),
       '([؀-ۿ])([0-9])','\1 \2','g'),'([0-9])([؀-ۿ])','\1 \2','g'),'\s+',' ','g'),E'‎‏','')) AS name_norm
  FROM bom_recipes br
  CROSS JOIN LATERAL regexp_split_to_table(br.source_recipe_raw,'[\\+]+') WITH ORDINALITY AS tk(tok,ord)
  WHERE btrim(br.source_recipe_raw) <> '70 صافي' AND btrim(tk.tok) <> ''
),
mapped AS (
  SELECT recipe_id, ord, lead_qty,
    CASE WHEN name_norm='كسر صافي' THEN 'كسر' ELSE name_norm END AS name_final
  FROM parsed WHERE name_norm <> '' AND name_norm <> 'صافي'
)
INSERT INTO bom_recipe_materials (bom_recipe_id, material_id, ratio_qty, qty_explicit, position)
SELECT mp.recipe_id, m.id, COALESCE(mp.lead_qty,1), mp.lead_qty IS NOT NULL,
       row_number() OVER (PARTITION BY mp.recipe_id ORDER BY mp.ord)
FROM mapped mp JOIN materials m ON m.name_ar = mp.name_final;

-- 6b. Override: 70 صافي -> مركز 70 ×1 (user ruling 2026-06-28)
INSERT INTO bom_recipe_materials (bom_recipe_id, material_id, ratio_qty, qty_explicit, position)
SELECT br.id, m.id, 1, false, 1
FROM bom_recipes br JOIN materials m ON m.name_ar = 'مركز 70'
WHERE btrim(br.source_recipe_raw) = '70 صافي';

-- 7. bom_component_colours — from moulds.colours, normalized + أبيض merge
WITH mc AS (
  SELECT bc.id AS comp_id, CASE WHEN nm='أبيض' THEN 'أبيض 14' ELSE nm END AS colour_name
  FROM bom_components bc
  JOIN moulds mo ON mo.id = bc.mould_id
  CROSS JOIN LATERAL jsonb_array_elements_text(mo.colours) AS col(raw)
  CROSS JOIN LATERAL (SELECT btrim(translate(regexp_replace(regexp_replace(regexp_replace(
     col.raw,'([؀-ۿ])([0-9])','\1 \2','g'),'([0-9])([؀-ۿ])','\1 \2','g'),'\s+',' ','g'),E'‎‏','')) AS nm) n
  WHERE mo.colours IS NOT NULL AND jsonb_typeof(mo.colours)='array' AND nm <> '' AND nm <> '0'
)
INSERT INTO bom_component_colours (bom_component_id, colour_id)
SELECT DISTINCT mc.comp_id, c.id
FROM mc JOIN colours c ON c.name_ar = mc.colour_name
ON CONFLICT DO NOTHING;
