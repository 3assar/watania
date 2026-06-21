// AWP Auth — session management using Supabase users table

async function sha256(msg) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

let SESSION = null; // { id, username, role }

function getSession() {
  if (SESSION) return SESSION;
  try {
    const s = localStorage.getItem('awp_session');
    if (s) SESSION = JSON.parse(s);
  } catch {}
  return SESSION;
}

async function initAuth(onSuccess, onReady) {
  // Restore existing session
  const saved = localStorage.getItem('awp_session');
  if (saved) {
    try { SESSION = JSON.parse(saved); } catch {}
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
    const h = await sha256(password);
    const users = await dbGetUsersWithHash();
    const user = users.find(u => u.username.toLowerCase() === username && u.password_hash === h);

    if (!user) {
      errEl.textContent = 'Invalid credentials.';
      pEl.value = '';
      return;
    }

    SESSION = { id: user.id, username: user.username, role: user.role };
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

function isAdmin() { return SESSION && SESSION.role === 'admin'; }
function canEdit() { return SESSION && (SESSION.role === 'admin' || SESSION.role === 'editor'); }
function isSupervisor() { return SESSION && SESSION.role === 'supervisor'; }
