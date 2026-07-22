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
// SCHEMA REAL (verificado contra datos_congestion/, corrige el contrato
// congelado en design.md que asumía vehiculos.csv con una fila por vehículo):
//   - `empresas.csv`: una fila por empresa, YA agregada/precomputada upstream
//     (account_id, n_veh, km, mecc, iev, rank, hwy_share, peak_share, ...) —
//     este archivo NO debe re-derivar esas métricas.
//   - `vehiculos.csv`: una fila por VIAJE (id_viaje, owner_id, account_id,
//     km_recorridos, mecc_veh_s) — SIN agregar. El nivel Camión/Empresa se
//     arma acá sumando km_recorridos/mecc_veh_s por owner_id (única derivación
//     permitida: suma simple de estos dos campos, nunca mean/sum de otros).
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
let _congRouteLayer = null;      // L.geoJSON con la ruta GPS real del camión en foco (overlay)

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

  // ── vehiculos.csv → row[] (una fila por VIAJE, no por vehículo — schema
  // real verificado: id_viaje, owner_id, account_id, km_recorridos, mecc_veh_s) ─
  if (vehRes.status === 'fulfilled') {
    _congVehData = (vehRes.value || []).filter(r =>
      r && r.id_viaje != null && r.id_viaje !== '' && r.owner_id != null && r.owner_id !== '');
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
  // TODO: map-cong-wrap (mapa de Congestión) se mantiene oculto de forma
  // deliberada por ahora — decisión pendiente de revisar en un PR futuro.
  // if (wrap) wrap.style.display = 'block';

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

// Reubica físicamente el bloque de la huella (#map-cong-empty + #map-cong-wrap,
// que a su vez contiene #map-cong) dentro del slot de la superficie activa.
// Hoy solo 'cong-map-slot-camion' (Camión→Congestión) existe en el DOM — la
// Empresa→Congestión sub-tab que originalmente iba a reusar este mismo mapa
// vía 'cong-map-slot-empresa' fue revertida (ver design.md "Design Revision
// — Phase 4 pivot"); los KPIs de empresa ahora viven en el sub-tab Global sin
// mapa propio. Función queda genérica (recibe slotId) por si una futura
// superficie necesita reubicar el mismo mapa compartido. _congMap es una
// única instancia Leaflet (design.md: "footprint map — network-level and
// shared", sin filtro por empresa): el mismo nodo DOM se mueve al panel
// visible, dejando congInitMap()/congRenderFootprint() genuinamente sin
// modificar (siguen resolviendo 'map-cong'/'map-cong-wrap'/'map-cong-empty'
// por id fijo). No-op si el slot ya es el padre actual, o si algún elemento
// no está montado.
function _congMountFootprintMap(slotId) {
  const slot  = document.getElementById(slotId);
  const empty = document.getElementById('map-cong-empty');
  const wrap  = document.getElementById('map-cong-wrap');
  if (!slot || !empty || !wrap) return;
  if (empty.parentElement !== slot) slot.appendChild(empty);
  if (wrap.parentElement  !== slot) slot.appendChild(wrap);
}

// Overlay de la ruta GPS real del camión en foco, encima de la huella de red.
// Usa gpsLayers (gps.js) — el mismo cruce owner_id → bus_id que ya arma
// _congBuildByOwner() — así que solo dibuja algo si ese Archivo GPS ya está
// cargado (Exposición); si no hay match, la huella queda sola.
// ownerId == null → sin camión en foco (nivel Empresa): limpia el overlay y
// vuelve a encuadrar la red completa.
function _congRenderVehicleRouteOverlay(ownerId) {
  if (_congRouteLayer) {
    try { _congMap.removeLayer(_congRouteLayer); } catch (e) { /* ya removida */ }
    _congRouteLayer = null;
  }
  if (!_congMap) return;

  if (!ownerId) {
    try {
      if (_congLayer) {
        const bounds = _congLayer.getBounds();
        if (bounds.isValid()) _congMap.fitBounds(bounds, { padding: [20, 20] });
      }
    } catch (e) { /* geometría no lista aún — mantener vista actual */ }
    return;
  }

  const busIds = _congByOwner.get(String(ownerId)) || [];
  if (!busIds.length || typeof gpsLayers !== 'object' || !gpsLayers) return;
  const features = busIds.map(id => gpsLayers[id] && gpsLayers[id].feature).filter(Boolean);
  if (!features.length) return;

  _congRouteLayer = L.geoJSON(features, {
    style: { color: '#1a73e8', weight: 4, opacity: 0.95 },
  }).addTo(_congMap);

  try {
    const bounds = _congRouteLayer.getBounds();
    if (bounds.isValid()) _congMap.fitBounds(bounds, { padding: [40, 40] });
  } catch (e) { /* geometría no lista aún — mantener vista actual */ }
}

// ─── ENTRADA A CONGESTIÓN — Camión (única superficie con drill-down propio) ──
// Llamado desde switchSubTab (Camión→Congestión, sub-tab dentro del tab
// Camión). La Empresa-side integration (Phase 4) does NOT have an equivalent
// "tab enter" hook — it is a set of congestion cards embedded in the existing
// Empresa→Global sub-tab, driven by _congCompanyCardsUpdate() from
// comparativas.js's _kpiUpdateGrids(), not by its own sub-tab entry point
// (see design.md "Design Revision — Phase 4 pivot").
async function congOnTabEnter() {
  await congEnsureLoaded();
  _congMountFootprintMap('cong-map-slot-camion');
  congRenderFootprint();

  // Camión→Congestión: selector Empresa/Camión/Viaje + KPIs/tabla. No-op
  // defensivo si el panel Camión no está montado (p.ej. llamado desde Empresa
  // en un futuro PR3 antes de que exista un scope de flota).
  if (typeof _congPopulateEmpresaSel === 'function') _congPopulateEmpresaSel();
  if (typeof congRenderVehiclePanel === 'function') congRenderVehiclePanel();
}

// ══════════════════════════════════════════════════════════════════════════════
// CAMIÓN→CONGESTIÓN — selector Empresa/Camión/Viaje + KPIs/tabla/detalle
//
// `vehiculos.csv` trae una fila por VIAJE (id_viaje, owner_id, account_id,
// km_recorridos, mecc_veh_s) — no por vehículo. El scope se resuelve en
// cascada vía #cong-empresa-sel → #cong-camion-sel → #cong-viaje-sel (propios
// de Congestión, independientes del Archivo GPS/#gps-empresa-sel de arriba):
//   - Camión = "todos" → nivel EMPRESA: KPIs desde empresas.csv (ya agregado
//     upstream, no recalcular) + tabla de camiones (suma de viajes por owner_id).
//   - Viaje = "todos"  → nivel CAMIÓN: totales del camión + tabla de sus viajes.
//   - Viaje específico → nivel VIAJE: detalle de ese viaje individual.
// ══════════════════════════════════════════════════════════════════════════════

// Estado de la tabla actualmente pintada (rows/cols/sort) — reconstruido en
// cada cambio de nivel, reordenado in-place al hacer clic en un encabezado.
let _congTableState = { rows: [], cols: [], sort: { col: null, dir: 'desc' } };

function _congFmtNum(v, decimals) {
  const n = Number(v);
  if (isNaN(n)) return '—';
  const d = decimals == null ? 1 : decimals;
  return n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
}

// ── Poblado en cascada de los tres selects (Empresa → Camión → Viaje) ──────
function _congPopulateEmpresaSel() {
  const sel = document.getElementById('cong-empresa-sel');
  if (!sel) return;
  const prev = sel.value;
  const ids = Array.from(new Set(_congVehData.map(r => String(r.account_id))))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  sel.innerHTML = '<option value="">Selecciona una empresa…</option>' + ids.map(id => {
    const emp = _congEmpData.get(id);
    const label = emp && emp.n_veh != null ? `${id} (${emp.n_veh})` : id;
    return `<option value="${id}">${label}</option>`;
  }).join('');
  if (ids.includes(prev)) sel.value = prev;
}

function _congPopulateCamionSel(accountId) {
  const sel = document.getElementById('cong-camion-sel');
  if (!sel) return;
  if (!accountId) {
    sel.innerHTML = '<option value="all">Todos los camiones</option>';
    sel.disabled = true;
    return;
  }
  const owners = Array.from(new Set(
    _congVehData.filter(r => String(r.account_id) === accountId).map(r => String(r.owner_id))
  )).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  sel.innerHTML = '<option value="all">Todos los camiones</option>' +
    owners.map(id => `<option value="${id}">Camión ${id}</option>`).join('');
  sel.disabled = false;
}

function _congPopulateViajeSel(accountId, ownerId) {
  const sel = document.getElementById('cong-viaje-sel');
  if (!sel) return;
  if (!accountId || !ownerId) {
    sel.innerHTML = '<option value="all">Todos los viajes</option>';
    sel.disabled = true;
    return;
  }
  const viajes = _congVehData
    .filter(r => String(r.account_id) === accountId && String(r.owner_id) === ownerId)
    .map(r => String(r.id_viaje))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  sel.innerHTML = '<option value="all">Todos los viajes</option>' +
    viajes.map(id => `<option value="${id}">${id}</option>`).join('');
  sel.disabled = false;
}

function congOnEmpresaChange() {
  const accountId = document.getElementById('cong-empresa-sel')?.value || '';
  _congPopulateCamionSel(accountId);
  _congPopulateViajeSel(accountId, null);
  congRenderVehiclePanel();
}

function congOnCamionChange() {
  const accountId = document.getElementById('cong-empresa-sel')?.value || '';
  const ownerId   = document.getElementById('cong-camion-sel')?.value || 'all';
  _congPopulateViajeSel(accountId, ownerId === 'all' ? null : ownerId);
  congRenderVehiclePanel();
}

function congOnViajeChange() {
  congRenderVehiclePanel();
}

// Reconstruye el índice inverso owner_id → bus_id[] a partir de gpsLayers
// (gps.js). Rebuilt en cada render de la tabla — no persistido. Si Exposición
// aún no cargó datos, gpsLayers está vacío y el cruce simplemente no
// encuentra match (design.md: "sin error, re-resoluble en el próximo render").
function _congBuildByOwner() {
  _congByOwner = new Map();
  if (typeof gpsLayers !== 'object' || !gpsLayers) return;
  Object.entries(gpsLayers).forEach(([busId, entry]) => {
    const ownerId = entry && entry.feature && entry.feature.properties
      ? entry.feature.properties.owner_id : null;
    if (ownerId == null || ownerId === '') return;
    const key = String(ownerId);
    if (!_congByOwner.has(key)) _congByOwner.set(key, []);
    _congByOwner.get(key).push(busId);
  });
}

// ── ENTRADA: decide qué nivel pintar según el scope elegido en los 3 selects ─
function congRenderVehiclePanel() {
  const empty   = document.getElementById('cong-veh-empty');
  const content = document.getElementById('cong-veh-content');
  if (!empty || !content) return;   // panel Camión no montado — no-op defensivo

  const accountId  = document.getElementById('cong-empresa-sel')?.value || '';
  const companyRows = accountId ? _congVehData.filter(r => String(r.account_id) === accountId) : [];

  if (!accountId || !companyRows.length) {
    empty.style.display   = 'flex';
    content.style.display = 'none';
    _congCloseVehDetail();
    _congRenderVehicleRouteOverlay(null);
    return;
  }

  empty.style.display   = 'none';
  content.style.display = 'block';

  _congBuildByOwner();

  const ownerId = document.getElementById('cong-camion-sel')?.value || 'all';
  const viajeId = document.getElementById('cong-viaje-sel')?.value || 'all';

  _congRenderVehicleRouteOverlay(ownerId === 'all' ? null : ownerId);

  if (ownerId === 'all') {
    _congRenderEmpresaLevel(accountId, companyRows);
  } else if (viajeId === 'all') {
    _congRenderCamionLevel(accountId, ownerId, companyRows);
  } else {
    _congRenderViajeLevel(ownerId, viajeId, companyRows);
  }
}

// Agrupa filas de viaje por camión — únicas cifras derivables de vehiculos.csv
// son sumas de km_recorridos/mecc_veh_s; no hay iev/n_pasadas/hwy_share a este
// nivel de grano (esos solo existen agregados por empresa en empresas.csv).
function _congAggByOwner(rows) {
  const map = new Map();
  rows.forEach(r => {
    const id = String(r.owner_id);
    if (!map.has(id)) map.set(id, { owner_id: id, km: 0, mecc: 0, n_viajes: 0 });
    const acc = map.get(id);
    acc.km       += Number(r.km_recorridos) || 0;
    acc.mecc     += Number(r.mecc_veh_s)    || 0;
    acc.n_viajes += 1;
  });
  return Array.from(map.values());
}

const _CONG_CAMION_COLS = [
  { key: 'owner_id', lbl: 'Camión',    num: false },
  { key: 'km',       lbl: 'Km',        num: true },
  { key: 'mecc',     lbl: 'MECC',      num: true },
  { key: 'n_viajes',  lbl: 'N° viajes', num: true },
];

const _CONG_VIAJE_COLS = [
  { key: 'id_viaje', lbl: 'Viaje', num: false },
  { key: 'km',        lbl: 'Km',   num: true },
  { key: 'mecc',      lbl: 'MECC', num: true },
];

// ── Constructor compartido de tarjetas de congestión a nivel EMPRESA ───────
// Única fuente de verdad para "cómo se ve el set de tarjetas de congestión de
// una empresa" — reusado por _congRenderEmpresaLevel (Camión→Congestión, su
// propio drill-down) y por _congCompanyCardsUpdate (integración en el sub-tab
// Global de Empresa, ver bloque más abajo). Devuelve [] si no hay fila en
// _congEmpData para ese account_id (graceful degradation — ambas superficies
// delegan a _congRenderKpis([]), que limpia el container sin lanzar).
function _congBuildCompanyCards(accountId) {
  const emp = _congEmpData.get(accountId);
  const cards = [];
  if (!emp) return cards;

  if (emp.iev != null && emp.iev_global) {
    const iev    = Number(emp.iev);
    const global = Number(emp.iev_global);
    const diffPct = ((iev - global) / global) * 100;
    cards.push({
      kind: 'bar', lbl: 'IEV', val: _congFmtNum(iev, 3),
      fillPct: (iev / global) * 100, scaleMin: '0', scaleMax: `ciudad ${_congFmtNum(global, 4)}`,
      delta: {
        arrow: diffPct <= 0 ? '▼' : '▲',
        cls: diffPct <= 0 ? 'good' : 'bad',
        text: `${_congFmtNum(Math.abs(diffPct), 0)}% vs promedio ciudad`,
      },
    });
  }
  cards.push({ kind: 'stat', lbl: 'MECC', val: _congFmtNum(emp.mecc, 2), desc: ['carga vial acumulada de la empresa'] });
  cards.push({ kind: 'stat', lbl: 'Distancia', val: _congFmtNum(emp.km, 0), unit: 'km', desc: ['km recorridos en la red'] });
  cards.push({ kind: 'stat', lbl: 'Vehículos', val: emp.n_veh != null ? String(emp.n_veh) : '—', desc: ['en la flota'] });
  if (emp.rank != null && emp.n_comparables) {
    const rank = Number(emp.rank), total = Number(emp.n_comparables);
    const percentile = Math.round(((total - rank) / total) * 100);
    cards.push({
      kind: 'rank', lbl: 'Ranking ciudad', val: String(rank), unit: `/ ${total}`,
      fillPct: ((total - rank) / total) * 100,
      desc: [`más eficiente que el ${percentile}% de operadores comparables`],
    });
  }
  // hwy_share / peak_share — porcentajes 0-100 acotados (a diferencia de
  // MECC/Km/Vehículos, que no tienen techo natural). 'stat' plano (no 'bar')
  // porque no hay una referencia externa contra la cual barrear el fill —
  // 'bar' en este módulo siempre representa "valor vs escala/otro punto"
  // (IEV vs iev_global, rank vs total); acá solo hay el propio porcentaje,
  // así que una barra de 0-100% no agregaría información sobre una cifra que
  // ya es, por definición, un porcentaje — el % en el valor ya comunica la
  // proporción sin necesitar refuerzo visual redundante.
  if (emp.hwy_share != null && !isNaN(Number(emp.hwy_share))) {
    cards.push({
      kind: 'stat', lbl: '% vías rápidas', val: _congFmtNum(Number(emp.hwy_share) * 100, 0), unit: '%',
      desc: ['proporción de la carga vial en autopistas/vías rápidas'],
    });
  }
  if (emp.peak_share != null && !isNaN(Number(emp.peak_share))) {
    cards.push({
      kind: 'stat', lbl: '% hora punta', val: _congFmtNum(Number(emp.peak_share) * 100, 0), unit: '%',
      desc: ['proporción de la carga vial concentrada en horas punta'],
    });
  }
  return cards;
}

// ── Nivel EMPRESA (Camión = "todos") — KPIs desde empresas.csv (precomputado,
// nunca recalculado) + tabla de camiones agregada desde vehiculos.csv ──────
function _congRenderEmpresaLevel(accountId, companyRows) {
  _congRenderKpis(_congBuildCompanyCards(accountId));

  _congRenderTable(_congAggByOwner(companyRows), _CONG_CAMION_COLS, 'km', row => {
    const sel = document.getElementById('cong-camion-sel');
    if (sel) { sel.value = row.owner_id; congOnCamionChange(); }
  });
  _congCloseVehDetail();
}

// ── Nivel CAMIÓN (Viaje = "todos") — totales del camión + tabla de viajes ──
function _congRenderCamionLevel(accountId, ownerId, companyRows) {
  const rows = companyRows.filter(r => String(r.owner_id) === ownerId);
  const km   = rows.reduce((a, r) => a + (Number(r.km_recorridos) || 0), 0);
  const mecc = rows.reduce((a, r) => a + (Number(r.mecc_veh_s) || 0), 0);
  const emp  = _congEmpData.get(accountId);

  const meccDesc = ['carga vial del camión'];
  if (emp && emp.mecc) {
    meccDesc.push(`${_congFmtNum((mecc / emp.mecc) * 100, 0)}% del MECC de la empresa`);
  }

  _congRenderKpis([
    { kind: 'stat', lbl: 'Viajes',     val: String(rows.length), desc: [`registrados para el camión ${ownerId}`] },
    { kind: 'stat', lbl: 'Km total',   val: _congFmtNum(km, 1),  unit: 'km', desc: ['suma de los viajes del camión'] },
    { kind: 'stat', lbl: 'MECC total', val: _congFmtNum(mecc, 2), desc: meccDesc },
  ]);

  const table = rows.map(r => ({
    id_viaje: String(r.id_viaje),
    km: Number(r.km_recorridos) || 0,
    mecc: Number(r.mecc_veh_s) || 0,
  }));
  _congRenderTable(table, _CONG_VIAJE_COLS, 'km', row => {
    const sel = document.getElementById('cong-viaje-sel');
    if (sel) { sel.value = row.id_viaje; congOnViajeChange(); }
  });

  _congRenderDetailCard(`Camión ${ownerId}`, [
    ['Km total', _congFmtNum(km, 1)],
    ['MECC total', _congFmtNum(mecc, 2)],
    ['N° viajes', String(rows.length)],
  ]);
}

// ── Nivel VIAJE — detalle de un único viaje ─────────────────────────────────
function _congRenderViajeLevel(ownerId, viajeId, companyRows) {
  _congRenderKpis([]);
  const tabla = document.getElementById('cong-veh-tabla');
  if (tabla) tabla.innerHTML = '';

  const row = companyRows.find(r => String(r.owner_id) === ownerId && String(r.id_viaje) === viajeId);
  if (!row) { _congCloseVehDetail(); return; }

  _congRenderDetailCard(`Viaje ${viajeId}`, [
    ['Km recorridos', _congFmtNum(row.km_recorridos, 1)],
    ['MECC', _congFmtNum(row.mecc_veh_s, 2)],
  ]);
}

// ── KPIs — cifras ya armadas por el nivel que llama (sin recalcular acá) ───
// Tres formas de tarjeta, según `kind`:
//   'stat' — valor + líneas de descripción (MECC, Km, Vehículos, Viajes)
//   'bar'  — valor + barra de progreso 0→escala + línea de variación (IEV)
//   'rank' — valor "N / total" + barra de posición + descripción (Ranking)
// `containerId` opcional (default 'cong-kpi-row', usado por Camión→
// Congestión vía #cong-kpi-row). La integración de Empresa (Global sub-tab,
// ver bloque _congCompanyCardsUpdate() más abajo) reusa esta MISMA función
// pasando 'cmp-cong-kpi-row-a'/'cmp-cong-kpi-row-b' como containerId — no
// hay un sistema de tarjetas separado para esa superficie, ambas comparten
// _congBuildCompanyCards() + _congRenderKpis().
function _congRenderKpis(cards, containerId) {
  const container = document.getElementById(containerId || 'cong-kpi-row');
  if (!container) return;
  container.innerHTML = '';
  cards.forEach(c => {
    const el = document.createElement('div');
    el.className = 'cong-kpi';

    let html = `<div class="cong-kpi-lbl">${c.lbl}</div>
      <div class="cong-kpi-val">${c.val}${c.unit ? `<span class="cong-kpi-unit">${c.unit}</span>` : ''}</div>`;

    if (c.kind === 'bar' || c.kind === 'rank') {
      const pct = Math.max(0, Math.min(100, c.fillPct || 0));
      const fillClass = c.kind === 'rank' ? 'rank' : '';
      html += `<div class="cong-kpi-bar"><div class="cong-kpi-bar-fill ${fillClass}" style="width:${pct}%"></div></div>`;
      if (c.scaleMin != null && c.scaleMax != null) {
        html += `<div class="cong-kpi-bar-scale"><span>${c.scaleMin}</span><span>${c.scaleMax}</span></div>`;
      }
    }
    if (c.delta) {
      html += `<div class="cong-kpi-delta ${c.delta.cls}">${c.delta.arrow} ${c.delta.text}</div>`;
    }
    (c.desc || []).forEach(line => { html += `<div class="cong-kpi-desc">${line}</div>`; });

    el.innerHTML = html;
    container.appendChild(el);
  });
}

// ── Tabla ordenable genérica (camiones o viajes según el nivel activo) ─────
// Usa delegación de eventos con índice de fila en vez de onclick inline con
// IDs interpolados — evita el escapado frágil de comillas en el markup.
function _congRenderTable(rows, cols, defaultCol, onRowClick) {
  _congTableState = { rows, cols, onRowClick, sort: { col: defaultCol, dir: 'desc' } };
  _congPaintTable();
}

function _congPaintTable() {
  const container = document.getElementById('cong-veh-tabla');
  if (!container) return;

  const { rows, cols, sort, onRowClick } = _congTableState;
  const colDef = cols.find(c => c.key === sort.col);
  const sorted = rows.slice().sort((a, b) => {
    const va = a[sort.col], vb = b[sort.col];
    const cmp = colDef && colDef.num
      ? (Number(va) || 0) - (Number(vb) || 0)
      : String(va == null ? '' : va).localeCompare(String(vb == null ? '' : vb));
    return sort.dir === 'asc' ? cmp : -cmp;
  });

  const arrow = key => key !== sort.col ? '' : (sort.dir === 'asc' ? ' ▲' : ' ▼');

  let html = '<table class="cong-table"><thead><tr>';
  cols.forEach(c => {
    html += `<th class="cong-th-sort${c.num ? ' td-num' : ''}" onclick="_congOnSortClick('${c.key}')">${c.lbl}${arrow(c.key)}</th>`;
  });
  html += '</tr></thead><tbody>';
  sorted.forEach((r, i) => {
    html += `<tr class="cong-tr-veh" data-row-idx="${i}">` +
      cols.map(c => `<td class="${c.num ? 'td-num' : ''}">${c.num ? _congFmtNum(r[c.key], 1) : r[c.key]}</td>`).join('') +
      `</tr>`;
  });
  html += '</tbody></table>';
  container.innerHTML = html;

  if (onRowClick) {
    container.querySelectorAll('.cong-tr-veh').forEach(tr => {
      tr.addEventListener('click', () => onRowClick(sorted[Number(tr.dataset.rowIdx)]));
    });
  }
}

function _congOnSortClick(col) {
  const s = _congTableState.sort;
  _congTableState.sort = (s.col === col) ? { col, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { col, dir: 'desc' };
  _congPaintTable();
}

function _congCloseVehDetail() {
  const card = document.getElementById('cong-veh-detalle-card');
  if (card) card.style.display = 'none';
}

// ── Tarjeta de detalle ───────────────────────────────────────────────────
// `rows` es una lista de pares [etiqueta, valor] ya formateados por el nivel
// que llama (camión agregado o viaje individual).
function _congRenderDetailCard(title, rows) {
  const card = document.getElementById('cong-veh-detalle-card');
  const sub  = document.getElementById('cong-veh-detalle-sub');
  const body = document.getElementById('cong-veh-detalle');
  if (!card || !body) return;

  card.style.display = 'block';
  if (sub) sub.textContent = title;

  body.innerHTML = `
    <div class="cong-detalle-grid">
      ${rows.map(([lbl, val]) => `<div><span class="cong-detalle-lbl">${lbl}</span><span class="cong-detalle-val">${val}</span></div>`).join('')}
    </div>
  `;
}

// ══════════════════════════════════════════════════════════════════════════════
// CONGESTIÓN — KPIs de empresa SIN DEPENDENCIA TEMPORAL, integrados en el
// sub-tab Global de Empresa (Phase 4, reworked twice — see design.md "Design
// Revision — Phase 4 pivot" and the later revision reworking this section).
// NOT a dedicated "Congestión" sub-tab: tried first and rejected by the user
// after seeing it in-browser (an extra panel duplicating navigation for data
// with no drill-down of its own). A velocímetro grid (gauge grid, mirroring
// comparativas.js's Ruido KPI_LIST/_kpiRenderGrid/_kpiSvgGauge) was tried
// SECOND and also rejected by the user: forcing every congestion metric into
// the same gauge visual doesn't fit metrics that are naturally a comparison
// (IEV vs city average) or a position (ranking), not a standalone dial.
//
// Current approach: REUSE the multi-format card system Camión→Congestión's
// own Empresa-level drill-down already built and proved
// (_congBuildCompanyCards → _congRenderKpis, ~line 454 of this file) — 'stat'
// for plain values (MECC, Distancia, Vehículos, % vías rápidas, % hora
// punta), 'bar' for IEV (value vs city-wide iev_global), 'rank' for the
// city ranking. Same card kinds, same .cong-kpi/.cong-kpi-row CSS as Camión's
// own #cong-kpi-row — just two new sibling containers
// (#cmp-cong-kpi-row-a/#cmp-cong-kpi-row-b) so _congRenderKpis' existing
// containerId parameter can target them directly. No gauge SVG, no
// CONG_KPI_LIST, no percentile-from-referencia.csv positioning — that whole
// apparatus existed only to feed the (now removed) gauge widget.
//
// Wired from _kpiUpdateGrids() (comparativas.js) via a guarded fire-and-forget
// call to _congCompanyCardsUpdate(), so it updates whenever the Ruido grids
// do, without blocking them.
//
// Any comparativa mode dependent on a time period (month, week, etc.) would
// belong in the Temporal sub-tab instead — but per the frozen
// congestion-data-contract, NEITHER congestion/empresas.csv NOR
// congestion/vehiculos.csv carries any period/month column, so there is
// currently no period-dependent congestion metric to integrate there. This
// is a documented fact about the current data contract, not a gap left
// unbuilt — Temporal integration becomes applicable only if/when the
// contract adds a period-dependent congestion field.
// ══════════════════════════════════════════════════════════════════════════════

// ── Actualizar las dos filas de tarjetas cuando cambia la selección de
// empresas — llamado desde _kpiUpdateGrids() (comparativas.js), mismo
// trigger que las grillas de Ruido (#cmp-emp-a/#cmp-emp-b onchange).
// congEnsureLoaded() es idempotente (short-circuita tras la primera carga),
// así que esta llamada es segura en cada cambio de selección sin refetch
// redundante. Sin fila en _congEmpData para el account_id elegido →
// _congBuildCompanyCards devuelve [] → _congRenderKpis([]) limpia el
// container (mismo comportamiento que el nivel Viaje de Camión→Congestión,
// línea ~531) — degradación graciosa, sin throw. ───────────────────────────
async function _congCompanyCardsUpdate() {
  const empA = document.getElementById('cmp-emp-a')?.value;
  const empB = document.getElementById('cmp-emp-b')?.value;

  const section = document.getElementById('cmp-cong-kpi-section');
  if (!section) return;

  if (!empA && !empB) { section.style.display = 'none'; return; }

  section.style.display = 'block';

  const headA = document.getElementById('cmp-cong-kpi-head-a');
  const headB = document.getElementById('cmp-cong-kpi-head-b');
  if (headA) headA.textContent = empA ? `Congestión — ${empA}` : 'Congestión — Empresa A';
  if (headB) headB.textContent = empB ? `Congestión — ${empB}` : 'Congestión — Empresa B';

  await congEnsureLoaded();

  if (empA) _congRenderKpis(_congBuildCompanyCards(empA), 'cmp-cong-kpi-row-a');
  if (empB) _congRenderKpis(_congBuildCompanyCards(empB), 'cmp-cong-kpi-row-b');
}
