// Phase 2-C: server-side login — password hash never reaches the browser.
// Requires SUPABASE_SERVICE_ROLE_KEY set in Netlify environment variables.

async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export default async (request, context) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: cors });
  }

  const supabaseUrl     = Netlify.env.get('SUPABASE_URL');
  const serviceRoleKey  = Netlify.env.get('SUPABASE_SERVICE_ROLE_KEY');

  if (!supabaseUrl || !serviceRoleKey) {
    return new Response(JSON.stringify({ error: 'Server misconfiguration' }), { status: 500, headers: cors });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid request body' }), { status: 400, headers: cors });
  }

  const username = (body.username || '').trim().toLowerCase().slice(0, 64);
  const password = (body.password || '').slice(0, 256);

  if (!username || !password) {
    return new Response(JSON.stringify({ error: 'Username and password required' }), { status: 400, headers: cors });
  }

  const hash = await sha256(password);

  const url = `${supabaseUrl}/rest/v1/users?username=eq.${encodeURIComponent(username)}&active=eq.true&select=id,username,password_hash,role`;
  const res = await fetch(url, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
    },
  });

  if (!res.ok) {
    return new Response(JSON.stringify({ error: 'Authentication service unavailable' }), { status: 502, headers: cors });
  }

  const users = await res.json();
  const user  = Array.isArray(users) ? users.find(u => u.password_hash === hash) : null;

  if (!user) {
    return new Response(JSON.stringify({ error: 'Invalid credentials' }), { status: 401, headers: cors });
  }

  return new Response(JSON.stringify({ id: user.id, username: user.username, role: user.role }), {
    status: 200,
    headers: cors,
  });
};

export const config = { path: '/api/login' };
