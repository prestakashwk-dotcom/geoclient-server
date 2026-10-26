// admin.js - Lógica del Panel de Control de Clientes en Tiempo Real (v2 con Geocercas y 60 Días)
let map;
let tileLayers = {};
let currentLayer = 'osm';
let clientsMap = new Map();
let markersMap = new Map();
let trailsMap = new Map();
let geofencesMap = new Map(); // id -> L.circle
let geofencesList = [];
let activeTrailClientId = null;
let activeDayRoutePolyline = null;
let activeDayRouteMarkers = [];
let selectedClientId = null;
let soundEnabled = true;
let currentFilter = 'all';
let searchQuery = '';
let serverInfo = null;

// Audio context para sonido sutil de ping radar
let audioCtx = null;
function playPingSound() {
  if (!soundEnabled) return;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(440, audioCtx.currentTime + 0.15);
    gain.gain.setValueAtTime(0.08, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.15);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.15);
  } catch (e) {}
}

// Alarma sonora de advertencia
function playWarningSound() {
  if (!soundEnabled) return;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const now = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(580, now);
    osc.frequency.linearRampToValueAtTime(320, now + 0.2);
    osc.frequency.linearRampToValueAtTime(580, now + 0.4);
    osc.frequency.linearRampToValueAtTime(320, now + 0.6);
    gain.gain.setValueAtTime(0.2, now);
    gain.gain.linearRampToValueAtTime(0.01, now + 0.7);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(now);
    osc.stop(now + 0.7);
  } catch (e) {}
}

// Mostrar notificación flotante de alerta
function showAdminToast(msg, isSuccess = false) {
  const toast = document.getElementById('admin-alert-toast');
  const text = document.getElementById('toast-message');
  if (!toast || !text) return;

  text.textContent = msg;
  toast.className = `alert-toast visible ${isSuccess ? 'success' : ''}`;
  toast.querySelector('.toast-icon').textContent = isSuccess ? '✅' : '⚠️';

  setTimeout(() => {
    toast.classList.remove('visible');
  }, 7500);
}

// Inicializar Mapa Leaflet
function initMap() {
  map = L.map('map', {
    zoomControl: false,
    attributionControl: false
  }).setView([19.4326, -99.1332], 12);

  L.control.zoom({ position: 'bottomright' }).addTo(map);

  // Capas de mapas de alto rendimiento (sin bloqueos de OpenStreetMap)
  tileLayers.osm = L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    maxZoom: 20,
    subdomains: 'abcd',
    attribution: '&copy; CartoDB &copy; OpenStreetMap contributors'
  }).addTo(map);

  tileLayers.dark = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 20,
    subdomains: 'abcd',
    attribution: '&copy; CartoDB &copy; OpenStreetMap contributors'
  });

  tileLayers.satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19,
    attribution: '&copy; Esri &copy; Earthstar Geographics'
  });

  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition((pos) => {
      if (markersMap.size === 0) {
        map.setView([pos.coords.latitude, pos.coords.longitude], 13);
      }
    }, () => {});
  }
}

// Cambiar capa del mapa
function switchLayer(layerKey) {
  const mapElement = document.getElementById('map');
  if (tileLayers[currentLayer]) map.removeLayer(tileLayers[currentLayer]);
  tileLayers[layerKey].addTo(map);
  currentLayer = layerKey;

  if (layerKey === 'dark') {
    mapElement.classList.add('dark-tiles');
  } else {
    mapElement.classList.remove('dark-tiles');
  }

  document.querySelectorAll('.layer-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.layer === layerKey);
  });
}

// Variables de estado de enfoque y aislamiento
let isolatedClientId = null;

// Obtener coordenadas con micro-desplazamiento si coinciden exactamente en la misma zona
function getDisambiguatedLatLng(client) {
  let lat = Number(client.latitude);
  let lng = Number(client.longitude);
  if (!lat || !lng) return [0, 0];

  const sameLocationClients = [];
  clientsMap.forEach(other => {
    if (other.latitude && other.longitude) {
      const dist = Math.hypot(Number(other.latitude) - lat, Number(other.longitude) - lng);
      if (dist < 0.00035) { // ~35 metros
        sameLocationClients.push(other.id);
      }
    }
  });

  if (sameLocationClients.length > 1) {
    sameLocationClients.sort();
    const idx = sameLocationClients.indexOf(client.id);
    if (idx > 0) {
      const angle = (idx * 2 * Math.PI) / sameLocationClients.length;
      const offset = 0.00018; // ~18 metros visuales para separar burbujas en la misma calle
      lat += offset * Math.cos(angle);
      lng += offset * Math.sin(angle);
    }
  }

  return [lat, lng];
}

// Determinar clases de color según estado del cliente
function getMarkerClasses(client) {
  let bubbleStatus = 'status-green';
  let ringStatus = '';

  if (client.gpsStatus === 'GPS_OFF' || client.gpsStatus === 'PERMISSION_DENIED') {
    bubbleStatus = 'status-red';
    ringStatus = 'ring-red';
  } else if (client.deviceChanged || client.gpsStatus === 'BG_RESTRICTED') {
    bubbleStatus = 'status-amber';
    ringStatus = 'ring-amber';
  } else if (!client.isOnline) {
    bubbleStatus = 'status-gray';
    ringStatus = 'ring-none';
  }

  return { bubbleStatus, ringStatus };
}

// Crear marcador con pulso radar y diferenciador visual
function createClientMarker(client) {
  const [lat, lng] = getDisambiguatedLatLng(client);
  const initials = (client.name || 'C').substring(0, 2).toUpperCase();
  const dniLabel = client.dni ? `[${client.dni}] ` : '';
  const firstName = (client.name || 'Cliente').split(' ')[0];
  const isSelected = client.id === selectedClientId || client.id === isolatedClientId;
  const { bubbleStatus, ringStatus } = getMarkerClasses(client);

  const iconHtml = `
    <div class="radar-marker ${isSelected ? 'selected' : ''}" id="radar-marker-${client.id}">
      <div class="marker-pulse-ring ${ringStatus}"></div>
      <div class="marker-bubble ${bubbleStatus}">${initials}</div>
      <div class="marker-label ${isSelected ? 'selected' : ''}">
        ${dniLabel}${firstName}
      </div>
    </div>
  `;

  const customIcon = L.divIcon({
    html: iconHtml,
    className: 'custom-radar-icon',
    iconSize: [44, 44],
    iconAnchor: [22, 22]
  });

  const marker = L.marker([lat, lng], { 
    icon: customIcon,
    zIndexOffset: isSelected ? 10000 : 100
  });

  marker.on('click', () => {
    selectClient(client.id);
  });

  marker.on('mouseover', () => {
    marker.setZIndexOffset(10000);
  });

  marker.on('mouseout', () => {
    if (client.id !== selectedClientId && client.id !== isolatedClientId) {
      marker.setZIndexOffset(100);
    }
  });

  const safeName = (client.name || 'Cliente').replace(/'/g, "\\'");
  const popupContent = `
    <div class="marker-popup">
      <h4>${client.name || 'Cliente'}</h4>
      <p style="color:#38bdf8; font-weight:700; margin-bottom:4px;">DNI: ${client.dni || client.id}</p>
      <div class="popup-meta">
        <span>🔋 Batería: <strong>${client.battery !== undefined && client.battery !== null ? Math.round(client.battery)+'%' : 'N/A'}</strong></span>
        <span>🎯 Precisión: <strong>${client.accuracy ? '±'+Math.round(client.accuracy)+'m' : 'N/A'}</strong></span>
        <span>⚡ Vel: <strong>${client.speed ? Math.round(client.speed * 3.6)+' km/h' : '0 km/h'}</strong></span>
        <span>📱 Equipo: <strong>${client.deviceModel || 'Android'}</strong></span>
        ${client.hardwareId ? `<span>🆔 Hardware: <strong style="font-family:monospace; font-size:10px; color:#38bdf8;">${client.hardwareId}</strong></span>` : ''}
        <span>📡 Estado: <strong>${client.statusMessage || (client.isOnline ? 'Conectado' : 'Desconectado')}</strong></span>
      </div>
      <div class="popup-actions" style="margin-top:8px; display:flex; flex-wrap:wrap; gap:6px;">
        <button class="btn-card highlight" onclick="isolateClient('${client.id}')">🎯 ${isolatedClientId === client.id ? 'Ver Todos' : 'Aislar Solo a Este'}</button>
        <button class="btn-card" onclick="openHistoryModal('${client.id}')">📅 60 Días</button>
        <button class="btn-card" onclick="openGeofenceModalForClient('${client.id}')">📍 Geocerca</button>
        <button class="btn-card" style="background:rgba(239,68,68,0.15); border-color:rgba(239,68,68,0.4); color:#ef4444;" onclick="deleteClientPrompt('${client.id}', '${safeName}')">🗑️ Eliminar</button>
      </div>
    </div>
  `;
  marker.bindPopup(popupContent);
  return marker;
}

// Actualizar o crear marcador de cliente
function updateMapMarker(client) {
  if (!client.latitude || !client.longitude) return;

  const [lat, lng] = getDisambiguatedLatLng(client);
  const initials = (client.name || 'C').substring(0, 2).toUpperCase();
  const dniLabel = client.dni ? `[${client.dni}] ` : '';
  const firstName = (client.name || 'Cliente').split(' ')[0];
  const isSelected = client.id === selectedClientId || client.id === isolatedClientId;
  const { bubbleStatus, ringStatus } = getMarkerClasses(client);

  const iconHtml = `
    <div class="radar-marker ${isSelected ? 'selected' : ''}" id="radar-marker-${client.id}">
      <div class="marker-pulse-ring ${ringStatus}"></div>
      <div class="marker-bubble ${bubbleStatus}">${initials}</div>
      <div class="marker-label ${isSelected ? 'selected' : ''}">
        ${dniLabel}${firstName}
      </div>
    </div>
  `;

  const newIcon = L.divIcon({
    html: iconHtml,
    className: 'custom-radar-icon',
    iconSize: [44, 44],
    iconAnchor: [22, 22]
  });

  if (markersMap.has(client.id)) {
    const marker = markersMap.get(client.id);
    marker.setLatLng([lat, lng]);
    marker.setIcon(newIcon);
    marker.setZIndexOffset(isSelected ? 10000 : 100);
  } else {
    const marker = createClientMarker(client);
    // Si estamos en modo aislado y no es este cliente, no agregarlo a la capa activa
    if (!isolatedClientId || isolatedClientId === client.id) {
      marker.addTo(map);
    }
    markersMap.set(client.id, marker);
  }

  // Actualizar recorrido si está activo
  if (activeTrailClientId === client.id) {
    updateTrail(client);
  }
}

// Dibujar u ocultar rastro de ruta reciente
function toggleTrail(clientId) {
  if (activeTrailClientId === clientId) {
    if (trailsMap.has(clientId)) {
      map.removeLayer(trailsMap.get(clientId));
      trailsMap.delete(clientId);
    }
    activeTrailClientId = null;
  } else {
    if (activeTrailClientId && trailsMap.has(activeTrailClientId)) {
      map.removeLayer(trailsMap.get(activeTrailClientId));
      trailsMap.delete(activeTrailClientId);
    }
    activeTrailClientId = clientId;
    const client = clientsMap.get(clientId);
    if (client) updateTrail(client);
  }
  renderClientList();
}

function updateTrail(client) {
  if (!client.history || client.history.length === 0) return;
  const latlngs = client.history.map(p => [p.lat, p.lng]);

  if (trailsMap.has(client.id)) {
    trailsMap.get(client.id).setLatLngs(latlngs);
  } else {
    const polyline = L.polyline(latlngs, {
      color: '#10b981',
      weight: 4,
      opacity: 0.85,
      dashArray: '8, 8',
      lineCap: 'round'
    }).addTo(map);
    trailsMap.set(client.id, polyline);
  }
}

// Centrar en cliente seleccionado
function selectClient(clientId) {
  selectedClientId = clientId;
  const client = clientsMap.get(clientId);
  if (!client) return;

  if (client.latitude && client.longitude) {
    map.setView([client.latitude, client.longitude], 16, { animate: true, duration: 1 });
    if (markersMap.has(clientId)) {
      markersMap.get(clientId).openPopup();
      markersMap.get(clientId).setZIndexOffset(10000);
    }
  }

  const badge = document.getElementById('telemetry-badge');
  if (badge) {
    badge.classList.add('visible');
    document.getElementById('telemetry-text').innerHTML = `
      <strong>${client.name}</strong> [DNI: ${client.dni || client.id}] |
      Batería: <strong>${client.battery !== undefined && client.battery !== null ? Math.round(client.battery)+'%' : 'N/A'}</strong> |
      Velocidad: <strong>${client.speed ? Math.round(client.speed * 3.6)+' km/h' : '0 km/h'}</strong> |
      Equipo: <strong>${client.deviceModel || 'Android'}</strong>
    `;
  }

  renderClientList();
}

// MODO AISLADO: Aislar a un solo cliente para análisis forense exclusivo
function isolateClient(clientId) {
  if (isolatedClientId === clientId) {
    clearIsolation();
    return;
  }

  const client = clientsMap.get(clientId);
  if (!client) return;

  isolatedClientId = clientId;
  selectedClientId = clientId;

  // Filtrar marcadores en el mapa: solo mostrar al cliente aislado
  markersMap.forEach((marker, id) => {
    if (id === clientId) {
      marker.addTo(map);
      marker.setZIndexOffset(10000);
      marker.getElement()?.classList.remove('dimmed');
      marker.getElement()?.classList.add('selected');
    } else {
      map.removeLayer(marker);
    }
  });

  // Ocultar rutas de otros clientes
  trailsMap.forEach((trail, id) => {
    if (id !== clientId) map.removeLayer(trail);
  });

  // Mostrar banner de aislamiento
  const banner = document.getElementById('isolation-banner');
  const nameEl = document.getElementById('iso-client-name');
  const dniEl = document.getElementById('iso-client-dni');
  if (banner && nameEl && dniEl) {
    nameEl.textContent = `🎯 Modo Aislado: Viendo solo a "${client.name}"`;
    dniEl.textContent = `DNI: ${client.dni || client.id} • ${client.phone ? 'Tel: ' + client.phone : ''}`;
    banner.style.display = 'flex';
  }

  if (client.latitude && client.longitude) {
    map.setView([client.latitude, client.longitude], 17, { animate: true });
    if (markersMap.has(clientId)) {
      markersMap.get(clientId).openPopup();
    }
  }

  renderClientList();
  showAdminToast(`🎯 Vista aislada para "${client.name}". Los demás clientes se han ocultado del mapa.`, true);
}

// Desactivar modo aislado y mostrar todos los clientes nuevamente
function clearIsolation() {
  isolatedClientId = null;

  // Restaurar todos los marcadores al mapa
  markersMap.forEach((marker, id) => {
    const c = clientsMap.get(id);
    if (c && c.latitude && c.longitude) {
      marker.addTo(map);
      marker.setZIndexOffset(100);
      marker.getElement()?.classList.remove('dimmed');
      marker.getElement()?.classList.remove('selected');
    }
  });

  // Restaurar ruta activa si existe
  if (activeTrailClientId && trailsMap.has(activeTrailClientId)) {
    trailsMap.get(activeTrailClientId).addTo(map);
  }

  const banner = document.getElementById('isolation-banner');
  if (banner) banner.style.display = 'none';

  renderClientList();
  fitAllMarkers();
  showAdminToast('👁️ Todos los clientes visibles nuevamente en el mapa', true);
}

// Variable para cliente pendiente de borrar
let pendingDeleteClientId = null;
let pendingDeleteClientName = null;

// Eliminar un cliente individual
function deleteClientPrompt(clientId, clientName) {
  pendingDeleteClientId = clientId;
  pendingDeleteClientName = clientName;
  const modal = document.getElementById('modal-confirm-delete');
  const nameEl = document.getElementById('del-client-name');
  const dniEl = document.getElementById('del-client-dni');

  if (modal && nameEl && dniEl) {
    nameEl.textContent = clientName || 'Cliente';
    dniEl.textContent = `DNI / ID: ${clientId}`;
    modal.classList.add('open');
  } else {
    if (confirm(`🗑️ ¿ELIMINAR CLIENTE?\n\n¿Estás seguro de eliminar a "${clientName}" [DNI: ${clientId}]?`)) {
      executeDeleteClient(clientId, clientName);
    }
  }
}

async function executeDeleteClient(clientId, clientName) {
  try {
    const res = await fetch(`/api/clients/${encodeURIComponent(clientId)}`, {
      method: 'DELETE'
    });
    const data = await res.json();
    if (data.success) {
      removeClientFromLocalRadar(data.removedId || clientId);
      showAdminToast(`🗑️ Cliente "${clientName}" eliminado del radar`, true);
    } else {
      showAdminToast('Error eliminando cliente: ' + (data.error || 'Desconocido'), false);
    }
  } catch (err) {
    showAdminToast('Error al conectar con el servidor para eliminar.', false);
  }
}

function removeClientFromLocalRadar(clientId) {
  if (markersMap.has(clientId)) {
    map.removeLayer(markersMap.get(clientId));
    markersMap.delete(clientId);
  }
  if (trailsMap.has(clientId)) {
    map.removeLayer(trailsMap.get(clientId));
    trailsMap.delete(clientId);
  }
  clientsMap.delete(clientId);

  if (selectedClientId === clientId) selectedClientId = null;
  if (isolatedClientId === clientId) clearIsolation();

  renderClientList();
}

// Depuración masiva de clientes inactivos o de prueba
async function purgeInactiveClients() {
  const confirmed = confirm('🧹 LIMPIEZA DE CLIENTES FANTASMAS:\n\n¿Deseas eliminar del radar a todos los clientes de prueba o inactivos que NO tienen ubicación GPS o llevan más de 3 días sin transmitir?');
  if (!confirmed) return;

  try {
    const res = await fetch('/api/clients/purge-inactive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ days: 3 })
    });
    const data = await res.json();
    if (data.success) {
      data.removedIds.forEach(id => {
        if (markersMap.has(id)) {
          map.removeLayer(markersMap.get(id));
          markersMap.delete(id);
        }
        if (trailsMap.has(id)) {
          map.removeLayer(trailsMap.get(id));
          trailsMap.delete(id);
        }
        clientsMap.delete(id);
      });

      renderClientList();
      showAdminToast(`🧹 Limpieza completada: ${data.count} clientes fantasmas eliminados`, true);
    }
  } catch (err) {
    alert('Error ejecutando limpieza de clientes.');
  }
}

// Ajustar vista para abarcar todos los marcadores
function fitAllMarkers() {
  const bounds = L.latLngBounds([]);
  markersMap.forEach(m => bounds.extend(m.getLatLng()));
  geofencesMap.forEach(c => bounds.extend(c.getLatLng()));
  if (bounds.isValid()) {
    map.fitBounds(bounds, { padding: [50, 50], maxZoom: 16 });
  }
}

// Formato de tiempo relativo
function timeAgo(timestamp) {
  if (!timestamp) return 'Nunca';
  const diffSec = Math.floor((Date.now() - timestamp) / 1000);
  if (diffSec < 15) return 'Justo ahora';
  if (diffSec < 60) return `Hace ${diffSec}s`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `Hace ${diffMin}m`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `Hace ${diffHr}h`;
  return `Hace ${Math.floor(diffHr / 24)}d`;
}

// Renderizar lista lateral de clientes
function renderClientList() {
  const container = document.getElementById('client-list');
  const clientsArr = Array.from(clientsMap.values());

  const onlineClients = clientsArr.filter(c => c.isOnline);
  const offlineClients = clientsArr.filter(c => !c.isOnline);
  const alertClients = clientsArr.filter(c => 
    c.gpsStatus === 'GPS_OFF' || 
    c.gpsStatus === 'PERMISSION_DENIED' || 
    c.gpsStatus === 'BG_RESTRICTED' || 
    c.deviceChanged
  );

  document.getElementById('count-all').textContent = clientsArr.length;
  document.getElementById('count-online').textContent = onlineClients.length;
  document.getElementById('count-offline').textContent = offlineClients.length;
  const countAlertsEl = document.getElementById('count-alerts');
  if (countAlertsEl) countAlertsEl.textContent = alertClients.length;
  document.getElementById('active-count-pill').textContent = `${onlineClients.length} activos`;

  let filtered = clientsArr;
  if (currentFilter === 'online') filtered = onlineClients;
  if (currentFilter === 'offline') filtered = offlineClients;
  if (currentFilter === 'alerts') filtered = alertClients;

  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    filtered = filtered.filter(c => {
      const matchName = (c.name || '').toLowerCase().includes(q);
      const matchPhone = (c.phone || '').toLowerCase().includes(q);
      const matchDni = (c.dni || c.id || '').toLowerCase().includes(q);
      return matchName || matchPhone || matchDni;
    });
  }

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🔍</div>
        <h3>No se encontraron clientes</h3>
        <p>No hay clientes que coincidan con la búsqueda o filtro seleccionado.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = '';
  filtered.forEach(client => {
    let statusClass = 'offline';
    let statusBadgeText = '';

    if (client.gpsStatus === 'GPS_OFF') {
      statusClass = 'gps-off';
      statusBadgeText = '<span style="color:#ef4444; font-weight:800; font-size:10px; background:rgba(239,68,68,0.2); border:1px solid rgba(239,68,68,0.4); padding:2px 6px; border-radius:4px; margin-left:6px;">📴 GPS APAGADO</span>';
    } else if (client.gpsStatus === 'PERMISSION_DENIED') {
      statusClass = 'gps-off';
      statusBadgeText = '<span style="color:#ef4444; font-weight:800; font-size:10px; background:rgba(239,68,68,0.2); border:1px solid rgba(239,68,68,0.4); padding:2px 6px; border-radius:4px; margin-left:6px;">🚫 PERMISO DENEGADO</span>';
    } else if (client.gpsStatus === 'BG_RESTRICTED') {
      statusClass = 'paused';
      statusBadgeText = '<span style="color:#f59e0b; font-weight:800; font-size:10px; background:rgba(245,158,11,0.2); border:1px solid rgba(245,158,11,0.5); padding:2px 6px; border-radius:4px; margin-left:6px;">⚠️ 2° PLANO RESTRINGIDO</span>';
    } else if (client.isOnline && client.isTracking) {
      statusClass = 'online';
    } else if (client.isOnline && !client.isTracking) {
      statusClass = 'paused';
    }

    let deviceBadgeText = '';
    if (client.deviceChanged) {
      deviceBadgeText = '<span style="color:#f59e0b; font-weight:800; font-size:10px; background:rgba(245,158,11,0.2); border:1px solid rgba(245,158,11,0.5); padding:2px 6px; border-radius:4px; margin-left:4px;" title="Dispositivo cambiado">🚨 TELÉFONO CAMBIADO</span>';
    }

    const initials = (client.name || 'C').substring(0, 2).toUpperCase();
    const isSelected = client.id === selectedClientId;
    const isIsolated = client.id === isolatedClientId;
    const hasTrailActive = activeTrailClientId === client.id;

    const card = document.createElement('div');
    card.className = `client-card ${isSelected ? 'active-selected' : ''} ${isIsolated ? 'isolated-card' : ''}`;
    card.innerHTML = `
      <div class="client-card-header">
        <div class="avatar-badge">
          ${initials}
          <span class="status-dot ${statusClass}"></span>
        </div>
        <div class="client-info-main">
          <div class="client-name" style="display:flex; align-items:center; justify-content:space-between;">
            <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:140px;">${client.name || 'Cliente'}</span>
            <div style="display:flex; align-items:center;">${statusBadgeText}${deviceBadgeText}</div>
          </div>
          <div class="client-phone">
            <strong style="color:#38bdf8;">DNI: ${client.dni || client.id}</strong> • ${client.phone ? client.phone + ' • ' : ''}${timeAgo(client.lastSeen)}
          </div>
          <div style="font-size:11px; color:#94a3b8; margin-top:3px; display:flex; align-items:center; gap:6px;">
            <span>📱 <strong style="color:#e2e8f0;">${client.deviceModel || 'Android'}</strong></span>
            ${client.hardwareId ? `<span style="font-size:9px; font-family:monospace; color:#38bdf8; background:rgba(56,189,248,0.1); border:1px solid rgba(56,189,248,0.25); padding:1px 5px; border-radius:3px;" title="Huella Única Hardware (Android ID): ${client.hardwareId}">HW: ${client.hardwareId.substring(0, 8)}...</span>` : ''}
          </div>
        </div>
      </div>

      ${client.deviceChanged ? `
        <div style="background: rgba(245, 158, 11, 0.15); border: 1px dashed #f59e0b; border-radius: 6px; padding: 6px 10px; margin: 8px 0; font-size: 11px; color: #fbbf24; line-height: 1.4;">
          ⚠️ <strong>Alerta: Cambio de Teléfono</strong><br>
          Anterior: <span style="color:#e2e8f0;">${client.previousDevice?.model || 'Desconocido'}</span> ➔ Nuevo: <span style="color:#38bdf8; font-weight:700;">${client.deviceModel || 'Android'}</span><br>
          <button class="btn-card btn-confirm-device" data-id="${client.id}" style="margin-top:6px; width:100%; flex:none; background:rgba(16,185,129,0.15); border-color:rgba(16,185,129,0.4); color:#34d399;">✅ Confirmar: es el teléfono nuevo del cliente</button>
        </div>
      ` : ''}

      ${client.gpsStatus === 'GPS_OFF' ? `
        <div style="background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.4); border-radius: 6px; padding: 6px 10px; margin: 8px 0; font-size: 11px; color: #f87171; line-height: 1.4;">
          📴 <strong>Alerta GPS:</strong> El cliente tiene el interruptor de GPS APAGADO en su teléfono. Indícale que encienda la "Ubicación" en la barra de notificaciones superior.
        </div>
      ` : client.gpsStatus === 'PERMISSION_DENIED' ? `
        <div style="background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.4); border-radius: 6px; padding: 6px 10px; margin: 8px 0; font-size: 11px; color: #f87171; line-height: 1.4;">
          🚫 <strong>Alerta Permisos:</strong> Permiso de ubicación denegado en el celular. El cliente debe tocar "Solucionar Permisos" en la app.
        </div>
      ` : client.gpsStatus === 'BG_RESTRICTED' ? `
        <div style="background: rgba(245, 158, 11, 0.15); border: 1px solid rgba(245, 158, 11, 0.4); border-radius: 6px; padding: 6px 10px; margin: 8px 0; font-size: 11px; color: #fbbf24; line-height: 1.4;">
          ⚠️ <strong>Segundo Plano:</strong> Falta permiso "Permitir todo el tiempo". Si bloquea la pantalla, puede pausarse la transmisión.
        </div>
      ` : ''}

      <div class="client-telemetry">
        <div class="telemetry-item" title="${client.deviceModel || 'Android'}">
          <span class="telemetry-label">Equipo</span>
          <span class="telemetry-val" style="font-size:11px; max-width:70px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${client.deviceModel || 'Android'}</span>
        </div>
        <div class="telemetry-item">
          <span class="telemetry-label">Batería</span>
          <span class="telemetry-val">${client.battery !== undefined && client.battery !== null ? Math.round(client.battery)+'%' : 'N/A'}</span>
        </div>
        <div class="telemetry-item">
          <span class="telemetry-label">Precisión</span>
          <span class="telemetry-val">${client.accuracy ? '±' + Math.round(client.accuracy) + 'm' : 'N/A'}</span>
        </div>
        <div class="telemetry-item">
          <span class="telemetry-label">Velocidad</span>
          <span class="telemetry-val">${client.speed ? Math.round(client.speed * 3.6) + ' km/h' : '0 km/h'}</span>
        </div>
      </div>

      <div class="client-card-actions">
        <button class="btn-card highlight btn-track-client" data-id="${client.id}" title="Centrar en el mapa">
          🎯 Rastrear
        </button>
        <button class="btn-card ${isIsolated ? 'highlight' : ''} btn-isolate-client" data-id="${client.id}" title="Ver solo a este cliente y ocultar los demás" style="background:${isIsolated ? '#0284c7' : 'rgba(2,132,199,0.15)'}; border-color:rgba(2,132,199,0.4); color:${isIsolated ? '#ffffff' : '#38bdf8'}; font-weight:700;">
          ${isIsolated ? '👁️ Ver Todos' : '🎯 Aislar'}
        </button>
        <button class="btn-card btn-history-client" data-id="${client.id}" title="Ver historial de los últimos 60 días" style="background:rgba(56,189,248,0.15); border-color:rgba(56,189,248,0.4); color:#38bdf8;">
          📅 60 Días
        </button>
        <button class="btn-card btn-geofence-client" data-id="${client.id}" title="Crear geocerca para este cliente" style="background:rgba(245,158,11,0.15); border-color:rgba(245,158,11,0.4); color:#fbbf24;">
          📍 Geocerca
        </button>
        <button class="btn-card ${hasTrailActive ? 'highlight' : ''} btn-trail-client" data-id="${client.id}" title="Ver u ocultar recorrido reciente">
          🗺️ ${hasTrailActive ? 'Ocultar' : 'Ruta'}
        </button>
        <button class="btn-card btn-notify-client" data-id="${client.id}" title="Enviar aviso o alarma al teléfono del cliente" style="background:rgba(56,189,248,0.15); border-color:rgba(56,189,248,0.4); color:#38bdf8; font-weight:700;">
          💬 Notificar
        </button>
        ${client.phone ? `
          <a href="https://wa.me/${client.phone.replace(/[^0-9]/g, '')}" target="_blank" class="btn-card" title="WhatsApp">
            💬 WA
          </a>
        ` : ''}
        <button class="btn-card btn-delete-client" data-id="${client.id}" title="Eliminar cliente del radar" style="background:rgba(239,68,68,0.15); border-color:rgba(239,68,68,0.35); color:#ef4444; max-width:38px; flex:0 0 38px;">
          🗑️
        </button>
      </div>
    `;

    // Eventos de la tarjeta
    card.addEventListener('click', (e) => {
      if (e.target.closest('button') || e.target.closest('a')) return;
      selectClient(client.id);
    });

    card.querySelector('.btn-track-client').addEventListener('click', () => {
      selectClient(client.id);
    });

    card.querySelector('.btn-isolate-client').addEventListener('click', (e) => {
      e.stopPropagation();
      isolateClient(client.id);
    });

    card.querySelector('.btn-trail-client').addEventListener('click', () => {
      toggleTrail(client.id);
    });

    card.querySelector('.btn-history-client').addEventListener('click', () => {
      openHistoryModal(client.id);
    });

    card.querySelector('.btn-geofence-client').addEventListener('click', () => {
      openGeofenceModalForClient(client.id);
    });

    card.querySelector('.btn-notify-client').addEventListener('click', (e) => {
      e.stopPropagation();
      openNotifyModal(client.id);
    });

    const confirmBtn = card.querySelector('.btn-confirm-device');
    if (confirmBtn) {
      confirmBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await fetch(`/api/clients/${encodeURIComponent(client.id)}/confirm-device`, { method: 'POST' });
        showAdminToast('✅ Nuevo teléfono confirmado como legítimo', true);
      });
    }

    card.querySelector('.btn-delete-client').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteClientPrompt(client.id, client.name || 'Cliente');
    });

    container.appendChild(card);
  });
}

// GEOCERCAS: Renderizado y administración
function renderGeofencesOnMap() {
  // Limpiar círculos viejos
  geofencesMap.forEach(circle => map.removeLayer(circle));
  geofencesMap.clear();

  geofencesList.forEach(fence => {
    let color = '#f59e0b'; // Amarillo
    if (fence.type === 'CASA') color = '#10b981'; // Verde
    if (fence.type === 'TRABAJO') color = '#3b82f6'; // Azul
    if (fence.type === 'ZONA_RIESGO') color = '#ef4444'; // Rojo

    const circle = L.circle([fence.latitude, fence.longitude], {
      radius: fence.radius,
      color: color,
      fillColor: color,
      fillOpacity: 0.18,
      weight: 2
    }).addTo(map);

    circle.bindTooltip(`<strong>${fence.name}</strong> (${fence.radius}m)<br>Tipo: ${fence.type}`, {
      permanent: false,
      direction: 'top'
    });

    geofencesMap.set(fence.id, circle);
  });

  const countEl = document.getElementById('geofences-count-pill');
  if (countEl) countEl.textContent = geofencesList.length;
  renderGeofencesListUI();
}

function renderGeofencesListUI() {
  const container = document.getElementById('geofences-list-container');
  if (!container) return;

  if (geofencesList.length === 0) {
    container.innerHTML = '<p style="color:var(--text-muted); font-size:0.85rem;">No hay geocercas creadas aún.</p>';
    return;
  }

  container.innerHTML = '';
  geofencesList.forEach(f => {
    const item = document.createElement('div');
    item.style.cssText = 'background:rgba(255,255,255,0.02); border:1px solid var(--border-color); border-radius:6px; padding:8px 12px; display:flex; justify-content:space-between; align-items:center;';
    item.innerHTML = `
      <div>
        <strong style="font-size:0.9rem; color:var(--text-primary);">${f.name}</strong>
        <div style="font-size:0.75rem; color:var(--text-muted);">
          Radio: ${f.radius}m • Tipo: ${f.type} ${f.clientId ? '• Cliente: ' + f.clientId : '• Global'}
        </div>
      </div>
      <div style="display:flex; gap:6px;">
        <button class="btn-card highlight btn-center-fence" style="font-size:0.75rem; padding:4px 8px;">🎯 Ver</button>
        <button class="btn-card btn-delete-fence" style="font-size:0.75rem; padding:4px 8px; background:rgba(239,68,68,0.2); color:#ef4444; border-color:rgba(239,68,68,0.4);">🗑️</button>
      </div>
    `;

    item.querySelector('.btn-center-fence').addEventListener('click', () => {
      map.setView([f.latitude, f.longitude], 16);
      document.getElementById('modal-geofences').classList.remove('open');
    });

    item.querySelector('.btn-delete-fence').addEventListener('click', async () => {
      if (confirm(`¿Eliminar la geocerca "${f.name}"?`)) {
        await fetch(`/api/geofences/${f.id}`, { method: 'DELETE' });
        geofencesList = geofencesList.filter(x => x.id !== f.id);
        renderGeofencesOnMap();
      }
    });

    container.appendChild(item);
  });
}

function updateGeofenceClientSelect() {
  const select = document.getElementById('fence-client-select');
  if (!select) return;
  select.innerHTML = '<option value="">🌐 Todos los Clientes (Global)</option>';
  clientsMap.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.dni || c.id;
    opt.textContent = `${c.name} [DNI: ${c.dni || c.id}]`;
    select.appendChild(opt);
  });
}

function openGeofenceModalForClient(clientId) {
  const client = clientsMap.get(clientId);
  const modal = document.getElementById('modal-geofences');
  updateGeofenceClientSelect();

  if (client) {
    document.getElementById('fence-client-select').value = client.dni || client.id;
    document.getElementById('fence-name').value = `Casa de ${client.name.split(' ')[0]}`;
    if (client.latitude && client.longitude) {
      document.getElementById('fence-lat').value = client.latitude;
      document.getElementById('fence-lng').value = client.longitude;
    }
  }

  modal.classList.add('open');
}

// HISTORIAL 60 DÍAS: Cargar días y dibujar ruta
let currentHistoryClientId = null;
async function openHistoryModal(clientId) {
  currentHistoryClientId = clientId;
  const client = clientsMap.get(clientId);
  if (!client) return;

  document.getElementById('history-modal-client-name').textContent = client.name;
  document.getElementById('history-modal-client-dni').textContent = `DNI: ${client.dni || client.id}`;

  const select = document.getElementById('history-day-select');
  select.innerHTML = '<option value="">Cargando días registrados...</option>';
  document.getElementById('history-day-stats').style.display = 'none';

  const modal = document.getElementById('modal-history');
  modal.classList.add('open');

  try {
    const res = await fetch(`/api/clients/${clientId}/history-days`);
    const data = await res.json();

    select.innerHTML = '';
    if (data.days && data.days.length > 0) {
      data.days.forEach(day => {
        const opt = document.createElement('option');
        opt.value = day;
        opt.textContent = `📅 ${day}`;
        select.appendChild(opt);
      });
      // Cargar el día más reciente por defecto
      loadDayHistory(clientId, data.days[0]);
    } else {
      select.innerHTML = '<option value="">No hay historial registrado aún (Empieza hoy)</option>';
    }
  } catch (err) {
    select.innerHTML = '<option value="">Error cargando fechas</option>';
  }
}

async function loadDayHistory(clientId, day) {
  if (!day) return;
  try {
    const res = await fetch(`/api/clients/${clientId}/history-day/${day}`);
    const data = await res.json();
    if (data.points && data.points.length > 0) {
      const pts = data.points;
      document.getElementById('stat-points-count').textContent = pts.length;
      document.getElementById('stat-battery-start').textContent = pts[0].battery !== undefined ? `${Math.round(pts[0].battery)}%` : 'N/A';
      document.getElementById('stat-time-start').textContent = new Date(pts[0].timestamp).toLocaleTimeString();
      document.getElementById('stat-time-end').textContent = new Date(pts[pts.length - 1].timestamp).toLocaleTimeString();
      document.getElementById('history-day-stats').style.display = 'block';
    } else {
      document.getElementById('history-day-stats').style.display = 'none';
    }
  } catch (_) {}
}

async function drawSelectedDayRoute() {
  const select = document.getElementById('history-day-select');
  const day = select.value;
  if (!day || !currentHistoryClientId) return;

  try {
    const res = await fetch(`/api/clients/${currentHistoryClientId}/history-day/${day}`);
    const data = await res.json();

    if (!data.points || data.points.length === 0) {
      alert('No hay puntos registrados para este día.');
      return;
    }

    clearDayRoute();

    const latlngs = data.points.map(p => [p.lat, p.lng]);
    activeDayRoutePolyline = L.polyline(latlngs, {
      color: '#38bdf8',
      weight: 5,
      opacity: 0.9,
      lineCap: 'round',
      lineJoin: 'round'
    }).addTo(map);

    // Marcador de Inicio (Verde)
    const startPoint = data.points[0];
    const startMarker = L.circleMarker([startPoint.lat, startPoint.lng], {
      radius: 9,
      color: '#10b981',
      fillColor: '#10b981',
      fillOpacity: 1
    }).addTo(map).bindPopup(`<strong>🏁 Inicio del Día (${day})</strong><br>Hora: ${new Date(startPoint.timestamp).toLocaleTimeString()}`);
    activeDayRouteMarkers.push(startMarker);

    // Marcador de Fin (Rojo)
    const endPoint = data.points[data.points.length - 1];
    const endMarker = L.circleMarker([endPoint.lat, endPoint.lng], {
      radius: 9,
      color: '#ef4444',
      fillColor: '#ef4444',
      fillOpacity: 1
    }).addTo(map).bindPopup(`<strong>🛑 Última Posición (${day})</strong><br>Hora: ${new Date(endPoint.timestamp).toLocaleTimeString()}`);
    activeDayRouteMarkers.push(endMarker);

    map.fitBounds(activeDayRoutePolyline.getBounds(), { padding: [50, 50] });
    document.getElementById('modal-history').classList.remove('open');
    showAdminToast(`🗺️ Ruta del día ${day} cargada en el mapa (${data.points.length} puntos)`, true);
  } catch (err) {
    alert('Error al dibujar la ruta del día.');
  }
}

function clearDayRoute() {
  if (activeDayRoutePolyline) {
    map.removeLayer(activeDayRoutePolyline);
    activeDayRoutePolyline = null;
  }
  activeDayRouteMarkers.forEach(m => map.removeLayer(m));
  activeDayRouteMarkers = [];
}

// Modal Nuevo Cliente / DNI
function updateGeneratedLink() {
  const dni = document.getElementById('input-client-dni').value.trim() || '74892150';
  const name = document.getElementById('input-client-name').value.trim();
  const phone = document.getElementById('input-client-phone').value.trim();

  const baseUrl = serverInfo ? serverInfo.clientUrl : `${window.location.origin}/client.html`;
  const url = new URL(baseUrl);
  url.searchParams.set('dni', dni);
  url.searchParams.set('id', dni);
  if (name) url.searchParams.set('name', name);
  if (phone) url.searchParams.set('phone', phone);

  const fullUrl = url.toString();
  document.getElementById('generated-link').value = fullUrl;

  const downloadPageUrl = serverInfo 
    ? `${serverInfo.baseUrl}/descargar.html` 
    : `${window.location.origin}/descargar.html`;
  const apkInput = document.getElementById('apk-download-link');
  if (apkInput) apkInput.value = downloadPageUrl;

  const qrImg = document.getElementById('qr-image');
  const qrLoading = document.getElementById('qr-loading');
  qrLoading.style.display = 'block';
  qrImg.style.display = 'none';

  const qrApiUrl = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(fullUrl)}&bgcolor=11-18-27&color=16-185-129`;
  qrImg.src = qrApiUrl;
  qrImg.onload = () => {
    qrLoading.style.display = 'none';
    qrImg.style.display = 'block';
  };

  const waBtn = document.getElementById('btn-share-whatsapp');
  if (waBtn) {
    const waText = encodeURIComponent(`Hola ${name || 'Estimado cliente'}, para activar tu localizador del préstamo por favor abre este enlace en tu celular: ${fullUrl}`);
    const phoneClean = phone.replace(/[^0-9]/g, '');
    waBtn.href = phoneClean ? `https://wa.me/${phoneClean}?text=${waText}` : `https://wa.me/?text=${waText}`;
  }
}

// Configurar WebSockets
function setupSocket() {
  const socket = io();
  window.gcSocket = socket;

  socket.on('connect', () => {
    document.getElementById('server-status-text').textContent = 'Radar En Vivo';
    socket.emit('admin:join', { token: window.GC_AUTH ? window.GC_AUTH.getToken() : '' });
  });

  socket.on('disconnect', () => {
    document.getElementById('server-status-text').textContent = 'Reconectando...';
  });

  socket.on('admin:unauthorized', () => {
    if (window.GC_AUTH) window.GC_AUTH.showLogin('Inicia sesión para ver el radar.');
  });

  socket.on('client:removed-silent', () => {});

  socket.on('admin:init-clients', (clients) => {
    clients.forEach(c => {
      clientsMap.set(c.id, c);
      if (c.latitude && c.longitude) {
        updateMapMarker(c);
      }
    });
    renderClientList();
    if (clients.length > 0) fitAllMarkers();
  });

  socket.on('admin:init-geofences', (fences) => {
    geofencesList = fences || [];
    renderGeofencesOnMap();
  });

  socket.on('client:location-updated', (data) => {
    const client = data.client;
    clientsMap.set(client.id, client);
    updateMapMarker(client);
    renderClientList();
    playPingSound();
  });

  socket.on('client:status-changed', (data) => {
    const client = clientsMap.get(data.clientId);
    if (client) {
      if (data.isOnline !== undefined) client.isOnline = data.isOnline;
      if (data.isTracking !== undefined) client.isTracking = data.isTracking;
      renderClientList();
    }
  });

  // Alerta de GPS apagado o problemas de permisos
  socket.on('client:gps-alert', (data) => {
    const client = clientsMap.get(data.clientId) || { id: data.clientId, name: data.name };
    client.gpsStatus = data.gpsStatus;
    client.statusMessage = data.message || client.statusMessage;
    client.name = data.name || client.name;
    clientsMap.set(data.clientId, client);


    renderClientList();
    updateMapMarker(client);
  });

  // Alerta de cambio de dispositivo físico
  socket.on('client:device-alert', (data) => {
    const client = clientsMap.get(data.clientId) || { id: data.clientId, name: data.name };
    client.deviceChanged = true;
    client.previousDevice = { model: data.oldDevice };
    client.deviceModel = data.newDevice;
    clientsMap.set(data.clientId, client);

    renderClientList();
  });

  // Alerta de Geocerca (Entrada / Salida de Casa, Trabajo, etc.)
  socket.on('client:geofence-alert', (data) => {
    playWarningSound();
    showAdminToast(data.message, data.type === 'ENTER');
  });

  socket.on('client:message-delivered', (data) => {
    const c = clientsMap.get(data.clientId);
    const name = c ? c.name : 'El cliente';
    showAdminToast(`✅ ${name} confirmó lectura de aviso en su celular`, true);
    const statusBox = document.getElementById('notify-status-box');
    if (statusBox) {
      statusBox.style.display = 'block';
      statusBox.style.background = 'rgba(16, 185, 129, 0.2)';
      statusBox.style.border = '1px solid #10b981';
      statusBox.style.color = '#34d399';
      statusBox.textContent = `✅ ¡Aviso leído y confirmado por el cliente! (${new Date(data.timestamp).toLocaleTimeString()})`;
    }
  });

  socket.on('client:removed', (data) => {
    clientsMap.delete(data.clientId);
    if (markersMap.has(data.clientId)) {
      map.removeLayer(markersMap.get(data.clientId));
      markersMap.delete(data.clientId);
    }
    renderClientList();
  });
}

// Cargar info del servidor y geocercas iniciales
async function fetchServerInfo() {
  try {
    const res = await fetch('/api/server-info');
    serverInfo = await res.json();
    document.getElementById('client-url-preview').textContent = serverInfo.clientUrl;
    const iphoneQr = document.getElementById('qr-iphone-guide');
    if (iphoneQr && serverInfo.clientUrl) {
      iphoneQr.src = `https://api.qrserver.com/v1/create-qr-code/?size=110x110&data=${encodeURIComponent(serverInfo.clientUrl)}&bgcolor=11-18-27&color=56-189-248`;
    }
  } catch (err) {}

  try {
    const resGeo = await fetch('/api/geofences');
    const dataGeo = await resGeo.json();
    if (dataGeo.geofences) {
      geofencesList = dataGeo.geofences;
      renderGeofencesOnMap();
    }
  } catch (err) {}
}

// Event Listeners
document.addEventListener('DOMContentLoaded', () => {
  initMap();
  setupSocket();
  fetchServerInfo();

  // Capas del mapa
  document.querySelectorAll('.layer-btn').forEach(btn => {
    btn.addEventListener('click', () => switchLayer(btn.dataset.layer));
  });

  // Centrar mapa
  document.getElementById('btn-fit-all').addEventListener('click', fitAllMarkers);

  // Toggle sonido
  const soundBtn = document.getElementById('btn-sound-toggle');
  soundBtn.addEventListener('click', () => {
    soundEnabled = !soundEnabled;
    soundBtn.querySelector('.icon').textContent = soundEnabled ? '🔔' : '🔕';
  });

  // Filtros
  document.querySelectorAll('.filter-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentFilter = tab.dataset.filter;
      renderClientList();
    });
  });

  // Búsqueda
  document.getElementById('client-search').addEventListener('input', (e) => {
    searchQuery = e.target.value.trim();
    renderClientList();
  });

  // Modal Nuevo Cliente / DNI
  const modalNewClient = document.getElementById('modal-new-client');
  document.getElementById('btn-new-client').addEventListener('click', () => {
    updateGeneratedLink();
    modalNewClient.classList.add('open');
  });

  document.getElementById('btn-close-modal').addEventListener('click', () => {
    modalNewClient.classList.remove('open');
  });

  modalNewClient.addEventListener('click', (e) => {
    if (e.target === modalNewClient) modalNewClient.classList.remove('open');
  });

  document.getElementById('input-client-dni').addEventListener('input', updateGeneratedLink);
  document.getElementById('input-client-name').addEventListener('input', updateGeneratedLink);
  document.getElementById('input-client-phone').addEventListener('input', updateGeneratedLink);

  document.getElementById('btn-save-client-db').addEventListener('click', async () => {
    const dni = document.getElementById('input-client-dni').value.trim();
    const name = document.getElementById('input-client-name').value.trim();
    const phone = document.getElementById('input-client-phone').value.trim();
    if (!dni) {
      alert('Ingresa el número de DNI');
      return;
    }
    const res = await fetch('/api/clients', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dni, name, phone })
    });
    const result = await res.json();
    if (result.success) {
      showAdminToast(`✅ Ficha del cliente DNI ${dni} guardada con éxito`, true);
      modalNewClient.classList.remove('open');
      renderClientList();
    }
  });

  // Copiar enlaces
  document.getElementById('btn-copy-link').addEventListener('click', () => {
    const input = document.getElementById('generated-link');
    input.select();
    navigator.clipboard.writeText(input.value);
    const copyBtn = document.getElementById('btn-copy-link');
    copyBtn.textContent = '¡Copiado!';
    setTimeout(() => { copyBtn.textContent = 'Copiar'; }, 2000);
  });

  const copyApkBtn = document.getElementById('btn-copy-apk-link');
  if (copyApkBtn) {
    copyApkBtn.addEventListener('click', () => {
      const input = document.getElementById('apk-download-link');
      input.select();
      navigator.clipboard.writeText(input.value);
      copyApkBtn.textContent = '¡Copiado!';
      setTimeout(() => { copyApkBtn.textContent = 'Copiar'; }, 2000);
    });
  }

  // Modal Geocercas
  const modalGeofences = document.getElementById('modal-geofences');
  document.getElementById('btn-geofences').addEventListener('click', () => {
    updateGeofenceClientSelect();
    modalGeofences.classList.add('open');
  });

  document.getElementById('btn-close-geofences').addEventListener('click', () => {
    modalGeofences.classList.remove('open');
  });

  modalGeofences.addEventListener('click', (e) => {
    if (e.target === modalGeofences) modalGeofences.classList.remove('open');
  });

  // Usar ubicación actual del cliente en geocerca
  document.getElementById('btn-fence-use-client-loc').addEventListener('click', () => {
    const clientDni = document.getElementById('fence-client-select').value;
    let client = null;
    if (clientDni) {
      client = clientsMap.get(clientDni);
    } else if (selectedClientId) {
      client = clientsMap.get(selectedClientId);
    }
    if (client && client.latitude && client.longitude) {
      document.getElementById('fence-lat').value = client.latitude;
      document.getElementById('fence-lng').value = client.longitude;
      showAdminToast(`Ubicación de ${client.name} copiada`, true);
    } else {
      alert('Selecciona un cliente que tenga señal GPS activa.');
    }
  });

  // Guardar Geocerca
  document.getElementById('btn-create-fence-submit').addEventListener('click', async () => {
    const name = document.getElementById('fence-name').value.trim();
    const type = document.getElementById('fence-type').value;
    const clientId = document.getElementById('fence-client-select').value;
    const radius = Number(document.getElementById('fence-radius').value);
    const lat = Number(document.getElementById('fence-lat').value);
    const lng = Number(document.getElementById('fence-lng').value);

    if (!name || isNaN(lat) || isNaN(lng)) {
      alert('Completa el nombre y las coordenadas de la geocerca.');
      return;
    }

    const res = await fetch('/api/geofences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, type, clientId, radius, latitude: lat, longitude: lng })
    });
    const result = await res.json();
    if (result.success) {
      geofencesList.push(result.geofence);
      renderGeofencesOnMap();
      showAdminToast(`📍 Geocerca "${name}" activada`, true);
      document.getElementById('fence-name').value = '';
    }
  });

  // Modal Historial 60 Días
  const modalHistory = document.getElementById('modal-history');
  document.getElementById('btn-close-history').addEventListener('click', () => {
    modalHistory.classList.remove('open');
  });

  modalHistory.addEventListener('click', (e) => {
    if (e.target === modalHistory) modalHistory.classList.remove('open');
  });

  document.getElementById('history-day-select').addEventListener('change', (e) => {
    if (currentHistoryClientId && e.target.value) {
      loadDayHistory(currentHistoryClientId, e.target.value);
    }
  });

  document.getElementById('btn-draw-day-route').addEventListener('click', drawSelectedDayRoute);
  document.getElementById('btn-clear-day-route').addEventListener('click', () => {
    clearDayRoute();
    showAdminToast('Ruta histórica limpiada del mapa', true);
  });

  // Modal Guía de Instalación (Android & Apple iPhone)
  const modalInstallGuide = document.getElementById('modal-install-guide');
  const btnOpenInstallGuide = document.getElementById('btn-open-install-guide');
  const btnCloseInstallGuide = document.getElementById('btn-close-install-guide');

  if (btnOpenInstallGuide && modalInstallGuide) {
    btnOpenInstallGuide.addEventListener('click', () => {
      modalInstallGuide.classList.add('open');
    });
  }

  if (btnCloseInstallGuide && modalInstallGuide) {
    btnCloseInstallGuide.addEventListener('click', () => {
      modalInstallGuide.classList.remove('open');
    });
  }

  if (modalInstallGuide) {
    modalInstallGuide.addEventListener('click', (e) => {
      if (e.target === modalInstallGuide) modalInstallGuide.classList.remove('open');
    });
  }

  // Pestañas dentro del modal Guía (Descargas vs Admin/Cliente)
  const tabGuideInstall = document.getElementById('tab-guide-install');
  const tabGuideRoles = document.getElementById('tab-guide-roles');
  const secGuideInstall = document.getElementById('section-guide-install');
  const secGuideRoles = document.getElementById('section-guide-roles');

  if (tabGuideInstall && tabGuideRoles && secGuideInstall && secGuideRoles) {
    tabGuideInstall.addEventListener('click', () => {
      tabGuideInstall.classList.add('active');
      tabGuideRoles.classList.remove('active');
      secGuideInstall.style.display = 'block';
      secGuideRoles.style.display = 'none';
    });

    tabGuideRoles.addEventListener('click', () => {
      tabGuideRoles.classList.add('active');
      tabGuideInstall.classList.remove('active');
      secGuideInstall.style.display = 'none';
      secGuideRoles.style.display = 'block';
    });
  }

  // Pestañas OS dentro de "Nuevo Cliente / DNI"
  const tabAndroid = document.getElementById('tab-modal-android');
  const tabApple = document.getElementById('tab-modal-apple');
  const secAndroid = document.getElementById('section-modal-android');
  const secApple = document.getElementById('section-modal-apple');
  const labelDirectLink = document.getElementById('label-direct-link');
  const qrCaption = document.getElementById('qr-caption');

  if (tabAndroid && tabApple && secAndroid && secApple) {
    tabAndroid.addEventListener('click', () => {
      tabAndroid.classList.add('active');
      tabApple.classList.remove('active');
      secAndroid.style.display = 'block';
      secApple.style.display = 'none';
      if (labelDirectLink) labelDirectLink.textContent = '🌐 Enlace Directo para el Cliente (Con su DNI):';
      if (qrCaption) qrCaption.textContent = 'Escanea con la cámara del celular Android para vincular de inmediato';
    });

    tabApple.addEventListener('click', () => {
      tabApple.classList.add('active');
      tabAndroid.classList.remove('active');
      secAndroid.style.display = 'none';
      secApple.style.display = 'block';
      if (labelDirectLink) labelDirectLink.textContent = '🍎 Enlace Safari para iPhone (Con su DNI):';
      if (qrCaption) qrCaption.textContent = 'Apunta con la Cámara del iPhone para abrir en Safari y Agregar a Pantalla de Inicio';
    });
  }

  // Botón Copiar enlace APK Global
  const btnCopyGlobalApk = document.getElementById('btn-copy-global-apk-link');
  if (btnCopyGlobalApk) {
    btnCopyGlobalApk.addEventListener('click', () => {
      const apkUrl = serverInfo 
        ? `${serverInfo.baseUrl}/descargar.html` 
        : `${window.location.origin}/descargar.html`;
      navigator.clipboard.writeText(apkUrl);
      btnCopyGlobalApk.textContent = '¡Copiado!';
      showAdminToast('📋 Enlace de descarga copiado al portapapeles', true);
      setTimeout(() => { btnCopyGlobalApk.textContent = '📋 Copiar Enlace APK'; }, 2000);
    });
  }

  // Botón Copiar Enlace iPhone
  const btnCopyIphoneGuide = document.getElementById('btn-copy-iphone-guide-link');
  if (btnCopyIphoneGuide) {
    btnCopyIphoneGuide.addEventListener('click', () => {
      const clientUrl = serverInfo ? serverInfo.clientUrl : `${window.location.origin}/client.html`;
      const textToCopy = `📱 Instrucciones para iPhone (Apple):\n1. Abre este enlace en Safari: ${clientUrl}\n2. Toca Compartir (icono ⎋ abajo)\n3. Toca "Agregar a pantalla de inicio"`;
      navigator.clipboard.writeText(textToCopy);
      btnCopyIphoneGuide.textContent = '¡Instrucciones Copiadas!';
      showAdminToast('🍎 Instrucciones para iPhone copiadas al portapapeles', true);
      setTimeout(() => { btnCopyIphoneGuide.textContent = '📋 Copiar Enlace para Clientes con iPhone'; }, 2500);
    });
  }

  // Botón Quitar Modo Aislado
  const btnClearIso = document.getElementById('btn-clear-isolation');
  if (btnClearIso) {
    btnClearIso.addEventListener('click', clearIsolation);
  }

  // Botón Limpiar Clientes Fantasmas
  const btnPurge = document.getElementById('btn-purge-ghosts');
  if (btnPurge) {
    btnPurge.addEventListener('click', purgeInactiveClients);
  }

  // Botón Toggle Sidebar (Móvil / Pantallas pequeñas)
  const btnToggleSidebar = document.getElementById('btn-toggle-sidebar');
  const sidebarEl = document.getElementById('sidebar');
  if (btnToggleSidebar && sidebarEl) {
    btnToggleSidebar.addEventListener('click', () => {
      sidebarEl.classList.toggle('collapsed');
      setTimeout(() => {
        if (map) map.invalidateSize();
      }, 350);
    });
  }

  // Modal de Confirmación de Borrado de Cliente
  const deleteModal = document.getElementById('modal-confirm-delete');
  const btnCloseDel = document.getElementById('btn-close-delete-modal');
  const btnCancelDel = document.getElementById('btn-cancel-delete');
  const btnConfirmDel = document.getElementById('btn-confirm-delete');

  if (btnCloseDel && deleteModal) {
    btnCloseDel.addEventListener('click', () => deleteModal.classList.remove('open'));
  }
  if (btnCancelDel && deleteModal) {
    btnCancelDel.addEventListener('click', () => deleteModal.classList.remove('open'));
  }
  if (btnConfirmDel && deleteModal) {
    btnConfirmDel.addEventListener('click', () => {
      deleteModal.classList.remove('open');
      if (pendingDeleteClientId) {
        executeDeleteClient(pendingDeleteClientId, pendingDeleteClientName);
      }
    });
  }

  // Modal de Aviso / Notificación al Cliente
  const notifyModal = document.getElementById('modal-notify-client');
  const btnCloseNotify = document.getElementById('btn-close-notify-modal');
  const btnCancelNotify = document.getElementById('btn-cancel-notify');
  const btnSendNotify = document.getElementById('btn-send-notify');

  if (btnCloseNotify && notifyModal) {
    btnCloseNotify.addEventListener('click', closeNotifyModal);
  }
  if (btnCancelNotify && notifyModal) {
    btnCancelNotify.addEventListener('click', closeNotifyModal);
  }
  if (notifyModal) {
    notifyModal.addEventListener('click', (e) => {
      if (e.target === notifyModal) closeNotifyModal();
    });
  }

  // Plantillas rápidas
  document.querySelectorAll('.btn-preset-msg').forEach(btn => {
    btn.addEventListener('click', () => {
      const title = btn.dataset.title;
      const msg = btn.dataset.msg;
      const titleInput = document.getElementById('notify-msg-title');
      const bodyInput = document.getElementById('notify-msg-body');
      if (titleInput && title) titleInput.value = title;
      if (bodyInput && msg) bodyInput.value = msg;
    });
  });

  if (btnSendNotify) {
    btnSendNotify.addEventListener('click', sendClientNotification);
  }

  // Inicializar divisor arrastrable (resizer) para la barra lateral
  initSidebarResizer();
});

let activeNotifyClientId = null;

function openNotifyModal(clientId) {
  const client = clientsMap.get(clientId);
  if (!client) return;

  activeNotifyClientId = clientId;
  const modal = document.getElementById('modal-notify-client');
  const nameEl = document.getElementById('notify-client-name');
  const dniEl = document.getElementById('notify-client-dni');
  const bodyEl = document.getElementById('notify-msg-body');
  const statusBox = document.getElementById('notify-status-box');

  if (nameEl) nameEl.textContent = client.name || 'Cliente';
  if (dniEl) dniEl.textContent = `DNI: ${client.dni || client.id} • ${client.isOnline ? '🟢 En línea ahora' : '⚪ Desconectado'}`;
  if (bodyEl) bodyEl.value = '';
  if (statusBox) statusBox.style.display = 'none';

  if (modal) modal.classList.add('open');
}

function closeNotifyModal() {
  const modal = document.getElementById('modal-notify-client');
  if (modal) modal.classList.remove('open');
  activeNotifyClientId = null;
}

async function sendClientNotification() {
  if (!activeNotifyClientId) return;
  const client = clientsMap.get(activeNotifyClientId);
  const title = (document.getElementById('notify-msg-title')?.value || 'Aviso de Administración').trim();
  const message = (document.getElementById('notify-msg-body')?.value || '').trim();
  const playSound = document.getElementById('notify-play-sound')?.checked !== false;
  const statusBox = document.getElementById('notify-status-box');

  if (!message) {
    alert('Por favor escribe un mensaje o selecciona una plantilla rápida.');
    return;
  }

  if (statusBox) {
    statusBox.style.display = 'block';
    statusBox.style.background = 'rgba(56, 189, 248, 0.15)';
    statusBox.style.border = '1px solid #38bdf8';
    statusBox.style.color = '#7dd3fc';
    statusBox.textContent = '📡 Enviando aviso al teléfono del cliente...';
  }

  try {
    const res = await fetch(`/api/clients/${encodeURIComponent(activeNotifyClientId)}/send-message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, message, playSound })
    });
    const data = await res.json();
    if (data.success) {
      if (statusBox) {
        statusBox.style.background = 'rgba(16, 185, 129, 0.2)';
        statusBox.style.border = '1px solid #10b981';
        statusBox.style.color = '#34d399';
        statusBox.textContent = `🚀 ¡Aviso transmitido con éxito al teléfono de ${client ? client.name : 'cliente'}! Sonará y vibrará en su pantalla.`;
      }
      showAdminToast(`💬 Aviso enviado a ${client ? client.name : 'cliente'}`, true);
      setTimeout(() => {
        closeNotifyModal();
      }, 2500);
    } else {
      if (statusBox) {
        statusBox.style.background = 'rgba(239, 68, 68, 0.2)';
        statusBox.style.border = '1px solid #ef4444';
        statusBox.style.color = '#f87171';
        statusBox.textContent = `Error: ${data.error || 'No se pudo enviar el aviso'}`;
      }
    }
  } catch (err) {
    if (statusBox) {
      statusBox.style.background = 'rgba(239, 68, 68, 0.2)';
      statusBox.style.border = '1px solid #ef4444';
      statusBox.style.color = '#f87171';
      statusBox.textContent = 'Error de conexión con el servidor.';
    }
  }
}

// Resizer interactivo para la barra lateral (arrastrar ancho libremente)
function initSidebarResizer() {
  const handle = document.getElementById('sidebar-drag-handle');
  const sidebar = document.getElementById('sidebar');
  if (!handle || !sidebar) return;

  let isDragging = false;
  let startX = 0;
  let startWidth = 0;

  handle.addEventListener('mousedown', (e) => {
    isDragging = true;
    startX = e.clientX;
    startWidth = sidebar.getBoundingClientRect().width;
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });

  window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const newWidth = Math.max(260, Math.min(650, startWidth + (e.clientX - startX)));
    sidebar.style.width = `${newWidth}px`;
    if (map) map.invalidateSize();
  });

  window.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      handle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      if (map) map.invalidateSize();
    }
  });

  // Doble clic en el borde para plegar o desplegar
  handle.addEventListener('dblclick', () => {
    sidebar.classList.toggle('collapsed');
    setTimeout(() => { if (map) map.invalidateSize(); }, 200);
  });
}
