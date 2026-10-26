// client.js - Transmisor de Ubicación en Tiempo Real
let socket = null;
let watchId = null;
let isTracking = true;
let pingsCount = 0;
let batteryLevel = null;
let isCharging = false;

// Estado del cliente
let clientData = {
  id: '',
  dni: '',
  name: '',
  phone: '',
  serverUrl: ''
};

// Cargar parámetros de URL o LocalStorage
function initClientData() {
  const params = new URLSearchParams(window.location.search);
  
  // DNI prioritario desde URL o LocalStorage
  clientData.dni = params.get('dni') || params.get('id') || localStorage.getItem('geoclient_dni');
  
  // Si no hay DNI en URL ni en LocalStorage, consultar a AndroidApp nativo (SharedPreferences permanente)
  if (!clientData.dni && window.AndroidApp && typeof window.AndroidApp.getSavedCredentials === 'function') {
    try {
      const saved = JSON.parse(window.AndroidApp.getSavedCredentials());
      if (saved && saved.dni) {
        clientData.dni = saved.dni;
        if (saved.name) clientData.name = saved.name;
        if (saved.phone) clientData.phone = saved.phone;
        localStorage.setItem('geoclient_dni', clientData.dni);
        if (clientData.name) localStorage.setItem('geoclient_name', clientData.name);
        if (clientData.phone) localStorage.setItem('geoclient_phone', clientData.phone);
      }
    } catch (_) {}
  }
  
  // Si aún no hay DNI, solicitar login al cliente
  if (!clientData.dni) {
    const loginModal = document.getElementById('modal-client-login');
    if (loginModal) loginModal.classList.add('open');
    return false;
  }

  clientData.id = clientData.dni;
  localStorage.setItem('geoclient_dni', clientData.dni);
  localStorage.setItem('geoclient_id', clientData.id);

  // Nombre
  clientData.name = params.get('name') || localStorage.getItem('geoclient_name') || 'Cliente DNI ' + clientData.dni;
  localStorage.setItem('geoclient_name', clientData.name);

  // Teléfono
  clientData.phone = params.get('phone') || localStorage.getItem('geoclient_phone') || '';
  if (clientData.phone) localStorage.setItem('geoclient_phone', clientData.phone);

  // Servidor (priorizar Render cloud en producción y APK)
  const defaultServer = 'https://geoclient-radar.onrender.com';
  let sUrl = params.get('server') || localStorage.getItem('geoclient_server');
  // Si no hay servidor, o contiene localhost / 192.168 / file:, migrar automáticamente a Render
  if (!sUrl || sUrl === 'file://' || sUrl.startsWith('file:') || sUrl === 'null' || sUrl.includes('localhost') || sUrl.includes('192.168')) {
    sUrl = (window.location.protocol === 'http:' || window.location.protocol === 'https:') 
      ? window.location.origin 
      : defaultServer;
  }
  clientData.serverUrl = sUrl.replace(/\/+$/, '');
  localStorage.setItem('geoclient_server', clientData.serverUrl);

  // Actualizar UI
  document.getElementById('client-display-id').textContent = `DNI: ${clientData.dni}`;
  document.getElementById('client-display-name').textContent = clientData.name;
  document.getElementById('user-avatar').textContent = (clientData.name || 'C').substring(0, 2).toUpperCase();
  const dniInput = document.getElementById('input-edit-dni');
  if (dniInput) dniInput.value = clientData.dni;
  document.getElementById('input-edit-name').value = clientData.name;
  document.getElementById('input-server-url').value = clientData.serverUrl;
  return true;
}

// Monitoreo de batería si el navegador lo soporta
function initBattery() {
  if (navigator.getBattery) {
    navigator.getBattery().then(battery => {
      function updateBatteryInfo() {
        batteryLevel = battery.level * 100;
        isCharging = battery.charging;
        const batEl = document.getElementById('val-battery');
        batEl.textContent = `${Math.round(batteryLevel)}% ${isCharging ? '⚡' : ''}`;
      }
      updateBatteryInfo();
      battery.addEventListener('levelchange', updateBatteryInfo);
      battery.addEventListener('chargingchange', updateBatteryInfo);
    }).catch(() => {});
  }
}

// Obtener huella e información del dispositivo
function getDeviceFingerprint() {
  let devId = localStorage.getItem('geoclient_hardware_id');
  if (!devId) {
    devId = 'HW-' + Array.from(crypto.getRandomValues(new Uint8Array(8))).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    localStorage.setItem('geoclient_hardware_id', devId);
  }

  const urlParams = new URLSearchParams(window.location.search);
  const nativeModel = urlParams.get('nativeModel');
  const nativeDevId = urlParams.get('nativeDevId');

  let modelName = nativeModel || 'Android';
  if (!nativeModel) {
    const ua = navigator.userAgent;
    const match = ua.match(/Android[^;]+; ([^;)]+)/);
    if (match && match[1]) {
      modelName = match[1].trim();
    } else if (ua.includes('iPhone')) {
      modelName = 'Apple iPhone';
    } else if (ua.includes('Windows')) {
      modelName = 'PC Windows';
    }
  }

  return {
    deviceId: nativeDevId || devId,
    model: modelName,
    screen: `${window.screen.width}x${window.screen.height}`
  };
}

// Iniciar conexión Socket.io
function connectSocket() {
  const url = clientData.serverUrl || 'https://geoclient-radar.onrender.com';
  console.log('📡 Conectando al radar:', url);
  
  if (typeof io !== 'function') {
    console.error('❌ Socket.io no disponible');
    const summary = document.getElementById('status-summary');
    if (summary) summary.textContent = '⚠️ Error: Librería de conexión no cargada';
    return;
  }

  try {
    socket = io(url, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      randomizationFactor: 0.5
    });

    socket.on('connect', () => {
      console.log('✅ Conectado exitosamente al radar en:', url);
      const summary = document.getElementById('status-summary');
      if (summary) summary.textContent = '🟢 Conectado al Radar en Vivo (24/7)';
      socket.emit('client:join', {
        clientId: clientData.id,
        dni: clientData.dni,
        name: clientData.name,
        phone: clientData.phone,
        device: getDeviceFingerprint()
      });
      // Reanudar GPS de inmediato al conectar
      if (isTracking) startGpsTracking();
    });

    socket.on('disconnect', (reason) => {
      console.log('Desconectado del servidor de rastreo:', reason);
      const summary = document.getElementById('status-summary');
      if (summary) summary.textContent = '🟡 Reconectando con el Radar...';
    });

    socket.on('reconnect', (attempt) => {
      console.log(`Reconectado exitosamente tras ${attempt} intentos`);
      const summary = document.getElementById('status-summary');
      if (summary) summary.textContent = '🟢 Conectado al Radar en Vivo (24/7)';
      socket.emit('client:join', {
        clientId: clientData.id,
        dni: clientData.dni,
        name: clientData.name,
        phone: clientData.phone,
        device: getDeviceFingerprint()
      });
    });

    socket.on('client:incoming-message', (data) => {
      if (!data || !data.message) return;
      playMessageChime();
      if (navigator.vibrate) navigator.vibrate([300, 150, 300, 150, 500]);
      showIncomingMessageModal(data);
    });
  } catch (err) {
    console.warn('Socket error', err);
  }
}

const CURRENT_APP_VERSION = 4;

function playMessageChime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(523.25, now);
    osc.frequency.setValueAtTime(659.25, now + 0.15);
    osc.frequency.setValueAtTime(783.99, now + 0.3);
    osc.frequency.setValueAtTime(1046.50, now + 0.45);
    gain.gain.setValueAtTime(0.3, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.8);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.8);
  } catch (_) {}
}

function showIncomingMessageModal(data) {
  let modal = document.getElementById('modal-incoming-message');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'modal-incoming-message';
    modal.className = 'settings-modal';
    modal.style.zIndex = '15000';
    modal.style.background = 'rgba(10, 14, 23, 0.96)';
    document.body.appendChild(modal);
  }

  modal.innerHTML = `
    <div class="settings-card" style="text-align: center; border: 2px solid #38bdf8; max-width: 380px;">
      <div style="font-size: 3rem; margin-bottom: 6px;">🔔</div>
      <h2 style="color: #38bdf8; font-size: 1.25rem; font-weight: 800; margin-bottom: 6px;">${data.title || 'Aviso de Administración'}</h2>
      <p style="font-size: 0.95rem; color: #f9fafb; margin: 14px 0; line-height: 1.5; font-weight: 600; background: rgba(56, 189, 248, 0.08); padding: 12px; border-radius: 8px; border-left: 3px solid #38bdf8; text-align: left;">
        ${data.message}
      </p>
      <button id="btn-ack-msg" class="btn-primary" style="width: 100%; padding: 12px; font-weight: 800; font-size: 1rem; margin-top: 10px;">
        ✅ Entendido / Confirmar Lectura
      </button>
    </div>
  `;

  modal.classList.add('open');

  document.getElementById('btn-ack-msg').onclick = () => {
    modal.classList.remove('open');
    if (socket && socket.connected) {
      socket.emit('client:message-ack', {
        messageId: data.id,
        clientId: clientData.id,
        dni: clientData.dni
      });
    }
  };
}

const CURRENT_APP_VERSION = 5;

async function checkAppVersion() {
  try {
    const sUrl = clientData.serverUrl || window.location.origin;
    const res = await fetch(`${sUrl}/api/app-version`);
    if (!res.ok) return;
    const info = await res.json();
    if (info && info.versionCode > CURRENT_APP_VERSION) {
      showUpdateModal(info);
    }
  } catch (_) {}
}

function showUpdateModal(info) {
  let modal = document.getElementById('modal-app-update');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'modal-app-update';
    modal.className = 'settings-modal';
    modal.style.zIndex = '20000';
    modal.style.background = 'rgba(10, 14, 23, 0.98)';
    document.body.appendChild(modal);
  }

  const downloadUrl = (clientData.serverUrl || '') + (info.apkUrl || '/download-apk');

  modal.innerHTML = `
    <div class="settings-card" style="text-align: center; border: 2px solid #10b981; max-width: 380px;">
      <div style="font-size: 3rem; margin-bottom: 6px;">🚀</div>
      <h2 style="color: #34d399; font-size: 1.25rem; font-weight: 800; margin-bottom: 4px;">Actualización Disponible (v${info.versionName || '4.0'})</h2>
      <p style="font-size: 0.85rem; color: #cbd5e1; margin: 10px 0; line-height: 1.4;">
        Se ha publicado una nueva versión con mejoras de rastreo satelital 24/7 y conectividad permanente.
      </p>
      <div style="background: rgba(16,185,129,0.1); border: 1px solid rgba(16,185,129,0.25); border-radius: 8px; padding: 10px; margin-bottom: 14px; text-align: left; font-size: 0.78rem; color: #a7f3d0; line-height: 1.4;">
        ✨ <strong>Mejoras:</strong> ${info.releaseNotes || 'Rastreo 24/7 y mensajería en vivo.'}
      </div>
      <a href="${downloadUrl}" download="GeoClient-Localizador.apk" class="btn-primary" style="display:block; text-align:center; padding: 14px; font-size: 1rem; font-weight: 800; text-decoration: none; background: #059669;">
        ⬇️ Descargar e Instalar Actualización
      </a>
      <p style="font-size: 0.72rem; color: #9ca3af; margin-top: 10px;">
        💡 <strong>Actualización directa:</strong> No necesitas desinstalar tu app actual. Al abrir el archivo descargado, pulsa <em>"Actualizar"</em> y tus datos se conservarán.
      </p>
    </div>
  `;

  modal.classList.add('open');
}

// Escuchar cambios de conectividad de red del dispositivo (Wi-Fi / Datos móviles)
window.addEventListener('online', () => {
  console.log('📡 Red restaurada. Reconectando...');
  if (socket && !socket.connected) {
    socket.connect();
  }
  if (isTracking) startGpsTracking();
});

window.addEventListener('offline', () => {
  console.warn('📴 Dispositivo sin conexión a internet.');
  document.getElementById('val-coords').textContent = 'Sin conexión a internet (Esperando red...)';
});

// Diagnóstico y Control de Permisos de Ubicación
function hidePermissionAlert() {
  const box = document.getElementById('permission-diagnostic-box');
  if (box) box.style.display = 'none';
}

function showPermissionAlert(config) {
  const box = document.getElementById('permission-diagnostic-box');
  if (!box) return;

  const iconEl = document.getElementById('perm-alert-icon');
  const titleEl = document.getElementById('perm-alert-title');
  const descEl = document.getElementById('perm-alert-desc');
  const btnAction = document.getElementById('btn-perm-action');

  if (iconEl) iconEl.textContent = config.icon || '⚠️';
  if (titleEl) titleEl.textContent = config.title || 'Alerta de Permisos';
  if (descEl) descEl.textContent = config.desc || '';

  // Actualizar checklist
  const chkHw = document.getElementById('chk-hardware-gps');
  const chkFine = document.getElementById('chk-fine-perm');
  const chkBg = document.getElementById('chk-bg-perm');

  if (chkHw) {
    chkHw.textContent = config.hardwareGps ? 'ENCENDIDO' : '❌ APAGADO';
    chkHw.className = `perm-check-status ${config.hardwareGps ? 'ok' : 'bad'}`;
  }
  if (chkFine) {
    chkFine.textContent = config.finePerm ? 'CONCEDIDO' : '❌ DENEGADO';
    chkFine.className = `perm-check-status ${config.finePerm ? 'ok' : 'bad'}`;
  }
  if (chkBg) {
    chkBg.textContent = config.bgPerm ? 'PERMITIDO' : '⚠️ RESTRINGIDO';
    chkBg.className = `perm-check-status ${config.bgPerm ? 'ok' : 'bad'}`;
  }
  const chkActivity = document.getElementById('chk-activity-perm');
  if (chkActivity) {
    chkActivity.textContent = config.activity !== false ? 'OPTIMIZADO' : '⚠️ RESTRINGIDO';
    chkActivity.className = `perm-check-status ${config.activity !== false ? 'ok' : 'bad'}`;
  }
  const chkBattery = document.getElementById('chk-battery-perm');
  if (chkBattery) {
    chkBattery.textContent = 'SIN RESTRICCIÓN';
    chkBattery.className = 'perm-check-status ok';
  }

  if (btnAction) {
    btnAction.textContent = config.btnText || '⚙️ Ajustar Permisos';
    btnAction.onclick = config.btnAction || (() => {});
    btnAction.style.background = config.btnColor || '#dc2626';
  }

  box.style.display = 'block';
}

// Comprobación profunda de permisos de Android / Navegador
function checkAndDiagnosePermissions() {
  // Caso 1: Corriendo dentro del APK de Android
  if (window.AndroidApp && typeof window.AndroidApp.checkPermissionsDetailed === 'function') {
    try {
      const info = JSON.parse(window.AndroidApp.checkPermissionsDetailed());
      // info = { fine: bool, coarse: bool, background: bool, hardwareGps: bool }

      if (!info.hardwareGps) {
        showPermissionAlert({
          icon: '📴',
          title: 'Interruptor GPS de tu Teléfono APAGADO',
          desc: 'El chip de ubicación de tu teléfono está apagado en la barra superior de Android. El servidor no puede localizarte hasta que lo enciendas.',
          hardwareGps: false,
          finePerm: info.fine || info.coarse,
          bgPerm: info.background,
          btnText: '📍 Encender Interruptor de GPS Ahora',
          btnColor: '#ef4444',
          btnAction: () => {
            if (window.AndroidApp.openLocationSettings) window.AndroidApp.openLocationSettings();
            else if (window.AndroidApp.openAppSettings) window.AndroidApp.openAppSettings();
          }
        });
        notifyGpsAlert('GPS_OFF', 'Interruptor GPS apagado en el teléfono del cliente');
        return false;
      }

      if (!info.fine && !info.coarse) {
        showPermissionAlert({
          icon: '⚠️',
          title: 'Falta Permiso de Ubicación en este Teléfono',
          desc: 'La app no tiene autorización para acceder al GPS. Por contrato de préstamo es obligatorio conceder permiso "Preciso".',
          hardwareGps: true,
          finePerm: false,
          bgPerm: info.background,
          btnText: '⚙️ Conceder Permiso de Ubicación',
          btnColor: '#dc2626',
          btnAction: () => {
            if (window.AndroidApp.requestPermissionsAgain) window.AndroidApp.requestPermissionsAgain();
            else if (window.AndroidApp.openAppSettings) window.AndroidApp.openAppSettings();
          }
        });
        notifyGpsAlert('PERMISSION_DENIED', 'Permiso de ubicación denegado en el teléfono');
        return false;
      }

      if (!info.background) {
        showPermissionAlert({
          icon: '🔋',
          title: 'Falta Permiso "Permitir Todo el Tiempo" (Segundo Plano)',
          desc: 'Para que la app siga transmitiendo cuando la pantalla se bloquee o abras otra app, debes elegir "Permitir todo el tiempo".',
          hardwareGps: true,
          finePerm: true,
          bgPerm: false,
          btnText: '🛡️ Cambiar a "Permitir todo el tiempo"',
          btnColor: '#d97706',
          btnAction: () => {
            if (window.AndroidApp.openAppSettings) window.AndroidApp.openAppSettings();
          }
        });
        return true;
      }

      // Todo perfecto en Android
      hidePermissionAlert();
      return true;
    } catch (e) {
      console.warn('Error leyendo permisos detallados:', e);
    }
  }

  // Caso 2: Navegador Web (Safari iPhone, Chrome Web)
  if (navigator.permissions && navigator.permissions.query) {
    navigator.permissions.query({ name: 'geolocation' }).then((perm) => {
      if (perm.state === 'denied') {
        showPermissionAlert({
          icon: '🚫',
          title: 'Permiso Denegado en el Navegador',
          desc: 'Has bloqueado la ubicación en este navegador. Toca el candado 🔒 en la barra superior de direcciones y activa el acceso a la Ubicación.',
          hardwareGps: true,
          finePerm: false,
          bgPerm: false,
          btnText: 'ℹ️ Cómo Habilitar en Navegador',
          btnColor: '#dc2626',
          btnAction: () => {
            alert('En tu navegador:\n1. Toca el icono de Ajustes o Candado 🔒 en la barra de URL\n2. Busca "Permisos" o "Ubicación"\n3. Cámbialo a "Permitir"\n4. Recarga la página.');
          }
        });
        notifyGpsAlert('PERMISSION_DENIED', 'Ubicación denegada en navegador web');
      } else {
        hidePermissionAlert();
      }
    }).catch(() => {});
  }

  return true;
}

// PUENTE NATIVO: El hardware GPS de Android envía las coordenadas satelitales directamente aquí
window.receiveNativeLocation = function(lat, lng, accuracy, speed, heading) {
  // Ocultar alerta de permisos si estábamos recibiendo datos de hardware
  hidePermissionAlert();

  onGpsSuccess({
    coords: {
      latitude: Number(lat),
      longitude: Number(lng),
      accuracy: Number(accuracy) || 5,
      speed: Number(speed) || 0,
      heading: Number(heading) || 0
    }
  });
};

// Iniciar monitoreo GPS de alta precisión
function startGpsTracking() {
  // Primero forzar lectura nativa si corre en APK Android
  if (window.AndroidApp && typeof window.AndroidApp.requestNativeLocation === 'function') {
    window.AndroidApp.requestNativeLocation();
  }

  // Verificar estado de permisos detallado
  checkAndDiagnosePermissions();

  if (!navigator.geolocation) {
    if (!window.AndroidApp) {
      alert('Tu dispositivo o navegador no soporta geolocalización.');
    }
    return;
  }

  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
  }

  const options = {
    enableHighAccuracy: true,
    timeout: 12000,
    maximumAge: 2000
  };

  watchId = navigator.geolocation.watchPosition(
    onGpsSuccess,
    (err) => {
      // Si estamos en el APK y el hardware GPS está disponible o enviando datos, NO mostrar error falso de Chromium
      if (window.AndroidApp) {
        checkAndDiagnosePermissions();
      } else {
        onGpsError(err);
      }
    },
    options
  );
}

function stopGpsTracking() {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
}

// Envío de ubicación exitoso
let lastGpsState = 'ACTIVE';
function onGpsSuccess(position) {
  if (!isTracking) return;

  const { latitude, longitude, accuracy, speed, heading } = position.coords;

  // Ocultar alerta de permisos si antes había advertencia
  hidePermissionAlert();

  // Si antes estaba apagado o con error, notificar restauración
  if (lastGpsState !== 'ACTIVE') {
    lastGpsState = 'ACTIVE';
    notifyGpsAlert('ACTIVE', 'GPS activo y transmitiendo');
  }

  // Actualizar UI
  pingsCount++;
  document.getElementById('val-pings').textContent = pingsCount;
  document.getElementById('val-accuracy').textContent = `±${Math.round(accuracy)}m`;

  // Nivel de señal y calidad GPS
  const meter = document.getElementById('signal-bars-meter');
  const sigTitle = document.getElementById('sig-quality-title');
  const sigSub = document.getElementById('sig-quality-sub');
  const sigIcon = document.getElementById('sig-icon');

  if (meter && sigTitle) {
    meter.className = 'signal-bars-meter';
    if (accuracy <= 8) {
      meter.classList.add('level-4');
      sigTitle.textContent = `Señal Óptima: ±${Math.round(accuracy)}m (Satélites GNSS)`;
      if (sigSub) sigSub.textContent = 'GPS + GLONASS + Galileo con máxima precisión';
      if (sigIcon) sigIcon.textContent = '🟢';
    } else if (accuracy <= 20) {
      meter.classList.add('level-3');
      sigTitle.textContent = `Señal Buena: ±${Math.round(accuracy)}m (Satelital + Red)`;
      if (sigSub) sigSub.textContent = 'Satélite con triangulación asistida';
      if (sigIcon) sigIcon.textContent = '🛰️';
    } else if (accuracy <= 45) {
      meter.classList.add('level-2');
      sigTitle.textContent = `Señal Media: ±${Math.round(accuracy)}m (Wi-Fi + Celular)`;
      if (sigSub) sigSub.textContent = 'Triangulación por antenas y redes cercanas';
      if (sigIcon) sigIcon.textContent = '🟡';
    } else {
      meter.classList.add('level-1');
      sigTitle.textContent = `Señal Aproximada: ±${Math.round(accuracy)}m`;
      if (sigSub) sigSub.textContent = 'Bajo techo / Buscando mayor número de satélites';
      if (sigIcon) sigIcon.textContent = '📡';
    }
  }

  // Actividad física y movimiento
  const speedKmh = speed ? Math.round(speed * 3.6) : 0;
  document.getElementById('val-speed').textContent = `${speedKmh} km/h`;
  const actChip = document.getElementById('activity-chip');
  if (actChip) {
    if (speedKmh > 20) {
      actChip.textContent = `🚗 En Vehículo (${speedKmh} km/h)`;
      actChip.style.background = 'rgba(16,185,129,0.15)';
      actChip.style.color = '#34d399';
    } else if (speedKmh >= 3) {
      actChip.textContent = `🚶 Caminando (${speedKmh} km/h)`;
      actChip.style.background = 'rgba(56,189,248,0.15)';
      actChip.style.color = '#38bdf8';
    } else {
      actChip.textContent = '🛑 Punto Fijo / Detenido';
      actChip.style.background = 'rgba(245,158,11,0.15)';
      actChip.style.color = '#fbbf24';
    }
  }

  document.getElementById('val-coords').textContent = `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;

  const payload = {
    clientId: clientData.id,
    dni: clientData.dni,
    name: clientData.name,
    phone: clientData.phone,
    latitude,
    longitude,
    accuracy,
    speed,
    heading,
    battery: batteryLevel,
    charging: isCharging,
    device: getDeviceFingerprint(),
    isTracking: true,
    timestamp: Date.now()
  };

  // Enviar vía Socket.io
  if (socket && socket.connected) {
    socket.emit('client:update-location', payload);
  } else {
    // Fallback vía REST HTTP
    fetch(`${clientData.serverUrl}/api/location`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).catch(() => {});
  }
}

function onGpsError(err) {
  console.warn('GPS Error:', err.message);
  checkAndDiagnosePermissions();

  let status = 'GPS_ERROR';
  let msg = 'Esperando señal GPS...';

  if (err.code === 1) {
    status = 'PERMISSION_DENIED';
    msg = '⚠️ Permiso de ubicación no otorgado';
  } else if (err.code === 2) {
    status = 'GPS_OFF';
    msg = '📴 GPS apagado en el dispositivo';
  } else if (err.code === 3) {
    status = 'GPS_TIMEOUT';
    msg = '🛰️ Buscando satélites GPS...';
  }

  document.getElementById('val-coords').textContent = msg;

  if (status === 'GPS_OFF' || status === 'PERMISSION_DENIED') {
    if (lastGpsState !== status) {
      lastGpsState = status;
      notifyGpsAlert(status, msg);
    }
  }
}

// Notificar al servidor sobre estado de GPS
function notifyGpsAlert(status, message) {
  const payload = {
    clientId: clientData.id,
    dni: clientData.dni,
    name: clientData.name,
    gpsStatus: status,
    message: message
  };

  if (socket && socket.connected) {
    socket.emit('client:gps-alert', payload);
  } else {
    fetch(`${clientData.serverUrl}/api/gps-alert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).catch(() => {});
  }
}

// Puentes llamados desde Android nativo si se apaga el switch del GPS
window.handleNativeGpsDisabled = function() {
  console.warn('Alerta nativa de Android: GPS desactivado');
  checkAndDiagnosePermissions();
};

window.handleNativeGpsEnabled = function() {
  console.log('Alerta nativa de Android: GPS activado');
  hidePermissionAlert();
  startGpsTracking();
};

// La transmisión NO se puede apagar por contrato de préstamo
function toggleTracking() {
  // Asegurar que siempre esté activo
  isTracking = true;

  const pulseContainer = document.getElementById('pulse-container');
  const powerBtn = document.getElementById('btn-toggle-tracking');
  const powerText = document.getElementById('power-text');
  const statusSummary = document.getElementById('status-summary');

  if (pulseContainer) pulseContainer.classList.add('active');
  if (powerBtn) {
    powerBtn.classList.remove('paused');
    powerBtn.classList.add('shake');
    setTimeout(() => powerBtn.classList.remove('shake'), 600);
  }
  if (powerText) powerText.textContent = 'TRANSMITIENDO';
  if (statusSummary) statusSummary.textContent = '🔒 Transmisión obligatoria activa las 24 horas por contrato';

  alert('🔒 LOCALIZACIÓN OBLIGATORIA:\nPor condiciones del contrato de préstamo, la transmisión de tu ubicación GPS debe permanecer encendida 24/7 y no puede ser apagada.');

  startGpsTracking();
}

// Inicialización
document.addEventListener('DOMContentLoaded', () => {
  const hasDni = initClientData();
  initBattery();
  checkAppVersion();
  setInterval(checkAppVersion, 30 * 60 * 1000);
  if (hasDni) {
    connectSocket();
    startGpsTracking();
  }

  // Listener para el botón de login con DNI del cliente
  const btnLoginSubmit = document.getElementById('btn-login-submit');
  if (btnLoginSubmit) {
    btnLoginSubmit.addEventListener('click', () => {
      const inputDni = document.getElementById('input-login-dni').value.trim();
      const inputName = document.getElementById('input-login-name').value.trim();

      if (!inputDni) {
        alert('Por favor ingresa tu número de DNI');
        return;
      }

      clientData.dni = inputDni;
      clientData.id = inputDni;
      localStorage.setItem('geoclient_dni', inputDni);
      localStorage.setItem('geoclient_id', inputDni);

      if (inputName) {
        clientData.name = inputName;
        localStorage.setItem('geoclient_name', inputName);
      } else {
        clientData.name = 'Cliente DNI ' + inputDni;
      }

      // Guardar también en Android nativo SharedPreferences (inmune a borrado de caché)
      if (window.AndroidApp && typeof window.AndroidApp.saveClientCredentials === 'function') {
        try {
          window.AndroidApp.saveClientCredentials(clientData.dni, clientData.name, clientData.phone || '');
        } catch (_) {}
      }

      document.getElementById('client-display-id').textContent = `DNI: ${clientData.dni}`;
      document.getElementById('client-display-name').textContent = clientData.name;
      document.getElementById('user-avatar').textContent = clientData.name.substring(0, 2).toUpperCase();

      document.getElementById('modal-client-login').classList.remove('open');

      connectSocket();
      startGpsTracking();
    });
  }

  // Detectar si ya está corriendo DENTRO del APK de Android o en navegador
  const isInApk = !!window.AndroidApp || 
                  window.location.protocol === 'file:' || 
                  /GeoClientApp/i.test(navigator.userAgent);

  const bannerAndroid = document.getElementById('banner-android');
  const bannerIos = document.getElementById('banner-ios');
  const btnDownloadHeader = document.querySelector('a[href="/descargar.html"]');

  if (isInApk) {
    // Si YA ESTÁ DENTRO DEL APK: Ocultar banner de descarga y botón del header
    if (bannerAndroid) bannerAndroid.style.display = 'none';
    if (bannerIos) bannerIos.style.display = 'none';
    if (btnDownloadHeader) btnDownloadHeader.style.display = 'none';
  } else {
    // Si está en navegador móvil
    const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent);
    if (isIos) {
      if (bannerAndroid) bannerAndroid.style.display = 'none';
      if (bannerIos) bannerIos.style.display = 'flex';
    } else {
      if (bannerAndroid) bannerAndroid.style.display = 'flex';
      if (bannerIos) bannerIos.style.display = 'none';
    }
  }

  // Activar Screen Wake Lock si el navegador lo soporta
  if ('wakeLock' in navigator) {
    navigator.wakeLock.request('screen').catch(() => {});
  }

  // Activar animación inicial
  document.getElementById('pulse-container').classList.add('active');

  // Botón principal de encendido/apagado
  document.getElementById('btn-toggle-tracking').addEventListener('click', toggleTracking);

  // Modal de Ajustes
  const settingsModal = document.getElementById('settings-modal');
  document.getElementById('btn-settings-toggle').addEventListener('click', () => {
    settingsModal.classList.add('open');
  });

  document.getElementById('btn-cancel-settings').addEventListener('click', () => {
    settingsModal.classList.remove('open');
  });

  document.getElementById('btn-save-settings').addEventListener('click', () => {
    const newName = document.getElementById('input-edit-name')?.value.trim();
    if (newName) {
      clientData.name = newName;
      localStorage.setItem('geoclient_name', newName);
      document.getElementById('client-display-name').textContent = newName;
      document.getElementById('user-avatar').textContent = newName.substring(0, 2).toUpperCase();
    }
    settingsModal.classList.remove('open');
  });

  // Botón de Cerrar Sesión / Desvincular DNI
  const btnLogout = document.getElementById('btn-logout-client');
  if (btnLogout) {
    btnLogout.addEventListener('click', () => {
      if (!confirm('¿Deseas cerrar la sesión y desvincular este DNI de este teléfono?')) return;

      // Limpiar LocalStorage
      localStorage.removeItem('geoclient_dni');
      localStorage.removeItem('geoclient_id');
      localStorage.removeItem('geoclient_name');
      localStorage.removeItem('geoclient_phone');

      // Limpiar SharedPreferences en Android nativo
      if (window.AndroidApp && typeof window.AndroidApp.clearSavedCredentials === 'function') {
        try { window.AndroidApp.clearSavedCredentials(); } catch (_) {}
      }

      // Desconectar socket actual
      if (socket) {
        socket.disconnect();
      }

      // Reiniciar datos en memoria
      clientData.dni = '';
      clientData.id = '';
      clientData.name = '';

      // Cerrar modal de ajustes y abrir modal de login
      settingsModal.classList.remove('open');
      const inputLoginDni = document.getElementById('input-login-dni');
      if (inputLoginDni) inputLoginDni.value = '';
      const inputLoginName = document.getElementById('input-login-name');
      if (inputLoginName) inputLoginName.value = '';

      const loginModal = document.getElementById('modal-client-login');
      if (loginModal) loginModal.classList.add('open');
    });
  }

  // Temporizador de sesión de transmisión en vivo
  const sessionStartTime = Date.now();
  const uptimeEl = document.getElementById('session-uptime');
  setInterval(() => {
    if (!uptimeEl) return;
    const elapsedSec = Math.floor((Date.now() - sessionStartTime) / 1000);
    const hrs = String(Math.floor(elapsedSec / 3600)).padStart(2, '0');
    const mins = String(Math.floor((elapsedSec % 3600) / 60)).padStart(2, '0');
    const secs = String(elapsedSec % 60).padStart(2, '0');
    uptimeEl.textContent = `⏱️ ${hrs}:${mins}:${secs}`;
  }, 1000);

  // Copiar coordenadas al portapapeles al hacer clic
  const coordsBox = document.getElementById('coords-copy-box');
  const txtCopy = document.getElementById('txt-copy-coords');
  if (coordsBox) {
    coordsBox.addEventListener('click', () => {
      const coordsVal = document.getElementById('val-coords')?.textContent;
      if (coordsVal && !coordsVal.includes('Esperando')) {
        navigator.clipboard.writeText(coordsVal);
        if (navigator.vibrate) navigator.vibrate(25);
        if (txtCopy) {
          txtCopy.textContent = '✅ ¡Copiado!';
          setTimeout(() => { txtCopy.textContent = '📋 Copiar'; }, 2000);
        }
      }
    });
  }

  // Comprobar estado de permisos periódicamente para auto-recuperar si el usuario activó el GPS
  setInterval(() => {
    if (isTracking) {
      checkAndDiagnosePermissions();
    }
  }, 5000);
});

