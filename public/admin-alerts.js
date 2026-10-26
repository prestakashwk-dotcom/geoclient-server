// admin-alerts.js - Centro de alertas del administrador (se carga DESPUÉS de admin.js)
// Alertas en vivo, historial, botones Llamar / WhatsApp y notificaciones push en segundo plano.
(function () {
  let alerts = [];
  let panelOpen = false;
  let pushActive = false;
  const baseTitle = document.title;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const unackedCount = () => alerts.filter((a) => !a.acked).length;

  function ago(ts) {
    return typeof timeAgo === 'function' ? timeAgo(ts) : new Date(ts).toLocaleTimeString();
  }

  function updateBadge() {
    const n = unackedCount();
    const badge = $('alerts-badge');
    if (badge) {
      badge.textContent = n > 99 ? '99+' : n;
      badge.style.display = n ? 'flex' : 'none';
    }
    const btn = $('btn-alerts');
    if (btn) btn.classList.toggle('has-alerts', n > 0);
    document.title = n ? `(${n}) ${baseTitle}` : baseTitle;
  }

  function sevClass(a) {
    return a.severity === 'high' ? 'sev-high' : a.severity === 'medium' ? 'sev-medium' : 'sev-info';
  }

  function render() {
    const list = $('alerts-list');
    if (!list) return;
    updateBadge();
    if (!alerts.length) {
      list.innerHTML = '<div class="alerts-empty">✅ Sin alertas. Todo tranquilo.</div>';
      return;
    }
    list.innerHTML = alerts.map((a) => {
      const phone = (a.phone || '').replace(/[^0-9+]/g, '');
      const waPhone = phone.replace(/[^0-9]/g, '');
      const waText = encodeURIComponent(`Hola ${a.name}, notamos un problema con tu localizador: ${a.message} Por favor revísalo.`);
      return `
      <div class="alert-item ${sevClass(a)} ${a.acked ? 'acked' : ''}" data-id="${esc(a.id)}">
        <div class="alert-head">
          <span class="alert-ico">${esc(a.icon || '⚠️')}</span>
          <div class="alert-title">
            <strong>${esc(a.label || a.type)}</strong> · ${esc(a.name)}
            <span class="alert-dni">DNI ${esc(a.dni)}</span>
          </div>
          <span class="alert-time">${esc(ago(a.ts))}</span>
        </div>
        <div class="alert-msg">${esc(a.message)}</div>
        <div class="alert-actions">
          ${phone ? `<a class="btn-card alert-call" href="tel:${esc(phone)}">📞 Llamar</a>` : ''}
          ${waPhone ? `<a class="btn-card alert-wa" target="_blank" rel="noopener" href="https://wa.me/${esc(waPhone)}?text=${waText}">💬 WhatsApp</a>` : ''}
          ${a.latitude != null ? `<button class="btn-card" data-act="map" data-client="${esc(a.clientId)}">🎯 Ver en mapa</button>` : ''}
          ${a.type === 'DEVICE_CHANGED' ? `<button class="btn-card alert-confirm" data-act="confirm" data-client="${esc(a.clientId)}">✅ Es legítimo</button>` : ''}
          ${a.acked ? '' : `<button class="btn-card" data-act="ack" data-id="${esc(a.id)}">✓ Leído</button>`}
        </div>
      </div>`;
    }).join('');
  }

  function openPanel() {
    panelOpen = true;
    $('alerts-panel').classList.add('open');
    render();
  }
  function closePanel() {
    panelOpen = false;
    $('alerts-panel').classList.remove('open');
  }

  async function ackOne(id) {
    const a = alerts.find((x) => x.id === id);
    if (a) a.acked = true;
    render();
    fetch(`/api/alerts/${encodeURIComponent(id)}/ack`, { method: 'POST' }).catch(() => {});
  }

  async function ackAll() {
    alerts.forEach((a) => { a.acked = true; });
    render();
    fetch('/api/alerts/ack-all', { method: 'POST' }).catch(() => {});
  }

  function onNewAlert(a) {
    if (alerts.some((x) => x.id === a.id)) return;
    alerts.unshift(a);
    alerts = alerts.slice(0, 200);
    render();

    if (a.severity !== 'info' && typeof playWarningSound === 'function') playWarningSound();
    if (typeof showAdminToast === 'function') {
      showAdminToast(`${a.icon} ${a.name}: ${a.message}`, a.severity === 'info');
    }
    // Si el push en segundo plano no está activo, avisa con una notificación del navegador
    if (!pushActive && document.hidden && 'Notification' in window && Notification.permission === 'granted' && a.severity !== 'info') {
      try {
        const n = new Notification(`${a.icon} ${a.label}: ${a.name}`, { body: a.message, tag: a.id });
        n.onclick = () => { window.focus(); openPanel(); n.close(); };
      } catch (_) {}
    }
  }

  /* ----------------------------- Push en segundo plano ----------------------------- */
  const urlB64ToUint8 = (b64) => {
    const pad = '='.repeat((4 - (b64.length % 4)) % 4);
    const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
  };

  function setPushStatus() {
    const el = $('push-status');
    const btn = $('btn-enable-push');
    if (!el || !btn) return;
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      el.textContent = '⚠️ Este navegador no soporta avisos en segundo plano (en iPhone instala la app: Compartir → Agregar a pantalla de inicio).';
      btn.style.display = 'none';
    } else if (pushActive) {
      el.textContent = '🔔 Avisos en segundo plano ACTIVOS en este dispositivo.';
      btn.style.display = 'none';
    } else if ('Notification' in window && Notification.permission === 'denied') {
      el.textContent = '🚫 Bloqueaste las notificaciones. Actívalas en los permisos del sitio.';
      btn.style.display = 'none';
    } else {
      el.textContent = '🔕 Avisos en segundo plano desactivados.';
      btn.style.display = '';
    }
  }

  async function enablePush(interactive) {
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) return setPushStatus();
      const reg = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;

      if (Notification.permission === 'default' && interactive) await Notification.requestPermission();
      if (Notification.permission !== 'granted') return setPushStatus();

      const keyRes = await (await fetch('/api/push/key')).json();
      if (!keyRes.enabled) return setPushStatus();

      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlB64ToUint8(keyRes.publicKey)
        });
      }
      await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: sub.toJSON() })
      });
      pushActive = true;
    } catch (e) {
      console.warn('Push no disponible:', e.message);
    }
    setPushStatus();
  }

  document.addEventListener('DOMContentLoaded', () => {
    const btn = $('btn-alerts');
    if (!btn) return;
    btn.addEventListener('click', () => (panelOpen ? closePanel() : openPanel()));
    $('btn-close-alerts').addEventListener('click', closePanel);
    $('btn-ack-all').addEventListener('click', ackAll);
    $('btn-enable-push').addEventListener('click', () => enablePush(true));

    $('alerts-list').addEventListener('click', async (e) => {
      const b = e.target.closest('button[data-act]');
      if (!b) return;
      const act = b.dataset.act;
      if (act === 'ack') ackOne(b.dataset.id);
      if (act === 'map') {
        closePanel();
        if (typeof selectClient === 'function') selectClient(b.dataset.client);
      }
      if (act === 'confirm') {
        await fetch(`/api/clients/${encodeURIComponent(b.dataset.client)}/confirm-device`, { method: 'POST' });
        const a = alerts.find((x) => x.clientId === b.dataset.client && x.type === 'DEVICE_CHANGED' && !x.acked);
        if (a) ackOne(a.id);
        if (typeof showAdminToast === 'function') showAdminToast('✅ Nuevo teléfono confirmado como legítimo', true);
      }
    });

    const toast = $('admin-alert-toast');
    if (toast) { toast.style.cursor = 'pointer'; toast.addEventListener('click', openPanel); }

    // Esperar a que admin.js cree el socket
    let tries = 0;
    const wait = setInterval(() => {
      tries += 1;
      if (window.gcSocket) {
        clearInterval(wait);
        window.gcSocket.on('admin:init-alerts', (list) => { alerts = list || []; render(); });
        window.gcSocket.on('admin:alert', onNewAlert);
      } else if (tries > 100) clearInterval(wait);
    }, 100);

    updateBadge();
    setPushStatus();
    if (window.GC_AUTH && window.GC_AUTH.getToken()) {
      // Si ya hay permiso concedido, re-suscribe en silencio
      if ('Notification' in window && Notification.permission === 'granted') enablePush(false);
      if (location.hash === '#alerts') setTimeout(openPanel, 600);
      // Primera vez: pedir activar avisos al primer clic en cualquier parte
      if ('Notification' in window && Notification.permission === 'default') {
        const once = () => { document.removeEventListener('click', once); setTimeout(openPanel, 300); };
        document.addEventListener('click', once, { once: true });
      }
    }
    setInterval(() => { if (panelOpen) render(); }, 30000);
  });
})();
