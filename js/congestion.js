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

  // Camión→Congestión: KPIs de flota + tabla de vehículos (PR2). No-op
  // defensivo si el panel Camión no está montado (p.ej. llamado desde Empresa
  // en un futuro PR3 antes de que exista un scope de flota).
  if (typeof congRenderVehiclePanel === 'function') congRenderVehiclePanel();
}

// ══════════════════════════════════════════════════════════════════════════════
// CAMIÓN→CONGESTIÓN — KPIs de flota, tabla de vehículos y detalle (PR2)
//
// Regla vinculante (Phase 0.3 / design.md): `_congVehData` ya viene agregado
// upstream. Todo lo de acá abajo SOLO lee, filtra, ordena y renderiza esos
// campos — nunca recalcula mean/sum de campos crudos por vehículo.
// ══════════════════════════════════════════════════════════════════════════════

// Estado de orden de la tabla (no persistido — se resetea al recargar la página).
let _congVehSort = { col: 'km', dir: 'desc' };

// gps_vehicle_id del vehículo actualmente abierto en el panel de detalle, o null.
let _congVehSelected = null;

const _CONG_VEH_COLS = [
  { key: 'gps_vehicle_id', lbl: 'Vehículo',   num: false },
  { key: 'km',              lbl: 'Km',         num: true  },
  { key: 'mecc',            lbl: 'MECC',       num: true  },
  { key: 'iev',              lbl: 'IEV',        num: true  },
  { key: 'n_pasadas',        lbl: 'N° pasadas', num: true  },
];

// ── SCOPE DE EMPRESA ACTIVO — mismo criterio que gps.js ya usa hoy ─────────
// DECISIÓN (no explícita en design.md, tomada en apply — ver PR2 apply-progress):
// Camión no tiene un selector de empresa propio para Congestión; gps.js ya
// resuelve "empresa activa" con dos señales que conviven hoy en el propio tab:
//   1. #gps-empresa-sel: sub-filtro DENTRO del archivo/geojson ya cargado
//      (existe y es visible solo cuando ese archivo trae >1 account_id).
//   2. _r2CurrentArchivo (r2.js): en modo "empresa" ES el account_id del
//      archivo cargado — r2.js lo documenta como el selector "definitivo".
// Replicamos exactamente esa jerarquía: si #gps-empresa-sel tiene un valor
// específico (≠ 'all') se usa; si no, se cae a _r2CurrentArchivo en modo
// empresa. Si ninguna de las dos resuelve una única empresa (nada cargado
// aún, o modo "mezclado" sin account_id), se trata como "sin scope" → la
// tabla/KPIs quedan vacías (empty-state) en vez de mezclar vehículos de
// distintas empresas, que violaría el requirement "selected company scope".
function _congActiveAccountId() {
  const empresaSel = document.getElementById('gps-empresa-sel');
  if (empresaSel && empresaSel.value && empresaSel.value !== 'all') {
    return String(empresaSel.value);
  }
  if (typeof _r2Modo !== 'undefined' && _r2Modo === 'empresa' &&
      typeof _r2CurrentArchivo !== 'undefined' && _r2CurrentArchivo) {
    return String(_r2CurrentArchivo);
  }
  return null;
}

function _congScopedVehRows() {
  const accountId = _congActiveAccountId();
  if (accountId == null) return [];
  return _congVehData.filter(r => String(r.account_id) === accountId);
}

// ── ENTRADA: KPIs + tabla para el scope de empresa activo ──────────────────
function congRenderVehiclePanel() {
  const empty   = document.getElementById('cong-veh-empty');
  const content = document.getElementById('cong-veh-content');
  if (!empty || !content) return;   // panel Camión no montado — no-op defensivo

  const scopedRows = _congScopedVehRows();

  if (!scopedRows.length) {
    empty.style.display   = 'flex';
    content.style.display = 'none';
    _congVehSelected = null;
    return;
  }

  empty.style.display   = 'none';
  content.style.display = 'block';

  _congRenderFleetKpis(scopedRows);
  _congRenderVehTable(scopedRows);

  // Si el vehículo seleccionado sigue en el scope tras el re-render, refresca
  // su detalle; si ya no está (cambió de empresa), cierra el panel.
  if (_congVehSelected != null) {
    const stillThere = scopedRows.some(r => String(r.gps_vehicle_id) === _congVehSelected);
    if (stillThere) _congRenderVehDetail(_congVehSelected, scopedRows);
    else _congCloseVehDetail();
  }
}

// ── KPIs de flota — solo lectura de campos precomputados (Phase 0.3) ───────
function _congRenderFleetKpis(rows) {
  const container = document.getElementById('cong-kpi-row');
  if (!container) return;

  const kmVals   = rows.map(r => Number(r.km)).filter(v => !isNaN(v));
  const meccVals = rows.map(r => Number(r.mecc)).filter(v => !isNaN(v));
  const sum = arr => arr.reduce((a, b) => a + b, 0);
  const avg = arr => arr.length ? sum(arr) / arr.length : 0;

  const kpis = [
    { val: rows.length.toLocaleString(),
      lbl: 'Vehículos',     sub: 'en la flota' },
    { val: sum(kmVals).toLocaleString(undefined, { maximumFractionDigits: 0 }),
      lbl: 'Km total',      sub: 'suma de la flota' },
    { val: avg(kmVals).toFixed(1),
      lbl: 'Km promedio',   sub: 'por vehículo' },
    { val: avg(meccVals).toFixed(2),
      lbl: 'MECC promedio', sub: 'carga vial' },
  ];

  container.innerHTML = '';
  kpis.forEach(k => {
    const el = document.createElement('div');
    el.className = 'cong-kpi';
    el.innerHTML = `<div class="cong-kpi-val">${k.val}</div>
      <div class="cong-kpi-lbl">${k.lbl}</div>
      <div class="cong-kpi-sub">${k.sub}</div>`;
    container.appendChild(el);
  });
}

// ── Tabla de vehículos ordenable (clic en encabezado) ───────────────────────
function _congFmtNum(v, decimals) {
  const n = Number(v);
  if (isNaN(n)) return '—';
  const d = decimals == null ? 1 : decimals;
  return n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
}

function _congRenderVehTable(rows) {
  const container = document.getElementById('cong-veh-tabla');
  if (!container) return;

  const { col, dir } = _congVehSort;
  const colDef = _CONG_VEH_COLS.find(c => c.key === col);
  const sorted = rows.slice().sort((a, b) => {
    const va = a[col], vb = b[col];
    let cmp;
    if (colDef && colDef.num) cmp = (Number(va) || 0) - (Number(vb) || 0);
    else cmp = String(va == null ? '' : va).localeCompare(String(vb == null ? '' : vb));
    return dir === 'asc' ? cmp : -cmp;
  });

  const arrow = key => key !== col ? '' : (dir === 'asc' ? ' ▲' : ' ▼');

  let html = '<table class="cong-table"><thead><tr>';
  _CONG_VEH_COLS.forEach(c => {
    html += `<th class="cong-th-sort" onclick="_congOnSortClick('${c.key}')">${c.lbl}${arrow(c.key)}</th>`;
  });
  html += '</tr></thead><tbody>';

  sorted.forEach(r => {
    const vid    = String(r.gps_vehicle_id);
    const vidJs  = vid.replace(/'/g, "\\'");
    const isSel  = vid === _congVehSelected;
    html += `<tr class="cong-tr-veh${isSel ? ' active' : ''}" onclick="_congOnVehRowClick('${vidJs}')">
      <td>${vid}</td>
      <td class="td-num">${_congFmtNum(r.km, 1)}</td>
      <td class="td-num">${_congFmtNum(r.mecc, 2)}</td>
      <td class="td-num">${_congFmtNum(r.iev, 2)}</td>
      <td class="td-num">${_congFmtNum(r.n_pasadas, 0)}</td>
    </tr>`;
  });
  html += '</tbody></table>';
  container.innerHTML = html;
}

function _congOnSortClick(col) {
  if (_congVehSort.col === col) {
    _congVehSort = { col, dir: _congVehSort.dir === 'asc' ? 'desc' : 'asc' };
  } else {
    _congVehSort = { col, dir: 'desc' };
  }
  _congRenderVehTable(_congScopedVehRows());
}

function _congOnVehRowClick(vehicleId) {
  _congVehSelected = vehicleId;
  const scopedRows = _congScopedVehRows();
  _congRenderVehTable(scopedRows);   // refresca el resaltado de fila activa
  _congRenderVehDetail(vehicleId, scopedRows);
}

function _congCloseVehDetail() {
  _congVehSelected = null;
  const card = document.getElementById('cong-veh-detalle-card');
  if (card) card.style.display = 'none';
}

// ── Detalle de vehículo ──────────────────────────────────────────────────────
function _congRenderVehDetail(vehicleId, scopedRows) {
  const card = document.getElementById('cong-veh-detalle-card');
  const sub  = document.getElementById('cong-veh-detalle-sub');
  const body = document.getElementById('cong-veh-detalle');
  if (!card || !body) return;

  const row = scopedRows.find(r => String(r.gps_vehicle_id) === vehicleId);
  if (!row) { _congCloseVehDetail(); return; }

  card.style.display = 'block';
  if (sub) sub.textContent = `Vehículo ${vehicleId}`;

  const pct = v => v != null && !isNaN(Number(v)) ? (Number(v) * 100).toFixed(0) + '%' : '—';

  body.innerHTML = `
    <div class="cong-detalle-grid">
      <div><span class="cong-detalle-lbl">Km</span><span class="cong-detalle-val">${_congFmtNum(row.km, 1)}</span></div>
      <div><span class="cong-detalle-lbl">MECC</span><span class="cong-detalle-val">${_congFmtNum(row.mecc, 2)}</span></div>
      <div><span class="cong-detalle-lbl">IEV</span><span class="cong-detalle-val">${_congFmtNum(row.iev, 2)}</span></div>
      <div><span class="cong-detalle-lbl">N° pasadas</span><span class="cong-detalle-val">${_congFmtNum(row.n_pasadas, 0)}</span></div>
      <div><span class="cong-detalle-lbl">% vías rápidas</span><span class="cong-detalle-val">${pct(row.hwy_share)}</span></div>
      <div><span class="cong-detalle-lbl">% hora punta</span><span class="cong-detalle-val">${pct(row.peak_share)}</span></div>
    </div>
  `;
}
