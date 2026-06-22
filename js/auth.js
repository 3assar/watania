// AWP Auth — session management using Supabase users table

async function sha256(msg) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

const SESSION_TTL = 8 * 60 * 60 * 1000; // 8 hours

let SESSION = null; // { id, username, role, loginAt }

function sessionExpired(s) {
  return !s || !s.loginAt || (Date.now() - s.loginAt) > SESSION_TTL;
}

function getSession() {
  if (SESSION) return SESSION;
  try {
    const s = localStorage.getItem('awp_session');
    if (s) SESSION = JSON.parse(s);
  } catch {}
  return SESSION;
}

async function initAuth(onSuccess, onReady) {
  // Restore existing session — clear it if expired
  const saved = localStorage.getItem('awp_session');
  if (saved) {
    try { SESSION = JSON.parse(saved); } catch {}
    if (SESSION && sessionExpired(SESSION)) {
      SESSION = null;
      localStorage.removeItem('awp_session');
    }
    if (SESSION) { onSuccess(); return; }
  }
  // Ensure default admin user exists in Supabase
  try {
    const users = await dbGetUsers();
    if (!users || users.length === 0) {
      const h = await sha256('6666');
      await dbCreateUser({ username: 'yousef', password_hash: h, role: 'admin', active: true });
    }
  } catch (e) {
    console.warn('Auth init warning:', e.message);
  }
  onReady();
}

async function doLogin() {
  const uEl = document.getElementById('lu');
  const pEl = document.getElementById('lp');
  const errEl = document.getElementById('login-err');
  const btn = document.querySelector('.login-btn');

  const username = uEl.value.trim().toLowerCase();
  const password = pEl.value;

  if (!username || !password) {
    errEl.textContent = 'Please enter username and password.';
    return;
  }

  btn.textContent = 'Signing in…';
  btn.disabled = true;
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

    SESSION = { id: data.id, username: data.username, role: data.role, loginAt: Date.now() };
    localStorage.setItem('awp_session', JSON.stringify(SESSION));
    showApp();
  } catch (e) {
    errEl.textContent = 'Login failed: ' + e.message;
  } finally {
    btn.textContent = 'Sign in';
    btn.disabled = false;
  }
}

function doLogout() {
  SESSION = null;
  localStorage.removeItem('awp_session');
  location.href = 'index.html';
}

function isAdmin()      { return !!(SESSION && SESSION.role === 'admin'); }
function isSupervisor() { return !!(SESSION && SESSION.role === 'supervisor'); }
function isOperator()   { return !!(SESSION && SESSION.role === 'operator'); }
function canEdit()      { return isAdmin() || isSupervisor(); }   // create/edit WOs + library cards
function canAct()       { return isAdmin() || isSupervisor() || isOperator(); } // start/pause/resume/complete
