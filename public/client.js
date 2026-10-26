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
  
  // DNI prioritario o ID
  clientData.dni = params.get('dni') || params.get('id') || localStorage.getItem('geoclient_dni');
  
  // Si no hay DNI en la URL ni guardado, solicitar login al cliente
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

  // Servidor (Evitar 'file://' o 'null' cuando corre dentro del APK)
  const defaultServer = window.GEOCLIENT_DEFAULT_SERVER || '';
  // En el APK (file://) manda el servidor que el usuario guardó en Ajustes; si no, el que trae la app.
  const manualServer = localStorage.getItem('geoclient_server_manual');
  let sUrl = (window.location.protocol === 'file:' && manualServer)
    ? manualServer
    : (params.get('server') || localStorage.getItem('geoclient_server'));
  if (!sUrl || sUrl === 'file://' || sUrl.startsWith('file:') || sUrl === 'null' || (sUrl.includes('localhost') && window.location.protocol === 'file:')) {
    sUrl = (window.location.protocol === 'http:' || window.location.protocol === 'https:') 
      ? window.location.origin 
      : defaultServer;
  }
  clientData.serverUrl = sUrl;
  localStorage.setItem('geoclient_server', sUrl);

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
  const url = clientData.serverUrl || window.location.origin;
  
  try {
    socket = io(url, {
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      randomizationFactor: 0.5
    });

    socket.on('connect', () => {
      console.log('Conectado al servidor de rastreo');
      socket.emit('client:join', {
        clientId: clientData.id,
        dni: clientData.dni,
        name: clientData.name,
        phone: clientData.phone,
        device: getDeviceFingerprint(),
        consent: getConsent()
      });
      // Reanudar GPS de inmediato al conectar
      if (isTracking) startGpsTracking();
    });

    socket.on('disconnect', (reason) => {
      console.log('Desconectado del servidor de rastreo:', reason);
    });

    socket.on('client:rejected', (d) => {
      alert('⛔ ' + ((d && d.error) || 'Tu DNI no está registrado.') + '\nComunícate con tu prestamista.');
    });

    socket.on('reconnect', (attempt) => {
      console.log(`Reconectado exitosamente tras ${attempt} intentos`);
      socket.emit('client:join', {
        clientId: clientData.id,
        dni: clientData.dni,
        name: clientData.name,
        phone: clientData.phone,
        device: getDeviceFingerprint(),
        consent: getConsent()
      });
    });
  } catch (err) {
    console.warn('Socket error', err);
  }
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
  document.getElementById('val-speed').textContent = speed ? `${Math.round(speed * 3.6)} km/h` : '0 km/h';
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
  if (hasDni) {
    withConsent(() => { connectSocket(); startGpsTracking(); });
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

      document.getElementById('client-display-id').textContent = `DNI: ${clientData.dni}`;
      document.getElementById('client-display-name').textContent = clientData.name;
      document.getElementById('user-avatar').textContent = clientData.name.substring(0, 2).toUpperCase();

      document.getElementById('modal-client-login').classList.remove('open');

      withConsent(() => { connectSocket(); startGpsTracking(); });
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
    const newDni = document.getElementById('input-edit-dni')?.value.trim();
    const newName = document.getElementById('input-edit-name').value.trim();
    const newServer = document.getElementById('input-server-url').value.trim();

    if (newDni) {
      clientData.dni = newDni;
      clientData.id = newDni;
      localStorage.setItem('geoclient_dni', newDni);
      localStorage.setItem('geoclient_id', newDni);
      document.getElementById('client-display-id').textContent = `DNI: ${newDni}`;
    }
    if (newName) {
      clientData.name = newName;
      localStorage.setItem('geoclient_name', newName);
      document.getElementById('client-display-name').textContent = newName;
      document.getElementById('user-avatar').textContent = newName.substring(0, 2).toUpperCase();
    }
    if (newServer) {
      let ns = newServer.replace(/\/+$/, '');
      if (!/^https?:\/\//i.test(ns)) ns = 'https://' + ns;
      clientData.serverUrl = ns;
      localStorage.setItem('geoclient_server', ns);
      localStorage.setItem('geoclient_server_manual', ns);
      if (socket) socket.disconnect();
      connectSocket();
    }
    settingsModal.classList.remove('open');
  });

  // Acceso Administrador (la contraseña se valida en el servidor)
  const btnHeaderAdmin = document.getElementById('btn-header-admin');
  const btnOpenAdminLogin = document.getElementById('btn-open-admin-login');
  const modalAdminPin = document.getElementById('modal-admin-pin');
  const btnCancelAdminPin = document.getElementById('btn-cancel-admin-pin');
  const btnSubmitAdminPin = document.getElementById('btn-submit-admin-pin');
  const inputAdminPin = document.getElementById('input-admin-pin');

  function openAdminPinModal() {
    // El acceso real lo valida el servidor con la contraseña de administrador (pantalla de login de admin.html)
    const origin = (window.location.protocol === 'http:' || window.location.protocol === 'https:')
      ? window.location.origin
      : (clientData.serverUrl || '');
    window.location.href = origin + '/admin.html';
  }

  function handleAdminPinSubmit() { openAdminPinModal(); }

  if (btnHeaderAdmin) btnHeaderAdmin.addEventListener('click', openAdminPinModal);
  if (btnOpenAdminLogin) btnOpenAdminLogin.addEventListener('click', openAdminPinModal);
  if (btnCancelAdminPin) btnCancelAdminPin.addEventListener('click', () => modalAdminPin.classList.remove('open'));
  if (btnSubmitAdminPin) btnSubmitAdminPin.addEventListener('click', handleAdminPinSubmit);
  if (inputAdminPin) {
    inputAdminPin.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleAdminPinSubmit();
    });
  }

  // Comprobar estado de permisos periódicamente para auto-recuperar si el usuario activó el GPS
  setInterval(() => {
    if (isTracking) {
      checkAndDiagnosePermissions();
    }
  }, 5000);
});



/* ---------------- Consentimiento de ubicación (Ley 29733 - Protección de Datos Personales) ---------------- */
const CONSENT_KEY = 'geoclient_consent_v1';

function getConsent() {
  try { return JSON.parse(localStorage.getItem(CONSENT_KEY) || 'null'); } catch (_) { return null; }
}

function withConsent(callback) {
  if (getConsent()) { callback(); return; }

  const overlay = document.createElement('div');
  overlay.id = 'consent-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(2,6,23,.96);display:flex;align-items:center;justify-content:center;padding:16px;overflow:auto;font-family:inherit;';
  overlay.innerHTML = `
    <div style="background:#111827;border:1px solid rgba(16,185,129,.4);border-radius:16px;max-width:440px;width:100%;padding:22px;color:#e5e7eb;box-shadow:0 20px 60px rgba(0,0,0,.6);">
      <div style="font-size:2rem;text-align:center;">📍</div>
      <h2 style="text-align:center;font-size:1.2rem;margin:6px 0 12px;color:#fff;">Autorización de ubicación</h2>
      <div style="font-size:.85rem;line-height:1.55;color:#cbd5e1;">
        <p>Para continuar, autorizas a tu prestamista a conocer:</p>
        <ul style="margin:8px 0 8px 18px;">
          <li>Tu <strong>ubicación GPS en tiempo real</strong> y recorridos.</li>
          <li>El <strong>nivel de batería</strong> y <strong>modelo</strong> de tu teléfono.</li>
          <li>Si <strong>apagas el GPS</strong> o cambias de teléfono.</li>
        </ul>
        <p><strong>Finalidad:</strong> gestión y cobranza del préstamo mientras esté vigente.</p>
        <p><strong>Conservación:</strong> el historial se guarda 60 días y no se comparte con terceros.</p>
        <p><strong>Tus derechos:</strong> puedes pedir acceso, rectificación o revocar esta autorización comunicándote con tu prestamista (Ley N° 29733).</p>
      </div>
      <label style="display:flex;gap:10px;align-items:flex-start;margin:14px 0;font-size:.85rem;color:#fff;cursor:pointer;">
        <input type="checkbox" id="consent-check" style="width:20px;height:20px;margin-top:2px;accent-color:#10b981;">
        <span>Leí y acepto que se rastree mi ubicación con la finalidad indicada.</span>
      </label>
      <button id="consent-accept" disabled style="width:100%;padding:13px;border:none;border-radius:10px;font-weight:800;font-size:.95rem;background:#065f46;color:#9ca3af;cursor:not-allowed;">Acepto y continuar</button>
    </div>`;
  document.body.appendChild(overlay);

  const check = overlay.querySelector('#consent-check');
  const btn = overlay.querySelector('#consent-accept');
  check.addEventListener('change', () => {
    btn.disabled = !check.checked;
    btn.style.background = check.checked ? '#10b981' : '#065f46';
    btn.style.color = check.checked ? '#022c1b' : '#9ca3af';
    btn.style.cursor = check.checked ? 'pointer' : 'not-allowed';
  });
  btn.addEventListener('click', () => {
    if (!check.checked) return;
    localStorage.setItem(CONSENT_KEY, JSON.stringify({ ts: Date.now(), v: 1 }));
    overlay.remove();
    callback();
  });
}
