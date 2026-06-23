// AWP Auth — session backed by a signed JWT issued by /api/login.
// The token is stored in localStorage. Claims are read from the payload.
// Role cannot be forged — signature is verified server-side on every write.

let SESSION = null; // { id, username, role, exp }

function _b64pad(str) {
  return str.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, (4 - str.length % 4) % 4);
}

function parseJWTPayload(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    return JSON.parse(atob(_b64pad(parts[1])));
  } catch { return null; }
}

function getToken() {
  try { return localStorage.getItem('awp_token') || null; } catch { return null; }
}

function sessionExpired() {
  const token = getToken();
  if (!token) return true;
  const payload = parseJWTPayload(token);
  return !payload || payload.exp < Math.floor(Date.now() / 1000);
}

function getSession() {
  if (SESSION) return SESSION;
  const token = getToken();
  if (!token) return null;
  const p = parseJWTPayload(token);
  if (!p) return null;
  SESSION = { id: p.sub, username: p.username, role: p.awp_role, exp: p.exp };
  return SESSION;
}

async function initAuth(onSuccess, onReady) {
  if (!sessionExpired()) {
    SESSION = getSession();
    if (SESSION) { onSuccess(); return; }
  }
  // Clear any stale token
  localStorage.removeItem('awp_token');
  SESSION = null;

  // Bootstrap: ensure default admin exists (GET — uses anon key, safe before login)
  try {
    const users = await dbGetUsers();
    if (!users || users.length === 0) {
      // Can't create without a token — just show login. Admin must be seeded via Supabase.
      console.warn('No users found. Seed at least one admin via Supabase dashboard.');
    }
  } catch (e) {
    console.warn('Auth init warning:', e.message);
  }
  onReady();
}

async function doLogin() {
  const uEl   = document.getElementById('lu');
  const pEl   = document.getElementById('lp');
  const errEl = document.getElementById('login-err');
  const btn   = document.querySelector('.login-btn');

  const username = uEl.value.trim().toLowerCase();
  const password = pEl.value;

  if (!username || !password) { errEl.textContent = 'Please enter username and password.'; return; }

  btn.textContent = 'Signing in…';
  btn.disabled    = true;
  errEl.textContent = '';

  try {
    const res  = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();

    if (!res.ok || data.error) {
      errEl.textContent = data.error || 'Invalid credentials.';
      pEl.value = '';
      return;
    }

    const payload = parseJWTPayload(data.token);
    if (!payload) { errEl.textContent = 'Login failed: invalid token.'; return; }

    localStorage.setItem('awp_token', data.token);
    SESSION = { id: payload.sub, username: payload.username, role: payload.awp_role, exp: payload.exp };
    showApp();
  } catch (e) {
    errEl.textContent = 'Login failed: ' + e.message;
  } finally {
    btn.textContent = 'Sign in';
    btn.disabled    = false;
  }
}

function doLogout() {
  SESSION = null;
  localStorage.removeItem('awp_token');
  location.href = 'index.html';
}

function isAdmin()      { const s = SESSION || getSession(); return !!(s && s.role === 'admin'); }
function isSupervisor() { const s = SESSION || getSession(); return !!(s && s.role === 'supervisor'); }
function isOperator()   { const s = SESSION || getSession(); return !!(s && s.role === 'operator'); }
function canEdit()      { return isAdmin() || isSupervisor(); }
function canAct()       { return isAdmin() || isSupervisor() || isOperator(); }
