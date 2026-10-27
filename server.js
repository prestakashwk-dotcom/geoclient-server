// server.js - GeoClient Radar (v3: PostgreSQL + login admin + alertas + Web Push)
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { createStore, dayString, HISTORY_DAYS } = require('./db');
const { resolveDeviceModel } = require('./device-models');

/* ------------------------------ Configuración ------------------------------ */
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || (IS_PROD ? null : 'admin123');
const REQUIRE_REGISTERED = String(process.env.REQUIRE_REGISTERED || 'true') === 'true';
const OFFLINE_SECONDS = Number(process.env.OFFLINE_SECONDS) || 120;   // sin señal => alerta
const LOW_BATTERY = Number(process.env.LOW_BATTERY) || 15;            // % para alerta de batería baja
const DEAD_BATTERY = 5;                                               // % para "batería agotada"
const TOKEN_TTL_MS = 30 * 24 * 3600 * 1000;
const ONLINE_WINDOW_MS = 45000;

if (!ADMIN_PASSWORD) {
  console.error('❌ Falta la variable de entorno ADMIN_PASSWORD (obligatoria en producción).');
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });
const store = createStore(__dirname);

app.use(cors());
app.use(express.json({ limit: '100kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

/* --------------------------------- Estado ---------------------------------- */
const clients = new Map();
let geofences = [];
let SECRET = null;
let webpush = null;
let pushReady = false;

const logErr = (ctx) => (e) => console.error(`[${ctx}]`, e && e.message ? e.message : e);

/* ----------------------------- Autenticación admin ---------------------------- */
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const sign = (payload) => crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');

function createToken() {
  const payload = b64u(JSON.stringify({ exp: Date.now() + TOKEN_TTL_MS }));
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string' || !SECRET) return false;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return false;
  const expected = sign(payload);
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof exp === 'number' && exp > Date.now();
  } catch (_) { return false; }
}

function requireAdmin(req, res, next) {
  const h = req.get('authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (verifyToken(token)) return next();
  res.status(401).json({ success: false, error: 'No autorizado', code: 'UNAUTHORIZED' });
}

const loginAttempts = new Map(); // ip -> { n, reset }
function loginLimited(ip) {
  const now = Date.now();
  const r = loginAttempts.get(ip);
  if (!r || r.reset < now) return false;
  return r.n >= 8;
}
function loginFail(ip) {
  const now = Date.now();
  const r = loginAttempts.get(ip);
  if (!r || r.reset < now) loginAttempts.set(ip, { n: 1, reset: now + 10 * 60 * 1000 });
  else r.n += 1;
}
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

app.post('/api/auth/login', (req, res) => {
  const ip = req.ip;
  if (loginLimited(ip)) {
    return res.status(429).json({ success: false, error: 'Demasiados intentos. Espera 10 minutos.' });
  }
  const pass = String((req.body && req.body.password) || '');
  if (crypto.timingSafeEqual(sha(pass), sha(ADMIN_PASSWORD))) {
    loginAttempts.delete(ip);
    return res.json({ success: true, token: createToken() });
  }
  loginFail(ip);
  res.status(401).json({ success: false, error: 'Contraseña incorrecta' });
});

app.get('/api/auth/check', requireAdmin, (req, res) => res.json({ success: true }));

/* -------------------------------- Utilidades -------------------------------- */
const DNI_RE = /^[A-Za-z0-9_-]{3,24}$/;
const clean = (s, max = 80) => String(s == null ? '' : s).replace(/[<>]/g, '').trim().slice(0, max);

function validCoord(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) &&
    lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 && !(lat === 0 && lng === 0);
}

function getDistanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371e3, p1 = lat1 * Math.PI / 180, p2 = lat2 * Math.PI / 180;
  const dp = (lat2 - lat1) * Math.PI / 180, dl = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function getLocalIp() {
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const i of ifs[name]) if (i.family === 'IPv4' && !i.internal) return i.address;
  }
  return 'localhost';
}

const isOnline = (c) => (Date.now() - (c.lastSeen || 0)) < ONLINE_WINDOW_MS;

// Cliente listo para enviar al panel (sin campos internos)
function pub(c) {
  const o = {};
  for (const k of Object.keys(c)) {
    if (k.startsWith('_') || k === 'geofenceState' || k === 'history') continue;
    o[k] = c[k];
  }
  o.history = (c.history || []).slice(-120);
  o.isOnline = isOnline(c);
  const rawModel = c.deviceInfo ? c.deviceInfo.model : (c.deviceModel || 'Android');
  o.deviceModel = resolveDeviceModel(rawModel);
  o.hardwareId = (c.deviceInfo && (c.deviceInfo.id || c.deviceInfo.deviceId)) || null;
  return o;
}

// Guardado con límite de frecuencia por cliente (evita saturar la base de datos)
const pendingSave = new Map();
function persistClient(c, force = false) {
  const now = Date.now();
  if (force || !c._savedAt || now - c._savedAt > 5000) {
    c._savedAt = now;
    clearTimeout(pendingSave.get(c.id));
    pendingSave.delete(c.id);
    store.saveClient(c).catch(logErr('saveClient'));
    return;
  }
  if (!pendingSave.has(c.id)) {
    pendingSave.set(c.id, setTimeout(() => {
      pendingSave.delete(c.id);
      const cur = clients.get(c.id);
      if (cur) { cur._savedAt = Date.now(); store.saveClient(cur).catch(logErr('saveClient')); }
    }, 5000));
  }
}

/* --------------------------- Alertas y notificaciones --------------------------- */
const ALERT_META = {
  OFFLINE:           { severity: 'high',   icon: '📵', label: 'Sin señal' },
  BATTERY_DEAD:      { severity: 'high',   icon: '🪫', label: 'Batería agotada' },
  BATTERY_LOW:       { severity: 'medium', icon: '🔋', label: 'Batería baja' },
  GPS_OFF:           { severity: 'high',   icon: '📴', label: 'GPS apagado' },
  PERMISSION_DENIED: { severity: 'high',   icon: '🚫', label: 'Permiso denegado' },
  BG_RESTRICTED:     { severity: 'medium', icon: '⚠️', label: 'Segundo plano restringido' },
  TRACKING_OFF:      { severity: 'high',   icon: '⏸️', label: 'Transmisión detenida' },
  DEVICE_CHANGED:    { severity: 'high',   icon: '🚨', label: 'Cambio de teléfono' },
  GEOFENCE_ENTER:    { severity: 'info',   icon: '📍', label: 'Entró a geocerca' },
  GEOFENCE_EXIT:     { severity: 'medium', icon: '🚨', label: 'Salió de geocerca' },
  BACK_ONLINE:       { severity: 'info',   icon: '✅', label: 'Volvió a conectarse' },
  ADMIN_MESSAGE:     { severity: 'info',   icon: '💬', label: 'Mensaje enviado' }
};
const COOLDOWN_TYPES = new Set(['GPS_OFF', 'PERMISSION_DENIED', 'BG_RESTRICTED', 'BATTERY_LOW']);
const alertCooldown = new Map();

function raiseAlert(type, c, message) {
  const meta = ALERT_META[type] || { severity: 'medium', icon: '⚠️', label: type };
  const now = Date.now();
  if (COOLDOWN_TYPES.has(type)) {
    const key = `${c.id}:${type}`;
    if (now - (alertCooldown.get(key) || 0) < 10 * 60 * 1000) return null;
    alertCooldown.set(key, now);
  }
  const alert = {
    id: crypto.randomUUID(),
    ts: now,
    type,
    severity: meta.severity,
    icon: meta.icon,
    label: meta.label,
    clientId: c.id,
    dni: c.dni || c.id,
    name: c.name || ('Cliente ' + c.id),
    phone: c.phone || '',
    message,
    battery: c.battery ?? null,
    latitude: c.latitude ?? null,
    longitude: c.longitude ?? null
  };
  console.log(`[ALERTA ${type}] ${alert.name} (${alert.dni}): ${message}`);
  store.addAlert(alert).catch(logErr('addAlert'));
  io.to('admins').emit('admin:alert', alert);
  sendPush(alert);
  return alert;
}

async function sendPush(alert) {
  if (!pushReady || alert.severity === 'info') return;
  try {
    const subs = await store.listPushSubs();
    const payload = JSON.stringify({
      title: `${alert.icon} ${alert.label}: ${alert.name}`,
      body: alert.message,
      tag: alert.id,
      url: '/admin.html#alerts'
    });
    await Promise.all(subs.map(async (sub) => {
      try { await webpush.sendNotification(sub, payload, { TTL: 3600, urgency: 'high' }); }
      catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) store.deletePushSub(sub.endpoint).catch(() => {});
      }
    }));
  } catch (e) { logErr('push')(e); }
}

// DEDUPLICACIÓN POR IDENTIFICADOR DE HARDWARE
// Si el mismo celular físico (ANDROID_ID o deviceId) se conecta con otro DNI (ej: borraron datos o crearon registro duplicado),
// detectamos el duplicado y eliminamos el registro fantasma para que nunca haya 2 registros en curso para un mismo celular.
function deduplicateHardwareDevice(currentClientId, devId) {
  if (!devId || String(devId).length < 5) return null;
  const cleanDevId = String(devId).trim();

  for (const [otherId, other] of Array.from(clients.entries())) {
    if (otherId === currentClientId) continue;
    const otherDevId = other.deviceInfo && (other.deviceInfo.id || other.deviceInfo.deviceId);
    if (otherDevId && String(otherDevId).trim() === cleanDevId) {
      console.log(`[DEDUPLICACIÓN] Celular hardware ${cleanDevId} ya pertenecía a ${other.name} (${otherId}). Eliminando registro fantasma para evitar duplicados.`);
      clients.delete(otherId);
      clearTimeout(pendingSave.get(otherId));
      pendingSave.delete(otherId);
      store.deleteClient(otherId).catch(logErr('deleteClient'));
      io.to('admins').emit('client:removed', { clientId: otherId });
      return other;
    }
  }
  return null;
}

/* ----------------------- Cambio de dispositivo / geocercas ----------------------- */
function checkDeviceChange(client, incoming) {
  if (!incoming) return false;
  const devId = incoming.deviceId || incoming.nativeDevId;
  const rawModel = clean(incoming.model || 'Dispositivo Desconocido', 80);
  const model = resolveDeviceModel(rawModel);

  // Actualizar modelo comercial limpio en el cliente
  client.deviceModel = model;

  if (!client.deviceInfo) {
    client.deviceInfo = { id: devId, model, firstSeen: Date.now() };
    client.deviceHistory = [client.deviceInfo];
    return false;
  }
  if (model && client.deviceInfo.model !== model) {
    client.deviceInfo.model = model;
  }
  if (client.deviceInfo.id && devId && client.deviceInfo.id !== devId) {
    const previous = { ...client.deviceInfo };
    client.deviceChanged = true;
    client.previousDevice = previous;
    client.deviceInfo = { id: devId, model, changedAt: Date.now() };
    client.deviceHistory = (client.deviceHistory || [previous]).concat(client.deviceInfo).slice(-10);
    persistClient(client, true);
    io.to('admins').emit('client:device-alert', {
      clientId: client.id, dni: client.dni || client.id, name: client.name,
      oldDevice: previous.model, newDevice: model, timestamp: Date.now()
    });
    raiseAlert('DEVICE_CHANGED', client, `Cambió de teléfono: ${previous.model} ➔ ${model}`);
    return true;
  }
  return false;
}

function checkGeofences(client, lat, lng) {
  if (!geofences.length) return;
  if (!client.geofenceState) client.geofenceState = {};
  geofences.forEach(fence => {
    if (fence.clientId && fence.clientId !== client.id && fence.clientId !== client.dni) return;
    const inside = getDistanceMeters(lat, lng, fence.latitude, fence.longitude) <= fence.radius;
    const was = !!client.geofenceState[fence.id];
    const mode = fence.alertOn || 'BOTH';
    if (inside && !was) {
      client.geofenceState[fence.id] = true;
      if (mode !== 'EXIT') raiseAlert('GEOFENCE_ENTER', client, `Llegó a ${fence.name}`);
    } else if (!inside && was) {
      client.geofenceState[fence.id] = false;
      if (mode !== 'ENTER') raiseAlert('GEOFENCE_EXIT', client, `Salió de ${fence.name}`);
    }
  });
}

/* ------------------------- Procesamiento de ubicación ------------------------- */
// Único punto de entrada para REST y WebSocket: valida, guarda y avisa.
function processLocation(raw, forceTracking) {
  if (!raw || typeof raw !== 'object') return { ok: false, status: 400, error: 'Datos inválidos' };
  const id = String(raw.dni || raw.clientId || '').trim();
  if (!DNI_RE.test(id)) return { ok: false, status: 400, error: 'DNI/ID inválido' };
  const lat = Number(raw.latitude), lng = Number(raw.longitude);
  if (!validCoord(lat, lng)) return { ok: false, status: 400, error: 'Coordenadas inválidas' };

  let c = clients.get(id);
  if (!c && REQUIRE_REGISTERED) {
    return { ok: false, status: 403, error: 'Cliente no registrado. Pide al administrador que te registre.' };
  }
  if (!c) c = { id, dni: id, history: [] };

  const now = Date.now();
  if (c._lastLocAt && now - c._lastLocAt < 1000) return { ok: true, throttled: true };
  if (raw.device) {
    const devId = raw.device.deviceId || raw.device.nativeDevId;
    if (devId) deduplicateHardwareDevice(id, devId);
    checkDeviceChange(c, raw.device);
  }

  c.id = id;
  c.dni = id;
  if (!c.nameLocked && raw.name) c.name = clean(raw.name);
  if (!c.name) c.name = 'Cliente DNI ' + id;
  if (raw.phone && !c.phone) c.phone = clean(raw.phone, 20);
  c.latitude = lat;
  c.longitude = lng;
  c.accuracy = Number.isFinite(Number(raw.accuracy)) && raw.accuracy !== null ? Number(raw.accuracy) : null;
  c.speed = Number.isFinite(Number(raw.speed)) && raw.speed !== null ? Number(raw.speed) : null;
  c.heading = Number.isFinite(Number(raw.heading)) && raw.heading !== null ? Number(raw.heading) : null;
  if (raw.battery !== undefined && raw.battery !== null && Number.isFinite(Number(raw.battery))) {
    c.battery = Math.max(0, Math.min(100, Number(raw.battery)));
  }
  if (raw.charging !== undefined) c.charging = Boolean(raw.charging);
  c.isTracking = forceTracking ? true : (raw.isTracking !== undefined ? Boolean(raw.isTracking) : true);
  if (raw.consent && !c.consentAt) c.consentAt = Number(raw.consent.ts) || now;
  const wasOffline = c.offlineAlerted;
  c.lastSeen = now;

  // Si llega ubicación, el GPS y los permisos están funcionando
  if (c.gpsStatus === 'GPS_OFF' || c.gpsStatus === 'PERMISSION_DENIED') {
    c.gpsStatus = 'ACTIVE';
    c.statusMessage = '';
  }

  // Alertas de conexión y batería
  if (wasOffline) {
    c.offlineAlerted = false;
    raiseAlert('BACK_ONLINE', c, 'El cliente volvió a transmitir.');
  }
  if (c.battery !== undefined && c.battery !== null) {
    if (c.battery <= LOW_BATTERY && !c.charging) {
      if (!c.lowBatAlerted) {
        c.lowBatAlerted = true;
        raiseAlert('BATTERY_LOW', c, `Batería al ${Math.round(c.battery)}%. Puede apagarse pronto.`);
      }
    } else if (c.battery > LOW_BATTERY + 5 || c.charging) {
      c.lowBatAlerted = false;
    }
  }

  // Historial: guarda solo si se movió >20 m o pasó ≥60 s (ahorra espacio en la base gratuita)
  if (!c.history) c.history = [];
  const last = c.history[c.history.length - 1];
  const moved = !last || getDistanceMeters(last.lat, last.lng, lat, lng) > 20;
  if (moved || now - last.timestamp >= 60000) {
    const point = { lat, lng, accuracy: c.accuracy, speed: c.speed, battery: c.battery, timestamp: now };
    c.history.push(point);
    if (c.history.length > 200) c.history.shift();
    store.addPoint(id, point).catch(logErr('addPoint'));
  }

  checkGeofences(c, lat, lng);

  const isNew = !clients.has(id);
  clients.set(id, c);
  persistClient(c, isNew);
  io.to('admins').emit('client:location-updated', { client: pub(c) });
  return { ok: true, client: c };
}

function processGpsAlert(data) {
  if (!data) return false;
  const id = String(data.dni || data.clientId || '').trim();
  if (!DNI_RE.test(id)) return false;
  const c = clients.get(id) || (REQUIRE_REGISTERED ? null : { id, dni: id, history: [] });
  if (!c) return false;
  const status = ['GPS_OFF', 'PERMISSION_DENIED', 'BG_RESTRICTED', 'ACTIVE'].includes(data.gpsStatus) ? data.gpsStatus : 'GPS_OFF';
  c.gpsStatus = status;
  c.statusMessage = clean(data.message || (status === 'ACTIVE' ? '' : 'GPS desactivado'), 160);
  c.lastAlertTime = Date.now();
  if (!c.nameLocked && data.name) c.name = clean(data.name);
  clients.set(id, c);
  persistClient(c, true);

  io.to('admins').emit('client:gps-alert', {
    clientId: id, dni: id, name: c.name || ('Cliente DNI ' + id),
    gpsStatus: status, message: c.statusMessage, timestamp: Date.now()
  });
  if (status !== 'ACTIVE') {
    const msgs = {
      GPS_OFF: 'Apagó el interruptor de GPS de su teléfono.',
      PERMISSION_DENIED: 'Denegó/retiró el permiso de ubicación.',
      BG_RESTRICTED: 'Falta el permiso "Permitir todo el tiempo"; puede dejar de transmitir con la pantalla bloqueada.'
    };
    raiseAlert(status, c, msgs[status]);
  }
  return true;
}

/* ----------------------------- Vigilante de conexión ----------------------------- */
function watchdog() {
  const now = Date.now();
  for (const c of clients.values()) {
    if (!c.lastSeen || !c.isTracking || c.offlineAlerted) continue;
    const silentMs = now - c.lastSeen;
    if (silentMs < OFFLINE_SECONDS * 1000) continue;
    c.offlineAlerted = true;
    persistClient(c, true);
    io.to('admins').emit('client:status-changed', { clientId: c.id, dni: c.dni, isOnline: false });
    const mins = Math.max(1, Math.round(silentMs / 60000));
    const dead = c.battery !== undefined && c.battery !== null && c.battery <= DEAD_BATTERY && !c.charging;
    if (dead) {
      raiseAlert('BATTERY_DEAD', c, `Dejó de transmitir hace ${mins} min con batería al ${Math.round(c.battery)}%. Probablemente se quedó sin batería.`);
    } else {
      raiseAlert('OFFLINE', c, `Sin señal hace ${mins} min (batería ${c.battery != null ? Math.round(c.battery) + '%' : 'desconocida'}). Puede estar sin internet, con la app cerrada o el teléfono apagado.`);
    }
  }
}

/* ---------------------------------- Rutas públicas ---------------------------------- */
app.get('/api/health', (req, res) => res.json({ ok: true, storage: store.kind, uptime: Math.round(process.uptime()) }));

const APP_VERSION = {
  versionCode: 5,
  versionName: '5.0',
  apkUrl: '/download-apk',
  forceUpdate: false,
  releaseNotes: 'Rastreo ultra-preciso con Actividad Física, Triangulación Bluetooth y reconexión automática en arranque.'
};

app.get('/api/app-version', (req, res) => res.json({ success: true, ...APP_VERSION }));

app.get(['/download-apk', '/download', '/download/apk', '/geoclient.apk'], (req, res) => {
  res.download(path.join(__dirname, 'public', 'geoclient.apk'), 'GeoClient-Localizador.apk', (err) => {
    if (err && !res.headersSent) res.status(500).send('No se pudo descargar el archivo APK');
  });
});

app.post('/api/location', (req, res) => {
  const r = processLocation(req.body, false);
  if (!r.ok) return res.status(r.status || 400).json({ success: false, error: r.error });
  res.json({ success: true, message: 'Ubicación registrada con éxito' });
});

app.post('/api/gps-alert', (req, res) => {
  if (!processGpsAlert(req.body)) return res.status(400).json({ success: false, error: 'Datos inválidos' });
  res.json({ success: true, message: 'Alerta procesada' });
});

/* -------------------------- Rutas de Navegación Limpia (SaaS Multi-Usuario) ------------------------- */
// Portal Corporativo Institucional (Página Principal de Confianza)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Panel de Administración Central (URL limpia)
app.get(['/admin', '/dashboard', '/panel'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Portal de Autenticación de Administrador
app.get(['/login', '/acceso', '/auth'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Portal de Vinculación y Telemetría del Cliente (URL limpia)
app.get(['/cliente', '/rastreo', '/tracking', '/app'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'client.html'));
});

// Centro Oficial de Descargas (URL limpia)
app.get(['/descargar', '/descargas', '/instalador'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'descargar.html'));
});

// Redirecciones 301 automáticas para eliminar archivos .html de la barra de direcciones
app.get('/admin.html', (req, res) => res.redirect(301, '/admin'));
app.get('/client.html', (req, res) => {
  const q = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
  res.redirect(301, '/cliente' + q);
});
app.get('/descargar.html', (req, res) => res.redirect(301, '/descargar'));
app.get('/login.html', (req, res) => res.redirect(301, '/login'));

app.use(express.static(path.join(__dirname, 'public')));

/* ---------------------------------- Rutas de admin ---------------------------------- */
app.get('/api/server-info', requireAdmin, (req, res) => {
  const proto = (req.get('x-forwarded-proto') || req.protocol || 'http').split(',')[0];
  const baseUrl = `${proto}://${req.get('host')}`;
  res.json({
    localIp: getLocalIp(), port: PORT, baseUrl,
    adminUrl: `${baseUrl}/admin`, clientUrl: `${baseUrl}/cliente`, apkUrl: `${baseUrl}/descargar`,
    storage: store.kind, requireRegistered: REQUIRE_REGISTERED, historyDays: HISTORY_DAYS,
    currentTime: Date.now()
  });
});

app.get('/api/clients', requireAdmin, (req, res) => {
  const list = Array.from(clients.values()).map(c => {
    const p = pub(c);
    delete p.history;
    p.historyCount = (c.history || []).length;
    return p;
  });
  res.json({ success: true, count: list.length, clients: list });
});

app.post('/api/clients', requireAdmin, async (req, res) => {
  const { dni, name, phone, notes } = req.body || {};
  const id = String(dni || '').trim();
  if (!DNI_RE.test(id)) return res.status(400).json({ success: false, error: 'DNI inválido (3-24 letras/números)' });
  const c = clients.get(id) || { id, history: [] };
  c.dni = id;
  if (name) { c.name = clean(name); c.nameLocked = true; }
  if (phone) c.phone = clean(phone, 20);
  if (notes) c.notes = clean(notes, 300);
  c.updatedAt = Date.now();
  clients.set(id, c);
  persistClient(c, true);
  io.to('admins').emit('client:location-updated', { client: pub(c) });
  res.json({ success: true, client: pub(c) });
});

function resolveClientId(param) {
  const p = String(param || '').trim();
  if (clients.has(p)) return p;
  for (const [id, c] of clients.entries()) if (String(c.dni || '') === p) return id;
  return null;
}

app.delete('/api/clients/:id', requireAdmin, async (req, res) => {
  const id = resolveClientId(req.params.id);
  if (!id) return res.status(404).json({ success: false, error: 'Cliente no encontrado' });
  clients.delete(id);
  clearTimeout(pendingSave.get(id)); pendingSave.delete(id);
  try { await store.deleteClient(id); } catch (e) { logErr('deleteClient')(e); }
  io.to('admins').emit('client:removed', { clientId: id });
  res.json({ success: true, message: 'Cliente eliminado exitosamente', removedId: id });
});

app.post('/api/clients/purge-inactive', requireAdmin, async (req, res) => {
  const days = Number(req.body && req.body.days) || 3;
  const limit = Date.now() - days * 24 * 3600 * 1000;
  const removedIds = [];
  for (const [id, c] of Array.from(clients.entries())) {
    if (!c.latitude || !c.lastSeen || c.lastSeen < limit) {
      clients.delete(id);
      removedIds.push(id);
      try { await store.deleteClient(id); } catch (e) { logErr('purge')(e); }
      io.to('admins').emit('client:removed', { clientId: id });
    }
  }
  res.json({ success: true, count: removedIds.length, removedIds });
});

// El administrador confirma que el cambio de teléfono es legítimo
app.post('/api/clients/:id/confirm-device', requireAdmin, (req, res) => {
  const id = resolveClientId(req.params.id);
  if (!id) return res.status(404).json({ success: false, error: 'Cliente no encontrado' });
  const c = clients.get(id);
  c.deviceChanged = false;
  c.previousDevice = null;
  persistClient(c, true);
  io.to('admins').emit('client:location-updated', { client: pub(c) });
  res.json({ success: true });
});

// Enviar notificación / mensaje directo a un cliente desde el panel admin
app.post('/api/clients/:id/send-message', requireAdmin, (req, res) => {
  const id = resolveClientId(req.params.id);
  if (!id) return res.status(404).json({ success: false, error: 'Cliente no encontrado' });
  const c = clients.get(id);

  const title = clean((req.body && req.body.title) || 'Aviso de Administración', 80);
  const message = clean((req.body && req.body.message) || '', 500);
  const playSound = req.body && req.body.playSound !== false;
  const urgency = req.body && req.body.urgency === 'high' ? 'high' : 'normal';

  if (!message) return res.status(400).json({ success: false, error: 'El mensaje no puede estar vacío' });

  const msgPayload = {
    id: crypto.randomUUID(),
    title,
    message,
    playSound,
    urgency,
    timestamp: Date.now()
  };

  io.to(`client:${id}`).emit('client:incoming-message', msgPayload);
  raiseAlert('ADMIN_MESSAGE', c, `Aviso enviado: "${message.slice(0, 70)}"`);

  res.json({ success: true, delivered: isOnline(c), message: msgPayload });
});

// Enviar notificación / mensaje a TODOS los clientes simultáneamente
app.post('/api/clients/broadcast-message', requireAdmin, (req, res) => {
  const title = clean((req.body && req.body.title) || 'Aviso General', 80);
  const message = clean((req.body && req.body.message) || '', 500);
  const playSound = req.body && req.body.playSound !== false;

  if (!message) return res.status(400).json({ success: false, error: 'El mensaje no puede estar vacío' });

  const msgPayload = {
    id: crypto.randomUUID(),
    title,
    message,
    playSound,
    urgency: 'high',
    timestamp: Date.now()
  };

  io.emit('client:incoming-message', msgPayload);
  res.json({ success: true, count: clients.size, message: msgPayload });
});

app.get('/api/clients/:id/history', requireAdmin, (req, res) => {
  const c = clients.get(req.params.id);
  if (!c) return res.status(404).json({ success: false, error: 'Cliente no encontrado' });
  res.json({ success: true, clientId: c.id, history: c.history || [] });
});

app.get('/api/clients/:id/history-days', requireAdmin, async (req, res) => {
  try { res.json({ success: true, days: await store.historyDays(req.params.id) }); }
  catch (e) { res.status(500).json({ success: false, error: 'Error leyendo historial' }); }
});

app.get('/api/clients/:id/history-day/:day', requireAdmin, async (req, res) => {
  const day = String(req.params.day).replace(/[^0-9-]/g, '');
  try {
    const points = await store.historyDay(req.params.id, day);
    res.json({ success: true, day, count: points.length, points });
  } catch (e) { res.status(500).json({ success: false, error: 'Error leyendo el día' }); }
});

/* Geocercas */
app.get('/api/geofences', requireAdmin, (req, res) => res.json({ success: true, count: geofences.length, geofences }));

app.post('/api/geofences', requireAdmin, async (req, res) => {
  const { name, latitude, longitude, radius, clientId, type, alertOn } = req.body || {};
  const lat = Number(latitude), lng = Number(longitude);
  if (!name || !validCoord(lat, lng)) return res.status(400).json({ success: false, error: 'Nombre y coordenadas válidas requeridos' });
  const fence = {
    id: 'GEO-' + Date.now().toString(36),
    name: clean(name, 60), latitude: lat, longitude: lng,
    radius: Math.max(20, Math.min(50000, Number(radius) || 150)),
    clientId: clientId ? String(clientId).trim() : null,
    type: type || 'CASA', alertOn: alertOn || 'BOTH', createdAt: Date.now()
  };
  geofences.push(fence);
  await store.saveGeofence(fence).catch(logErr('saveGeofence'));
  io.to('admins').emit('geofence:created', fence);
  res.json({ success: true, geofence: fence });
});

app.delete('/api/geofences/:id', requireAdmin, async (req, res) => {
  const id = req.params.id;
  geofences = geofences.filter(g => g.id !== id);
  await store.deleteGeofence(id).catch(logErr('deleteGeofence'));
  io.to('admins').emit('geofence:deleted', { id });
  res.json({ success: true, message: 'Geocerca eliminada' });
});

/* Alertas */
app.get('/api/alerts', requireAdmin, async (req, res) => {
  const limit = Math.min(300, Number(req.query.limit) || 100);
  res.json({ success: true, alerts: await store.listAlerts(limit) });
});
app.post('/api/alerts/ack-all', requireAdmin, async (req, res) => {
  await store.ackAllAlerts();
  res.json({ success: true });
});
app.post('/api/alerts/:id/ack', requireAdmin, async (req, res) => {
  await store.ackAlert(req.params.id);
  res.json({ success: true });
});

/* Notificaciones push (llegan aunque el panel esté cerrado) */
app.get('/api/push/key', requireAdmin, (req, res) => {
  res.json({ success: true, enabled: pushReady, publicKey: pushReady ? webpush.__publicKey : null });
});
app.post('/api/push/subscribe', requireAdmin, async (req, res) => {
  const sub = req.body && req.body.subscription;
  if (!sub || !sub.endpoint || !sub.keys) return res.status(400).json({ success: false, error: 'Suscripción inválida' });
  await store.savePushSub(sub);
  res.json({ success: true });
});
app.post('/api/push/unsubscribe', requireAdmin, async (req, res) => {
  if (req.body && req.body.endpoint) await store.deletePushSub(req.body.endpoint);
  res.json({ success: true });
});

/* ----------------------------------- Socket.IO ----------------------------------- */
io.on('connection', (socket) => {
  let boundClientId = null;

  socket.on('admin:join', async (data) => {
    if (!verifyToken(data && data.token)) { socket.emit('admin:unauthorized'); return; }
    socket.join('admins');
    socket.emit('admin:init-clients', Array.from(clients.values()).map(pub));
    socket.emit('admin:init-geofences', geofences);
    try { socket.emit('admin:init-alerts', await store.listAlerts(100)); } catch (_) {}
  });

  socket.on('client:join', (data) => {
    if (!data) return;
    const id = String(data.dni || data.clientId || '').trim();
    if (!DNI_RE.test(id)) return;
    let c = clients.get(id);
    if (!c && REQUIRE_REGISTERED) { socket.emit('client:rejected', { error: 'Cliente no registrado' }); return; }
    if (!c) c = { id, dni: id, history: [] };
    boundClientId = id;
    socket.join(`client:${id}`);
    c.dni = id;
    if (!c.nameLocked && data.name) c.name = clean(data.name);
    if (!c.name) c.name = 'Cliente DNI ' + id;
    if (data.phone && !c.phone) c.phone = clean(data.phone, 20);
    if (data.consent && !c.consentAt) c.consentAt = Number(data.consent.ts) || Date.now();
    c.lastSeen = Date.now();
    c.isTracking = true;
    if (data.device) {
      const devId = data.device.deviceId || data.device.nativeDevId;
      if (devId) deduplicateHardwareDevice(id, devId);
      checkDeviceChange(c, data.device);
    }
    const wasOffline = c.offlineAlerted;
    if (wasOffline) { c.offlineAlerted = false; raiseAlert('BACK_ONLINE', c, 'El cliente volvió a conectarse.'); }
    clients.set(id, c);
    persistClient(c, true);
    io.to('admins').emit('client:status-changed', { clientId: id, dni: id, isOnline: true, name: c.name });
  });

  socket.on('client:update-location', (loc) => { processLocation(loc, true); });

  socket.on('client:toggle-tracking', (data) => {
    const id = String((data && (data.dni || data.clientId)) || '').trim();
    const c = clients.get(id);
    if (!c) return;
    c.isTracking = !!data.isTracking;
    c.lastSeen = Date.now();
    persistClient(c, true);
    io.to('admins').emit('client:status-changed', { clientId: id, dni: c.dni, isTracking: c.isTracking, isOnline: true });
    if (!c.isTracking) raiseAlert('TRACKING_OFF', c, 'Detuvo la transmisión de su ubicación.');
  });

  socket.on('client:gps-alert', (data) => { processGpsAlert(data); });

  socket.on('client:message-ack', (ack) => {
    if (!ack) return;
    const cid = ack.clientId || boundClientId;
    io.to('admins').emit('client:message-delivered', {
      clientId: cid,
      messageId: ack.messageId,
      timestamp: Date.now()
    });
  });

  socket.on('disconnect', () => {
    if (!boundClientId) return;
    const c = clients.get(boundClientId);
    if (c) c.lastSeen = Math.max(c.lastSeen || 0, Date.now() - 1000);
  });
});

/* ------------------------------------- Arranque ------------------------------------- */
async function initSecrets() {
  SECRET = process.env.AUTH_SECRET || await store.getConfig('auth_secret');
  if (!SECRET) {
    SECRET = crypto.randomBytes(32).toString('hex');
    await store.setConfig('auth_secret', SECRET);
  }

  try {
    webpush = require('web-push');
    let vapid = await store.getConfig('vapid');
    if (vapid) { try { vapid = JSON.parse(vapid); } catch (_) { vapid = null; } }
    if (!vapid) {
      vapid = webpush.generateVAPIDKeys();
      await store.setConfig('vapid', JSON.stringify(vapid));
    }
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@geoclient.local', vapid.publicKey, vapid.privateKey);
    webpush.__publicKey = vapid.publicKey;
    pushReady = true;
  } catch (e) {
    console.warn('⚠️ Notificaciones push desactivadas:', e.message);
  }
}

async function main() {
  await store.init();
  await initSecrets();

  const list = await store.loadClients();
  const now = Date.now();
  list.forEach(c => {
    // Evita una avalancha de alertas "sin señal" al reiniciar el servidor
    if (c.lastSeen && now - c.lastSeen > OFFLINE_SECONDS * 1000) c.offlineAlerted = true;
    clients.set(c.id, c);
  });
  geofences = await store.loadGeofences();
  console.log(`💾 Almacenamiento: ${store.kind} | 📂 ${clients.size} clientes | 📍 ${geofences.length} geocercas`);

  store.cleanup().catch(logErr('cleanup'));
  setInterval(() => store.cleanup().catch(logErr('cleanup')), 6 * 3600 * 1000);
  setInterval(watchdog, 15000);

  server.listen(PORT, '0.0.0.0', () => {
    console.log('=======================================================');
    console.log(`🚀 GEO-CLIENT v3 escuchando en el puerto ${PORT}`);
    console.log(`📱 Panel Administrador: http://localhost:${PORT}/admin.html`);
    console.log(`📡 Red local:           http://${getLocalIp()}:${PORT}/admin.html`);
    console.log(`🔐 Login admin: ${process.env.ADMIN_PASSWORD ? 'contraseña de ADMIN_PASSWORD' : "contraseña por defecto 'admin123' (SOLO desarrollo)"}`);
    console.log(`🔔 Push: ${pushReady ? 'activo' : 'inactivo'} | Registro obligatorio: ${REQUIRE_REGISTERED}`);
    console.log('=======================================================');
  });
}

async function shutdown() {
  console.log('Cerrando servidor, guardando datos...');
  for (const [id, t] of pendingSave.entries()) {
    clearTimeout(t);
    const c = clients.get(id);
    if (c) await store.saveClient(c).catch(() => {});
  }
  if (store.flushNow) store.flushNow();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e && e.message ? e.message : e));

main().catch((e) => { console.error('❌ Error al iniciar:', e); process.exit(1); });
