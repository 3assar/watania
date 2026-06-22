// AWP Supabase client — REST API helpers
// All DB access goes through these functions.

const SUPABASE_URL = 'https://iyyhxhahdtpftpdzgyqd.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_NZ0rp4YCjBPpeCJ4TGoRCg_WZ4jmSen';

const SB = {
  headers: {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
  },
  async fetch(path, opts = {}) {
    const { headers: extraHeaders, ...restOpts } = opts;
    const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
      ...restOpts,
      headers: { ...this.headers, ...(extraHeaders || {}) },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`DB error ${res.status}: ${body}`);
    }
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) return res.json();
    return null;
  },
};

// ── PRODUCTS ──────────────────────────────────────────────────────────────────

async function dbGetProducts() {
  return SB.fetch('/products?select=*&active=eq.true&order=name');
}

async function dbUpdateProduct(id, patch) {
  return SB.fetch(`/products?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(patch),
  });
}

async function dbInsertProduct(data) {
  return SB.fetch('/products', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(data),
  });
}

async function dbDeleteProduct(id) {
  return SB.fetch(`/products?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// ── MOULDS ────────────────────────────────────────────────────────────────────

async function dbGetMoulds() {
  return SB.fetch('/moulds?select=*&order=dp_idx');
}

// ── PRODUCT OVERRIDES ─────────────────────────────────────────────────────────

async function dbGetOverrides() {
  return SB.fetch('/product_overrides?select=*');
}

async function dbGetOverridesLight() {
  return SB.fetch('/product_overrides?select=product_id,name_en_override,name_ar_override,category_override,subcategory_override,code_override,barcode_override,notes,weight,dimensions,volume,bom_json,packaging_json,quality_json,assembly_steps,revisions,last_edited_by,last_edited_at,trashed,trashed_by,trashed_at,has_image');
}

async function dbGetOverrideImage(productId) {
  const rows = await SB.fetch(`/product_overrides?product_id=eq.${encodeURIComponent(productId)}&select=image_data`);
  return rows?.[0]?.image_data || null;
}

async function dbUpsertOverride(productId, data) {
  return SB.fetch('/product_overrides', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ product_id: String(productId), ...data }),
  });
}

async function dbDeleteOverride(productId) {
  return SB.fetch(`/product_overrides?product_id=eq.${encodeURIComponent(productId)}`, {
    method: 'DELETE',
  });
}

// ── USERS ─────────────────────────────────────────────────────────────────────

async function dbGetUsers() {
  return SB.fetch('/users?select=id,username,role,active&order=username');
}

async function dbCreateUser(data) {
  return SB.fetch('/users', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(data),
  });
}

async function dbUpdateUser(id, patch) {
  return SB.fetch(`/users?id=eq.${id}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(patch),
  });
}

async function dbDeleteUser(id) {
  return SB.fetch(`/users?id=eq.${id}`, { method: 'DELETE' });
}

// ── ACTIVITY LOG ──────────────────────────────────────────────────────────────

async function dbLogActivity(userId, action, entityType, entityId, details, module) {
  try {
    await SB.fetch('/activity_log', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        user_id: userId || null,
        action,
        entity_type: entityType || null,
        entity_id: entityId ? String(entityId) : null,
        details: details || null,
        module: module || null,
      }),
    });
  } catch (e) {
    console.warn('Activity log failed:', e.message);
  }
}

async function dbGetActivityLog(module) {
  let q = '/activity_log?select=*,users(username)&order=created_at.desc&limit=200';
  if (module) q += `&module=eq.${encodeURIComponent(module)}`;
  return SB.fetch(q);
}

async function dbPauseWorkOrder(orderId, reason, reasonOther, pausedBy) {
  return SB.fetch('/rpc/pause_work_order', {
    method: 'POST',
    body: JSON.stringify({ p_order_id: orderId, p_reason: reason, p_reason_other: reasonOther || null, p_paused_by: pausedBy || null }),
  });
}

async function dbResumeWorkOrder(orderId) {
  return SB.fetch('/rpc/resume_work_order', {
    method: 'POST',
    body: JSON.stringify({ p_order_id: orderId }),
  });
}

// ── MACHINES ──────────────────────────────────────────────────────────────────

async function dbGetMachines() {
  return SB.fetch('/machines?select=*&order=name');
}

async function dbUpdateMachine(id, patch) {
  return SB.fetch(`/machines?id=eq.${id}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(patch),
  });
}

// ── WORK ORDERS ───────────────────────────────────────────────────────────────

async function dbGetWorkOrders(filters = {}) {
  let q = '/work_orders?select=*&order=created_at.desc&limit=50';
  if (filters.status) q += `&status=eq.${filters.status}`;
  if (filters.machine_id) q += `&machine_id=eq.${encodeURIComponent(filters.machine_id)}`;
  if (filters.offset) q += `&offset=${filters.offset}`;
  return SB.fetch(q);
}

async function dbCreateWorkOrder(data) {
  return SB.fetch('/work_orders', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(data),
  });
}

async function dbUpdateWorkOrder(id, patch) {
  return SB.fetch(`/work_orders?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(patch),
  });
}

async function dbDeleteWorkOrder(id) {
  return SB.fetch('/rpc/delete_work_order', {
    method: 'POST',
    body: JSON.stringify({ p_order_id: id }),
  });
}

// ── SHIFT LOGS ────────────────────────────────────────────────────────────────

async function dbGetShiftLogs(orderId) {
  return SB.fetch(`/shift_logs?order_id=eq.${encodeURIComponent(orderId)}&order=log_date.asc`);
}

async function dbCreateShiftLog(data) {
  return SB.fetch('/shift_logs', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(data),
  });
}

async function dbUpsertShiftLog(orderId, logDate, data) {
  return SB.fetch('/shift_logs', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify({ order_id: orderId, log_date: logDate, ...data }),
  });
}

// ── PAUSE LOGS ────────────────────────────────────────────────────────────────

async function dbGetPauseLogs(orderId) {
  return SB.fetch(`/pause_logs?order_id=eq.${encodeURIComponent(orderId)}&order=paused_at.asc`);
}

async function dbCreatePauseLog(data) {
  return SB.fetch('/pause_logs', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(data),
  });
}

async function dbResumePauseLog(id) {
  return SB.fetch(`/pause_logs?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ resumed_at: new Date().toISOString() }),
  });
}

// ── MACHINES (extended) ───────────────────────────────────────────────────────

async function dbGetMachinesGrouped() {
  const rows = await SB.fetch('/machines?select=*&order=name');
  const sectors = { A: [], B: [], C: [] };
  for (const m of rows) {
    const s = m.sector || m.name[0];
    if (sectors[s]) sectors[s].push(m);
  }
  return sectors;
}
