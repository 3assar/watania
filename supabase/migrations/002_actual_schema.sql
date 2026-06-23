-- =============================================================================
-- 002_actual_schema.sql
-- Snapshot of the LIVE Supabase schema as of 2026-06-22
-- This file is documentation — it reconciles the gap between 001_phase1_schema.sql
-- (which reflected an older design) and the actual current state of the DB.
-- It is idempotent: safe to run against a fresh DB to reproduce current state.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- SEQUENCES
-- ---------------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS activity_log_id_seq;
CREATE SEQUENCE IF NOT EXISTS inventory_id_seq;
CREATE SEQUENCE IF NOT EXISTS moulds_id_seq;
CREATE SEQUENCE IF NOT EXISTS users_id_seq;
CREATE SEQUENCE IF NOT EXISTS workers_id_seq;
CREATE SEQUENCE IF NOT EXISTS work_order_seq;  -- used by generate_work_order_id()

-- ---------------------------------------------------------------------------
-- TABLES
-- ---------------------------------------------------------------------------

-- users — app-level auth (NOT Supabase Auth)
CREATE TABLE IF NOT EXISTS public.users (
  id            INTEGER PRIMARY KEY DEFAULT nextval('users_id_seq'),
  username      TEXT    NOT NULL UNIQUE,
  email         TEXT,
  password_hash TEXT    NOT NULL,
  role          TEXT    NOT NULL DEFAULT 'viewer'
                  CHECK (role IN ('admin','supervisor','operator','viewer')),
  active        BOOLEAN DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login    TIMESTAMPTZ,
  last_action   TEXT,
  last_action_at TIMESTAMPTZ
);

-- machines — 60 injection-moulding machines across 3 sectors (A, B, C)
CREATE TABLE IF NOT EXISTS public.machines (
  id               UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT    NOT NULL UNIQUE,
  tonnage          INTEGER NOT NULL,
  status           TEXT    NOT NULL DEFAULT 'idle',
  current_order_id TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  sector           TEXT,
  wc_code          TEXT
);

-- products — master product catalogue (synced from ERP)
CREATE TABLE IF NOT EXISTS public.products (
  id                   VARCHAR PRIMARY KEY,
  name                 TEXT    NOT NULL,
  barcode              TEXT,
  internal_code        TEXT,
  category             TEXT    NOT NULL,
  subcategory          TEXT,
  weight_g             NUMERIC,
  dimensions_json      JSONB,
  cycle_time_sec       NUMERIC,
  shot_weight_g        NUMERIC,
  pcs_per_cycle        INTEGER DEFAULT 1,
  machine_min_tonnage  INTEGER,
  machine_max_tonnage  INTEGER,
  bom_json             JSONB DEFAULT '[]',
  dye_ratio            NUMERIC DEFAULT 0.50,
  active               BOOLEAN DEFAULT true,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  name_ar              TEXT,
  barcodes_json        JSONB,
  colours_json         JSONB,
  image_data           TEXT,
  image_url            TEXT,
  notes                TEXT,
  production_status    TEXT NOT NULL DEFAULT 'not_started',
  last_produced_at     DATE
);

-- product_overrides — user-edited overrides on top of synced product data
CREATE TABLE IF NOT EXISTS public.product_overrides (
  product_id          VARCHAR PRIMARY KEY,
  name_en_override    TEXT,
  name_ar_override    TEXT,
  code_override       TEXT,
  barcode_override    TEXT,
  category_override   TEXT,
  subcategory_override TEXT,
  image_data          TEXT,
  notes               TEXT,
  bom_json            JSONB DEFAULT '[]',
  weight              TEXT,
  dimensions          TEXT,
  volume              TEXT,
  packaging_json      JSONB,
  quality_json        JSONB,
  assembly_steps      JSONB,
  revisions           JSONB,
  last_edited_by      TEXT,
  last_edited_at      TIMESTAMPTZ,
  trashed             BOOLEAN DEFAULT false,
  trashed_by          TEXT,
  trashed_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  has_image           BOOLEAN DEFAULT false
);

-- moulds — mould catalogue (linked to products and machines)
CREATE TABLE IF NOT EXISTS public.moulds (
  id                  INTEGER PRIMARY KEY DEFAULT nextval('moulds_id_seq'),
  dp_idx              INTEGER,
  name_ar             TEXT    NOT NULL,
  group_ar            TEXT,
  subgroup            TEXT,
  mould_code          TEXT,
  material_recipe     TEXT,
  pieces_per_cycle    INTEGER DEFAULT 1,
  cycle_time_sec      NUMERIC,
  compatible_machines JSONB   DEFAULT '[]',
  colours             JSONB   DEFAULT '[]',
  internal_id         TEXT,
  product_id          VARCHAR,
  part_number         INTEGER DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- work_orders — one WO per mould run
CREATE TABLE IF NOT EXISTS public.work_orders (
  id                    TEXT    PRIMARY KEY,  -- WO-YYYY-NNNN via generate_work_order_id()
  product_id            VARCHAR NOT NULL,
  machine_id            UUID,
  created_by            TEXT    NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  due_date              DATE,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  status                TEXT    NOT NULL DEFAULT 'planned',
  total_qty             INTEGER NOT NULL,
  colours_json          JSONB   NOT NULL DEFAULT '[]',
  raw_material_qty_kg   NUMERIC,
  planned_runtime_hours NUMERIC,
  planned_shift_hours   NUMERIC,
  mould_in_at           TIMESTAMPTZ,
  mould_out_at          TIMESTAMPTZ,
  completed_at          TIMESTAMPTZ,
  notes                 TEXT,
  weight_per_piece_g    NUMERIC,
  cooling_time_s        INTEGER,
  cycle_time_s          INTEGER,
  pieces_per_cycle      INTEGER DEFAULT 1,
  day_worker            TEXT,
  night_worker          TEXT,
  material_recipe       TEXT,
  produced_qty          INTEGER DEFAULT 0,   -- maintained by fn_update_produced_qty trigger
  mould_name            TEXT,
  started_at            TIMESTAMPTZ,
  overtime_reason       TEXT,
  early_completion_notes TEXT,
  archived              BOOLEAN NOT NULL DEFAULT false
);

-- shift_logs — one row per (order_id, log_date); day + night split
-- INSERT/UPDATE/DELETE fires fn_update_produced_qty trigger on work_orders
CREATE TABLE IF NOT EXISTS public.shift_logs (
  id                    UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id              TEXT    NOT NULL,
  log_date              DATE    NOT NULL,
  shift                 TEXT,
  worker_name           TEXT,
  worker_id             INTEGER,
  units_produced        INTEGER DEFAULT 0,   -- legacy (unused by new UI)
  waste_units           INTEGER DEFAULT 0,   -- legacy
  waste_percentage      NUMERIC,
  colour_breakdown_json JSONB,
  actual_shift_hours    NUMERIC,
  notes                 TEXT,
  supervisor_sign_off   BOOLEAN DEFAULT false,
  supervisor_name       TEXT,
  supervisor_sign_off_at TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  day_production        INTEGER DEFAULT 0,   -- active field: day shift output
  day_waste             INTEGER DEFAULT 0,
  day_worker            TEXT,
  night_production      INTEGER DEFAULT 0,  -- active field: night shift output
  night_waste           INTEGER DEFAULT 0,
  night_worker          TEXT,
  UNIQUE (order_id, log_date)
);

-- pause_logs — one row per pause event (resumed_at NULL = currently paused)
CREATE TABLE IF NOT EXISTS public.pause_logs (
  id           UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     TEXT    NOT NULL,
  paused_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  resumed_at   TIMESTAMPTZ,
  reason       TEXT    NOT NULL,
  reason_other TEXT,
  paused_by    TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- activity_log — audit trail for all user actions
CREATE TABLE IF NOT EXISTS public.activity_log (
  id          INTEGER PRIMARY KEY DEFAULT nextval('activity_log_id_seq'),
  user_id     INTEGER,
  action      TEXT    NOT NULL,
  entity_type TEXT,
  entity_id   TEXT,
  details     JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  module      TEXT       -- 'library' | 'production'
);

-- workers — worker roster (freetext name on logs, FK not enforced)
CREATE TABLE IF NOT EXISTS public.workers (
  id               INTEGER PRIMARY KEY DEFAULT nextval('workers_id_seq'),
  name             TEXT    NOT NULL,
  department       TEXT,
  shift_preference TEXT,
  hr_id            TEXT,
  active           BOOLEAN DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- inventory — per-product, per-colour stock ledger
CREATE TABLE IF NOT EXISTS public.inventory (
  id            INTEGER PRIMARY KEY DEFAULT nextval('inventory_id_seq'),
  product_id    VARCHAR NOT NULL,
  colour        TEXT,
  qty_on_hand   INTEGER DEFAULT 0,
  qty_reserved  INTEGER DEFAULT 0,
  qty_available INTEGER,  -- computed externally (on_hand - reserved)
  last_updated  TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes         TEXT
);

-- profiles — single-row JSON blob for app settings / user preferences
CREATE TABLE IF NOT EXISTS public.profiles (
  id         TEXT PRIMARY KEY DEFAULT 'profiles',
  data       JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- INDEXES
-- ---------------------------------------------------------------------------

-- users
CREATE UNIQUE INDEX IF NOT EXISTS users_username_key      ON public.users (username);
CREATE INDEX        IF NOT EXISTS users_username_idx      ON public.users (username);
CREATE INDEX        IF NOT EXISTS users_role_idx          ON public.users (role);

-- machines
CREATE INDEX        IF NOT EXISTS machines_status_idx     ON public.machines (status);
CREATE INDEX        IF NOT EXISTS machines_tonnage_idx    ON public.machines (tonnage);

-- products
CREATE INDEX        IF NOT EXISTS products_active_idx        ON public.products (active);
CREATE INDEX        IF NOT EXISTS products_barcode_idx       ON public.products (barcode);
CREATE INDEX        IF NOT EXISTS products_category_idx      ON public.products (category);
CREATE INDEX        IF NOT EXISTS products_internal_code_idx ON public.products (internal_code);

-- moulds
CREATE INDEX        IF NOT EXISTS moulds_dp_idx_idx       ON public.moulds (dp_idx);
CREATE INDEX        IF NOT EXISTS moulds_mould_code_idx   ON public.moulds (mould_code);
CREATE INDEX        IF NOT EXISTS moulds_product_id_idx   ON public.moulds (product_id);

-- work_orders
CREATE UNIQUE INDEX IF NOT EXISTS one_running_per_machine ON public.work_orders (machine_id)
  WHERE (status = 'in_progress' AND archived = false);  -- DB-enforced machine lock
CREATE INDEX        IF NOT EXISTS wo_archived_idx         ON public.work_orders (archived);
CREATE INDEX        IF NOT EXISTS wo_created_idx          ON public.work_orders (created_at DESC);
CREATE INDEX        IF NOT EXISTS wo_machine_idx          ON public.work_orders (machine_id);
CREATE INDEX        IF NOT EXISTS wo_machine_status_idx   ON public.work_orders (machine_id, status);
CREATE INDEX        IF NOT EXISTS wo_product_idx          ON public.work_orders (product_id);
CREATE INDEX        IF NOT EXISTS wo_status_archived_idx  ON public.work_orders (status, archived);
CREATE INDEX        IF NOT EXISTS wo_status_idx           ON public.work_orders (status);

-- shift_logs
CREATE UNIQUE INDEX IF NOT EXISTS shift_logs_order_date_unique ON public.shift_logs (order_id, log_date);
CREATE INDEX        IF NOT EXISTS sl_date_idx             ON public.shift_logs (log_date DESC);
CREATE INDEX        IF NOT EXISTS sl_order_idx            ON public.shift_logs (order_id);
CREATE INDEX        IF NOT EXISTS sl_shift_idx            ON public.shift_logs (shift);
CREATE INDEX        IF NOT EXISTS sl_worker_idx           ON public.shift_logs (worker_name);

-- activity_log
CREATE INDEX        IF NOT EXISTS activity_log_created_idx ON public.activity_log (created_at DESC);
CREATE INDEX        IF NOT EXISTS activity_log_entity_idx  ON public.activity_log (entity_type, entity_id);
CREATE INDEX        IF NOT EXISTS activity_log_user_idx    ON public.activity_log (user_id);

-- inventory
CREATE INDEX        IF NOT EXISTS inventory_product_colour_idx ON public.inventory (product_id, colour);

-- profiles
CREATE INDEX        IF NOT EXISTS profiles_updated_idx    ON public.profiles (updated_at DESC);

-- ---------------------------------------------------------------------------
-- FUNCTIONS
-- ---------------------------------------------------------------------------

-- Generates next WO ID: WO-YYYY-NNNN
CREATE OR REPLACE FUNCTION public.generate_work_order_id()
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
  new_id      TEXT;
  year_prefix TEXT;
BEGIN
  year_prefix := 'WO-' || TO_CHAR(CURRENT_DATE, 'YYYY') || '-';
  new_id := year_prefix || TO_CHAR(nextval('work_order_seq'), 'FM0000');
  RETURN new_id;
END;
$$;
GRANT EXECUTE ON FUNCTION public.generate_work_order_id() TO anon;

-- Atomic pause: set WO status=paused + insert pause_log row in one transaction
CREATE OR REPLACE FUNCTION public.pause_work_order(
  p_order_id    TEXT,
  p_reason      TEXT,
  p_reason_other TEXT,
  p_paused_by   TEXT
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  UPDATE work_orders SET status = 'paused' WHERE id = p_order_id;
  INSERT INTO pause_logs (order_id, paused_at, reason, reason_other, paused_by)
  VALUES (p_order_id, NOW(), p_reason, p_reason_other, p_paused_by);
END;
$$;
GRANT EXECUTE ON FUNCTION public.pause_work_order(TEXT,TEXT,TEXT,TEXT) TO anon;

-- Atomic resume: close open pause_log row + set WO status=in_progress in one transaction
CREATE OR REPLACE FUNCTION public.resume_work_order(
  p_order_id TEXT
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_log_id UUID;
BEGIN
  SELECT id INTO v_log_id
  FROM pause_logs
  WHERE order_id = p_order_id AND resumed_at IS NULL
  ORDER BY paused_at DESC LIMIT 1;

  IF v_log_id IS NOT NULL THEN
    UPDATE pause_logs SET resumed_at = NOW() WHERE id = v_log_id;
  END IF;

  UPDATE work_orders SET status = 'in_progress' WHERE id = p_order_id;
END;
$$;
GRANT EXECUTE ON FUNCTION public.resume_work_order(TEXT) TO anon;

-- Atomic delete: remove shift_logs + pause_logs + work_order in one transaction
CREATE OR REPLACE FUNCTION public.delete_work_order(
  p_order_id TEXT
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM shift_logs WHERE order_id = p_order_id;
  DELETE FROM pause_logs  WHERE order_id = p_order_id;
  DELETE FROM work_orders WHERE id       = p_order_id;
END;
$$;
GRANT EXECUTE ON FUNCTION public.delete_work_order(TEXT) TO anon;

-- Trigger: auto-update work_orders.produced_qty (and status) after any shift_log write
-- Only auto-advances status when current status is 'planned' or 'in_progress'
-- (will not flip a 'paused' or 'completed' WO back to in_progress)
CREATE OR REPLACE FUNCTION public.fn_update_produced_qty()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_order_id   TEXT;
  v_produced   BIGINT;
  v_total      INTEGER;
  v_cur_status TEXT;
  v_new_status TEXT;
BEGIN
  v_order_id := COALESCE(NEW.order_id, OLD.order_id);

  SELECT COALESCE(SUM(day_production + night_production), 0)
  INTO v_produced
  FROM shift_logs WHERE order_id = v_order_id;

  SELECT total_qty, status INTO v_total, v_cur_status
  FROM work_orders WHERE id = v_order_id;

  IF v_cur_status IN ('planned', 'in_progress') THEN
    v_new_status := CASE
      WHEN v_produced >= v_total AND v_total > 0 THEN 'completed'
      WHEN v_produced > 0                         THEN 'in_progress'
      ELSE 'planned'
    END;
    UPDATE work_orders SET produced_qty = v_produced, status = v_new_status
    WHERE id = v_order_id;
  ELSE
    UPDATE work_orders SET produced_qty = v_produced WHERE id = v_order_id;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_update_produced_qty ON public.shift_logs;
CREATE TRIGGER trg_update_produced_qty
  AFTER INSERT OR UPDATE OR DELETE ON public.shift_logs
  FOR EACH ROW EXECUTE FUNCTION public.fn_update_produced_qty();

-- updated_at auto-stamp trigger (attached to machines, work_orders, products, etc.)
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- VIEWS
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.v_work_order_summary AS
SELECT
  wo.id,
  wo.product_id,
  p.name AS product_name,
  wo.machine_id,
  m.name AS machine_name,
  wo.status,
  wo.total_qty,
  COALESCE(SUM(sl.day_production + sl.night_production), 0) AS actual_units_produced,
  wo.planned_runtime_hours,
  wo.created_at,
  wo.due_date
FROM work_orders wo
LEFT JOIN products      p  ON p.id  = wo.product_id
LEFT JOIN machines      m  ON m.id  = wo.machine_id
LEFT JOIN shift_logs    sl ON sl.order_id = wo.id
GROUP BY wo.id, p.name, m.name;

CREATE OR REPLACE VIEW public.v_waste_analysis AS
SELECT
  p.id,
  p.name,
  COUNT(DISTINCT wo.id)                                      AS total_orders,
  COALESCE(SUM(sl.day_production + sl.night_production), 0)  AS total_units,
  COALESCE(SUM(sl.day_waste      + sl.night_waste),      0)  AS total_waste,
  ROUND(
    CASE WHEN SUM(sl.day_production + sl.night_production) > 0
         THEN SUM(sl.day_waste + sl.night_waste)::NUMERIC
              / SUM(sl.day_production + sl.night_production) * 100
         ELSE 0 END, 2
  ) AS waste_pct
FROM products    p
LEFT JOIN work_orders  wo ON wo.product_id = p.id
LEFT JOIN shift_logs   sl ON sl.order_id   = wo.id
GROUP BY p.id, p.name;

CREATE OR REPLACE VIEW public.v_worker_output AS
SELECT
  sl.worker_name,
  DATE_TRUNC('week', sl.log_date)::DATE                      AS week_starting,
  COUNT(DISTINCT sl.order_id)                                AS orders_worked,
  COALESCE(SUM(sl.day_production + sl.night_production), 0)  AS total_units,
  COALESCE(SUM(sl.day_waste      + sl.night_waste),      0)  AS total_waste,
  ROUND(AVG(sl.waste_percentage), 2)                         AS avg_waste_pct,
  COALESCE(SUM(sl.actual_shift_hours), 0)                    AS total_hours
FROM shift_logs sl
GROUP BY sl.worker_name, DATE_TRUNC('week', sl.log_date);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
-- users: fully locked, column-level: password_hash NOT readable by anon
-- All other tables: anon_all (open) — future: tighten to session-validated roles

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
-- policies managed via Supabase dashboard (anon_select_users, anon_insert_users, etc.)
-- password_hash column is NOT granted to anon (column-level revocation)
