async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function b64url(obj) {
  return btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function signJWT(payload, secret) {
  const header = b64url({ alg: 'HS256', typ: 'JWT' });
  const body   = b64url(payload);
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${header}.${body}`));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return `${header}.${body}.${sigB64}`;
}

// Echo the request Origin only if it's in the allowlist (ALLOWED_ORIGINS env var,
// comma-separated). Add the custom domain to that env var when it goes live — no
// code change needed. NOTE: the app's own calls are same-origin, so CORS never
// applies to them; this only governs cross-origin callers.
function allowOrigin(request, env) {
  const allowed = (env.ALLOWED_ORIGINS || 'https://watania-vision.pages.dev')
    .split(',').map(s => s.trim()).filter(Boolean);
  const origin = request.headers.get('Origin') || '';
  return allowed.includes(origin) ? origin : allowed[0];
}

export async function onRequest(context) {
  const { request, env } = context;

  const cors = {
    'Access-Control-Allow-Origin':  allowOrigin(request, env),
    'Vary':                         'Origin',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type':                 'application/json',
  };

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: cors });
  }

  const supabaseUrl    = env.SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  const sessionSecret  = env.SESSION_SECRET;

  if (!supabaseUrl || !serviceRoleKey || !sessionSecret) {
    return new Response(JSON.stringify({ error: 'Server misconfiguration' }), { status: 500, headers: cors });
  }

  // Rate limit: cap login attempts per IP per minute. The Free plan has no WAF
  // rate limiting, so we count in Cloudflare KV (binding: RATE_LIMIT_KV).
  // Fails OPEN if the binding is missing or KV errors, so login never breaks
  // during/after setup — it just runs unthrottled until KV is wired up.
  const RL_LIMIT  = 8;   // attempts allowed
  const RL_WINDOW = 60;  // per this many seconds (KV minimum TTL is 60)
  if (env.RATE_LIMIT_KV) {
    const ip  = request.headers.get('CF-Connecting-IP') || 'unknown';
    const key = `login:${ip}`;
    try {
      const count = parseInt(await env.RATE_LIMIT_KV.get(key)) || 0;
      if (count >= RL_LIMIT) {
        return new Response(
          JSON.stringify({ error: 'Too many login attempts. Please wait a minute and try again.' }),
          { status: 429, headers: cors }
        );
      }
      await env.RATE_LIMIT_KV.put(key, String(count + 1), { expirationTtl: RL_WINDOW });
    } catch (_) { /* KV unavailable — do not block a legitimate login */ }
  }

  let body;
  try { body = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid request body' }), { status: 400, headers: cors });
  }

  const username = (body.username || '').trim().toLowerCase().slice(0, 64);
  const password = (body.password || '').slice(0, 256);
  if (!username || !password) {
    return new Response(JSON.stringify({ error: 'Username and password required' }), { status: 400, headers: cors });
  }

  const hash = await sha256(password);

  const res = await fetch(
    `${supabaseUrl}/rest/v1/users?username=eq.${encodeURIComponent(username)}&active=eq.true&select=id,username,password_hash,role`,
    { headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` } }
  );

  if (!res.ok) {
    return new Response(JSON.stringify({ error: 'Authentication service unavailable' }), { status: 502, headers: cors });
  }

  const users = await res.json();
  const user  = Array.isArray(users) ? users.find(u => u.password_hash === hash) : null;

  if (!user) {
    return new Response(JSON.stringify({ error: 'Invalid credentials' }), { status: 401, headers: cors });
  }

  const now   = Math.floor(Date.now() / 1000);
  const token = await signJWT({
    sub:      String(user.id),
    username: user.username,
    awp_role: user.role,
    iat:      now,
    exp:      now + 8 * 60 * 60,
  }, sessionSecret);

  return new Response(JSON.stringify({ token }), { status: 200, headers: cors });
}
