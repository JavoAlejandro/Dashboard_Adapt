'use strict';
// ══════════════════════════════════════════════════════════════════════════════
// congestion.js — Panel de Congestión: indicadores de carga vial por empresa
// y por vehículo, más la huella de red compartida (mapa).
//
// Carga los artifacts `congestion/*` UNA SOLA VEZ (lazy, on first open de
// cualquiera de las dos superficies Congestión), mirroring ruidoEnsureLoaded().
// Cada artifact se resuelve de forma independiente (Promise.allSettled): un
// 404 en uno nunca bloquea ni rompe los demás.
//
// IMPORTANTE (frozen por design.md / congestion-data-contract spec): las filas
// de `empresas.csv` y `vehiculos.csv` ya vienen agregadas/precomputadas
// upstream. Este archivo NO debe re-derivar métricas (sin mean/sum de campos
// crudos) — solo fetch, filtra, ordena y renderiza estos campos ya calculados.
// ══════════════════════════════════════════════════════════════════════════════

// ── ESTADO DEL MÓDULO ───────────────────────────────────────────────────────
let _congLoaded   = false;
let _congLoading  = false;

let _congEmpData  = new Map();   // Map<account_id, row>            — congestion/empresas.csv
let _congVehData  = [];          // row[]                            — congestion/vehiculos.csv
let _congRefData  = new Map();   // Map<metrica, {p10..p90}>         — congestion/referencia.csv (opcional)
let _congGeo      = null;        // FeatureCollection                — congestion/red_mecc.geojson

// Reverse index owner_id → bus_id[] (Camión→Congestión cross-link, PR2).
// Declarado aquí porque es parte del estado del módulo (design.md), se
// construye recién en Fase 3 (rebuilt per render, no persistido).
let _congByOwner  = new Map();

let _congMap      = null;        // instancia Leaflet propia del mapa de huella
let _congLayer    = null;        // L.geoJSON con los tramos de red coloreados

// ─── COLOR RAMP HUELLA — verde→amarillo→naranja→rojo (carga vial, local, no en TOKENS)
const CONGEST_RAMP = [
  { t: 0.00, r: 44,  g: 158, b: 91  },  // verde   — carga baja
  { t: 0.35, r: 232, g: 181, b: 58  },  // amarillo— carga moderada
  { t: 0.65, r: 245, g: 134, b: 42  },  // naranja — carga alta
  { t: 1.00, r: 224, g: 49,  b: 49  },  // rojo    — carga muy alta / saturado
];

function _congColor(norm) {
  let lo = CONGEST_RAMP[0], hi = CONGEST_RAMP[CONGEST_RAMP.length - 1];
  for (let i = 1; i < CONGEST_RAMP.length; i++) {
    if (norm <= CONGEST_RAMP[i].t) { lo = CONGEST_RAMP[i - 1]; hi = CONGEST_RAMP[i]; break; }
  }
  const f = (norm - lo.t) / Math.max(hi.t - lo.t, 1e-9);
  return [
    Math.round(lo.r + (hi.r - lo.r) * f),
    Math.round(lo.g + (hi.g - lo.g) * f),
    Math.round(lo.b + (hi.b - lo.b) * f),
  ];
}

function _congCssColor(norm, alpha = 0.9) {
  const [r, g, b] = _congColor(norm);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ─── CARGA LAZY DE congestion/* (una sola vez) ───────────────────────────────
// Promise.allSettled aísla cada artifact: un 404/error en uno no bloquea a
// los demás. No lanza excepción — cada fallo se resuelve como degradación
// graciosa (Map/array vacío, geojson null) y se loguea con console.warn.
async function congEnsureLoaded() {
  if (_congLoaded || _congLoading) return _congLoaded;
  _congLoading = true;

  const [empRes, vehRes, refRes, geoRes] = await Promise.allSettled([
    fetchParseCsv('congestion/empresas.csv'),
    fetchParseCsv('congestion/vehiculos.csv'),
    fetchParseCsv('congestion/referencia.csv'),
    r2Fetch('congestion/red_mecc.geojson').then(res => res.json()),
  ]);

  // ── empresas.csv → Map<account_id, row> ────────────────────────────────
  _congEmpData = new Map();
  if (empRes.status === 'fulfilled') {
    (empRes.value || []).forEach(row => {
      if (row && row.account_id != null && row.account_id !== '') {
        _congEmpData.set(String(row.account_id), row);
      }
    });
  } else {
    console.warn('[Congestión] empresas.csv no disponible:', empRes.reason?.message || empRes.reason);
  }

  // ── vehiculos.csv → row[] ────────────────────────────────────────────────
  if (vehRes.status === 'fulfilled') {
    _congVehData = (vehRes.value || []).filter(r => r && r.gps_vehicle_id != null && r.gps_vehicle_id !== '');
  } else {
    _congVehData = [];
    console.warn('[Congestión] vehiculos.csv no disponible:', vehRes.reason?.message || vehRes.reason);
  }

  // ── referencia.csv (opcional) → Map<metrica, {p10..p90}> ─────────────────
  _congRefData = new Map();
  if (refRes.status === 'fulfilled') {
    (refRes.value || []).forEach(row => {
      if (row && row.metrica != null && row.metrica !== '') {
        _congRefData.set(String(row.metrica), row);
      }
    });
  } else {
    console.warn('[Congestión] referencia.csv no disponible (opcional):', refRes.reason?.message || refRes.reason);
  }

  // ── red_mecc.geojson ──────────────────────────────────────────────────────
  if (geoRes.status === 'fulfilled') {
    _congGeo = geoRes.value;
  } else {
    _congGeo = null;
    console.warn('[Congestión] red_mecc.geojson no disponible:', geoRes.reason?.message || geoRes.reason);
  }

  _congLoaded  = true;
  _congLoading = false;
  return true;
}

// ══════════════════════════════════════════════════════════════════════════════
// HUELLA DE RED — capa compartida Leaflet (Empresa + Camión, sin filtro por
// compañía: congestion-footprint-map spec — geometría de red, no por-empresa)
// ══════════════════════════════════════════════════════════════════════════════

// Carga agregada (promedio de las 24 horas) de un feature de la red.
// mecc_veh_s es un array de 24 valores horarios (spec: congestion-data-contract).
function _congFeatureAvgLoad(feature) {
  const arr = feature?.properties?.mecc_veh_s;
  if (!Array.isArray(arr) || !arr.length) return null;
  const vals = arr.map(Number).filter(v => !isNaN(v));
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function congInitMap() {
  if (_congMap) return;   // ya inicializado

  const container = document.getElementById('map-cong');
  if (!container) return;

  _congMap = L.map('map-cong', { zoomControl: true, attributionControl: false, preferCanvas: true });
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    subdomains: 'abcd', maxZoom: 19,
  }).addTo(_congMap);
}

// Pinta la huella de red completa (misma geometría, sin filtro por empresa —
// "company-scoped" solo aplica al contexto de KPIs/tabla, no a los tramos).
// Muestra map-cong-empty si el geojson no está disponible (404/ausente).
function congRenderFootprint() {
  const empty = document.getElementById('map-cong-empty');
  const wrap  = document.getElementById('map-cong-wrap');

  if (!_congGeo || !Array.isArray(_congGeo.features) || !_congGeo.features.length) {
    if (empty) empty.style.display = 'flex';
    if (wrap)  wrap.style.display  = 'none';
    return;
  }

  if (empty) empty.style.display = 'none';
  if (wrap)  wrap.style.display  = 'block';

  congInitMap();
  if (!_congMap) return;
  setTimeout(() => _congMap.invalidateSize(), 80);

  if (_congLayer) { _congMap.removeLayer(_congLayer); _congLayer = null; }

  const loads = _congGeo.features
    .map(_congFeatureAvgLoad)
    .filter(v => v != null);
  const minLoad = loads.length ? Math.min(...loads) : 0;
  const maxLoad = loads.length ? Math.max(...loads) : 1;
  const range   = Math.max(maxLoad - minLoad, 1e-9);

  _congLayer = L.geoJSON(_congGeo, {
    style(feature) {
      const load = _congFeatureAvgLoad(feature);
      const norm = load != null ? (load - minLoad) / range : 0;
      return { color: _congCssColor(norm), weight: 3, opacity: 0.85 };
    },
  }).addTo(_congMap);

  try {
    const bounds = _congLayer.getBounds();
    if (bounds.isValid()) _congMap.fitBounds(bounds, { padding: [20, 20] });
  } catch (e) { /* geometría vacía o inválida — mantener vista por defecto */ }
}

// ─── ENTRADA A CUALQUIER SUPERFICIE CONGESTIÓN (Camión o Empresa) ────────────
// Llamado desde switchSubTab (Camión) y, en PR3, desde switchCmpSubTab (Empresa).
async function congOnTabEnter() {
  await congEnsureLoaded();
  congRenderFootprint();
}
