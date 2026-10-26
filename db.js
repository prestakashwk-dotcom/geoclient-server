// db.js - Capa de almacenamiento persistente
// - Con DATABASE_URL  -> PostgreSQL (Neon, Supabase, Render...). Sobrevive reinicios y redeploys.
// - Sin DATABASE_URL  -> archivos JSON en ./data (solo para desarrollo local).
const fs = require('fs');
const path = require('path');

const TZ = process.env.APP_TZ || 'America/Lima';
const HISTORY_DAYS = Number(process.env.HISTORY_DAYS) || 60;
const ALERT_DAYS = 30;

function dayString(ts = Date.now()) {
  return new Date(ts).toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD
}

function stripClient(c) {
  const clone = {};
  for (const k of Object.keys(c)) {
    if (k.startsWith('_') || k === 'geofenceState' || k === 'history') continue;
    clone[k] = c[k];
  }
  return clone;
}

/* ------------------------------------------------------------------ */
/*  BACKEND POSTGRESQL                                                */
/* ------------------------------------------------------------------ */
function createPgStore(connectionString) {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString,
    ssl: /localhost|127\.0\.0\.1/.test(connectionString) ? false : { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 15000
  });
  pool.on('error', (e) => console.error('[pg] error en conexión inactiva:', e.message));

  return {
    kind: 'postgres',

    async init() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS clients (
          id text PRIMARY KEY,
          data jsonb NOT NULL,
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS locations (
          id bigserial PRIMARY KEY,
          client_id text NOT NULL,
          ts bigint NOT NULL,
          day text NOT NULL,
          lat double precision NOT NULL,
          lng double precision NOT NULL,
          accuracy real,
          speed real,
          battery real
        );
        CREATE INDEX IF NOT EXISTS idx_loc_client_day ON locations (client_id, day, ts);
        CREATE INDEX IF NOT EXISTS idx_loc_ts ON locations (ts);
        CREATE TABLE IF NOT EXISTS geofences (
          id text PRIMARY KEY,
          data jsonb NOT NULL
        );
        CREATE TABLE IF NOT EXISTS alerts (
          id text PRIMARY KEY,
          ts bigint NOT NULL,
          acked boolean NOT NULL DEFAULT false,
          data jsonb NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_alerts_ts ON alerts (ts DESC);
        CREATE TABLE IF NOT EXISTS config (
          key text PRIMARY KEY,
          value text NOT NULL
        );
        CREATE TABLE IF NOT EXISTS push_subs (
          endpoint text PRIMARY KEY,
          data jsonb NOT NULL
        );
      `);
    },

    async loadClients() {
      const { rows } = await pool.query('SELECT id, data FROM clients');
      const list = rows.map(r => ({ ...r.data, id: r.id, history: [] }));
      // Últimos puntos recientes para dibujar la ruta en vivo
      const since = Date.now() - 2 * 24 * 3600 * 1000;
      const pts = await pool.query(
        `SELECT client_id, ts, lat, lng, accuracy, speed, battery FROM (
           SELECT *, row_number() OVER (PARTITION BY client_id ORDER BY ts DESC) rn
           FROM locations WHERE ts > $1
         ) t WHERE rn <= 60 ORDER BY ts ASC`, [since]);
      const byId = new Map(list.map(c => [c.id, c]));
      pts.rows.forEach(p => {
        const c = byId.get(p.client_id);
        if (c) c.history.push({ lat: p.lat, lng: p.lng, accuracy: p.accuracy, speed: p.speed, battery: p.battery, timestamp: Number(p.ts) });
      });
      return list;
    },

    async saveClient(c) {
      await pool.query(
        `INSERT INTO clients (id, data, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
        [c.id, JSON.stringify(stripClient(c))]);
    },

    async deleteClient(id) {
      await pool.query('DELETE FROM clients WHERE id = $1', [id]);
      await pool.query('DELETE FROM locations WHERE client_id = $1', [id]);
    },

    async addPoint(clientId, p) {
      await pool.query(
        `INSERT INTO locations (client_id, ts, day, lat, lng, accuracy, speed, battery)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [clientId, p.timestamp, dayString(p.timestamp), p.lat, p.lng, p.accuracy ?? null, p.speed ?? null, p.battery ?? null]);
    },

    async historyDays(clientId) {
      const { rows } = await pool.query(
        'SELECT DISTINCT day FROM locations WHERE client_id = $1 ORDER BY day DESC', [clientId]);
      return rows.map(r => r.day);
    },

    async historyDay(clientId, day) {
      const { rows } = await pool.query(
        `SELECT ts, lat, lng, accuracy, speed, battery FROM locations
         WHERE client_id = $1 AND day = $2 ORDER BY ts ASC`, [clientId, day]);
      return rows.map(r => ({ lat: r.lat, lng: r.lng, accuracy: r.accuracy, speed: r.speed, battery: r.battery, timestamp: Number(r.ts) }));
    },

    async cleanup() {
      const limit = Date.now() - HISTORY_DAYS * 24 * 3600 * 1000;
      await pool.query('DELETE FROM locations WHERE ts < $1', [limit]);
      await pool.query('DELETE FROM alerts WHERE ts < $1', [Date.now() - ALERT_DAYS * 24 * 3600 * 1000]);
    },

    async loadGeofences() {
      const { rows } = await pool.query('SELECT data FROM geofences');
      return rows.map(r => r.data);
    },
    async saveGeofence(f) {
      await pool.query(
        `INSERT INTO geofences (id, data) VALUES ($1,$2)
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`, [f.id, JSON.stringify(f)]);
    },
    async deleteGeofence(id) {
      await pool.query('DELETE FROM geofences WHERE id = $1', [id]);
    },

    async addAlert(a) {
      await pool.query('INSERT INTO alerts (id, ts, acked, data) VALUES ($1,$2,false,$3) ON CONFLICT DO NOTHING',
        [a.id, a.ts, JSON.stringify(a)]);
    },
    async listAlerts(limit = 100) {
      const { rows } = await pool.query('SELECT data, acked FROM alerts ORDER BY ts DESC LIMIT $1', [limit]);
      return rows.map(r => ({ ...r.data, acked: r.acked }));
    },
    async ackAlert(id) {
      await pool.query('UPDATE alerts SET acked = true WHERE id = $1', [id]);
    },
    async ackAllAlerts() {
      await pool.query('UPDATE alerts SET acked = true WHERE acked = false');
    },

    async getConfig(key) {
      const { rows } = await pool.query('SELECT value FROM config WHERE key = $1', [key]);
      return rows[0] ? rows[0].value : null;
    },
    async setConfig(key, value) {
      await pool.query(
        `INSERT INTO config (key, value) VALUES ($1,$2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, String(value)]);
    },

    async listPushSubs() {
      const { rows } = await pool.query('SELECT data FROM push_subs');
      return rows.map(r => r.data);
    },
    async savePushSub(sub) {
      await pool.query(
        `INSERT INTO push_subs (endpoint, data) VALUES ($1,$2)
         ON CONFLICT (endpoint) DO UPDATE SET data = EXCLUDED.data`, [sub.endpoint, JSON.stringify(sub)]);
    },
    async deletePushSub(endpoint) {
      await pool.query('DELETE FROM push_subs WHERE endpoint = $1', [endpoint]);
    }
  };
}

/* ------------------------------------------------------------------ */
/*  BACKEND ARCHIVOS (desarrollo local)                               */
/* ------------------------------------------------------------------ */
function createFileStore(baseDir) {
  const DATA_DIR = path.join(baseDir, 'data');
  const CLIENTS_FILE = path.join(DATA_DIR, 'clients.json');
  const GEOFENCES_FILE = path.join(DATA_DIR, 'geofences.json');
  const ALERTS_FILE = path.join(DATA_DIR, 'alerts.json');
  const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
  const PUSH_FILE = path.join(DATA_DIR, 'push-subs.json');
  const HISTORY_DIR = path.join(DATA_DIR, 'history');

  const cache = new Map();   // id -> client sin history
  let geofences = [];
  let alerts = [];
  let dirtyTimer = null;

  const safe = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '_');
  const readJson = (file, fallback) => {
    try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback; }
    catch (_) { return fallback; }
  };
  const writeJson = (file, data) => {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file); // escritura atómica: evita archivos corruptos
  };
  const flushClients = () => {
    dirtyTimer = null;
    const obj = {};
    for (const [k, v] of cache.entries()) obj[k] = v;
    try { writeJson(CLIENTS_FILE, obj); } catch (e) { console.error('Error guardando clients.json:', e.message); }
  };

  return {
    kind: 'archivos',

    async init() {
      fs.mkdirSync(HISTORY_DIR, { recursive: true });
      geofences = readJson(GEOFENCES_FILE, []);
      alerts = readJson(ALERTS_FILE, []);
    },

    async loadClients() {
      const data = readJson(CLIENTS_FILE, {});
      return Object.entries(data).map(([k, v]) => {
        cache.set(k, stripClient(v));
        return { ...v, id: v.id || k, history: v.history || [] };
      });
    },

    async saveClient(c) {
      cache.set(c.id, stripClient(c));
      if (!dirtyTimer) dirtyTimer = setTimeout(flushClients, 1500); // agrupa escrituras
    },

    async deleteClient(id) {
      cache.delete(id);
      flushClients();
      const dir = path.join(HISTORY_DIR, safe(id));
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    },

    async addPoint(clientId, p) {
      const dir = path.join(HISTORY_DIR, safe(clientId));
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${dayString(p.timestamp)}.json`);
      const pts = readJson(file, []);
      pts.push(p);
      fs.writeFileSync(file, JSON.stringify(pts), 'utf8');
    },

    async historyDays(clientId) {
      const dir = path.join(HISTORY_DIR, safe(clientId));
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => f.replace('.json', '')).sort().reverse();
    },

    async historyDay(clientId, day) {
      const d = String(day).replace(/[^0-9-]/g, '');
      return readJson(path.join(HISTORY_DIR, safe(clientId), `${d}.json`), []);
    },

    async cleanup() {
      const limit = Date.now() - HISTORY_DAYS * 24 * 3600 * 1000;
      if (!fs.existsSync(HISTORY_DIR)) return;
      for (const cid of fs.readdirSync(HISTORY_DIR)) {
        const dir = path.join(HISTORY_DIR, cid);
        for (const f of fs.readdirSync(dir)) {
          const fp = path.join(dir, f);
          if (fs.statSync(fp).mtimeMs < limit) { try { fs.unlinkSync(fp); } catch (_) {} }
        }
      }
    },

    async loadGeofences() { return geofences; },
    async saveGeofence(f) {
      geofences = geofences.filter(g => g.id !== f.id);
      geofences.push(f);
      writeJson(GEOFENCES_FILE, geofences);
    },
    async deleteGeofence(id) {
      geofences = geofences.filter(g => g.id !== id);
      writeJson(GEOFENCES_FILE, geofences);
    },

    async addAlert(a) {
      alerts.unshift({ ...a, acked: false });
      alerts = alerts.slice(0, 500);
      writeJson(ALERTS_FILE, alerts);
    },
    async listAlerts(limit = 100) { return alerts.slice(0, limit); },
    async ackAlert(id) {
      const a = alerts.find(x => x.id === id);
      if (a) { a.acked = true; writeJson(ALERTS_FILE, alerts); }
    },
    async ackAllAlerts() {
      alerts.forEach(a => { a.acked = true; });
      writeJson(ALERTS_FILE, alerts);
    },

    async getConfig(key) {
      const cfg = readJson(CONFIG_FILE, {});
      return cfg[key] !== undefined ? cfg[key] : null;
    },
    async setConfig(key, value) {
      const cfg = readJson(CONFIG_FILE, {});
      cfg[key] = String(value);
      writeJson(CONFIG_FILE, cfg);
    },

    async listPushSubs() { return readJson(PUSH_FILE, []); },
    async savePushSub(sub) {
      const subs = readJson(PUSH_FILE, []).filter(s => s.endpoint !== sub.endpoint);
      subs.push(sub);
      writeJson(PUSH_FILE, subs);
    },
    async deletePushSub(endpoint) {
      writeJson(PUSH_FILE, readJson(PUSH_FILE, []).filter(s => s.endpoint !== endpoint));
    },

    flushNow() { if (dirtyTimer) { clearTimeout(dirtyTimer); flushClients(); } }
  };
}

function createStore(baseDir) {
  const url = process.env.DATABASE_URL;
  return url ? createPgStore(url) : createFileStore(baseDir);
}

module.exports = { createStore, dayString, HISTORY_DAYS };
