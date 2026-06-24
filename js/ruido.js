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

  // Pane para hexágonos — debajo de rutas y arcos críticos
  const p = _ruidoMap.createPane('ruidoPane');
  p.style.zIndex        = '300';
  p.style.pointerEvents = 'none';

  // Pane para arcos críticos — encima de todo (hexágonos + gradiente continuo)
  const pCrit = _ruidoMap.createPane('ruidoCriticosPane');
  pCrit.style.zIndex        = '500';
  pCrit.style.pointerEvents = 'none';
}

// ══════════════════════════════════════════════════════════════════════════════
// ARCOS DE RUTA — visualización completa desde RedVial
//
// Fuentes R2:
//   ruido/ruta_arcos_por_vehiculo.csv  → todos los arcos por owner_id + hour
//   ruido/redvial_arcos.geojson        → geometría real (LineString WGS84)
//
// Paleta por régimen:
//   sensitive  → #4FC3F7  celeste (free-flow, mayor ruido marginal)
//   transition → #FF8F00  ámbar
//   saturated  → #E53935  rojo
//   sin regime → #BBBBBB  gris neutro
//
// Animación por hora: se van revelando los arcos de cada hour acumulativamente.
// Los arcos críticos (top-5 por contrib) se resaltan encima con halo blanco.
// ══════════════════════════════════════════════════════════════════════════════

const REGIME_COLOR = {
  sensitive:  '#4FC3F7',
  transition: '#FF8F00',
  saturated:  '#E53935',
  none:       '#BBBBBB',
};
function _arcColor(regime) {
  const k = (regime || '').toLowerCase().trim();
  if (!k)                                                   return REGIME_COLOR.none;
  if (k.includes('sensitive') || k.includes('free'))        return REGIME_COLOR.sensitive;
  if (k.includes('saturated') || k.includes('congest'))     return REGIME_COLOR.saturated;
  if (k.includes('transition') || k.includes('trans'))      return REGIME_COLOR.transition;
  return REGIME_COLOR.none;
}
// Alias para los críticos (misma paleta)
function _criticosColor(regime) { return _arcColor(regime); }

// ── Índices ───────────────────────────────────────────────────────────────────
let _redvialIndex     = null;   // Map<arc_id_str, GeoJSON Feature>
let _redvialLoading   = false;

// Map<owner_id_str, Map<hour_int, [{arc_id, regime, dLdk, length_m}]>>
// Todas las horas de todos los arcos de cada vehículo
let _rutaArcosData    = null;
let _rutaArcosLoading = false;

let _criticosLayer    = null;   // L.layerGroup con arcos de la ruta activa

// ── Carga lazy de redvial_arcos.geojson ───────────────────────────────────────
async function _ruidoLoadRedvial() {
  if (_redvialIndex)   return true;
  if (_redvialLoading) return false;
  _redvialLoading = true;
  try {
    const res = await r2Fetch('ruido/redvial_arcos.geojson');
    const fc  = await res.json();
    _redvialIndex = new Map();
    (fc.features || []).forEach(f => {
      const id = f.properties?.id_arco ?? f.properties?.arc_id;
      if (id != null) _redvialIndex.set(String(id), f);
    });
    _redvialLoading = false;
    console.log(`[RedVial] ${_redvialIndex.size} arcos indexados`);
    return true;
  } catch (err) {
    _redvialLoading = false;
    console.warn('[RedVial] No disponible:', err.message);
    return false;
  }
}

// ── Carga lazy de ruta_arcos_por_vehiculo.csv ─────────────────────────────────
async function _ruidoLoadRutaArcos() {
  if (_rutaArcosData)   return true;
  if (_rutaArcosLoading) return false;
  _rutaArcosLoading = true;

  const status = document.getElementById('ruido-status');
  if (status) status.textContent = '⏳ Cargando arcos de ruta…';

  try {
    const res     = await r2Fetch('ruido/ruta_arcos_por_vehiculo.csv');
    const csvText = await res.text();

    await new Promise(resolve => Papa.parse(csvText, {
      header: true, dynamicTyping: true, skipEmptyLines: true,
      complete({ data: rows }) {
        _rutaArcosData = new Map();
        rows.forEach(r => {
          const oid   = String(r.owner_id ?? '').trim();
          const arcId = String(r.arc_id   ?? '').trim();
          const hour  = parseInt(r.hour, 10);
          if (!oid || !arcId || isNaN(hour)) return;

          if (!_rutaArcosData.has(oid)) _rutaArcosData.set(oid, new Map());
          const byHour = _rutaArcosData.get(oid);
          if (!byHour.has(hour)) byHour.set(hour, []);
          byHour.get(hour).push({
            arc_id:   arcId,
            regime:   String(r.regime   ?? '').trim(),
            dLdk:     r.dLdk != null && r.dLdk !== '' ? +r.dLdk : null,
            length_m: r.length_m != null ? +r.length_m : null,
          });
        });
        _rutaArcosLoading = false;
        const nVeh   = _rutaArcosData.size;
        const nArcos = [..._rutaArcosData.values()]
          .reduce((s, m) => s + [...m.values()].reduce((a, arr) => a + arr.length, 0), 0);
        console.log(`[RutaArcos] ${nVeh} vehículos · ${nArcos} arcos-hora`);
        if (status) status.textContent =
          `✓ ${nVeh} vehículos · ${nArcos.toLocaleString()} arcos cargados`;
        resolve();
      },
      error(err) {
        _rutaArcosLoading = false;
        console.warn('[RutaArcos] Error:', err);
        resolve();
      },
    }));
    return true;
  } catch (err) {
    _rutaArcosLoading = false;
    console.warn('[RutaArcos] No disponible:', err.message);
    if (status) status.textContent = '⚠ Arcos de ruta no disponibles';
    return false;
  }
}

// ── Limpiar capa de arcos ──────────────────────────────────────────────────────
let _rutaArcosToken = 0;   // incrementar al cambiar de ruta; las promesas viejas lo detectan

function _ruidoClearCriticos(silent = false) {
  if (_criticosLayer && _ruidoMap) {
    _ruidoMap.removeLayer(_criticosLayer);
    _criticosLayer = null;
  }
  if (!silent) _rutaArcosToken++;   // invalidar draws async pendientes (no en frames de animación)
}

// ── Obtener arcos de un vehículo hasta una hora dada (inclusive) ──────────────
// Devuelve Map<arc_id, {regime, dLdk}> con los arcos acumulados hasta `upToHour`.
// Un arc_id puede aparecer en varias horas — se conserva el primero encontrado
// (el de menor hour), ya que todos son válidos incluyendo dLdk = 0 o null.
function _rutaArcosHasta(ownerId, upToHour) {
  const byHour = _rutaArcosData?.get(String(ownerId));
  if (!byHour) return null;

  const acum = new Map();
  // Iterar en orden de hora para que la primera aparición (menor hour) prevalezca
  const hours = [...byHour.keys()].sort((a, b) => a - b);
  for (const hour of hours) {
    if (upToHour !== undefined && hour > upToHour) continue;
    byHour.get(hour).forEach(({ arc_id, regime, dLdk }) => {
      if (!acum.has(arc_id)) {
        // Primera vez que aparece este arco: registrar
        acum.set(arc_id, { regime, dLdk });
      } else if (!acum.get(arc_id).regime && regime) {
        // Ya existe pero sin régimen: actualizar con el que sí tiene
        acum.set(arc_id, { regime, dLdk });
      }
    });
  }
  return acum.size > 0 ? acum : null;
}

// ── Dibujar arcos en el mapa ──────────────────────────────────────────────────
// arcMap: Map<arc_id, {regime, dLdk}>
// critSet: Set<arc_id> de críticos (resaltado especial)
// target: L.layerGroup donde añadir
function _dibujarArcMap(arcMap, critSet, target) {
  // Capa 1: arcos normales coloreados por régimen
  arcMap.forEach(({ regime, dLdk }, arcId) => {
    if (critSet?.has(arcId)) return;
    const feat = _redvialIndex?.get(arcId);
    if (!feat) return;
    L.geoJSON(feat, {
      style: { color: _arcColor(regime), weight: 3, opacity: 0.85,
               pane: 'ruidoCriticosPane' },
      interactive: false,
    }).addTo(target);
  });

  // Capa 2: críticos con halo blanco encima
  critSet?.forEach(arcId => {
    const entry = arcMap.get(arcId);
    const feat  = _redvialIndex?.get(arcId);
    if (!feat) return;
    L.geoJSON(feat, {
      style: { color: '#ffffff', weight: 10, opacity: 0.5,
               pane: 'ruidoCriticosPane' },
      interactive: false,
    }).addTo(target);
    L.geoJSON(feat, {
      style: { color: _arcColor(entry?.regime), weight: 6, opacity: 1,
               pane: 'ruidoCriticosPane' },
    })
    .bindTooltip(
      `<b style="font-family:'Syne Mono',monospace;font-size:10px">Arco ${arcId}</b>` +
      (entry?.regime ? `<br>${entry.regime}` : '') +
      (entry?.dLdk != null ? ` · dLdk ${entry.dLdk.toFixed(3)}` : ''),
      { sticky: true, className: 'leaflet-tip' }
    )
    .addTo(target);
  });
}

// ── Pintar ruta completa (estado estático / post-animación) ───────────────────
async function _ruidoPintarTodosArcos(entry, criticos) {
  _ruidoClearCriticos();
  if (!_ruidoMap || !entry) return;

  const token = _rutaArcosToken;   // capturar token actual

  const [okR, okA] = await Promise.all([_ruidoLoadRedvial(), _ruidoLoadRutaArcos()]);
  if (!okR || !okA) return;
  if (_rutaArcosToken !== token) return;   // ruta cambió mientras cargaba — abortar

  const oid     = String(entry.feature.properties.owner_id ?? '');
  const arcMap  = _rutaArcosHasta(oid);   // todos los arcos (sin límite de hora)
  if (!arcMap) return;

  const critSet = new Set((criticos || []).map(c => String(c.arc_id)));
  _criticosLayer = L.layerGroup();
  _dibujarArcMap(arcMap, critSet, _criticosLayer);
  _criticosLayer.addTo(_ruidoMap);

  // Ajustar bounds al extent de los arcos dibujados
  try {
    const bounds = _criticosLayer.getLayers()
      .reduce((b, l) => b.extend(l.getBounds?.() ?? b), L.latLngBounds([]));
    if (bounds.isValid()) _ruidoMap.fitBounds(bounds, { padding: [30, 30] });
  } catch {}
}

// ── Actualizar arcos durante la animación (hasta hora `hour`) ─────────────────
async function _ruidoActualizarArcosHora(entry, hour, criticos) {
  _ruidoClearCriticos(true);   // silent: no invalidar el token en cada frame
  if (!_ruidoMap || !entry) return;

  const token = _rutaArcosToken;

  const [okR, okA] = await Promise.all([_ruidoLoadRedvial(), _ruidoLoadRutaArcos()]);
  if (!okR || !okA) return;
  if (_rutaArcosToken !== token) return;   // ruta cambió — abortar

  const oid    = String(entry.feature.properties.owner_id ?? '');
  const arcMap = _rutaArcosHasta(oid, hour);
  if (!arcMap) return;

  const critSet = new Set((criticos || []).map(c => String(c.arc_id)));
  _criticosLayer = L.layerGroup();
  _dibujarArcMap(arcMap, critSet, _criticosLayer);
  _criticosLayer.addTo(_ruidoMap);
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
    return;
  }

  // Limpiar también segmentos de arco y arcos críticos de la ruta anterior
  _ruidoClearSegLayers();
  _ruidoClearAnimSegs();
  _ruidoClearCriticos();

  document.getElementById('map-ruido-empty').style.display = 'none';
  document.getElementById('map-ruido-wrap').style.display  = 'block';

  // NO dibujamos la polilínea OSRM — los arcos de RedVial son la geometría principal.
  // Solo usamos coords para hacer fitBounds mientras los arcos cargan.
  if (entry.coords?.length) {
    _ruidoMap.fitBounds(L.latLngBounds(entry.coords), { padding: [30, 30] });
  }

  ruidoAnimState.targetId = busId;
  const p   = entry.feature.properties;
  const oid = p.owner_id ?? busId.split('_')[0];
  const dia = p.dia ?? '';
  if (note) note.textContent = `Camión ${oid} · Día ${dia} · ${entry.coords.length} puntos`;

  // Renderizar ambos paneles si los datos ya están cargados
  if (_ruidoLoaded) {
    _ruidoComputarVentana(entry);
    _ruidoRenderStatsPanel(entry);
    _ruidoPaintForPoint(entry, 0);
  }
  if (_camionLoaded) {
    _ruidoRenderVehiculoPanel(entry);
    // Pintar todos los arcos de la ruta + resaltado de críticos
    const diag = _ruidoDiagnosticoVehiculo(entry);
    _ruidoPintarTodosArcos(entry, diag?.criticos || []);
  }
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
// ruido/camion_hora_rm.csv → R, R_v por owner_id × h3_index × hour.
// R/R_v ya vienen calculados en el archivo (alcance acústico ponderado),
// no se cruzan con hexagonos_hora_rm.
let _camionData      = null;   // Map<owner_id, Map<"h3|hour", {R, R_v, h3, hour}>>
let _camionDiagData  = null;   // Map<owner_id, Map<"arc_id|hour", {arc_id,hour,contrib,R,regime,length_m}>>
let _camionArcosData = null;   // Map<"owner_id|dia|mes", Map<arc_id, {regime, dLdk}>>
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
          // Índice principal: owner_id → Map<"h3_index|hour", {R, R_v, h3, hour}>
          _camionData     = new Map();
          // Índice diagnóstico: owner_id → Map<"arc_id|hour", {arc_id,hour,contrib,R,regime,length_m}>
          _camionDiagData = new Map();

          // Índice de arcos por ruta exacta: "owner_id|dia|mes" → Map<arc_id, {regime, dLdk}>
          // Permite pintar TODOS los arcos de una ruta específica sin mezclar días.
          if (!_camionArcosData) _camionArcosData = new Map();

          rows.forEach(r => {
            const oid   = String(r.owner_id ?? '');
            const h3    = String(r.h3_index ?? '');
            const hour  = Math.round(+r.hour);
            if (!oid || !h3 || isNaN(hour)) return;

            // ── R por hexágono-hora ─────────────────────────────────────────
            if (!_camionData.has(oid)) _camionData.set(oid, new Map());
            const key  = h3 + '|' + hour;
            const prev = _camionData.get(oid).get(key) || { R: 0, R_v: 0, h3, hour };
            _camionData.get(oid).set(key, {
              R:   prev.R   + (+r.R   || 0),
              R_v: prev.R_v + (+r.R_v || 0),
              h3, hour,
            });

            // ── Diagnóstico: contrib = dLdk × R por (arc_id, hour) ─────────
            const arcId  = String(r.arc_id  ?? h3);
            const dLdk   = +r.dLdk    || 0;
            const R_val  = +r.R       || 0;
            const contrib = dLdk * R_val;
            const regime  = String(r.regime   ?? '');
            const length  = +r.length_m || 0;

            if (!_camionDiagData.has(oid)) _camionDiagData.set(oid, new Map());
            const dKey  = arcId + '|' + hour;
            const dp    = _camionDiagData.get(oid).get(dKey)
                        || { arc_id: arcId, hour, contrib: 0, R: 0, regime, length_m: length };
            _camionDiagData.get(oid).set(dKey, {
              arc_id:   arcId,
              hour,
              contrib:  dp.contrib  + contrib,
              R:        dp.R        + R_val,
              regime:   regime      || dp.regime,
              length_m: Math.max(dp.length_m, length),
            });

            // ── Arcos por ruta exacta (owner_id|dia|mes) ───────────────────
            const dia = String(r.dia ?? '');
            const mes = String(r.mes ?? '');
            if (!dia) return;
            const rutaKey = `${oid}|${dia}|${mes}`;
            if (!_camionArcosData.has(rutaKey)) _camionArcosData.set(rutaKey, new Map());
            const arcMap = _camionArcosData.get(rutaKey);
            // Si el mismo arc_id aparece varias veces, mantener el de mayor |dLdk|
            const prevArc = arcMap.get(arcId);
            if (!prevArc || Math.abs(dLdk) > Math.abs(prevArc.dLdk || 0)) {
              arcMap.set(arcId, { regime, dLdk });
            }
          });

          _camionLoaded  = true;
          _camionLoading = false;
          _ruidoOnDiagDataReady();
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

// Modo de cálculo: dedup (única definición según spec).
// Cada hexágono cuenta una sola vez con su R máximo en la ventana 7-22h.
// El dedup elimina el doble conteo temporal (mismo hex en distintas horas),
// no el solapamiento entre hexágonos vecinos (limitación del modelo).
const _ruidoPersonasModo = 'dedup';

// Calcula personas alcanzadas (R deduplicado):
// Para cada h3_index único, tomar el R máximo entre las horas válidas (7-22h)
// de esta ruta y sumar esos máximos. Cada hexágono cuenta una sola vez.
// Sin filtro geográfico — coherente con la definición del ranking de empresa.
function _ruidoGetPersonasAlcanzadas(entry) {
  if (!_camionData) return null;
  const oid     = String(entry.feature.properties.owner_id ?? '');
  const dataMap = _camionData.get(oid);
  if (!dataMap) return null;

  // Horas de esta ruta, solo ventana 7-22h
  const ts = entry.feature.properties.coord_timestamps || [];
  const horasRuta = new Set();
  ts.forEach(t => {
    const m = t && String(t).match(/^(\d{1,2}):/);
    if (m) { const h = parseInt(m[1], 10); if (h >= 7 && h <= 22) horasRuta.add(h); }
  });
  if (horasRuta.size === 0) return null;

  // Dedup por máximo: cada hexágono único cuenta una sola vez
  const maxPorHex = new Map();
  dataMap.forEach(({ R, h3, hour }) => {
    if (!horasRuta.has(hour)) return;
    const prev = maxPorHex.get(h3);
    if (!prev || R > prev) maxPorHex.set(h3, R);
  });

  let totalR = 0;
  maxPorHex.forEach(R => { totalR += R; });

  return totalR > 0 ? { R: Math.round(totalR) } : null;
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

// ─── PANEL LATERAL — IMPACTO POBLACIONAL (según mockup) ──────────────────────
function _ruidoRenderStatsPanel(entry) {
  const panel = document.getElementById('ruido-side-stats');
  if (!panel) return;

  const stats = _ruidoCalcularEstadisticas(entry);
  if (!stats || stats.avgGlobal == null) { panel.innerHTML = ''; return; }

  const db      = stats.avgGlobal;
  const banda   = _ruidoBanda(db);
  const pct     = _ruidoPercentil(db);
  const p       = entry.feature.properties;
  const oid     = p.owner_id != null ? p.owner_id : '';
  const personas = _ruidoGetPersonasAlcanzadas(entry);

  const S  = "font-family:'Syne',sans-serif;";
  const M  = "font-family:'Syne Mono',monospace;";
  const bandGrad = RUIDO_BANDAS.map((b, i) =>
    `${b.color} ${(i / RUIDO_BANDAS.length * 100).toFixed(0)}%`).join(',');

  let html = '';

  // Contexto + título
  html += `<div style="${M}font-size:10px;color:var(--muted);margin-bottom:2px">
    Vehículo ${oid} · empresa ${p.account_id ?? '—'}
  </div>
  <div style="${S}font-size:10.5px;color:var(--muted);font-style:italic;margin-bottom:10px">
    Vista de exposición de la población · uso de política pública
  </div>`;

  // Personas alcanzadas
  if (personas) {
    html += `<div style="${S}font-weight:800;font-size:34px;line-height:1.05">
      &#8776; ${personas.R.toLocaleString()}
      <span style="font-size:13px;font-weight:600;color:var(--muted)">personas (ponderado)</span>
    </div>
    <div style="${S}font-size:11px;color:var(--muted);margin-top:4px;margin-bottom:10px">
      alcanzadas por el ruido de este recorrido · deduplicado por hexágono
    </div>`;
  } else {
    html += `<div style="${M}font-size:10px;color:var(--muted);margin-bottom:10px">Sin datos de personas para este camión</div>`;
  }

  // Banda de ruido (card coloreada como mockup)
  html += `<div style="border-radius:9px;padding:11px 13px;color:#fff;display:flex;
                        align-items:center;justify-content:space-between;
                        background:${banda.color};margin-bottom:14px">
    <div>
      <div style="${S}font-weight:800;font-size:16px">${banda.label.toUpperCase()}</div>
      <div style="${S}font-size:10px;opacity:0.9;margin-top:2px">como ${banda.ref}</div>
    </div>
    <div style="text-align:right">
      <div style="${S}font-size:18px;font-weight:700">&#8776; ${db.toFixed(1)}</div>
      <div style="font-size:8px;letter-spacing:1px;opacity:0.85">dB(A)</div>
    </div>
  </div>`;

  // Posición en la RM
  if (pct != null) {
    html += `<div style="${S}font-size:11px;margin-bottom:6px">
      más ruidoso que el <b>${pct}%</b> de la Región Metropolitana
    </div>
    <div style="position:relative;height:9px;border-radius:5px;
                background:linear-gradient(90deg,${bandGrad});margin-bottom:3px">
      <div style="position:absolute;top:-4px;left:${pct}%;transform:translateX(-50%);
                  width:3px;height:17px;background:var(--ink);border-radius:2px;
                  box-shadow:0 0 0 2px #fff"></div>
    </div>
    <div style="display:flex;justify-content:space-between;${M}font-size:9px;
                color:var(--muted);margin-bottom:14px">
      <span>silencioso</span><span>ruidoso</span>
    </div>`;
  }

  // Referencia OMS
  html += `<div style="${S}font-size:11px;color:#374151;background:#F1F4F8;
                          border-radius:7px;padding:9px 11px;line-height:1.5;margin-bottom:14px">
    <b style="color:var(--ink)">Umbral OMS (tráfico): ${RUIDO_OMS_DB} dB.</b>
    Este recorrido lo supera${pct != null ? `, igual que el ${pct}% de la RM` : ''}.
    <span style="color:var(--muted)">(La OMS usa un promedio diario a fachada; referencia, no comparación exacta.)</span>
  </div>`;

  // Escala de bandas
  html += `<div style="${M}font-size:9px;letter-spacing:1.2px;text-transform:uppercase;
                          color:var(--muted);margin-bottom:8px">Escala de bandas</div>`;
  RUIDO_BANDAS.forEach(b => {
    html += `<div style="display:flex;align-items:center;gap:7px;${S}font-size:11px;
                          padding:3px 0;color:#374151">
      <span style="width:13px;height:13px;border-radius:3px;background:${b.color};flex-shrink:0;display:inline-block"></span>
      <span>${b.label}</span>
      <span style="color:var(--muted);font-size:10px">${b.min}${b.max < 999 ? '–' + b.max : '+'} dB</span>
    </div>`;
  });

  // Fuente
  html += `<div style="${M}font-size:9px;color:#9aa2ac;background:var(--bg);border-radius:4px;
                          padding:2px 6px;display:inline-block;margin-top:10px">
    R · L_rec · dashboard_menu_config.json
  </div>`;

  panel.innerHTML = html;
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


// ══════════════════════════════════════════════════════════════════════════════
// SEGMENTOS DE ARCO — capa superpuesta sobre los hexágonos de ruido
//
// Cuando el GeoJSON trae coord_arcos (generado por BASE_test.py --camion-hora),
// la ruta se dibuja como segmentos coloreados por dLdk encima de los hexágonos.
// No hay selector de modo: siempre se muestran ambas capas a la vez.
//
// Gradiente dLdk divergente centrado en 0 (README_2: ±p95 = ±1.71):
//   azul (#0571B0) → gris (#F7F7F7) → rojo (#CA0020)
// ══════════════════════════════════════════════════════════════════════════════

let _ruidoSegLayers = [];   // L.polyline[] ruta estática coloreada
let _ruidoAnimSegs  = [];   // L.polyline[] segmentos de animación

// ── Gradiente dLdk ────────────────────────────────────────────────────────────
const DLDK_DOMAIN = 1.71;
const DLDK_RAMP = [
  { t: 0.00, r: 5,   g: 113, b: 176 },  // azul  — reduce ruido
  { t: 0.25, r: 146, g: 197, b: 222 },
  { t: 0.50, r: 247, g: 247, b: 247 },  // gris  — neutro
  { t: 0.75, r: 244, g: 165, b: 130 },
  { t: 1.00, r: 202, g: 0,   b: 32  },  // rojo  — aporta ruido
];
function _ruidoDldkColor(dLdk) {
  const t = Math.max(0, Math.min(1, ((dLdk || 0) + DLDK_DOMAIN) / (2 * DLDK_DOMAIN)));
  let lo = DLDK_RAMP[0], hi = DLDK_RAMP[DLDK_RAMP.length - 1];
  for (let i = 1; i < DLDK_RAMP.length; i++) {
    if (t <= DLDK_RAMP[i].t) { lo = DLDK_RAMP[i - 1]; hi = DLDK_RAMP[i]; break; }
  }
  const f = (t - lo.t) / Math.max(hi.t - lo.t, 1e-9);
  return `rgb(${Math.round(lo.r+(hi.r-lo.r)*f)},${Math.round(lo.g+(hi.g-lo.g)*f)},${Math.round(lo.b+(hi.b-lo.b)*f)})`;
}

// ── ¿Tiene coord_arcos con datos? ────────────────────────────────────────────
function _ruidoHasArcos(entry) {
  const ca = entry?.feature?.properties?.coord_arcos;
  return Array.isArray(ca) && ca.some(a => a != null);
}

// ── Limpiar capas de segmentos ────────────────────────────────────────────────
function _ruidoClearSegLayers() {
  _ruidoSegLayers.forEach(l => { try { _ruidoMap.removeLayer(l); } catch {} });
  _ruidoSegLayers = [];
}
function _ruidoClearAnimSegs() {
  _ruidoAnimSegs.forEach(l => { try { _ruidoMap.removeLayer(l); } catch {} });
  _ruidoAnimSegs = [];
}

// ── Construir segmentos coloreados por dLdk ───────────────────────────────────
// Agrupa puntos consecutivos del mismo color en un único L.polyline.
// coords: [[lat,lng],...] · arcos: coord_arcos del GeoJSON · upTo: nº puntos
function _ruidoBuildSegments(coords, arcos, upTo, target) {
  const n = Math.min(upTo ?? coords.length, coords.length);
  if (n < 2) return;

  let segCoords = [coords[0]];
  let segColor  = _ruidoDldkColor(arcos[0]?.dLdk);

  for (let i = 1; i < n; i++) {
    const c = _ruidoDldkColor(arcos[i]?.dLdk);
    if (c === segColor) {
      segCoords.push(coords[i]);
    } else {
      segCoords.push(coords[i]);   // punto de unión para continuidad
      if (segCoords.length >= 2) {
        target.push(L.polyline(segCoords, {
          color: segColor, weight: 5, opacity: 1, smoothFactor: 1,
          interactive: false,
        }).addTo(_ruidoMap));
      }
      segCoords = [coords[i]];
      segColor  = c;
    }
  }
  if (segCoords.length >= 2) {
    target.push(L.polyline(segCoords, {
      color: segColor, weight: 5, opacity: 1, smoothFactor: 1,
      interactive: false,
    }).addTo(_ruidoMap));
  }
}

// ── Pintar segmentos estáticos completos ──────────────────────────────────────
function _ruidoPaintSegmentos(entry) {
  _ruidoClearSegLayers();
  if (!_ruidoMap || !entry || !_ruidoHasArcos(entry)) return;
  _ruidoBuildSegments(
    entry.coords,
    entry.feature.properties.coord_arcos,
    undefined,
    _ruidoSegLayers
  );
}

// ── Actualizar segmentos animados hasta el punto `shown` ─────────────────────
function _ruidoUpdateAnimSegments(entry, shown) {
  _ruidoClearAnimSegs();
  if (!_ruidoMap || !entry || !_ruidoHasArcos(entry)) return;
  _ruidoBuildSegments(
    entry.coords,
    entry.feature.properties.coord_arcos,
    shown,
    _ruidoAnimSegs
  );
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
  if (hour === _ruidoCurrentHour) return;
  _ruidoCurrentHour = hour;

  if (_ruidoLayerGrp && _ruidoMap) { _ruidoMap.removeLayer(_ruidoLayerGrp); _ruidoLayerGrp = null; }

  // Hexágonos de nivel de ruido ambiente
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
  _ruidoClearSegLayers();
  _ruidoClearCriticos();   // ocultar arcos críticos durante la animación

  // Solo el punto móvil — la geometría la dan los arcos de RedVial
  if (!ruidoAnimState.animDot) {
    ruidoAnimState.animDot = L.circleMarker(entry.coords[0], {
      radius: 7, fillColor: '#ffffff', fillOpacity: 1,
      color: '#1a1814', weight: 2,
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

  // Mover punto de posición sobre la ruta OSRM (referencia temporal)
  ruidoAnimState.animDot.setLatLng(coords[shown - 1]);

  const pct = (ruidoAnimState.progress * 100).toFixed(0);
  document.getElementById('ruido-anim-fill').style.width  = pct + '%';
  document.getElementById('ruido-anim-thumb').style.left  = pct + '%';
  document.getElementById('ruido-anim-label').textContent = pct + '%';

  // Hora actual desde coord_timestamps
  _ruidoPaintForPoint(entry, shown - 1);

  // Revelar arcos de RedVial acumulados hasta la hora actual
  const currentHour = _ruidoHourAtIndex(entry, shown - 1);
  if (currentHour !== null) {
    const diag = _ruidoDiagnosticoVehiculo(entry);
    _ruidoActualizarArcosHora(entry, currentHour, diag?.criticos || []);
  }

  if (ruidoAnimState.progress >= 1) {
    ruidoAnimState.active = false;
    document.getElementById('ruido-anim-icon-play').style.display  = '';
    document.getElementById('ruido-anim-icon-pause').style.display = 'none';
    document.getElementById('ruido-anim-note').textContent = '✓ Recorrido completo';
    // Restaurar vista completa al terminar
    const diag = _ruidoDiagnosticoVehiculo(entry);
    _ruidoPintarTodosArcos(entry, diag?.criticos || []);
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

  _ruidoClearAnimSegs();
  _ruidoClearCriticos();

  // Restaurar arcos de RedVial al resetear
  if (ruidoAnimState.targetId && gpsLayers[ruidoAnimState.targetId] && _ruidoMap) {
    const entry = gpsLayers[ruidoAnimState.targetId];
    const diag  = _ruidoDiagnosticoVehiculo(entry);
    _ruidoPintarTodosArcos(entry, diag?.criticos || []);
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

  // Leyenda de hexágonos (ruido ambiente)
  const gradStops = RUIDO_RAMP
    .map(s => `rgb(${s.r},${s.g},${s.b}) ${(s.t * 100).toFixed(0)}%`)
    .join(',');

  // Leyenda de segmentos dLdk (si el GeoJSON los trae)
  const entry = ruidoAnimState.targetId && gpsLayers[ruidoAnimState.targetId];
  const dldkStops = DLDK_RAMP
    .map(s => `rgb(${s.r},${s.g},${s.b}) ${(s.t * 100).toFixed(0)}%`)
    .join(',');
  const dldkLeg = _ruidoHasArcos(entry) ? `
    <div style="margin-top:8px;padding-top:7px;border-top:1px solid var(--border)">
      <div style="letter-spacing:0.1em;text-transform:uppercase;margin-bottom:5px">Segmentos · dLdk</div>
      <div style="height:5px;border-radius:2px;background:linear-gradient(to right,${dldkStops});margin-bottom:4px"></div>
      <div style="display:flex;justify-content:space-between">
        <span>reduce</span><span>neutro</span><span>aporta</span>
      </div>
    </div>` : '';

  leg.innerHTML = `
    <div style="letter-spacing:0.1em;text-transform:uppercase;margin-bottom:5px">Nivel de ruido</div>
    <div style="height:8px;border-radius:2px;background:linear-gradient(to right,${gradStops});margin-bottom:4px"></div>
    <div style="display:flex;justify-content:space-between">
      <span>${_ruidoMinDb.toFixed(0)} dB</span><span>${_ruidoMaxDb.toFixed(0)} dB</span>
    </div>
    ${dldkLeg}`;
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

  // Cargar CSVs de ruido + camión + KPIs de empresa, todo en paralelo
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
    _ruidoRenderVehiculoPanel(finalEntry);
    _ruidoPaintForPoint(finalEntry, 0);
  } else if (!finalEntry) {
    document.getElementById('map-ruido-empty').style.display = 'flex';
    document.getElementById('map-ruido-wrap').style.display  = 'none';
    const vStats = document.getElementById('ruido-vehiculo-stats');
    const iStats = document.getElementById('ruido-side-stats');
    if (vStats) vStats.innerHTML = '';
    if (iStats) iStats.innerHTML = '';
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

// ══════════════════════════════════════════════════════════════════════════════
// SWITCH PESTAÑAS INTERNAS DEL PANEL RUIDO (Vehículo / Impacto Poblacional)
// ══════════════════════════════════════════════════════════════════════════════

let _ruidoInnerTab = 'vehiculo';   // pestaña interna activa

function ruidoSwitchInnerTab(name, btn) {
  _ruidoInnerTab = name;

  // Actualizar estilos de botones
  const btnV = document.getElementById('ruido-tab-vehiculo-btn');
  const btnI = document.getElementById('ruido-tab-impacto-btn');
  if (btnV) {
    btnV.style.borderBottom = name === 'vehiculo' ? '2px solid var(--accent)' : '2px solid transparent';
    btnV.style.color        = name === 'vehiculo' ? 'var(--ink)' : 'var(--muted)';
  }
  if (btnI) {
    btnI.style.borderBottom = name === 'impacto' ? '2px solid var(--accent)' : '2px solid transparent';
    btnI.style.color        = name === 'impacto' ? 'var(--ink)' : 'var(--muted)';
  }

  // Solo alternar contenido del panel izquierdo — el mapa NO se toca
  const pV = document.getElementById('ruido-inner-vehiculo');
  const pI = document.getElementById('ruido-inner-impacto');
  if (pV) pV.style.display = name === 'vehiculo' ? 'block' : 'none';
  if (pI) pI.style.display = name === 'impacto'  ? 'block' : 'none';
}

// ══════════════════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════════════════
// DIAGNÓSTICO DE VEHÍCULO — cálculo desde _camionDiagData
// Según la nota de implementación:
//   1. contrib = dLdk × R  (ya calculado al parsear)
//   2. Tramo = (arc_id, hour) — ya agrupado
//   3. Ruido evitable → contrib > 0
//   4. Concentración: top1, top3, top5
//   5. Tramos críticos: top 5
//   6. Perfil horario: contrib por hour
//   7. Mezcla por régimen: contrib por regime
// ══════════════════════════════════════════════════════════════════════════════

function _ruidoDiagnosticoVehiculo(entry) {
  if (!_camionDiagData) return null;

  const oid     = String(entry.feature.properties.owner_id ?? '');
  const diagMap = _camionDiagData.get(oid);
  if (!diagMap || diagMap.size === 0) return null;

  // Horas de la ruta (ventana 7-22h)
  const ts = entry.feature.properties.coord_timestamps || [];
  const horasRuta = new Set();
  ts.forEach(t => {
    const m = t && String(t).match(/^(\d{1,2}):/);
    if (m) { const h = parseInt(m[1], 10); if (h >= 7 && h <= 22) horasRuta.add(h); }
  });

  // Tramos: filtrar por horas de la ruta (o aceptar todos si no hay timestamps)
  const tramos = [];
  diagMap.forEach(d => {
    if (horasRuta.size > 0 && !horasRuta.has(d.hour)) return;
    tramos.push({ ...d });
  });

  if (!tramos.length) return null;

  // Solo evitables (contrib > 0)
  const evitables = tramos.filter(d => d.contrib > 0)
                          .sort((a, b) => b.contrib - a.contrib);
  const totalPositivo = evitables.reduce((s, d) => s + d.contrib, 0);

  if (totalPositivo === 0) return { sin_evitables: true, oid };

  // Concentración
  const acum = (n) => evitables.slice(0, n).reduce((s, d) => s + d.contrib, 0);
  const pct  = (v) => totalPositivo > 0 ? Math.round(v / totalPositivo * 100) : 0;
  const concentracion = {
    top1: pct(acum(1)),
    top3: pct(acum(3)),
    top5: pct(acum(5)),
    total_tramos: evitables.length,
  };

  // Tramos críticos (top 5)
  const criticos = evitables.slice(0, 5).map(d => ({
    arc_id:  d.arc_id,
    hour:    d.hour,
    regime:  d.regime,
    R:       Math.round(d.R),
    pct:     pct(d.contrib),
    contrib: d.contrib,
  }));

  // Perfil horario
  const porHora = new Map();
  evitables.forEach(d => {
    porHora.set(d.hour, (porHora.get(d.hour) || 0) + d.contrib);
  });
  const perfilHorario = Array.from(porHora.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([hour, contrib]) => ({ hour, contrib, pct: pct(contrib) }));

  // Mezcla por régimen
  const porRegimen = new Map();
  evitables.forEach(d => {
    const reg = d.regime || 'Desconocido';
    porRegimen.set(reg, (porRegimen.get(reg) || 0) + d.contrib);
  });
  const regimenes = Array.from(porRegimen.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([regime, contrib]) => ({ regime, contrib, pct: pct(contrib) }));
  const regimenDominante = regimenes[0]?.regime || '';

  // Texto adaptativo según concentración y régimen
  let mensajeConcentracion, mensajeRegimen;
  if (concentracion.top3 >= 70) {
    mensajeConcentracion = `${Math.min(evitables.length, 3)} tramos = ${concentracion.top3}% · pocos tramos, alto retorno`;
  } else if (concentracion.top3 >= 40) {
    mensajeConcentracion = `Concentración moderada · top 3 = ${concentracion.top3}%`;
  } else {
    mensajeConcentracion = `Ruido repartido · top 3 = ${concentracion.top3}% · sin atajo de pocos tramos`;
  }

  const regLow = regimenDominante.toLowerCase();
  if (regLow.includes('sensitive') || regLow.includes('free')) {
    mensajeRegimen = 'Régimen dominante: free-flow · acción de mayor retorno: re-rutear tramos críticos';
  } else if (regLow.includes('saturated') || regLow.includes('congest')) {
    mensajeRegimen = 'Régimen dominante: congestión · ruido evitable es menor, palanca en horarios';
  } else {
    mensajeRegimen = `Régimen dominante: ${regimenDominante}`;
  }

  return {
    oid, totalPositivo, concentracion, criticos,
    perfilHorario, regimenes, regimenDominante,
    mensajeConcentracion, mensajeRegimen,
    sin_evitables: false,
  };
}

// ── RENDER DEL PANEL VEHÍCULO ─────────────────────────────────────────────────

function _ruidoRenderVehiculoPanel(entry) {
  const panel  = document.getElementById('ruido-vehiculo-stats');
  if (!panel) return;

  const diag = _ruidoDiagnosticoVehiculo(entry);
  const p    = entry.feature.properties;
  const oid  = p.owner_id ?? '';
  const dia  = p.dia      ?? '';
  const mes  = p.mes      ?? '';

  // Colores de banda (igual que mockup)
  const C = { b1:'#2C9E5B', b2:'#E8B53A', b3:'#F5862A', b4:'#E03131', b5:'#7A1631' };
  const S = `font-family:'Syne',sans-serif;`;
  const M = `font-family:'Syne Mono',monospace;`;
  const SEC = `display:block;${M}font-size:9px;letter-spacing:1.3px;text-transform:uppercase;color:var(--muted);margin:14px 0 8px`;

  if (!diag) {
    panel.innerHTML = `<span style="${M}font-size:10px;color:var(--muted)">Cargando datos de diagnóstico…</span>`;
    return;
  }

  // Contexto
  let html = `<div style="${M}font-size:10px;color:var(--muted);margin-bottom:2px">
    Vehículo ${oid} · empresa ${p.account_id ?? '—'}
  </div>
  <div style="${S}font-weight:800;font-size:15px;margin-bottom:14px">Diagnóstico de ruteo</div>`;

  if (diag.sin_evitables) {
    html += `<div style="${S}font-size:12px;color:var(--muted);padding:12px 0">
      Este vehículo casi no genera ruido marginal evitable en la franja diurna.
    </div>`;
    panel.innerHTML = html;
    return;
  }

  // ① CONCENTRACIÓN
  html += `<span style="${SEC}">Dónde está el ruido evitable</span>
  <div style="${S}margin-bottom:6px">
    <div style="font-size:36px;font-weight:800;line-height:1">${Math.min(diag.concentracion.total_tramos,3)} tramos = ${diag.concentracion.top3}%</div>
    <div style="font-size:11px;color:var(--muted);margin-top:3px">de todo el ruido evitable se genera en solo ${Math.min(diag.concentracion.total_tramos,3)} tramos del recorrido</div>
  </div>`;

  // ② TRAMOS CRÍTICOS
  html += `<span style="${SEC}">Tramos críticos (resaltados en el mapa)</span>`;
  diag.criticos.forEach((t, i) => {
    const barW = i === 0 ? diag.criticos[0].pct : Math.round(t.pct / diag.criticos[0].pct * 100);
    html += `<div style="display:flex;align-items:center;gap:8px;margin-bottom:7px;${S}font-size:11.5px">
      <span style="flex:0 0 18px;height:18px;border-radius:50%;background:${C.b5};color:#fff;
                   font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center">${i+1}</span>
      <span style="flex:0 0 130px">
        <b style="font-weight:700">Arco ${t.arc_id}</b> · ${String(t.hour).padStart(2,'0')}h<br>
        <span style="color:var(--muted);font-size:10px">${t.regime || '—'} · ~${t.R.toLocaleString()} pers.</span>
      </span>
      <div style="flex:1;height:12px;border-radius:4px;background:${C.b5};width:${barW}%;min-width:4px"></div>
      <span style="font-variant-numeric:tabular-nums;font-weight:700;min-width:30px;text-align:right">${t.pct}%</span>
    </div>`;
  });

  // ③ CUÁNDO Y EN QUÉ CONDICIÓN
  html += `<span style="${SEC}">Cuándo y en qué condición</span>`;

  // Mini barchart horario
  const maxPct = Math.max(...diag.perfilHorario.map(h => h.pct), 1);
  html += `<div style="display:flex;align-items:flex-end;gap:4px;height:48px;margin-bottom:4px">`;
  diag.perfilHorario.forEach(h => {
    const ht = Math.max(4, Math.round(h.pct / maxPct * 100));
    html += `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:2px">
      <div style="width:100%;background:${C.b3};border-radius:3px 3px 0 0;height:${ht}%"></div>
      <div style="${M}font-size:8px;color:var(--muted)">${String(h.hour).padStart(2,'0')}h</div>
    </div>`;
  });
  html += `</div>`;

  // Split de régimen
  const totalContrib = diag.regimenes.reduce((s, r) => s + r.contrib, 0) || 1;
  html += `<div style="display:flex;height:15px;border-radius:4px;overflow:hidden;margin-bottom:6px;${S}font-size:9px;color:#fff;font-weight:700">`;
  const regColors = [C.b1, C.b3, C.b4, C.b5];
  diag.regimenes.forEach((r, i) => {
    if (r.pct < 2) return;
    html += `<div style="width:${r.pct}%;background:${regColors[i % regColors.length]};
                          display:flex;align-items:center;justify-content:center;overflow:hidden;white-space:nowrap">
      ${r.pct >= 10 ? r.regime.split(' ')[0] + ' ' + r.pct + '%' : ''}
    </div>`;
  });
  html += `</div>`;

  html += `<div style="${S}font-size:11px;color:var(--muted);margin-bottom:12px">${diag.mensajeRegimen}</div>`;

  // Recomendación
  const primerTramo = diag.criticos[0];
  html += `<div style="margin-top:4px;${S}font-size:11.5px;background:#FFF6EE;
                        border:1px solid #F3D9C4;border-radius:8px;padding:10px 12px;line-height:1.5">
    <b style="color:#B4541F">Acción de mayor retorno:</b> ${diag.mensajeConcentracion}.
    ${primerTramo ? `Re-rutear el arco ${primerTramo.arc_id} a las ${String(primerTramo.hour).padStart(2,'0')}h concentra el ${primerTramo.pct}% del impacto.` : ''}
    Principio: el ruido evitable se genera en vías despejadas, no en la congestión.
  </div>`;

  // Fuente
  html += `<div style="${M}font-size:9px;color:#9aa2ac;background:var(--bg);border-radius:4px;
                          padding:2px 6px;display:inline-block;margin-top:10px">
    dLdk × R por tramo · archivo por camión
  </div>`;

  panel.innerHTML = html;
}

// ── HOOK: cuando se carga _camionDiagData, re-renderizar si hay ruta activa ──
function _ruidoOnDiagDataReady() {
  const finalId = ruidoAnimState.targetId;
  if (!finalId || !gpsLayers[finalId]) return;
  const entry = gpsLayers[finalId];
  _ruidoRenderVehiculoPanel(entry);
  // Pintar todos los arcos de la ruta ahora que _camionDiagData está disponible
  const diag = _ruidoDiagnosticoVehiculo(entry);
  _ruidoPintarTodosArcos(entry, diag?.criticos || []);
  // Re-renderizar Impacto también si los datos de hexágonos ya cargaron
  if (_ruidoLoaded) {
    _ruidoComputarVentana(entry);
    _ruidoRenderStatsPanel(entry);
    _ruidoPaintForPoint(entry, 0);
  }
}
