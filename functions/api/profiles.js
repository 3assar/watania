// Profiles store — a single JSON blob keyed by 'profiles'.
// GET: anon read. PUT: requires valid JWT, writes via service role key.

const SUPABASE_ANON_KEY = 'sb_publishable_NZ0rp4YCjBPpeCJ4TGoRCg_WZ4jmSen';

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

export async function onRequest(context) {
  const { request, env } = context;

  const cors = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type':                 'application/json',
  };

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  const supabaseUrl = env.SUPABASE_URL;
  if (!supabaseUrl) {
    return new Response(JSON.stringify({ error: 'Server misconfiguration' }), { status: 500, headers: cors });
  }

  if (request.method === 'GET') {
    try {
      const res = await fetch(`${supabaseUrl}/rest/v1/profiles?id=eq.profiles&select=data`, {
        headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
      });
      if (!res.ok) throw new Error(`Supabase GET failed: ${res.status}`);
      const rows = await res.json();
      const data = Array.isArray(rows) && rows[0]?.data ? rows[0].data : {};
      return new Response(JSON.stringify(data), { status: 200, headers: cors });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message, profiles: {} }), { status: 200, headers: cors });
    }
  }

  if (request.method === 'PUT') {
    const sessionSecret = env.SESSION_SECRET;
    const serviceKey    = env.SUPABASE_SERVICE_ROLE_KEY;

    if (!sessionSecret || !serviceKey) {
      return new Response(JSON.stringify({ error: 'Server misconfiguration' }), { status: 500, headers: cors });
    }

    const authHeader = request.headers.get('Authorization') || '';
    const rawToken   = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!rawToken) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: cors });
    }
    try {
      await verifyJWT(rawToken, sessionSecret);
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 401, headers: cors });
    }

    try {
      const body = await request.json();
      const res = await fetch(`${supabaseUrl}/rest/v1/profiles?on_conflict=id`, {
        method: 'POST',
        headers: {
          apikey:         serviceKey,
          Authorization:  `Bearer ${serviceKey}`,
          'Content-Type': 'application/json',
          Prefer:         'resolution=merge-duplicates,return=representation',
        },
        body: JSON.stringify({ id: 'profiles', data: body }),
      });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Supabase PUT failed: ${res.status} ${err}`);
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: cors });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors });
    }
  }

  return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: cors });
}
