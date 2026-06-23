// Authenticated write proxy — verifies signed JWT then forwards to Supabase via service role.
// All POST/PATCH/DELETE from the client go through here instead of directly to Supabase.
// Requires SESSION_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY in Netlify env vars.

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

export default async (request) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
  };

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: cors });
  }

  const sessionSecret = Netlify.env.get('SESSION_SECRET');
  const supabaseUrl   = Netlify.env.get('SUPABASE_URL');
  const serviceKey    = Netlify.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!sessionSecret || !supabaseUrl || !serviceKey) {
    return new Response(JSON.stringify({ error: 'Server misconfiguration' }), { status: 500, headers: cors });
  }

  // Verify token
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

  // Parse envelope: { path, method, body?, headers? }
  let envelope;
  try { envelope = await request.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid request body' }), { status: 400, headers: cors });
  }

  const { path, method, body, headers: extraHeaders = {} } = envelope;
  if (!path || !method) {
    return new Response(JSON.stringify({ error: 'Missing path or method' }), { status: 400, headers: cors });
  }

  // Forward to Supabase with service role key
  const fwdHeaders = {
    apikey:          serviceKey,
    Authorization:  `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
  };
  if (extraHeaders.Prefer) fwdHeaders.Prefer = extraHeaders.Prefer;

  const supaRes = await fetch(`${supabaseUrl}/rest/v1${path}`, {
    method,
    headers: fwdHeaders,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const ct          = supaRes.headers.get('content-type') || '';
  const resBody     = ct.includes('application/json') ? await supaRes.json() : await supaRes.text();
  const resBodyStr  = typeof resBody === 'string' ? resBody : JSON.stringify(resBody);

  return new Response(resBodyStr, {
    status:  supaRes.status,
    headers: { ...cors, 'Content-Type': ct || 'application/json' },
  });
};

export const config = { path: '/api/mutate' };
