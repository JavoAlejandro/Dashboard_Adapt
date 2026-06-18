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
          _ruidoBuildPercentileIndex();   // construir índice de percentil una sola vez
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

  // ── Limpieza completa de TODO lo relacionado a la ruta anterior ────────────
  // Importante: limpiar ANTES de tocar ruidoAnimState.targetId, porque
  // ruidoAnimReset() usa targetId para decidir qué restaurar.
  if (ruidoAnimState.rafId) cancelAnimationFrame(ruidoAnimState.rafId);
  ruidoAnimState.active   = false;
  ruidoAnimState.progress = 0;
  if (ruidoAnimState.animLayer && _ruidoMap) { _ruidoMap.removeLayer(ruidoAnimState.animLayer); ruidoAnimState.animLayer = null; }
  if (ruidoAnimState.animDot   && _ruidoMap) { _ruidoMap.removeLayer(ruidoAnimState.animDot);   ruidoAnimState.animDot   = null; }
  if (_ruidoRouteLayer && _ruidoMap) { _ruidoMap.removeLayer(_ruidoRouteLayer); _ruidoRouteLayer = null; }
  if (_ruidoLayerGrp   && _ruidoMap) { _ruidoMap.removeLayer(_ruidoLayerGrp);   _ruidoLayerGrp   = null; }
  _ruidoCurrentHour      = null;
  _ruidoHexEnVentana     = null;
  ruidoAnimState.targetId = null;   // limpiar referencia ANTES de resetear UI

  // Resetear controles de animación (botones, barra de progreso, badges)
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
  const badge = document.getElementById('ruido-hour-badge');
  if (badge) badge.style.display = 'none';
  const winBadge = document.getElementById('ruido-window-badge');
  if (winBadge) winBadge.style.display = 'none';

  const entry = gpsLayers[busId];
  const note  = document.getElementById('ruido-anim-note');

  if (!entry) {
    document.getElementById('map-ruido-empty').style.display = 'flex';
    document.getElementById('map-ruido-wrap').style.display  = 'none';
    document.getElementById('ruido-side-stats').style.display = 'none';
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

  // Precalcular hexágonos dentro del radio de la ruta (corredor de ruido relevante)
  if (_ruidoLoaded) {
    // Renderizar panel inmediatamente (sin ventana como fallback)
    _ruidoRenderStatsPanel(entry);
    // Luego calcular ventana y re-renderizar con valores precisos por tramo horario
    _ruidoComputarVentana(entry);
    _ruidoRenderStatsPanel(entry);
  } else {
    document.getElementById('ruido-side-stats').style.display = 'none';
  }

  // Mostrar el hexágono de la hora inicial inmediatamente (frame 0)
  if (_ruidoLoaded) _ruidoPaintForPoint(entry, 0);
}

let _ruidoRouteLayer = null;

// ─── VENTANA DE RADIO ALREDEDOR DE LA RUTA ────────────────────────────────────
const RUIDO_RADIO_KM_DEFAULT = 0.4;   // 400 metros por defecto
let _ruidoRadioKm        = RUIDO_RADIO_KM_DEFAULT;
let _ruidoHexEnVentana   = null;    // Set<h3_index> precomputado para la ruta activa

function _ruidoHaversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) ** 2 +
            Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) *
            Math.sin(dLon/2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Centro de cada hexágono — cacheado para no recalcular con h3-js cada vez
const _ruidoHexCentroCache = new Map();
function _ruidoHexCentro(hexId) {
  if (_ruidoHexCentroCache.has(hexId)) return _ruidoHexCentroCache.get(hexId);
  try {
    const fn = h3.cellToLatLng || h3.h3ToGeo;
    const c  = fn ? fn(hexId) : null;   // [lat, lng]
    _ruidoHexCentroCache.set(hexId, c);
    return c;
  } catch (e) {
    _ruidoHexCentroCache.set(hexId, null);
    return null;
  }
}

let _ruidoVentanaPorHora = null;   // Map<hora, Set<h3_index>> — ventana específica de cada hora

// Agrupa los índices de coords/timestamps de la ruta por hora del ping.
// Retorna Map<hora, [coords...]> — solo los pings (lat,lon) que ocurrieron en esa hora.
function _ruidoAgruparPingsPorHora(entry) {
  const ts     = entry.feature.properties.coord_timestamps || [];
  const coords = entry.coords;
  const porHora = new Map();

  for (let i = 0; i < coords.length; i++) {
    const t = ts[i];
    if (!t) continue;
    const m = String(t).match(/^(\d{1,2}):/);
    if (!m) continue;
    const hour = parseInt(m[1], 10);
    if (!porHora.has(hour)) porHora.set(hour, []);
    porHora.get(hour).push(coords[i]);
  }
  return porHora;
}

// Precalcula, PARA CADA HORA del recorrido, el set de hexágonos dentro del
// radio respecto a los pings que ocurrieron específicamente en esa hora
// (no respecto a la ruta completa). Esto evita que una hora "contamine"
// el promedio con tramos de la ruta que el camión aún no había recorrido.
function _ruidoComputarVentana(entry) {
  _ruidoVentanaPorHora = null;
  _ruidoHexEnVentana   = null;   // se mantiene por compatibilidad, ver nota abajo
  if (!_ruidoLoaded || !entry) return;

  const pingsPorHora = _ruidoAgruparPingsPorHora(entry);
  if (pingsPorHora.size === 0) return;

  // Todos los hexágonos únicos presentes en el dataset de ruido (universo de búsqueda)
  const todosHex = new Set();
  _ruidoByHour.forEach(hexMap => hexMap.forEach((_, hexId) => todosHex.add(hexId)));

  _ruidoVentanaPorHora = new Map();
  let totalEnAlgunaHora = new Set();

  pingsPorHora.forEach((pingsHora, hour) => {
    // Submuestrear: con tramos de 1 hora normalmente hay pocos pings, pero
    // por seguridad limitamos a ~40 puntos representativos del tramo.
    const step = Math.max(1, Math.floor(pingsHora.length / 40));
    const muestra = [];
    for (let i = 0; i < pingsHora.length; i += step) muestra.push(pingsHora[i]);

    const dentro = new Set();
    todosHex.forEach(hexId => {
      const centro = _ruidoHexCentro(hexId);
      if (!centro) return;
      const [hLat, hLon] = centro;
      const cerca = muestra.some(([lat, lon]) =>
        _ruidoHaversineKm(lat, lon, hLat, hLon) <= _ruidoRadioKm
      );
      if (cerca) dentro.add(hexId);
    });

    _ruidoVentanaPorHora.set(hour, dentro);
    dentro.forEach(h => totalEnAlgunaHora.add(h));
  });

  // _ruidoHexEnVentana ahora representa la UNIÓN de todas las horas — se usa
  // solo como fallback si alguna función vieja lo consulta directamente.
  _ruidoHexEnVentana = totalEnAlgunaHora;

  const badge = document.getElementById('ruido-window-badge');
  if (badge) {
    badge.textContent = `Ventana: ${_ruidoRadioKm} km · ${totalEnAlgunaHora.size.toLocaleString()} hexágonos en corredor (todas las horas)`;
    badge.style.display = 'block';
  }
}

function ruidoSetRadioKm(km) {
  _ruidoRadioKm = parseFloat(km) || RUIDO_RADIO_KM_DEFAULT;
  // Recalcular ventana para la ruta activa y repintar la hora actual
  const entry = gpsLayers[ruidoAnimState.targetId];
  if (entry) {
    _ruidoComputarVentana(entry);
    _ruidoRenderStatsPanel(entry);
    const hourActual = _ruidoCurrentHour;
    _ruidoCurrentHour = null;   // forzar repintado aunque sea la misma hora
    if (hourActual != null) _ruidoPaintHour(hourActual);
  }
}

// ─── DATOS DE CAMIÓN HORA (segundo CSV, lazy) ─────────────────────────────────
// ruido/camion_hora_rm.csv → R, R_v por account_id × owner_id × arc_id × hour
// Se carga la primera vez que se necesita (al renderizar el panel de stats).
let _camionData      = null;   // Map<owner_id, Map<hour, {R, R_v}>> — sumados por hora
let _camionLoaded    = false;
let _camionLoading   = false;

async function _ruidoEnsureCamionLoaded() {
  if (_camionLoaded || _camionLoading) return _camionLoaded;
  _camionLoading = true;
  try {
    const res     = await r2Fetch('ruido/camion_hora_rm.csv');
    const csvText = await res.text();
    return new Promise(resolve => {
      Papa.parse(csvText, {
        header: true, dynamicTyping: true, skipEmptyLines: true,
        complete({ data: rows }) {
          // Agregar R y R_v por owner_id × hour (sumando todos los arcos)
          _camionData = new Map();
          rows.forEach(r => {
            const oid  = String(r.owner_id  ?? '');
            const hour = Math.round(+r.hour);
            if (!oid || isNaN(hour)) return;
            if (!_camionData.has(oid)) _camionData.set(oid, new Map());
            const hMap = _camionData.get(oid);
            const prev = hMap.get(hour) || { R: 0, R_v: 0 };
            hMap.set(hour, { R: prev.R + (+r.R || 0), R_v: prev.R_v + (+r.R_v || 0) });
          });
          _camionLoaded  = true;
          _camionLoading = false;
          resolve(true);
        },
        error() { _camionLoading = false; resolve(false); },
      });
    });
  } catch {
    _camionLoading = false;
    return false;
  }
}

// Obtiene R y R_v totales del camión sumando todas las horas del recorrido.
function _ruidoGetPersonasAlcanzadas(entry) {
  if (!_camionData) return null;
  const oid  = String(entry.feature.properties.owner_id ?? '');
  const hMap = _camionData.get(oid);
  if (!hMap) return null;

  // Horas que cubre la ruta
  const ts = entry.feature.properties.coord_timestamps || [];
  const horasRuta = new Set();
  ts.forEach(t => {
    const m = t && String(t).match(/^(\d{1,2}):/);
    if (m) horasRuta.add(parseInt(m[1], 10));
  });

  let totalR = 0, totalRv = 0;
  horasRuta.forEach(h => {
    const d = hMap.get(h);
    if (d) { totalR += d.R; totalRv += d.R_v; }
  });
  return totalR > 0 ? { R: Math.round(totalR), R_v: Math.round(totalRv) } : null;
}

// ─── PERCENTIL EN LA RM (calculado una sola vez tras cargar hexágonos_hora) ───
let _ruidoDbSorted = null;   // Float64Array ordenado de todos los L_rec_dB de la RM

function _ruidoBuildPercentileIndex() {
  if (_ruidoDbSorted || !_ruidoData.length) return;
  const vals = _ruidoData.map(r => +r.L_rec_dB).filter(v => !isNaN(v));
  _ruidoDbSorted = new Float64Array(vals).sort();
}

function _ruidoPercentil(db) {
  if (!_ruidoDbSorted) return null;
  const n = _ruidoDbSorted.length;
  let lo = 0, hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (_ruidoDbSorted[mid] <= db) lo = mid + 1; else hi = mid;
  }
  return Math.round((lo / n) * 100);
}

// ─── BANDAS DE RUIDO + REFERENTES ─────────────────────────────────────────────
const RUIDO_BANDAS = [
  { label: 'Bajo',      ref: 'zona residencial tranquila',          min: 0,  max: 55, color: '#2C9E5B' },
  { label: 'Moderado',  ref: 'conversación normal',                 min: 55, max: 65, color: '#E8B53A' },
  { label: 'Alto',      ref: 'tráfico urbano fluido',               min: 65, max: 75, color: '#F5862A' },
  { label: 'Muy alto',  ref: 'tráfico intenso de una avenida',      min: 75, max: 85, color: '#E03131' },
  { label: 'Extremo',   ref: 'cerca de una autopista congestionada', min: 85, max: 999, color: '#7A1631' },
];
const RUIDO_OMS_DB = 53;

function _ruidoBanda(db) {
  return RUIDO_BANDAS.find(b => db >= b.min && db < b.max) || RUIDO_BANDAS[RUIDO_BANDAS.length - 1];
}

// ─── PANEL LATERAL — REDISEÑADO SEGÚN MOCKUP ──────────────────────────────────
function _ruidoRenderStatsPanel(entry) {
  const panel = document.getElementById('ruido-side-stats');
  if (!panel) return;

  const stats = _ruidoCalcularEstadisticas(entry);
  if (!stats || stats.avgGlobal == null) { panel.style.display = 'none'; return; }
  panel.style.display = 'flex';

  const db    = stats.avgGlobal;
  const banda = _ruidoBanda(db);
  const pct   = _ruidoPercentil(db);
  const p     = entry.feature.properties;
  const oid   = p.owner_id ?? '';
  const dia   = p.dia ?? '';
  const mes   = p.mes ?? '';
  const personas = _ruidoGetPersonasAlcanzadas(entry);

  // Gradiente de la barra de bandas para el track del percentil
  const bandGrad = RUIDO_BANDAS.map((b, i) => {
    const pctStart = (i / RUIDO_BANDAS.length * 100).toFixed(0);
    return `${b.color} ${pctStart}%`;
  }).join(',');

  // Desglose por hora (plegado, detalle técnico)
  const validHoras = stats.porHora.filter(h => h.avgDb != null);
  const minH = validHoras.length ? validHoras.reduce((a, b) => a.avgDb < b.avgDb ? a : b) : null;
  const maxH = validHoras.length ? validHoras.reduce((a, b) => a.avgDb > b.avgDb ? a : b) : null;

  const horasHtml = stats.porHora.map(h => {
    const norm  = h.avgDb != null ? Math.max(0, Math.min(1, (h.avgDb - _ruidoMinDb) / Math.max(_ruidoMaxDb - _ruidoMinDb, 1))) : 0;
    const color = h.avgDb != null ? _ruidoCssColor(norm, 0.9) : 'var(--border)';
    const txt   = h.avgDb != null ? `${h.avgDb.toFixed(1)} dB(A)` : 'sin datos';
    return `<li style="display:flex;align-items:center;gap:8px;font-family:'Syne Mono',monospace;font-size:10px;padding:4px 0;border-bottom:1px solid var(--border)">
      <span style="width:34px;color:var(--muted)">${String(h.hour).padStart(2,'0')}:00</span>
      <span style="width:8px;height:8px;border-radius:50%;background:${color};flex-shrink:0"></span>
      <span style="color:var(--ink)">${txt}</span>
    </li>`;
  }).join('');

  panel.innerHTML = `
    <!-- Contexto -->
    <div style="font-family:'Syne Mono',monospace;font-size:10px;color:var(--muted);margin-bottom:14px;letter-spacing:0.04em">
      Camión ${oid} · Día ${dia}${mes ? ' · Mes ' + mes : ''}
    </div>

    <!-- ① Personas alcanzadas -->
    <div style="position:relative;margin-bottom:20px;padding-bottom:20px;border-bottom:1px solid var(--border)">
      <span style="position:absolute;left:-8px;top:-4px;width:20px;height:20px;border-radius:50%;
                   background:var(--ink);color:var(--bg);font-family:'Syne',sans-serif;font-size:11px;
                   font-weight:700;display:flex;align-items:center;justify-content:center">1</span>
      ${personas ? `
        <div style="font-family:'Syne',sans-serif;font-weight:800;font-size:36px;line-height:1.05;color:var(--ink)">
          ≈ ${personas.R.toLocaleString()} <span style="font-size:14px;font-weight:600;color:var(--muted)">personas</span>
        </div>
        <div style="font-family:'Syne',sans-serif;font-size:11px;color:var(--muted);margin-top:2px">
          alcanzadas por el ruido de este recorrido
        </div>
        <div style="font-family:'Syne',sans-serif;font-size:12px;margin-top:6px;color:var(--ink)">
          de ellas, <strong style="color:#E03131">≈ ${personas.R_v.toLocaleString()} vulnerables</strong>
        </div>
      ` : `
        <div style="font-family:'Syne Mono',monospace;font-size:10px;color:var(--muted);padding:8px 0">
          Sin datos de personas para este camión en este período
        </div>
      `}
    </div>

    <!-- ② Banda de ruido -->
    <div style="position:relative;margin-bottom:20px;padding-bottom:20px;border-bottom:1px solid var(--border)">
      <span style="position:absolute;left:-8px;top:-4px;width:20px;height:20px;border-radius:50%;
                   background:var(--ink);color:var(--bg);font-family:'Syne',sans-serif;font-size:11px;
                   font-weight:700;display:flex;align-items:center;justify-content:center">2</span>
      <div style="background:${banda.color};border-radius:8px;padding:12px 14px;color:#fff;
                  display:flex;align-items:center;justify-content:space-between;margin-top:4px">
        <div>
          <div style="font-family:'Syne',sans-serif;font-weight:800;font-size:17px;letter-spacing:0.5px">
            ${banda.label.toUpperCase()}
          </div>
          <div style="font-family:'Syne',sans-serif;font-size:11px;opacity:0.9;margin-top:2px">
            como ${banda.ref}
          </div>
        </div>
        <div style="text-align:right">
          <div style="font-family:'Syne',sans-serif;font-size:18px;font-weight:700">${db.toFixed(1)}</div>
          <div style="font-size:9px;letter-spacing:1px;opacity:0.85">dB(A)</div>
        </div>
      </div>
    </div>

    <!-- ③ Posición en la RM -->
    ${pct != null ? `
    <div style="position:relative;margin-bottom:20px;padding-bottom:20px;border-bottom:1px solid var(--border)">
      <span style="position:absolute;left:-8px;top:-4px;width:20px;height:20px;border-radius:50%;
                   background:var(--ink);color:var(--bg);font-family:'Syne',sans-serif;font-size:11px;
                   font-weight:700;display:flex;align-items:center;justify-content:center">3</span>
      <div style="font-family:'Syne',sans-serif;font-size:12px;color:var(--ink);margin-top:4px;margin-bottom:8px">
        Más ruidoso que el <strong>${pct}%</strong> de la Región Metropolitana
      </div>
      <div style="position:relative;height:10px;border-radius:6px;
                  background:linear-gradient(90deg,${bandGrad})">
        <div style="position:absolute;top:-4px;left:${pct}%;transform:translateX(-50%);
                    width:3px;height:18px;background:var(--ink);border-radius:2px;
                    box-shadow:0 0 0 2px #fff"></div>
      </div>
      <div style="display:flex;justify-content:space-between;font-family:'Syne Mono',monospace;
                  font-size:9px;color:var(--muted);margin-top:5px">
        <span>silencioso</span><span>ruidoso</span>
      </div>
    </div>` : ''}

    <!-- ④ Referencia OMS -->
    <div style="position:relative;margin-bottom:20px;padding-bottom:20px;border-bottom:1px solid var(--border)">
      <span style="position:absolute;left:-8px;top:-4px;width:20px;height:20px;border-radius:50%;
                   background:var(--ink);color:var(--bg);font-family:'Syne',sans-serif;font-size:11px;
                   font-weight:700;display:flex;align-items:center;justify-content:center">4</span>
      <div style="font-family:'Syne',sans-serif;font-size:12px;color:#374151;
                  background:#F1F4F8;border-radius:8px;padding:10px 12px;margin-top:4px">
        <strong style="color:var(--ink)">Umbral de salud OMS (tráfico): ${RUIDO_OMS_DB} dB.</strong>
        Este recorrido lo supera${pct != null ? `, igual que el ${pct}% de la RM` : ''}.
        <span style="color:var(--muted)"> (La OMS usa un promedio diario a fachada; es una referencia, no una comparación exacta.)</span>
      </div>
    </div>

    <!-- Escala de bandas -->
    <div style="margin-bottom:16px">
      <div style="font-family:'Syne Mono',monospace;font-size:9px;letter-spacing:0.1em;
                  text-transform:uppercase;color:var(--muted);margin-bottom:8px">Escala de bandas</div>
      ${RUIDO_BANDAS.map(b => `
        <div style="display:flex;align-items:center;gap:8px;font-family:'Syne',sans-serif;
                    font-size:11px;padding:3px 0;color:#374151">
          <span style="width:13px;height:13px;border-radius:3px;background:${b.color};flex:0 0 auto"></span>
          <span>${b.label}</span>
          <span style="color:var(--muted);font-size:10px">${b.min}${b.max < 999 ? '–' + b.max : '+'}dB</span>
        </div>`).join('')}
    </div>

    <!-- Detalle técnico por hora (plegado) -->
    ${validHoras.length ? `
    <details style="margin-top:4px">
      <summary style="font-family:'Syne Mono',monospace;font-size:9px;letter-spacing:0.08em;
                      text-transform:uppercase;color:var(--muted);cursor:pointer;user-select:none;
                      list-style:none;display:flex;align-items:center;gap:6px">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"
             style="width:11px;height:11px"><path d="M4 6l4 4 4-4"/></svg>
        Detalle técnico por hora
        ${minH ? `· ${String(minH.hour).padStart(2,'0')}h–${String(maxH.hour).padStart(2,'0')}h` : ''}
      </summary>
      <ol style="list-style:none;margin:8px 0 0 0;padding:0">${horasHtml}</ol>
    </details>` : ''}
  `;
}

function _ruidoCalcularEstadisticas(entry) {
  if (!_ruidoLoaded || !_ruidoByHour) return null;

  const ts = entry.feature.properties.coord_timestamps || [];
  const horasRuta = new Set();
  ts.forEach(t => {
    if (!t) return;
    const m = String(t).match(/^(\d{1,2}):/);
    if (m) horasRuta.add(parseInt(m[1], 10));
  });

  if (horasRuta.size === 0) return null;

  const porHora = [];
  let sumaTotal = 0, nTotal = 0;

  Array.from(horasRuta).sort((a, b) => a - b).forEach(hour => {
    const hexMapFull  = _ruidoByHour.get(hour);
    // Si _ruidoVentanaPorHora existe y tiene datos para esta hora → filtrar
    // Si no → usar TODOS los hexágonos de esta hora (fallback sin ventana)
    const ventanaHora = _ruidoVentanaPorHora?.get(hour);
    const usarVentana = ventanaHora && ventanaHora.size > 0;

    if (!hexMapFull) { porHora.push({ hour, avgDb: null, nHex: 0 }); return; }

    const dbVals = [];
    hexMapFull.forEach((row, hexId) => {
      if (!usarVentana || ventanaHora.has(hexId)) {
        const db = +row.L_rec_dB;
        if (!isNaN(db)) dbVals.push(db);
      }
    });

    if (dbVals.length) {
      const avg = dbVals.reduce((a, b) => a + b, 0) / dbVals.length;
      porHora.push({ hour, avgDb: avg, nHex: dbVals.length });
      sumaTotal += dbVals.reduce((a, b) => a + b, 0);
      nTotal    += dbVals.length;
    } else {
      porHora.push({ hour, avgDb: null, nHex: 0 });
    }
  });

  const avgGlobal = nTotal > 0 ? sumaTotal / nTotal : null;
  return { avgGlobal, porHora, nMuestras: nTotal };
}

function _ruidoRenderStatsPanel(entry) {
  const panel = document.getElementById('ruido-side-stats');
  if (!panel) { console.warn('[RUIDO] ruido-side-stats no encontrado en DOM'); return; }

  const stats = _ruidoCalcularEstadisticas(entry);
  console.log('[RUIDO] stats:', stats,
    '| _ruidoLoaded:', _ruidoLoaded,
    '| _camionLoaded:', _camionLoaded,
    '| ts sample:', (entry.feature.properties.coord_timestamps || []).slice(0,3),
    '| ventanaPorHora:', _ruidoVentanaPorHora ? _ruidoVentanaPorHora.size + ' horas' : 'null'
  );

  if (!stats || stats.avgGlobal == null) {
    console.warn('[RUIDO] stats null o avgGlobal null — panel oculto');
    panel.style.display = 'none';
    return;
  }
  panel.style.display = 'flex';

  // Total destacado
  const avgEl    = document.getElementById('ruido-avg-db');
  const avgSubEl = document.getElementById('ruido-avg-db-sub');
  if (avgEl)    avgEl.textContent    = stats.avgGlobal.toFixed(1) + ' dB(A)';
  if (avgSubEl) avgSubEl.textContent = `Promedio ponderado por tramo horario (${_ruidoRadioKm} km de radio) · ${stats.nMuestras.toLocaleString()} muestras hexágono-hora`;

  // Identidad del camión
  const p   = entry.feature.properties;
  const oid = p.owner_id ?? '';
  const dia = p.dia ?? '';
  const mes = p.mes ?? '';
  const titleEl = document.getElementById('ruido-bsp-title');
  const subEl   = document.getElementById('ruido-bsp-sub');
  if (titleEl) titleEl.textContent = `Camión ${oid} · Día ${dia}`;
  if (subEl)   subEl.textContent   = mes ? `Mes ${mes}` : '';

  // Cards: mínimo / máximo del recorrido
  const validHoras = stats.porHora.filter(h => h.avgDb != null);
  const cardsEl = document.getElementById('ruido-bsp-cards');
  if (cardsEl && validHoras.length) {
    const minH = validHoras.reduce((a, b) => a.avgDb < b.avgDb ? a : b);
    const maxH = validHoras.reduce((a, b) => a.avgDb > b.avgDb ? a : b);
    cardsEl.innerHTML = `
      <div class="gss-card">
        <div class="gss-card-dot" style="background:#38a169"></div>
        <span class="gss-card-lbl">Hora más silenciosa</span>
        <span class="gss-card-val">${String(minH.hour).padStart(2,'0')}h · ${minH.avgDb.toFixed(1)}dB</span>
      </div>
      <div class="gss-card">
        <div class="gss-card-dot" style="background:#c53030"></div>
        <span class="gss-card-lbl">Hora más ruidosa</span>
        <span class="gss-card-val">${String(maxH.hour).padStart(2,'0')}h · ${maxH.avgDb.toFixed(1)}dB</span>
      </div>
      <div class="gss-card">
        <div class="gss-card-dot" style="background:var(--accent)"></div>
        <span class="gss-card-lbl">Horas con datos</span>
        <span class="gss-card-val">${validHoras.length} / ${stats.porHora.length}</span>
      </div>`;
  }

  // Desglose por hora
  const horasWrap = document.getElementById('ruido-horas-wrap');
  const horasList = document.getElementById('ruido-horas-list');
  if (horasWrap && horasList) {
    if (stats.porHora.length) {
      horasWrap.style.display = 'block';
      horasList.innerHTML = stats.porHora.map(h => {
        const norm  = h.avgDb != null ? Math.max(0, Math.min(1, (h.avgDb - _ruidoMinDb) / Math.max(_ruidoMaxDb - _ruidoMinDb, 1))) : 0;
        const color = h.avgDb != null ? _ruidoCssColor(norm, 0.9) : 'var(--border)';
        const txt   = h.avgDb != null ? `${h.avgDb.toFixed(1)} dB(A)` : 'sin datos';
        return `<li style="display:flex;align-items:center;gap:8px;font-family:'Syne Mono',monospace;font-size:10px;padding:4px 0">
          <span style="width:34px;color:var(--muted)">${String(h.hour).padStart(2,'0')}:00</span>
          <span style="width:8px;height:8px;border-radius:50%;background:${color};flex-shrink:0"></span>
          <span style="color:var(--ink)">${txt}</span>
        </li>`;
      }).join('');
    } else {
      horasWrap.style.display = 'none';
    }
  }
}

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

  const hexMapFull = _ruidoByHour.get(hour);
  _ruidoLayerGrp = L.layerGroup();

  // Filtrar solo hexágonos dentro de la ventana de ESTA hora específica
  // (los pings que realmente ocurrieron entre HH:00 y HH:59), no de toda la ruta.
  const ventanaHora = _ruidoVentanaPorHora ? _ruidoVentanaPorHora.get(hour) : null;
  const hexMap = ventanaHora
    ? new Map([...hexMapFull].filter(([hexId]) => ventanaHora.has(hexId)))
    : hexMapFull;

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

  // Mostrar mapa inmediatamente con lo que haya seleccionado
  const targetIdInicial = _ruidoResolveSingleId();
  if (targetIdInicial && gpsLayers[targetIdInicial]) {
    ruidoSyncRoute(targetIdInicial);
  } else {
    document.getElementById('map-ruido-empty').style.display = 'flex';
    document.getElementById('map-ruido-wrap').style.display  = 'none';
  }

  // Cargar ambos CSVs en paralelo
  const [ok] = await Promise.all([
    ruidoEnsureLoaded(),
    _ruidoEnsureCamionLoaded(),
  ]);
  if (ok) _ruidoUpdateLegend();

  // Resolver de nuevo DESPUÉS del await (el estado puede haber cambiado)
  // y usar directamente ruidoAnimState.targetId si aún coincide con gpsLayers
  const finalId = ruidoAnimState.targetId && gpsLayers[ruidoAnimState.targetId]
    ? ruidoAnimState.targetId
    : _ruidoResolveSingleId();

  const finalEntry = finalId ? gpsLayers[finalId] : null;

  if (finalEntry && ok) {
    if (finalId !== ruidoAnimState.targetId) {
      ruidoSyncRoute(finalId);
    }
    _ruidoComputarVentana(finalEntry);
    _ruidoRenderStatsPanel(finalEntry);
    _ruidoPaintForPoint(finalEntry, 0);
  } else if (!finalEntry) {
    document.getElementById('map-ruido-empty').style.display = 'flex';
    document.getElementById('map-ruido-wrap').style.display  = 'none';
    document.getElementById('ruido-side-stats').style.display = 'none';
    const note = document.getElementById('ruido-anim-note');
    if (note) note.textContent = 'Selecciona un camión específico en la pestaña Exposición (Camión + Mes + Día)';
  }
}

// Replica la resolución de "singleId" de applyFilters() en gps.js, para que
// Ruido siempre muestre exactamente la misma ruta que está activa en Exposición.
function _ruidoResolveSingleId() {
  if (typeof _getFilterVals !== 'function' || typeof _entryMatches !== 'function') return null;
  const fv = _getFilterVals();
  if (fv.bus === 'all') return null;   // sin camión específico → sin ruta única
  const candidates = Object.entries(gpsLayers).filter(([, e]) => _entryMatches(e, fv));
  return candidates.length === 1 ? candidates[0][0] : null;
}
