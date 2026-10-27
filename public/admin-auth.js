// admin-auth.js - Login del administrador (se carga ANTES de admin.js)
// Guarda el token, lo añade a todas las llamadas /api/* y muestra el login si expira.
(function () {
  const KEY = 'gc_admin_token';
  const getToken = () => localStorage.getItem(KEY) || '';

  const originalFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const isApi = url.startsWith('/api/') && !url.startsWith('/api/auth/login');
    if (isApi) {
      init = Object.assign({}, init);
      init.headers = Object.assign({}, init.headers, { Authorization: 'Bearer ' + getToken() });
    }
    return originalFetch(input, init).then((res) => {
      if (isApi && res.status === 401) showLogin();
      return res;
    });
  };

  function showLogin(msg) {
    const overlay = document.getElementById('login-overlay');
    if (!overlay) return;
    overlay.classList.add('open');
    const err = document.getElementById('login-error');
    if (err) err.textContent = msg || '';
    const input = document.getElementById('login-password');
    if (input) setTimeout(() => input.focus(), 100);
  }

  async function doLogin() {
    const input = document.getElementById('login-password');
    const btn = document.getElementById('login-submit');
    const err = document.getElementById('login-error');
    if (!input.value) return;
    btn.disabled = true;
    err.textContent = '';
    try {
      const res = await originalFetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: input.value })
      });
      const data = await res.json();
      if (data.success) {
        localStorage.setItem(KEY, data.token);
        location.reload();
      } else {
        err.textContent = data.error || 'No se pudo iniciar sesión';
        input.value = '';
        input.focus();
      }
    } catch (e) {
      err.textContent = 'No se pudo conectar con el servidor';
    }
    btn.disabled = false;
  }

  function logout() {
    localStorage.removeItem(KEY);
    location.reload();
  }

  window.GC_AUTH = { getToken, showLogin, logout };

  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('login-submit');
    const input = document.getElementById('login-password');
    if (btn) btn.addEventListener('click', doLogin);
    if (input) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
    const out = document.getElementById('btn-logout');
    if (!getToken()) {
      window.location.replace('/login');
    } else {
      originalFetch('/api/auth/check', { headers: { Authorization: 'Bearer ' + getToken() } })
        .then((r) => { 
          if (r.status === 401) { 
            localStorage.removeItem(KEY); 
            window.location.replace('/login'); 
          } 
        })
        .catch(() => {});
    }
  });

  function logout() {
    localStorage.removeItem(KEY);
    window.location.replace('/login');
  }
})();
