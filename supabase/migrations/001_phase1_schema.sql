-- ============================================================================
-- AWP System — Phase 1 Schema
-- Al Watania Plast Manufacturing Execution System
-- Created: 2026-06-18
-- Purpose: Product documentation, work orders, shift logs, inventory tracking
-- ============================================================================

-- ── EXTENSIONS ───────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- for gen_random_uuid()

-- ── HELPER: auto-update updated_at ───────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

-- ============================================================================
-- TABLE: machines
-- Injection-moulding machines on the factory floor
-- ============================================================================
CREATE TABLE IF NOT EXISTS machines (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT        NOT NULL UNIQUE,
  tonnage          INTEGER     NOT NULL,   -- clamping force in tonnes
  status           TEXT        NOT NULL DEFAULT 'idle'
                               CHECK (status IN ('idle','running','maintenance','offline')),
  current_order_id TEXT,                  -- FK to work_orders.id (text not uuid)

  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER machines_updated_at
  BEFORE UPDATE ON machines
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS machines_status_idx  ON machines (status);
CREATE INDEX IF NOT EXISTS machines_tonnage_idx ON machines (tonnage);

-- ============================================================================
-- TABLE: products
-- Mirrors the 437 existing product objects from Netlify Blobs
-- ============================================================================
CREATE TABLE IF NOT EXISTS products (
  id                  VARCHAR(50)  PRIMARY KEY,
  
  -- Identity
  name                TEXT        NOT NULL,
  barcode             TEXT,
  internal_code       TEXT,                 -- e.g. "01-001"

  -- Classification
  category            TEXT        NOT NULL,
  subcategory         TEXT,

  -- Physical specs
  weight_g            NUMERIC(10, 2),       -- grams
  dimensions_json     JSONB,                -- {length_mm, width_mm, height_mm}

  -- Moulding specs
  cycle_time_sec      NUMERIC(8, 2),
  shot_weight_g       NUMERIC(10, 2),
  pcs_per_cycle       INTEGER DEFAULT 1,
  machine_min_tonnage INTEGER,
  machine_max_tonnage INTEGER,

  -- Bill of materials & dye ratios
  bom_json            JSONB DEFAULT '[]'::JSONB,
  dye_ratio           NUMERIC(5, 3) DEFAULT 0.50,    -- 0.5 kg dye per 25kg bag (all products)

  -- Metadata
  active              BOOLEAN DEFAULT TRUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER products_updated_at
  BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS products_category_idx      ON products (category);
CREATE INDEX IF NOT EXISTS products_barcode_idx       ON products (barcode);
CREATE INDEX IF NOT EXISTS products_internal_code_idx ON products (internal_code);
CREATE INDEX IF NOT EXISTS products_active_idx        ON products (active);

-- ============================================================================
-- TABLE: profiles
-- Stores the legacy product override blob used by /api/profiles
-- ============================================================================
CREATE TABLE IF NOT EXISTS profiles (
  id          TEXT PRIMARY KEY DEFAULT 'profiles',
  data        JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER profiles_updated_at
  BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS profiles_updated_idx ON profiles (updated_at DESC);

-- ============================================================================
-- TABLE: work_orders
-- Production runs with WO-YYYY-NNNN ID format
-- Two-part document: Part 1 (planning) + Part 2 (tracking via shift_logs)
-- ============================================================================

CREATE SEQUENCE IF NOT EXISTS work_order_seq START WITH 1 INCREMENT BY 1;

CREATE TABLE IF NOT EXISTS work_orders (
  -- Human-readable PK: WO-2026-0001, WO-2026-0002, etc.
  id               TEXT        PRIMARY KEY,

  -- References
  product_id       VARCHAR(50) NOT NULL REFERENCES products (id) ON DELETE RESTRICT,
  machine_id       UUID                 REFERENCES machines (id) ON DELETE SET NULL,

  -- Authorship
  created_by       TEXT        NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  due_date         DATE,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Workflow status
  status           TEXT        NOT NULL DEFAULT 'planned'
                               CHECK (status IN ('planned','in_progress','paused','completed','cancelled')),

  -- Part 1: Planning side
  total_qty        INTEGER     NOT NULL,
  colours_json     JSONB       NOT NULL DEFAULT '[]'::JSONB,
  -- Structure: [
  --   { "colour": "Red", "qty": 100, "bags": 2, "dye_kg": 1.0 },
  --   { "colour": "Blue", "qty": 150, "bags": 3, "dye_kg": 1.5 }
  -- ]

  raw_material_qty_kg NUMERIC(10, 2),
  planned_runtime_hours NUMERIC(8, 2),
  planned_shift_hours NUMERIC(8, 2),

  -- Mould logistics
  mould_in_at      TIMESTAMPTZ,
  mould_out_at     TIMESTAMPTZ,

  -- Part 2: Tracking side
  completed_at     TIMESTAMPTZ,
  notes            TEXT,

  CONSTRAINT mould_dates_order CHECK (
    mould_out_at IS NULL OR mould_in_at IS NULL OR mould_out_at >= mould_in_at
  )
);

CREATE TRIGGER work_orders_updated_at
  BEFORE UPDATE ON work_orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Add deferred FK on machines
ALTER TABLE machines
  ADD CONSTRAINT machines_current_order_fk
  FOREIGN KEY (current_order_id) REFERENCES work_orders (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS wo_product_idx  ON work_orders (product_id);
CREATE INDEX IF NOT EXISTS wo_machine_idx  ON work_orders (machine_id);
CREATE INDEX IF NOT EXISTS wo_status_idx   ON work_orders (status);
CREATE INDEX IF NOT EXISTS wo_created_idx  ON work_orders (created_at DESC);

-- ============================================================================
-- TABLE: shift_logs
-- Per-shift production records (day/night) linked to a work order
-- Filled by admin end-of-day (Option A)
-- ============================================================================
CREATE TABLE IF NOT EXISTS shift_logs (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id            TEXT        NOT NULL REFERENCES work_orders (id) ON DELETE CASCADE,

  log_date            DATE        NOT NULL,
  shift               TEXT        NOT NULL CHECK (shift IN ('morning', 'night')),

  -- Worker and accountability
  worker_name         TEXT,
  worker_id           INTEGER,

  -- Production data (entered end-of-day)
  units_produced      INTEGER     DEFAULT 0 CHECK (units_produced >= 0),
  waste_units         INTEGER     DEFAULT 0 CHECK (waste_units >= 0),
  waste_percentage    NUMERIC(5, 2) GENERATED ALWAYS AS (
    CASE
      WHEN (units_produced + waste_units) = 0 THEN 0
      ELSE ROUND((waste_units::NUMERIC / (units_produced + waste_units) * 100), 2)
    END
  ) STORED,

  -- Colour-by-colour tracking (up to 9 colours)
  colour_breakdown_json JSONB,
  -- Structure: [
  --   { "colour": "Red", "units": 50, "waste": 2, "signed_by": "Ahmed" },
  --   { "colour": "Blue", "units": 75, "waste": 3, "signed_by": "Ibrahim" }
  -- ]

  actual_shift_hours  NUMERIC(8, 2),
  notes               TEXT,

  -- Supervisor sign-off
  supervisor_sign_off BOOLEAN DEFAULT FALSE,
  supervisor_name     TEXT,
  supervisor_sign_off_at TIMESTAMPTZ,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- One log row per order+date+shift
  UNIQUE (order_id, log_date, shift)
);

CREATE TRIGGER shift_logs_updated_at
  BEFORE UPDATE ON shift_logs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS sl_order_idx    ON shift_logs (order_id);
CREATE INDEX IF NOT EXISTS sl_date_idx     ON shift_logs (log_date DESC);
CREATE INDEX IF NOT EXISTS sl_shift_idx    ON shift_logs (shift);
CREATE INDEX IF NOT EXISTS sl_worker_idx   ON shift_logs (worker_name);

-- ============================================================================
-- TABLE: workers
-- Factory floor workers (Phase 2 placeholder; not used in Phase 1)
-- ============================================================================
CREATE TABLE IF NOT EXISTS workers (
  id               SERIAL PRIMARY KEY,
  name             TEXT        NOT NULL,
  department       TEXT,
  shift_preference TEXT        CHECK (shift_preference IN ('morning', 'night', 'flexible')),
  hr_id            TEXT,
  active           BOOLEAN DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- TABLE: inventory
-- Finished goods inventory (Phase 3 placeholder; not used in Phase 1)
-- ============================================================================
CREATE TABLE IF NOT EXISTS inventory (
  id               SERIAL PRIMARY KEY,
  product_id       VARCHAR(50) NOT NULL REFERENCES products (id),
  colour           TEXT,
  qty_on_hand      INTEGER DEFAULT 0,
  qty_reserved     INTEGER DEFAULT 0,
  qty_available    INTEGER GENERATED ALWAYS AS (qty_on_hand - qty_reserved) STORED,
  last_updated     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes            TEXT
);

CREATE INDEX IF NOT EXISTS inventory_product_colour_idx ON inventory (product_id, colour);

-- ============================================================================
-- TABLE: users
-- Authentication and role-based access control
-- ============================================================================
CREATE TABLE IF NOT EXISTS users (
  id               SERIAL PRIMARY KEY,
  username         TEXT        NOT NULL UNIQUE,
  email            TEXT,
  password_hash    TEXT        NOT NULL,
  role             TEXT        NOT NULL DEFAULT 'viewer'
                               CHECK (role IN ('admin', 'supervisor', 'viewer')),
  active           BOOLEAN DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login       TIMESTAMPTZ,
  last_action      TEXT,
  last_action_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS users_username_idx ON users (username);
CREATE INDEX IF NOT EXISTS users_role_idx     ON users (role);

-- ============================================================================
-- TABLE: activity_log
-- Audit trail for all data changes
-- ============================================================================
CREATE TABLE IF NOT EXISTS activity_log (
  id               SERIAL PRIMARY KEY,
  user_id          INTEGER REFERENCES users (id),
  action           TEXT        NOT NULL,
  entity_type      TEXT,
  entity_id        TEXT,
  details          JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS activity_log_user_idx       ON activity_log (user_id);
CREATE INDEX IF NOT EXISTS activity_log_created_idx    ON activity_log (created_at DESC);
CREATE INDEX IF NOT EXISTS activity_log_entity_idx     ON activity_log (entity_type, entity_id);

-- ============================================================================
-- FUNCTION: Generate sequential work order ID (WO-YYYY-NNNN format)
-- ============================================================================
CREATE OR REPLACE FUNCTION generate_work_order_id()
RETURNS TEXT AS $$
DECLARE
  new_id TEXT;
  year_prefix TEXT;
BEGIN
  year_prefix := 'WO-' || TO_CHAR(CURRENT_DATE, 'YYYY') || '-';
  new_id := year_prefix || TO_CHAR(nextval('work_order_seq'), 'FM0000');
  RETURN new_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- VIEWS: For reporting and analytics
-- ============================================================================

-- HR Worker Output Report (weekly aggregation)
CREATE OR REPLACE VIEW v_worker_output AS
SELECT
  sl.worker_name,
  DATE_TRUNC('week', sl.log_date)::DATE AS week_starting,
  COUNT(DISTINCT sl.order_id) AS orders_worked,
  SUM(sl.units_produced) AS total_units,
  SUM(sl.waste_units) AS total_waste,
  ROUND(AVG(sl.waste_percentage), 2) AS avg_waste_pct,
  SUM(sl.actual_shift_hours) AS total_hours
FROM shift_logs sl
WHERE sl.worker_name IS NOT NULL
GROUP BY sl.worker_name, DATE_TRUNC('week', sl.log_date);

-- Work Order Summary with progress tracking
CREATE OR REPLACE VIEW v_work_order_summary AS
SELECT
  wo.id,
  wo.product_id,
  p.name AS product_name,
  wo.machine_id,
  m.name AS machine_name,
  wo.status,
  wo.total_qty,
  COALESCE(SUM(sl.units_produced), 0) AS actual_units_produced,
  wo.planned_runtime_hours,
  wo.created_at,
  wo.due_date
FROM work_orders wo
LEFT JOIN products p ON wo.product_id = p.id
LEFT JOIN machines m ON wo.machine_id = m.id
LEFT JOIN shift_logs sl ON wo.id = sl.order_id
GROUP BY wo.id, wo.product_id, p.name, wo.machine_id, m.name, wo.status, wo.total_qty, wo.planned_runtime_hours, wo.created_at, wo.due_date;

-- Waste Rate Analysis (chronic waste issues identification)
CREATE OR REPLACE VIEW v_waste_analysis AS
SELECT
  p.id,
  p.name,
  COUNT(DISTINCT wo.id) AS total_orders,
  SUM(sl.units_produced) AS total_units,
  SUM(sl.waste_units) AS total_waste,
  ROUND(
    SUM(sl.waste_units)::NUMERIC / NULLIF(SUM(sl.units_produced + sl.waste_units), 0) * 100,
    2
  ) AS waste_pct
FROM products p
LEFT JOIN work_orders wo ON p.id = wo.product_id
LEFT JOIN shift_logs sl ON wo.id = sl.order_id
WHERE sl.id IS NOT NULL
GROUP BY p.id, p.name
ORDER BY waste_pct DESC;

-- ============================================================================
-- ROW-LEVEL SECURITY (enable now; policies added in phase 2)
-- ============================================================================
ALTER TABLE products    ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles    ENABLE ROW LEVEL SECURITY;
ALTER TABLE machines    ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_logs  ENABLE ROW LEVEL SECURITY;
ALTER TABLE users       ENABLE ROW LEVEL SECURITY;
ALTER TABLE workers     ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory   ENABLE ROW LEVEL SECURITY;

-- Temporary open policies for migration phase
-- REPLACE these with role-based policies before going live
CREATE POLICY "temp_open_products"    ON products    FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "temp_open_profiles"    ON profiles    FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "temp_open_machines"    ON machines    FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "temp_open_work_orders" ON work_orders FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "temp_open_shift_logs"  ON shift_logs  FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "temp_open_users"       ON users       FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "temp_open_workers"     ON workers     FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "temp_open_inventory"   ON inventory   FOR ALL USING (true) WITH CHECK (true);
