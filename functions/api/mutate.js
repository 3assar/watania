function b64pad(str) {
  return str.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, (4 - str.length % 4) % 4);
}

async function verifyJWT(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid token');
  const [h, p, s] = parts;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
  );
  const sigBytes = Uint8Array.from(atob(b64pad(s)), c => c.charCodeAt(0));
  const valid = await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(`${h}.${p}`));
  if (!valid) throw new Error('Invalid signature');
  const payload = JSON.parse(atob(b64pad(p)));
  if (payload.exp < Math.floor(Date.now() / 1000)) throw new Error('Token expired');
  return payload;
}

// ── Authorization rules ────────────────────────────────────────────────────────
// The proxy runs with the service-role key, so it MUST authorize every request
// itself — the DB no longer does (anon writes were revoked in migration 003, and
// service role bypasses RLS). Two gates:
//   1. write methods only — reads never go through the proxy, so allowing GET here
//      would let any logged-in user exfiltrate service-role-only data (e.g.
//      users.password_hash). Forbidden.
//   2. (table|rpc, method) must be allowlisted, and the caller's signed awp_role
//      must meet the minimum for that operation.
const ROLE_RANK = { viewer: 0, operator: 1, supervisor: 2, admin: 3 };

// Minimum role per table per write method. Anything absent is denied.
// NOTE: work_orders PATCH is 'operator' because shop-floor start/complete use it
// (canAct); supervisor-only edit/archive also use PATCH and can't be separated at
// this layer — residual over-permission, see TECHNICAL_AUDIT_v3 §1.6.
const TABLE_RULES = {
  work_orders:       { POST: 'supervisor', PATCH: 'operator',   DELETE: 'supervisor' },
  shift_logs:        { POST: 'operator',   PATCH: 'operator' },
  pause_logs:        { POST: 'operator',   PATCH: 'operator' },
  activity_log:      { POST: 'operator' },
  machines:          { PATCH: 'supervisor' },
  products:          { POST: 'supervisor', PATCH: 'supervisor', DELETE: 'supervisor' },
  product_overrides: { POST: 'supervisor', DELETE: 'supervisor' },
  users:             { POST: 'admin',      PATCH: 'admin',      DELETE: 'admin' },
};

const RPC_RULES = {
  pause_work_order:       'operator',
  resume_work_order:      'operator',
  delete_work_order:      'supervisor',
  generate_work_order_id: 'supervisor',
};

// Returns null if allowed, or { status, error } if denied.
function authorize(role, path, method) {
  if (!['POST', 'PATCH', 'DELETE'].includes(method)) {
    return { status: 405, error: 'Method not permitted through proxy' };
  }
  const rank = ROLE_RANK[role];
  if (rank === undefined) return { status: 403, error: 'Unknown role' };

  if (typeof path !== 'string' || !path.startsWith('/')) {
    return { status: 400, error: 'Invalid path' };
  }
  const segs = path.split('?')[0].split('/').filter(Boolean);
  if (segs.length === 0) return { status: 400, error: 'Invalid path' };

  let required;
  if (segs[0] === 'rpc') {
    required = RPC_RULES[segs[1]];
    if (!required) return { status: 403, error: 'RPC not permitted' };
  } else {
    const rules = TABLE_RULES[segs[0]];
    if (!rules) return { status: 403, error: 'Resource not permitted' };
    required = rules[method];
    if (!required) return { status: 405, error: 'Method not allowed on resource' };
  }
  if (rank < ROLE_RANK[required]) {
    return { status: 403, error: 'Insufficient role' };
  }
  return null;
}

export async function onRequest(context) {
  const { request, env } = context;

  const cors = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type':                 'application/json',
  };

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: cors });
  }

  const sessionSecret = env.SESSION_SECRET;
  const supabaseUrl   = env.SUPABASE_URL;
  const serviceKey    = env.SUPABASE_SERVICE_ROLE_KEY;

  if (!sessionSecret || !supabaseUrl || !serviceKey) {
    return new Response(JSON.stringify({ error: 'Server misconfiguration' }), { status: 500, headers: cors });
  }

  const authHeader = request.headers.get('Authorization') || '';
  const rawToken   = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!rawToken) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: cors });
  }
  let claims;
  try {
    claims = await verifyJWT(rawToken, sessionSecret);
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 401, headers: cors });
  }

  let envelope;
  try { envelope = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid request body' }), { status: 400, headers: cors });
  }

  const { path, method, body, headers: extraHeaders = {} } = envelope;
  if (!path || !method) {
    return new Response(JSON.stringify({ error: 'Missing path or method' }), { status: 400, headers: cors });
  }

  const denied = authorize(claims.awp_role, path, String(method).toUpperCase());
  if (denied) {
    return new Response(JSON.stringify({ error: denied.error }), { status: denied.status, headers: cors });
  }

  const fwdHeaders = {
    apikey:         serviceKey,
    Authorization:  `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
  };
  if (extraHeaders.Prefer) fwdHeaders.Prefer = extraHeaders.Prefer;

  let supaRes;
  try {
    supaRes = await fetch(`${supabaseUrl}/rest/v1${path}`, {
      method,
      headers: fwdHeaders,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Upstream fetch failed: ' + e.message }), { status: 502, headers: cors });
  }

  const ct = supaRes.headers.get('content-type') || '';
  let resBodyStr;
  try {
    if (ct.includes('application/json')) {
      const resBody = await supaRes.json();
      resBodyStr = JSON.stringify(resBody ?? null);
    } else {
      const resText = await supaRes.text();
      resBodyStr = resText === '' ? 'null' : resText;
    }
  } catch {
    resBodyStr = 'null';
  }

  const nullBodyStatus = [101, 103, 204, 205, 304].includes(supaRes.status);
  return new Response(nullBodyStatus ? null : resBodyStr, {
    status:  supaRes.status,
    headers: nullBodyStatus ? cors : { ...cors, 'Content-Type': ct || 'application/json' },
  });
}
