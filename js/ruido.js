'use strict';
// ══════════════════════════════════════════════════════════════════════════════
// ruido.js — Panel de Ruido: evolución de exposición acústica por hora
//
// Carga el CSV general de ruido (hexágono × hora, RM completo) UNA SOLA VEZ,
// independiente de la empresa/archivo activo en Exposición.
//
// Reusa gpsLayers (ya construido por gps.js) para el selector de ruta.
// Tiene su propio motor de animación: en cada frame, calcula la hora del
// ping actual (desde coord_timestamps) y pinta solo los hexágonos de esa
// hora — se reemplazan al cambiar de hora, sin acumular.
// ══════════════════════════════════════════════════════════════════════════════

let _ruidoData      = [];      // filas del CSV: h3_index, hour, L_rec_dB, P, P_v
let _ruidoByHour    = null;    // Map<hour, Map<h3_index, row>> — indexado para lookup O(1)
let _ruidoLoaded    = false;
let _ruidoLoading   = false;

let _ruidoLayerGrp  = null;    // L.layerGroup con los hexágonos de la hora actual
let _ruidoMap       = null;    // instancia Leaflet propia del sub-tab Ruido
let _ruidoCurrentHour = null;  // última hora pintada (evita redibujar si no cambió)

// Estado de animación propio (independiente de animState en animation.js)
let ruidoAnimState = {
  active:   false,
  progress: 0,
  targetId: null,
  animLayer: null,
  animDot:   null,
  rafId:     null,
  lastTs:    null,
};

// Rango de dB para normalizar la escala de color (se ajusta tras cargar datos)
let _ruidoMinDb = 40;
let _ruidoMaxDb = 80;

// ─── COLOR RAMP — escala de ruido, distinta a personas/hora y H3 impacto ──────
// Verde (silencioso) → amarillo → naranja → rojo (ruidoso)
const RUIDO_RAMP = [
  { t: 0.00, r: 56,  g: 161, b: 105 },  // verde — silencioso
  { t: 0.40, r: 214, g: 197, b: 38  },  // amarillo
  { t: 0.70, r: 230, g: 126, b: 34  },  // naranja
  { t: 1.00, r: 197, g: 48,  b: 48  },  // rojo — ruidoso
];

function _ruidoColor(norm) {
  let lo = RUIDO_RAMP[0], hi = RUIDO_RAMP[RUIDO_RAMP.length - 1];
  for (let i = 1; i < RUIDO_RAMP.length; i++) {
    if (norm <= RUIDO_RAMP[i].t) { lo = RUIDO_RAMP[i - 1]; hi = RUIDO_RAMP[i]; break; }
  }
  const f = (norm - lo.t) / Math.max(hi.t - lo.t, 1e-9);
  return [
    Math.round(lo.r + (hi.r - lo.r) * f),
    Math.round(lo.g + (hi.g - lo.g) * f),
    Math.round(lo.b + (hi.b - lo.b) * f),
  ];
}

function _ruidoCssColor(norm, alpha = 0.6) {
  const [r, g, b] = _ruidoColor(norm);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ─── H3 → LATLNGS (reusa h3-js ya cargado por h3overlay.js) ──────────────────
function _ruidoH3ToLatLngs(hexId) {
  try {
    if (typeof h3 === 'undefined') return null;
    const fn = h3.cellToBoundary || h3.h3ToGeoBoundary;
    return fn ? fn(hexId) : null;
  } catch (e) {
    return null;
  }
}

// ─── CARGA DEL CSV GENERAL (lazy, una sola vez) ──────────────────────────────
async function ruidoEnsureLoaded() {
  if (_ruidoLoaded || _ruidoLoading) return _ruidoLoaded;
  _ruidoLoading = true;

  const status = document.getElementById('ruido-status');
  if (status) status.textContent = '⏳ Cargando datos de ruido (RM)…';

  try {
    const res = await r2Fetch('ruido/hexagonos_hora_rm.csv');
    const csvText = await res.text();

    return new Promise((resolve) => {
      Papa.parse(csvText, {
        header: true,
        dynamicTyping: true,
        skipEmptyLines: true,
        complete({ data: rows }) {
          const required = ['h3_index', 'hour', 'L_rec_dB'];
          const cols = Object.keys(rows[0] || {});
          const missing = required.filter(c => !cols.includes(c));
          if (missing.length) {
            if (status) status.textContent = `✗ Columnas faltantes: ${missing.join(', ')}`;
            _ruidoLoading = false;
            resolve(false);
            return;
          }

          _ruidoData = rows.filter(r => r.h3_index && r.hour != null && r.L_rec_dB != null);

          // Indexar por hora → hexágono para lookup O(1) durante la animación
          _ruidoByHour = new Map();
          _ruidoData.forEach(r => {
            const h = Math.round(r.hour);
            if (!_ruidoByHour.has(h)) _ruidoByHour.set(h, new Map());
            _ruidoByHour.get(h).set(String(r.h3_index), r);
          });

          // Rango global de dB para la escala de color (fijo, no por-hora)
          const dbVals = _ruidoData.map(r => +r.L_rec_dB).filter(v => !isNaN(v));
          _ruidoMinDb = Math.min(...dbVals);
          _ruidoMaxDb = Math.max(...dbVals);

          const nHex = new Set(_ruidoData.map(r => r.h3_index)).size;
          if (status) {
            status.textContent =
              `✓ ${_ruidoData.length.toLocaleString()} registros · ${nHex.toLocaleString()} hexágonos · ` +
              `${_ruidoByHour.size} horas · ${_ruidoMinDb.toFixed(0)}–${_ruidoMaxDb.toFixed(0)} dB(A)`;
          }

          _ruidoLoaded  = true;
          _ruidoLoading = false;
          resolve(true);
        },
        error(e) {
          if (status) status.textContent = '✗ Error al leer CSV: ' + e.message;
          _ruidoLoading = false;
          resolve(false);
        },
      });
    });
  } catch (err) {
    if (status) status.textContent = `✗ Error al cargar: ${err.message}`;
    _ruidoLoading = false;
    return false;
  }
}

// ─── INIT DEL MAPA DE RUIDO (mapa Leaflet propio del sub-tab) ────────────────
function ruidoInitMap() {
  if (_ruidoMap) return;   // ya inicializado

  const container = document.getElementById('map-ruido');
  if (!container) return;

  _ruidoMap = L.map('map-ruido', { zoomControl: true, attributionControl: false, preferCanvas: true });
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    subdomains: 'abcd', maxZoom: 19,
  }).addTo(_ruidoMap);

  // Pane para hexágonos, debajo de las rutas
  const p = _ruidoMap.createPane('ruidoPane');
  p.style.zIndex        = '300';
  p.style.pointerEvents = 'none';
}

// ─── SINCRONIZAR RUTA ACTIVA DESDE EXPOSICIÓN ────────────────────────────────
// Llamado al entrar al sub-tab Ruido o al cambiar de camión en los selectores
// compartidos. Dibuja la ruta completa (estática) y prepara la animación.
function ruidoSyncRoute(busId) {
  if (!_ruidoMap) return;   // sub-tab Ruido aún no se ha abierto — nada que hacer todavía

  // Limpiar capa de ruta anterior si existe
  if (_ruidoRouteLayer) { _ruidoMap.removeLayer(_ruidoRouteLayer); _ruidoRouteLayer = null; }
  ruidoAnimReset();

  const entry = gpsLayers[busId];
  const note  = document.getElementById('ruido-anim-note');

  if (!entry) {
    document.getElementById('map-ruido-empty').style.display = 'flex';
    document.getElementById('map-ruido-wrap').style.display  = 'none';
    return;
  }

  document.getElementById('map-ruido-empty').style.display = 'none';
  document.getElementById('map-ruido-wrap').style.display  = 'block';

  _ruidoRouteLayer = L.polyline(entry.coords, {
    color: entry.color, weight: 3, opacity: 0.5,
  }).addTo(_ruidoMap);

  _ruidoMap.fitBounds(_ruidoRouteLayer.getBounds(), { padding: [30, 30] });

  ruidoAnimState.targetId = busId;
  const p   = entry.feature.properties;
  const oid = p.owner_id ?? busId.split('_')[0];
  const dia = p.dia ?? '';
  if (note) note.textContent = `Camión ${oid} · Día ${dia} · ${entry.coords.length} puntos`;

  // Mostrar el hexágono de la hora inicial inmediatamente (frame 0)
  if (_ruidoLoaded) _ruidoPaintForPoint(entry, 0);
}

let _ruidoRouteLayer = null;

// ─── EXTRAER HORA DESDE coord_timestamps (formato "HH:MM") ───────────────────
function _ruidoHourAtIndex(entry, idx) {
  const ts = entry.feature.properties.coord_timestamps;
  if (!Array.isArray(ts) || !ts[idx]) return null;
  const match = String(ts[idx]).match(/^(\d{1,2}):/);
  return match ? parseInt(match[1], 10) : null;
}

// ─── PINTAR HEXÁGONOS DE LA HORA CORRESPONDIENTE A UN PUNTO DE LA RUTA ───────
function _ruidoPaintForPoint(entry, pointIdx) {
  const hour = _ruidoHourAtIndex(entry, pointIdx);
  if (hour == null) return;
  _ruidoPaintHour(hour);
}

function _ruidoPaintHour(hour) {
  if (hour === _ruidoCurrentHour) return;   // misma hora, no redibujar
  _ruidoCurrentHour = hour;

  if (_ruidoLayerGrp && _ruidoMap) { _ruidoMap.removeLayer(_ruidoLayerGrp); _ruidoLayerGrp = null; }
  if (!_ruidoByHour || !_ruidoByHour.has(hour)) {
    _ruidoUpdateHourBadge(hour, 0);
    return;
  }

  const hexMap = _ruidoByHour.get(hour);
  _ruidoLayerGrp = L.layerGroup();

  hexMap.forEach((row, hexId) => {
    const latlngs = _ruidoH3ToLatLngs(hexId);
    if (!latlngs) return;

    const db    = +row.L_rec_dB || 0;
    const range = Math.max(_ruidoMaxDb - _ruidoMinDb, 1);
    const norm  = Math.max(0, Math.min(1, (db - _ruidoMinDb) / range));
    const fill  = _ruidoCssColor(norm, 0.55);
    const stroke = _ruidoCssColor(norm, 0.85);

    const poly = L.polygon(latlngs, {
      fillColor: fill, fillOpacity: 1, color: stroke, weight: 1,
      interactive: false, pane: 'ruidoPane',
    });
    _ruidoLayerGrp.addLayer(poly);
  });

  _ruidoLayerGrp.addTo(_ruidoMap);
  _ruidoUpdateHourBadge(hour, hexMap.size);
}

function _ruidoUpdateHourBadge(hour, nHex) {
  const badge = document.getElementById('ruido-hour-badge');
  const text  = document.getElementById('ruido-hour-badge-text');
  if (text)  text.textContent  = `${String(hour).padStart(2,'0')}:00 h · ${nHex.toLocaleString()} hexágonos`;
  if (badge) badge.style.display = 'flex';
}

// ─── MOTOR DE ANIMACIÓN PROPIO DEL PANEL RUIDO ───────────────────────────────
function ruidoAnimPlay() {
  if (!_ruidoLoaded) {
    document.getElementById('ruido-anim-note').textContent = '⏳ Cargando datos de ruido…';
    ruidoEnsureLoaded().then(ok => { if (ok) ruidoAnimPlay(); });
    return;
  }

  if (ruidoAnimState.active) {
    ruidoAnimState.active = false;
    cancelAnimationFrame(ruidoAnimState.rafId);
    document.getElementById('ruido-anim-icon-play').style.display  = '';
    document.getElementById('ruido-anim-icon-pause').style.display = 'none';
    return;
  }

  const targetId = ruidoAnimState.targetId;
  if (!targetId || !gpsLayers[targetId]) {
    document.getElementById('ruido-anim-note').textContent = '⚠ Selecciona un camión en la pestaña Exposición';
    return;
  }

  ruidoAnimState.active = true;
  ruidoAnimState.lastTs = null;
  if (ruidoAnimState.progress >= 1) ruidoAnimState.progress = 0;

  document.getElementById('ruido-anim-icon-play').style.display  = 'none';
  document.getElementById('ruido-anim-icon-pause').style.display = '';

  const entry = gpsLayers[targetId];
  if (_ruidoRouteLayer) { _ruidoMap.removeLayer(_ruidoRouteLayer); _ruidoRouteLayer = null; }

  if (!ruidoAnimState.animLayer) {
    ruidoAnimState.animLayer = L.polyline([], {
      color: entry.color, weight: 4, opacity: 1, smoothFactor: 1,
    }).addTo(_ruidoMap);
  }
  if (!ruidoAnimState.animDot) {
    ruidoAnimState.animDot = L.circleMarker(entry.coords[0], {
      radius: 7, fillColor: entry.color, fillOpacity: 1, color: '#fff', weight: 2,
    }).addTo(_ruidoMap);
  }

  ruidoAnimState.rafId = requestAnimationFrame(ruidoAnimFrame);
}

function ruidoAnimFrame(ts) {
  if (!ruidoAnimState.active) return;

  if (ruidoAnimState.lastTs === null) {
    ruidoAnimState.lastTs = ts;
    ruidoAnimState.rafId  = requestAnimationFrame(ruidoAnimFrame);
    return;
  }

  const dt = Math.min((ts - ruidoAnimState.lastTs) / 1000, 0.1);
  ruidoAnimState.lastTs = ts;

  const speedSel = document.getElementById('ruido-anim-speed');
  const speed    = speedSel ? parseFloat(speedSel.value) : 1;
  const entry    = gpsLayers[ruidoAnimState.targetId];
  const coords   = entry.coords;
  const n        = coords.length;

  ruidoAnimState.progress = Math.min(1, ruidoAnimState.progress + speed * dt / 20);

  const shown = Math.max(2, Math.floor(ruidoAnimState.progress * (n - 1)) + 1);
  ruidoAnimState.animLayer.setLatLngs(coords.slice(0, shown));
  ruidoAnimState.animDot.setLatLng(coords[shown - 1]);

  const pct = (ruidoAnimState.progress * 100).toFixed(0);
  document.getElementById('ruido-anim-fill').style.width  = pct + '%';
  document.getElementById('ruido-anim-thumb').style.left  = pct + '%';
  document.getElementById('ruido-anim-label').textContent = pct + '%';

  // Pintar hexágonos de la hora correspondiente al punto actual
  _ruidoPaintForPoint(entry, shown - 1);

  if (ruidoAnimState.progress >= 1) {
    ruidoAnimState.active = false;
    document.getElementById('ruido-anim-icon-play').style.display  = '';
    document.getElementById('ruido-anim-icon-pause').style.display = 'none';
    document.getElementById('ruido-anim-note').textContent = '✓ Recorrido completo';
    return;
  }

  ruidoAnimState.rafId = requestAnimationFrame(ruidoAnimFrame);
}

function ruidoAnimReset() {
  ruidoAnimState.active   = false;
  ruidoAnimState.progress = 0;
  if (ruidoAnimState.rafId) cancelAnimationFrame(ruidoAnimState.rafId);
  if (ruidoAnimState.animLayer && _ruidoMap) { _ruidoMap.removeLayer(ruidoAnimState.animLayer); ruidoAnimState.animLayer = null; }
  if (ruidoAnimState.animDot   && _ruidoMap) { _ruidoMap.removeLayer(ruidoAnimState.animDot);   ruidoAnimState.animDot   = null; }

  // Restaurar línea estática de la ruta
  if (ruidoAnimState.targetId && gpsLayers[ruidoAnimState.targetId] && _ruidoMap) {
    const entry = gpsLayers[ruidoAnimState.targetId];
    _ruidoRouteLayer = L.polyline(entry.coords, { color: entry.color, weight: 3, opacity: 0.5 }).addTo(_ruidoMap);
  }

  if (_ruidoLayerGrp && _ruidoMap) { _ruidoMap.removeLayer(_ruidoLayerGrp); _ruidoLayerGrp = null; }
  _ruidoCurrentHour = null;

  const badge = document.getElementById('ruido-hour-badge');
  if (badge) badge.style.display = 'none';

  const _fill  = document.getElementById('ruido-anim-fill');
  const _thumb = document.getElementById('ruido-anim-thumb');
  const _label = document.getElementById('ruido-anim-label');
  const _play  = document.getElementById('ruido-anim-icon-play');
  const _pause = document.getElementById('ruido-anim-icon-pause');
  if (_fill)  _fill.style.width    = '0%';
  if (_thumb) _thumb.style.left    = '0%';
  if (_label) _label.textContent   = '0%';
  if (_play)  _play.style.display  = '';
  if (_pause) _pause.style.display = 'none';

  // Repintar hora inicial
  if (ruidoAnimState.targetId && gpsLayers[ruidoAnimState.targetId] && _ruidoLoaded) {
    _ruidoPaintForPoint(gpsLayers[ruidoAnimState.targetId], 0);
  }
}

// ─── LEYENDA ──────────────────────────────────────────────────────────────────
function _ruidoUpdateLegend() {
  let leg = document.getElementById('ruido-legend');
  if (!leg) {
    leg = document.createElement('div');
    leg.id = 'ruido-legend';
    leg.style.cssText = [
      'position:absolute','bottom:80px','left:12px','z-index:500',
      'background:var(--surface)','border:1px solid var(--border)',
      'border-radius:4px','padding:8px 12px',
      'font-family:Syne Mono,monospace','font-size:9px',
      'color:var(--muted)','min-width:140px','pointer-events:none',
    ].join(';');
    document.getElementById('map-ruido')?.appendChild(leg);
  }

  const gradStops = RUIDO_RAMP
    .map(s => `rgb(${s.r},${s.g},${s.b}) ${(s.t * 100).toFixed(0)}%`)
    .join(',');

  leg.innerHTML = `
    <div style="letter-spacing:0.1em;text-transform:uppercase;margin-bottom:5px">
      Nivel de ruido
    </div>
    <div style="height:8px;border-radius:2px;background:linear-gradient(to right,${gradStops});margin-bottom:4px"></div>
    <div style="display:flex;justify-content:space-between">
      <span>${_ruidoMinDb.toFixed(0)} dB</span><span>${_ruidoMaxDb.toFixed(0)} dB</span>
    </div>`;
}

// ─── ENTRADA AL SUB-TAB RUIDO (llamado desde switchSubTab) ───────────────────
async function ruidoOnTabEnter() {
  ruidoInitMap();
  setTimeout(() => _ruidoMap && _ruidoMap.invalidateSize(), 80);

  const ok = await ruidoEnsureLoaded();
  if (ok) _ruidoUpdateLegend();

  // Sincronizar con el camión actualmente seleccionado en Exposición
  const busSel = document.getElementById('gps-bus-sel');
  const currentBusId = busSel && busSel.value !== 'all' ? busSel.value : null;
  if (currentBusId) {
    ruidoSyncRoute(currentBusId);
  } else {
    // Buscar la primera ruta visible como fallback
    const firstId = Object.keys(gpsLayers || {})[0];
    if (firstId) ruidoSyncRoute(firstId);
  }
}
