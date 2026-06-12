
// ── EMPRESA SUB-TABS ──────────────────────────────────────────────────────
function switchCmpSubTab(name, btn) {
  document.querySelectorAll('#sub-tabs-empresa .sub-tab')
    .forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('[id^="cmp-subpanel-"]')
    .forEach(p => p.classList.remove('active'));
  const panel = document.getElementById('cmp-subpanel-' + name);
  if (panel) panel.classList.add('active');
  if (name === 'global' && typeof cmpMap !== 'undefined' && cmpMap)
    setTimeout(() => cmpMap.invalidateSize(), 80);
}

'use strict';

// Colores de empresa A/B — sincronizados con styles.css :root vars
const EMP_A = '#e8a020';   // --emp-a: dorado
const EMP_B = '#4a6fa5';   // --emp-b: azul slate

// ══════════════════════════════════════════════════════════════════════════
// COMPARATIVAS TAB
// Handles camión-vs-camión and empresa-vs-empresa comparisons
// Depends on: gpsLayers, gpsData, statsData, mesKey (from gps.js)
//             BSP_SEG_KEYS, BSP_SEG_LABELS, BSP_COLORS (from impactos.js)
// ══════════════════════════════════════════════════════════════════════════

const HIDE_CAMION_VS_CAMION = true;  // Set false to re-enable camion comparison
let cmpMap       = null;
let cmpLayerA    = null;
let cmpLayerB    = null;
let cmpOverlays  = [];    // extra layers (empresa mode all-route lines)
let cmpIdA       = null;
let cmpIdB       = null;
let cmpMode      = 'camion';
let cmpTabInited = false;

// ── Init ──────────────────────────────────────────────────────────────────
function initCmpTab() {
  if (cmpTabInited) return;
  cmpTabInited = true;
  ensureCmpMap();
  if (Object.keys(gpsLayers).length > 0) populateCmpEmpresaSels();

  // Hide Camión vs Camión mode if disabled
  if (HIDE_CAMION_VS_CAMION) {
    const btnCamion   = document.getElementById('cmp-mode-camion');
    const inputCamion = document.getElementById('cmp-camion-inputs');
    const hint        = document.getElementById('cmp-tab-hint');
    if (btnCamion)   btnCamion.style.display   = 'none';
    if (inputCamion) inputCamion.style.display  = 'none';
    // Auto-activate empresa mode
    const btnEmpresa = document.getElementById('cmp-mode-empresa');
    const inputEmp   = document.getElementById('cmp-empresa-inputs');
    if (btnEmpresa)  { btnEmpresa.classList.add('active'); btnEmpresa.style.display = ''; }
    if (inputEmp)    inputEmp.style.display = 'flex';
    if (hint)        hint.textContent = 'Selecciona dos empresas para comparar su impacto promedio';
    cmpMode = 'empresa';
  }
}

function ensureCmpMap() {
  if (cmpMap) return;
  const el = document.getElementById('cmp-map');
  if (!el) return;
  cmpMap = L.map('cmp-map', { zoomControl: true, attributionControl: false, preferCanvas: true });
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    subdomains: 'abcd', maxZoom: 19
  }).addTo(cmpMap);
}

function populateCmpEmpresaSels() {
  const empresas = [...new Set(
    Object.values(gpsLayers)
      .map(e => e.feature.properties.account_id)
      .filter(v => v != null && v !== '').map(String)
  )].sort((a, b) => a.localeCompare(b));

  ['cmp-emp-a', 'cmp-emp-b'].forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    sel.innerHTML = '<option value="">Seleccionar empresa</option>';
    empresas.forEach(emp => {
      const o = document.createElement('option');
      o.value = emp; o.textContent = emp; sel.appendChild(o);
    });
  });
  const modeBtn = document.getElementById('cmp-mode-empresa');
  if (modeBtn && empresas.length === 0) {
    modeBtn.style.opacity = '0.4';
    modeBtn.title = 'No hay account_id en los datos cargados';
  }
}

// ── Mode toggle ──────────────────────────────────────────────────────────
function setCmpMode(mode, btn) {
  cmpMode = mode;
  document.querySelectorAll('.cmp-mode-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('cmp-camion-inputs').style.display  = mode === 'camion'  ? 'flex' : 'none';
  document.getElementById('cmp-empresa-inputs').style.display = mode === 'empresa' ? 'flex' : 'none';
  const hint = document.getElementById('cmp-tab-hint');
  if (hint) hint.textContent = mode === 'camion'
    ? 'Selecciona dos camiones para comparar sus camiones día (rutas) e impactos'
    : 'Selecciona dos empresas para comparar su impacto promedio';
  cmpIdA = cmpIdB = null;
  _resetCmpResults();
}

// ── Camión search ─────────────────────────────────────────────────────────
function _resolveCmpLayerId(busVal, diaVal, mesVal) {
  const busRaw = String(busVal).trim();
  const diaRaw = String(diaVal).trim();
  const mesRaw = String(mesVal).trim();
  for (const [id, entry] of Object.entries(gpsLayers)) {
    const p = entry.feature.properties;
    const oid = String(p.owner_id != null ? p.owner_id : (p.objectId != null ? p.objectId : ''));
    if (oid !== busRaw) continue;
    if (diaRaw && String(p.dia) !== diaRaw) continue;
    if (mesRaw) {
      const rawMes = (typeof mesKey !== 'undefined' && mesKey) ? p[mesKey] : p.mes;
      if (rawMes == null) continue;
      if (String(Math.round(parseFloat(rawMes))) !== mesRaw) continue;
    }
    return id;
  }
  return null;
}

function _fmtCamionLabel(p) {
  const MC = ['','Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  const oid = p.owner_id != null ? p.owner_id : p.objectId;
  const m   = p.mes != null ? Math.round(parseFloat(p.mes)) : null;
  return 'Camion ' + oid + ' · Dia ' + p.dia + (m && m >= 1 && m <= 12 ? ' · ' + MC[m] : '');
}

function cmpSearchA() {
  const id = _resolveCmpLayerId(
    document.getElementById('cmp-bus-a').value,
    document.getElementById('cmp-dia-a').value,
    document.getElementById('cmp-mes-a').value
  );
  const badge = document.getElementById('cmp-found-a');
  if (id) {
    cmpIdA = id;
    badge.textContent = '✓ ' + _fmtCamionLabel(gpsLayers[id].feature.properties);
    badge.style.display = 'inline';
    _cmpNotif('ok', 'Camion A encontrado');
  } else {
    cmpIdA = null;
    badge.style.display = 'none';
    _cmpNotif('err', 'Camion A no encontrado — revisa ID, dia y mes');
  }
  _updateCmpGoBtn();
}

function cmpSearchB() {
  const id = _resolveCmpLayerId(
    document.getElementById('cmp-bus-b').value,
    document.getElementById('cmp-dia-b').value,
    document.getElementById('cmp-mes-b').value
  );
  const badge = document.getElementById('cmp-found-b');
  if (id) {
    cmpIdB = id;
    badge.textContent = '✓ ' + _fmtCamionLabel(gpsLayers[id].feature.properties);
    badge.style.display = 'inline';
    _cmpNotif('ok', 'Camion B encontrado');
  } else {
    cmpIdB = null;
    badge.style.display = 'none';
    _cmpNotif('err', 'Camion B no encontrado — revisa ID, dia y mes');
  }
  _updateCmpGoBtn();
}

function _updateCmpGoBtn() {
  const btn = document.getElementById('cmp-go-btn');
  if (btn) btn.style.display = (cmpIdA && cmpIdB) ? 'inline-flex' : 'none';
}

// ── Empresa mode ──────────────────────────────────────────────────────────
function onCmpEmpChange() {
  const a = document.getElementById('cmp-emp-a').value;
  const b = document.getElementById('cmp-emp-b').value;
  const btn = document.getElementById('cmp-emp-go-btn');
  if (btn) btn.style.display = (a && b && a !== b) ? 'inline-flex' : 'none';
}

// ── Map helpers ───────────────────────────────────────────────────────────
function _resetCmpResults() {
  if (cmpMap) {
    if (cmpLayerA) { try { cmpMap.removeLayer(cmpLayerA); } catch {} cmpLayerA = null; }
    if (cmpLayerB) { try { cmpMap.removeLayer(cmpLayerB); } catch {} cmpLayerB = null; }
    cmpOverlays.forEach(l => { try { cmpMap.removeLayer(l); } catch {} });
    cmpOverlays = [];
  }
  const mapArea  = document.getElementById('cmp-map-area');
  const mapEmpty = document.getElementById('cmp-map-empty');
  if (mapArea)  mapArea.style.display  = 'none';
  if (mapEmpty) mapEmpty.style.display = 'block';
}

function _cmpNotif(type, msg) {
  const el = document.getElementById('cmp-notif-tab');
  if (!el) return;
  el.className = 'srch-notif ' + (type === 'ok' ? 'notif-ok' : 'notif-err');
  el.textContent = msg;
  el.style.display = 'block';
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.display = 'none'; }, 4000);
}

// ── Run: camion vs camion ─────────────────────────────────────────────────
// ── Compute average stat vals for a list of layer IDs ──────────────────────
function _avgStatsForIds(ids) {
  if (typeof statsData === 'undefined') return BSP_SEG_KEYS.map(() => null);
  const rows = ids.map(id => {
    // Resolve statsData key from layer properties (layer IDs include hora suffix)
    const entry = gpsLayers[id];
    if (!entry) return statsData[id];
    const p   = entry.feature.properties;
    const oid = String(p.owner_id ?? p.objectId ?? '');
    const dia = String(p.dia ?? '');
    const mes = p.mes != null ? String(Math.round(parseFloat(p.mes))) : null;
    const ano = p.ano != null ? p.ano : (p.anio ?? p.year ?? null);
    return (mes ? statsData[`${oid}_${dia}_${mes}`] : null)
        || statsData[`${oid}_${dia}`]
        || statsData[id];
  }).filter(Boolean);
  if (!rows.length) return BSP_SEG_KEYS.map(() => null);
  return BSP_SEG_KEYS.map(k => {
    const vals = rows.map(r => parseFloat(r[k])).filter(v => !isNaN(v));
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  });
}

function runComparativa() {
  if (!cmpIdA || !cmpIdB) return;
  ensureCmpMap();

  document.getElementById('cmp-map-empty').style.display = 'none';
  document.getElementById('cmp-map-area').style.display  = 'block';

  if (cmpLayerA) try { cmpMap.removeLayer(cmpLayerA); } catch {}
  if (cmpLayerB) try { cmpMap.removeLayer(cmpLayerB); } catch {}
  cmpOverlays.forEach(l => { try { cmpMap.removeLayer(l); } catch {} });
  cmpOverlays = [];

  const entA = gpsLayers[cmpIdA];
  const entB = gpsLayers[cmpIdB];

  cmpLayerA = L.polyline(entA.coords, { color: EMP_A, weight: 4, opacity: 0.9 }).addTo(cmpMap);
  cmpLayerB = L.polyline(entB.coords, { color: EMP_B, weight: 4, opacity: 0.9 }).addTo(cmpMap);

  const mkr = (ll, color, lbl) => {
    cmpOverlays.push(
      L.circleMarker(ll, { radius: 7, fillColor: color, fillOpacity: 1, color: '#fff', weight: 2 })
        .addTo(cmpMap).bindTooltip(lbl)
    );
  };
  mkr(entA.coords[0],                    EMP_A, 'Inicio A');
  mkr(entA.coords[entA.coords.length-1], EMP_A, 'Fin A');
  mkr(entB.coords[0],                    EMP_B, 'Inicio B');
  mkr(entB.coords[entB.coords.length-1], EMP_B, 'Fin B');

  cmpMap.fitBounds(L.latLngBounds([...entA.coords, ...entB.coords]), { padding: [40, 40] });
  setTimeout(() => cmpMap.invalidateSize(), 200);

  const lA = _fmtCamionLabel(entA.feature.properties);
  const lB = _fmtCamionLabel(entB.feature.properties);

  // Reset panel before rendering (clears empresa comparison if previously shown)
  const _panel = document.getElementById('cmp-panel-emp');
  if (_panel) { _panel.innerHTML = ''; _panel.style.display = 'none'; }

  _renderCmpCols(
    { label: lA, vals: _avgStatsForIds([cmpIdA]), color: EMP_A, n: null },
    { label: lB, vals: _avgStatsForIds([cmpIdB]), color: EMP_B, n: null }
  );

  const animBar = document.getElementById('cmp-anim-bar');
  if (animBar) animBar.style.display = 'flex';
  const title = document.getElementById('cmp-panel-title');
  if (title) title.textContent = 'Comparativa de camiones';
  const hint = document.getElementById('cmp-tab-hint');
  if (hint) hint.textContent = 'Camiones día (rutas): dorado (A) y azul (B)';
}

// ── Run: empresa vs empresa ───────────────────────────────────────────────
function runComparativaEmpresas() {
  const empA = document.getElementById('cmp-emp-a').value;
  const empB = document.getElementById('cmp-emp-b').value;
  if (!empA || !empB || empA === empB) {
    _cmpNotif('err', 'Selecciona dos empresas diferentes'); return;
  }
  ensureCmpMap();

  const idsA = Object.keys(gpsLayers).filter(id =>
    String(gpsLayers[id].feature.properties.account_id || '') === empA);
  const idsB = Object.keys(gpsLayers).filter(id =>
    String(gpsLayers[id].feature.properties.account_id || '') === empB);

  if (!idsA.length || !idsB.length) {
    _cmpNotif('err', 'Una empresa no tiene camiones día (rutas) cargadas'); return;
  }

  document.getElementById('cmp-map-empty').style.display = 'none';
  document.getElementById('cmp-map-area').style.display  = 'block';

  // Clear map
  if (cmpLayerA) try { cmpMap.removeLayer(cmpLayerA); } catch {}
  if (cmpLayerB) try { cmpMap.removeLayer(cmpLayerB); } catch {}
  cmpOverlays.forEach(l => { try { cmpMap.removeLayer(l); } catch {} });
  cmpOverlays = [];

  const allCoords = [];
  idsA.forEach(id => {
    const l = L.polyline(gpsLayers[id].coords, { color: EMP_A, weight: 2, opacity: 0.4 }).addTo(cmpMap);
    cmpOverlays.push(l); allCoords.push(...gpsLayers[id].coords);
  });
  idsB.forEach(id => {
    const l = L.polyline(gpsLayers[id].coords, { color: EMP_B, weight: 2, opacity: 0.4 }).addTo(cmpMap);
    cmpOverlays.push(l); allCoords.push(...gpsLayers[id].coords);
  });

  if (allCoords.length) cmpMap.fitBounds(L.latLngBounds(allCoords), { padding: [30, 30] });
  setTimeout(() => cmpMap.invalidateSize(), 200);

  // Compute metrics for each empresa
  const metricsA = _calcEmpresaMetrics(idsA);
  const metricsB = _calcEmpresaMetrics(idsB);

  _renderEmpresaCols(empA, metricsA, idsA.length, empB, metricsB, idsB.length);

  const animBar = document.getElementById('cmp-anim-bar');
  if (animBar) animBar.style.display = 'none';
  const title = document.getElementById('cmp-panel-title');
  if (title) title.textContent = empA + ' vs ' + empB;
  const hint = document.getElementById('cmp-tab-hint');
  if (hint) hint.textContent =
    idsA.length + ' camiones día (rutas) de ' + empA + '  vs  ' + idsB.length + ' camiones día (rutas) de ' + empB;
}

// ── Empresa metrics calculation ───────────────────────────────────────────
function _calcEmpresaMetrics(ids) {
  // 1. p/h promedio POR CAMIÓN/DÍA
  //    Para cada par (owner_id, dia, mes) → calcula su p/h
  //    Luego promedia esos valores por camión (media de sus días)
  //    Finalmente promedia entre camiones de la empresa
  //
  //    Estructura: phByCamionDay[oid][dayKey] = p/h de ese día
  const phByCamionDay = {};  // oid → { dayKey → p/h }

  ids.forEach(id => {
    const entry = gpsLayers[id];
    if (!entry) return;
    const p   = entry.feature.properties;
    const oid = String(p.owner_id ?? p.objectId ?? '');
    const dia = String(p.dia ?? '');
    const mes = p.mes != null ? String(Math.round(parseFloat(p.mes))) : null;
    const ano = p.ano != null ? p.ano : (p.anio ?? p.year ?? null);
    const dayKey = `${dia}_${mes ?? ''}`;

    // Resolve statsData row
    const row = (mes ? statsData[`${oid}_${dia}_${mes}`] : null)
             || statsData[`${oid}_${dia}`]
             || statsData[id];
    if (!row) return;

    // Total personas (etarios)
    const total = ['edad_menor_25_personas','edad_25_34_personas','edad_35_44_personas',
                   'edad_45_54_personas','edad_55_64_personas','edad_mayor_65_personas']
      .reduce((s, k) => s + (parseFloat(row[k]) || 0), 0);
    if (total <= 0) return;

    // Hours of operation
    const ini   = parseFloat(p.hora_inicio);
    const fin   = parseFloat(p.hora_fin);
    const horas = (!isNaN(ini) && !isNaN(fin) && fin > ini) ? (fin - ini) : null;
    if (!horas || horas <= 0) return;

    const ph = total / horas;
    if (!phByCamionDay[oid]) phByCamionDay[oid] = {};
    // If same camion+day has multiple trips, average them
    if (phByCamionDay[oid][dayKey] == null) {
      phByCamionDay[oid][dayKey] = ph;
    } else {
      phByCamionDay[oid][dayKey] = (phByCamionDay[oid][dayKey] + ph) / 2;
    }
  });

  // Average per camión (mean of its days), then average across camiones
  const phPerCamion = Object.values(phByCamionDay).map(days => {
    const vals = Object.values(days);
    return vals.reduce((a,b) => a+b, 0) / vals.length;
  });
  const avgPH = phPerCamion.length
    ? phPerCamion.reduce((a,b) => a+b, 0) / phPerCamion.length
    : null;
  const phCount = Object.values(phByCamionDay)
    .reduce((s, days) => s + Object.keys(days).length, 0);

  // 2. Promedio de días por camión
  // Use dia+mes as key to avoid collapsing same day across different months
  // e.g. día 5 of Nov and día 5 of Dec must be counted as 2 distinct days
  const byOwner = {};
  ids.forEach(id => {
    const p   = gpsLayers[id].feature.properties;
    const oid = String(p.owner_id ?? p.objectId ?? id);
    if (!byOwner[oid]) byOwner[oid] = new Set();
    if (p.dia != null) {
      const mes = p.mes != null ? String(Math.round(parseFloat(p.mes))) : '?';
      byOwner[oid].add(`${p.dia}_${mes}`);
    }
  });
  const diasPerCamion = Object.values(byOwner).map(s => s.size);
  const avgDias = diasPerCamion.length
    ? diasPerCamion.reduce((a,b) => a+b, 0) / diasPerCamion.length
    : null;
  const nCamiones = Object.keys(byOwner).length;

  // 3. Stays por camión/día: cada par (owner_id, dia) es una observación
  //    Ejemplo: camión A tiene 3 días → [10, 4, 7] → avg 7 stays/día
  //    Empresa avg = promedio de los promedios por camión
  const staysByOwnerDay = {};   // oid → { dayKey → nStays }
  ids.forEach(id => {
    const p   = gpsLayers[id].feature.properties;
    const oid = String(p.owner_id ?? p.objectId ?? id);
    const dia = p.dia != null ? String(p.dia) : '_';
    const mes = p.mes != null ? String(Math.round(parseFloat(p.mes))) : '_';
    const dayKey = dia + '_' + mes;
    if (!staysByOwnerDay[oid]) staysByOwnerDay[oid] = {};
    let stays = p.stays;
    if (typeof stays === 'string') { try { stays = JSON.parse(stays); } catch { stays = []; } }
    const n = Array.isArray(stays) ? stays.length : 0;
    // Accumulate stays per day (same camion+dia+mes may appear once per trip)
    staysByOwnerDay[oid][dayKey] = (staysByOwnerDay[oid][dayKey] || 0) + n;
  });
  // For each camion: avg stays across its days
  const avgStaysPerCamion = Object.values(staysByOwnerDay).map(days => {
    const vals = Object.values(days);
    return vals.length ? vals.reduce((a,b) => a+b, 0) / vals.length : 0;
  });
  const avgStays = avgStaysPerCamion.length
    ? avgStaysPerCamion.reduce((a,b) => a+b, 0) / avgStaysPerCamion.length
    : null;

  // 4. Proporciones GSE y etarias por camión
  //    Para cada camión: proporción de cada segmento = seg_personas / total_personas
  //    promediada entre sus días con datos. Luego promedio entre camiones.
  const GSE_KEYS  = ['gse_ab_personas','gse_c1a_personas','gse_c2_personas',
                     'gse_c3_personas','gse_d_personas','gse_e_personas'];
  const EDAD_KEYS = ['edad_menor_25_personas','edad_25_34_personas','edad_35_44_personas',
                     'edad_45_54_personas','edad_55_64_personas','edad_mayor_65_personas'];

  // propsByCamionDay[oid][dayKey] = { gse: [prop0..5], edad: [prop0..5] }
  const propsByCamionDay = {};

  ids.forEach(id => {
    const entry = gpsLayers[id];
    if (!entry) return;
    const p   = entry.feature.properties;
    const oid = String(p.owner_id ?? p.objectId ?? '');
    const dia = String(p.dia ?? '');
    const mes = p.mes != null ? String(Math.round(parseFloat(p.mes))) : null;
    const ano = p.ano != null ? p.ano : (p.anio ?? p.year ?? null);
    const dayKey = `${dia}_${mes ?? '?'}`;

    const row = (mes ? statsData[`${oid}_${dia}_${mes}`] : null)
             || statsData[`${oid}_${dia}`]
             || statsData[id];
    if (!row) return;

    const gseVals  = GSE_KEYS.map(k  => parseFloat(row[k])  || 0);
    const edadVals = EDAD_KEYS.map(k => parseFloat(row[k]) || 0);
    const gseTotal  = gseVals.reduce((a,b)  => a+b, 0);
    const edadTotal = edadVals.reduce((a,b) => a+b, 0);
    if (gseTotal <= 0) return;

    if (!propsByCamionDay[oid]) propsByCamionDay[oid] = {};
    propsByCamionDay[oid][dayKey] = {
      gse:  gseVals.map(v  => v / gseTotal),
      edad: edadVals.map(v => edadTotal > 0 ? v / edadTotal : 0)
    };
  });

  // Average per camión across its days, then across camiones
  const camionGseAvgs  = [];  // one array[6] per camión
  const camionEdadAvgs = [];  // one array[6] per camión
  Object.values(propsByCamionDay).forEach(days => {
    const dayList = Object.values(days);
    if (!dayList.length) return;
    const avgGse  = GSE_KEYS.map((_, i)  => dayList.reduce((s,d) => s + d.gse[i],  0) / dayList.length);
    const avgEdad = EDAD_KEYS.map((_, i) => dayList.reduce((s,d) => s + d.edad[i], 0) / dayList.length);
    camionGseAvgs.push(avgGse);
    camionEdadAvgs.push(avgEdad);
  });

  const avgGseProp  = camionGseAvgs.length
    ? GSE_KEYS.map((_, i)  => camionGseAvgs.reduce((s,c)  => s + c[i],  0) / camionGseAvgs.length)
    : null;
  const avgEdadProp = camionEdadAvgs.length
    ? EDAD_KEYS.map((_, i) => camionEdadAvgs.reduce((s,c) => s + c[i], 0) / camionEdadAvgs.length)
    : null;

  const result = { avgPH, avgDias, avgStays, avgGseProp, avgEdadProp, nCamiones, nRoutes: ids.length, phCount };
  console.log('Empresa metrics:', result);
  return result;
}

// ── Render empresa comparison panel ──────────────────────────────────────
function _renderEmpresaCols(nameA, mA, nA, nameB, mB, nB) {
  // Build side objects for unified access in GSE/edad section
  const sideA = { label: nameA, ...mA, n: nA, color: EMP_A };
  const sideB = { label: nameB, ...mB, n: nB, color: EMP_B };
  console.log('_renderEmpresaCols called:', nameA, mA, nameB, mB);
  const panel = document.getElementById('cmp-panel-emp');
  console.log('cmp-panel element:', panel ? 'found, display='+panel.style.display : 'NOT FOUND');
  if (!panel) { console.error('cmp-panel NOT FOUND in DOM'); return; }

  const fmtPH = v => v == null ? '—' : v.toFixed(1) + ' p/h·día';
  const fmtD  = v => v == null ? '—' : v.toFixed(1) + ' días';
  const fmtS  = v => v == null ? '—' : v.toFixed(1) + ' stays/día';

  // Build using DOM manipulation (avoids template literal issues)
  panel.innerHTML = '';

  // Header unificado — una sola barra con ambas empresas
  const header = document.createElement('div');
  header.className = 'cmp-panel-header';
  header.innerHTML =
    '<div class="cmp-company-badge">' +
      '<div class="cmp-company-id side-a">' + nameA + '</div>' +
      '<div class="cmp-company-meta side-a">' + mA.nCamiones + ' camiones · ' + nA + ' camiones día</div>' +
    '</div>' +
    '<div class="cmp-vs-divider">VS</div>' +
    '<div class="cmp-company-badge" style="align-items:flex-end">' +
      '<div class="cmp-company-id side-b">' + nameB + '</div>' +
      '<div class="cmp-company-meta side-b">' + mB.nCamiones + ' camiones · ' + nB + ' camiones día</div>' +
    '</div>';
  panel.appendChild(header);

  // Metrics container
  const grid = document.createElement('div');
  grid.style.cssText = 'margin-top:20px;display:flex;flex-direction:column;gap:0;border:1px solid var(--border);border-radius:6px;overflow:hidden';
  panel.appendChild(grid);

  // Column headers row
  const hdrRow = _mkRow(grid, true);
  _mkCell(hdrRow, '', 'flex:2;background:var(--ink);color:var(--bg)');
  const hA = _mkCell(hdrRow, nameA, 'flex:1;background:var(--ink);color:#e8a020;font-family:Syne,sans-serif;font-weight:800;font-size:13px');
  hA.innerHTML += '<br><span style="font-family:Syne Mono,monospace;font-size:9px;color:#aaa;font-weight:400">' + mA.nCamiones + ' camiones · ' + nA + ' camiones día</span>';
  _mkCell(hdrRow, 'Δ', 'width:60px;background:var(--ink);color:var(--bg);text-align:center;font-family:Syne Mono,monospace;font-size:11px');
  const hB = _mkCell(hdrRow, nameB, 'flex:1;background:var(--ink);color:#4a6fa5;font-family:Syne,sans-serif;font-weight:800;font-size:13px');
  hB.innerHTML += '<br><span style="font-family:Syne Mono,monospace;font-size:9px;color:#aaa;font-weight:400">' + mB.nCamiones + ' camiones · ' + nB + ' camiones día</span>';

  // Row 1: p/h
  const r1 = _mkRow(grid, false);
  const lbl1 = _mkCell(r1, 'Personas / hora por camión / día', 'flex:2;font-family:Syne,sans-serif;font-weight:600;font-size:13px;color:var(--ink)');
  lbl1.innerHTML += '<br><span style="font-size:9px;color:var(--muted);font-family:Syne Mono,monospace">Promedio de p/h por día de operación, promediado entre camiones — ' + mA.phCount + ' / ' + mB.phCount + ' días con datos</span>';
  const v1a = _mkCell(r1, fmtPH(mA.avgPH), 'flex:1;font-family:Syne,sans-serif;font-weight:800;font-size:24px;letter-spacing:-0.02em;color:var(--bg);-webkit-text-stroke:2px ' + EMP_A + ';text-stroke:2px ' + EMP_A + ';line-height:1');
  _mkDeltaCell(r1, mA.avgPH, mB.avgPH);
  _mkCell(r1, fmtPH(mB.avgPH), 'flex:1;font-family:Syne,sans-serif;font-weight:800;font-size:24px;letter-spacing:-0.02em;color:var(--bg);-webkit-text-stroke:2px ' + EMP_B + ';text-stroke:2px ' + EMP_B + ';line-height:1');

  // Row 2: días
  const r2 = _mkRow(grid, false);
  const lbl2 = _mkCell(r2, 'Días de datos por camión', 'flex:2;font-family:Syne,sans-serif;font-weight:600;font-size:13px;color:var(--ink)');
  lbl2.innerHTML += '<br><span style="font-size:9px;color:var(--muted);font-family:Syne Mono,monospace">Promedio de días únicos por camión</span>';
  _mkCell(r2, fmtD(mA.avgDias), 'flex:1;font-family:Syne,sans-serif;font-weight:800;font-size:24px;letter-spacing:-0.02em;color:var(--bg);-webkit-text-stroke:2px ' + EMP_A + ';text-stroke:2px ' + EMP_A + ';line-height:1');
  _mkDeltaCell(r2, mA.avgDias, mB.avgDias);
  _mkCell(r2, fmtD(mB.avgDias), 'flex:1;font-family:Syne,sans-serif;font-weight:800;font-size:24px;letter-spacing:-0.02em;color:var(--bg);-webkit-text-stroke:2px ' + EMP_B + ';text-stroke:2px ' + EMP_B + ';line-height:1');

  // Row 3: stays
  const r3 = _mkRow(grid, false);
  const lbl3 = _mkCell(r3, 'Stays por camión / día', 'flex:2;font-family:Syne,sans-serif;font-weight:600;font-size:13px;color:var(--ink)');
  lbl3.innerHTML += '<br><span style="font-size:9px;color:var(--muted);font-family:Syne Mono,monospace">Paradas promedio por día de operación, promediado entre camiones</span>';
  _mkCell(r3, fmtS(mA.avgStays), 'flex:1;font-family:Syne,sans-serif;font-weight:800;font-size:24px;letter-spacing:-0.02em;color:var(--bg);-webkit-text-stroke:2px ' + EMP_A + ';text-stroke:2px ' + EMP_A + ';line-height:1');
  _mkDeltaCell(r3, mA.avgStays, mB.avgStays);
  _mkCell(r3, fmtS(mB.avgStays), 'flex:1;font-family:Syne,sans-serif;font-weight:800;font-size:24px;letter-spacing:-0.02em;color:var(--bg);-webkit-text-stroke:2px ' + EMP_B + ';text-stroke:2px ' + EMP_B + ';line-height:1');

  // ── GSE + Edad section ──────────────────────────────────────────────
  if (sideA.avgGseProp || sideB.avgGseProp) {
    const segSep = document.createElement('div');
    segSep.style.cssText = 'margin-top:24px;border-top:1px solid var(--border);padding-top:16px';
    panel.appendChild(segSep);

    // Section title + subtitle — orden correcto, sin margin-top negativo
    const segTitle = document.createElement('div');
    segTitle.style.cssText = 'font-family:Syne,sans-serif;font-weight:700;font-size:13px;color:var(--ink);margin-bottom:4px';
    segTitle.textContent = 'Distribución socioeconómica y etaria';
    segSep.appendChild(segTitle);

    const segSub = document.createElement('div');
    segSub.style.cssText = 'font-family:Syne Mono,monospace;font-size:9px;color:var(--muted);margin-bottom:12px;letter-spacing:0.04em';
    segSub.textContent = 'Proporción promedio por camión — ponderada entre sus días de operación';
    segSep.appendChild(segSub);

    if (typeof estPropGSE !== 'undefined' && estPropGSE) {
      const legEl = document.createElement('div');
      legEl.style.cssText = 'font-family:Syne Mono,monospace;font-size:9px;color:var(--muted);margin-bottom:12px;letter-spacing:0.04em;display:flex;gap:12px';
      legEl.innerHTML = '<span><span class="trend-arrow trend-up">↑</span> &gt;+1pp vs estimador</span><span><span class="trend-arrow trend-down">↓</span> &lt;-1pp vs estimador</span><span><span class="trend-arrow trend-flat">—</span> dentro del rango</span>';
      segSep.appendChild(legEl);
    }
    segSep.appendChild(segSub);

    const SEG_LABELS = ['GSE AB','GSE C1a','GSE C2','GSE C3','GSE D','GSE E',
                        '<25','25–34','35–44','45–54','55–64','>65'];
    const SEG_COLORS = ['#7c3aed','#4f46e5','#2563eb','#0891b2','#059669','#16a34a',
                        '#f59e0b','#f97316','#ef4444','#ec4899','#a855f7','#6366f1'];

    // Combine GSE + edad into one 12-element array
    const valsA = [
      ...(sideA.avgGseProp  || Array(6).fill(null)),
      ...(sideA.avgEdadProp || Array(6).fill(null))
    ];
    const valsB = [
      ...(sideB.avgGseProp  || Array(6).fill(null)),
      ...(sideB.avgEdadProp || Array(6).fill(null))
    ];

    // Grid: label | bar+pct A | delta | bar+pct B
    const segGrid = document.createElement('div');
    segGrid.style.cssText = 'display:flex;flex-direction:column;gap:0;border:1px solid var(--border);border-radius:6px;overflow:hidden';
    segSep.appendChild(segGrid);

    // Header row
    const segHdr = _mkRow(segGrid, true);
    _mkCell(segHdr, 'Segmento', 'flex:1.4;background:var(--ink);color:var(--bg);font-family:Syne Mono,monospace;font-size:10px;letter-spacing:0.08em');
    _mkCell(segHdr, sideA.label, 'flex:2;background:var(--ink);color:' + EMP_A + ';font-family:Syne,sans-serif;font-weight:700;font-size:12px');
    _mkCell(segHdr, 'Δ', 'width:60px;background:var(--ink);color:var(--bg);text-align:center;font-family:Syne Mono,monospace;font-size:11px');
    _mkCell(segHdr, sideB.label, 'flex:2;background:var(--ink);color:' + EMP_B + ';font-family:Syne,sans-serif;font-weight:700;font-size:12px');

    valsA.forEach((va, i) => {
      // Separator between GSE and edad
      if (i === 6) {
        const sep = document.createElement('div');
        sep.style.cssText = 'padding:4px 16px;background:var(--bg);font-family:Syne Mono,monospace;font-size:8px;letter-spacing:0.14em;text-transform:uppercase;color:var(--muted);border-top:1px solid var(--border)';
        sep.textContent = 'Rango etario';
        segGrid.appendChild(sep);
      } else if (i === 0) {
        const gseHdr = document.createElement('div');
        gseHdr.style.cssText = 'padding:4px 16px;background:var(--bg);font-family:Syne Mono,monospace;font-size:8px;letter-spacing:0.14em;text-transform:uppercase;color:var(--muted)';
        gseHdr.textContent = 'Nivel socioeconómico';
        segGrid.appendChild(gseHdr);
      }

      const vb  = valsB[i];
      const row = _mkRow(segGrid, false);

      // Label with color dot
      const lblCell = _mkCell(row, '', 'flex:1.4;font-family:Syne Mono,monospace;font-size:11px;color:var(--ink2);flex-direction:row;align-items:center;gap:7px');
      const dot = document.createElement('div');
      dot.style.cssText = `width:8px;height:8px;border-radius:2px;background:${SEG_COLORS[i]};flex-shrink:0`;
      const lblSpan = document.createElement('span');
      lblSpan.textContent = SEG_LABELS[i];
      lblCell.appendChild(dot); lblCell.appendChild(lblSpan);

      // Get population estimator for this segment (estPropGSE/estPropEdad are global)
      const isEdad  = i >= 6;
      const estIdx  = isEdad ? i - 6 : i;
      const estProp = isEdad
        ? (typeof estPropEdad !== 'undefined' && estPropEdad ? estPropEdad[estIdx] : null)
        : (typeof estPropGSE  !== 'undefined' && estPropGSE  ? estPropGSE[estIdx]  : null);

      // Arrow helper (inline — no dependency on gps.js _trendArrow)
      function mkArrow(val, est) {
        if (val == null || est == null) return null;
        const diff = (val - est) * 100;
        const span = document.createElement('span');
        span.className = 'trend-arrow ' + (diff > 1 ? 'trend-up' : diff < -1 ? 'trend-down' : 'trend-flat');
        span.title = (diff > 0 ? '+' : '') + diff.toFixed(1) + 'pp vs estimador poblacional';
        span.textContent = diff > 1 ? '↑' : diff < -1 ? '↓' : '—';
        return span;
      }

      // Value A with bar + arrow
      const cellA = _mkCell(row, '', 'flex:2;flex-direction:column;gap:3px');
      const pctRowA = document.createElement('div');
      pctRowA.style.cssText = 'display:flex;align-items:center;gap:5px';
      const pctA = document.createElement('span');
      pctA.style.cssText = `font-family:Syne,sans-serif;font-weight:700;font-size:15px;color:${sideA.color}`;
      pctA.textContent = va != null ? (va * 100).toFixed(1) + '%' : '—';
      pctRowA.appendChild(pctA);
      const arrowA = mkArrow(va, estProp);
      if (arrowA) pctRowA.appendChild(arrowA);
      const barWrapA = document.createElement('div');
      barWrapA.style.cssText = 'height:3px;background:var(--border);border-radius:2px;overflow:hidden';
      const barA = document.createElement('div');
      barA.style.cssText = `height:100%;width:${va != null ? (va * 100).toFixed(1) : 0}%;background:${SEG_COLORS[i]};border-radius:2px;max-width:100%`;
      barWrapA.appendChild(barA);
      cellA.appendChild(pctRowA); cellA.appendChild(barWrapA);

      // Delta
      _mkDeltaCell(row, va != null ? va * 100 : null, vb != null ? vb * 100 : null);

      // Value B with bar + arrow
      const cellB = _mkCell(row, '', 'flex:2;flex-direction:column;gap:3px');
      const pctRowB = document.createElement('div');
      pctRowB.style.cssText = 'display:flex;align-items:center;gap:5px';
      const pctB = document.createElement('span');
      pctB.style.cssText = `font-family:Syne,sans-serif;font-weight:700;font-size:15px;color:${sideB.color}`;
      pctB.textContent = vb != null ? (vb * 100).toFixed(1) + '%' : '—';
      pctRowB.appendChild(pctB);
      const arrowB = mkArrow(vb, estProp);
      if (arrowB) pctRowB.appendChild(arrowB);
      const barWrapB = document.createElement('div');
      barWrapB.style.cssText = 'height:3px;background:var(--border);border-radius:2px;overflow:hidden';
      const barB = document.createElement('div');
      barB.style.cssText = `height:100%;width:${vb != null ? (vb * 100).toFixed(1) : 0}%;background:${SEG_COLORS[i]};border-radius:2px;max-width:100%`;
      barWrapB.appendChild(barB);
      cellB.appendChild(pctRowB); cellB.appendChild(barWrapB);
    });
  }

  // Show panel
  panel.style.display = 'block';
}

function _mkRow(parent, isHeader) {
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;align-items:stretch;' + (isHeader ? '' : 'border-top:1px solid var(--border)');
  parent.appendChild(row);
  return row;
}

function _mkCell(row, text, style) {
  const cell = document.createElement('div');
  cell.style.cssText = 'padding:12px 16px;display:flex;flex-direction:column;justify-content:center;gap:4px;' + style;
  cell.textContent = text;
  row.appendChild(cell);
  return cell;
}

function _mkDeltaCell(row, a, b) {
  const cell = _mkCell(row, '', 'width:80px;text-align:center;font-family:Syne Mono,monospace;font-size:12px;align-items:center;font-weight:600');
  if (a == null || b == null) { cell.textContent = '—'; return cell; }
  const d = a - b;
  const color = d > 0.05 ? '#f59e0b' : d < -0.05 ? EMP_B : '#8a867e';
  const span = document.createElement('span');
  span.style.color = color;
  span.style.fontWeight = '700';
  span.textContent = (d > 0 ? '+' : '') + d.toFixed(1);
  cell.appendChild(span);
  return cell;
}


function _cmpDelta(a, b, decimals) {
  if (a == null || b == null) return '<span style="color:var(--muted)">—</span>';
  const d = a - b;
  const color = d > 0 ? '#f59e0b' : d < 0 ? EMP_B : 'var(--muted)';
  return `<span style="color:${color};font-weight:700">${d > 0 ? '+' : ''}${d.toFixed(decimals)}</span>`;
}



// ── Camión vs Camión: render GSE + etario columns ────────────────────────
function _renderCmpCols(sideA, sideB) {
  const panel = document.getElementById('cmp-panel-emp');
  if (!panel) return;

  const fmtV = v => v == null ? '—' : (v >= 100 ? v.toFixed(0) : v.toFixed(1));
  const all  = [...sideA.vals, ...sideB.vals].filter(v => v != null);
  const maxAll = all.length ? Math.max(...all) : 1;

  panel.innerHTML = '';

  // Header
  const hdr = document.createElement('div');
  hdr.className = 'cmp-panel-header';
  const ttl = document.createElement('span');
  ttl.className = 'cmp-panel-title';
  ttl.id = 'cmp-panel-title';
  ttl.textContent = 'Comparativa de camiones día (rutas)';
  hdr.appendChild(ttl);
  panel.appendChild(hdr);

  // Two-column layout
  const cols = document.createElement('div');
  cols.className = 'cmp-cols';
  panel.appendChild(cols);

  function mkColHead(color, label) {
    const el = document.createElement('div');
    el.className = 'cmp-col-head';
    el.innerHTML = '<span style="font-family:Syne,sans-serif;font-weight:800;font-size:13px;color:' + color + '">' + label + '</span>';
    return el;
  }

  const colA = document.createElement('div'); colA.className = 'cmp-col cmp-col-a';
  const cardsA = document.createElement('div'); cardsA.className = 'cmp-col-cards';
  colA.appendChild(mkColHead(sideA.color, sideA.label)); colA.appendChild(cardsA);
  cols.appendChild(colA);

  const deltasCol = document.createElement('div'); deltasCol.className = 'cmp-col-dividers';
  cols.appendChild(deltasCol);

  const colB = document.createElement('div'); colB.className = 'cmp-col cmp-col-b';
  const cardsB = document.createElement('div'); cardsB.className = 'cmp-col-cards';
  colB.appendChild(mkColHead(sideB.color, sideB.label)); colB.appendChild(cardsB);
  cols.appendChild(colB);

  function renderCards(container, vals) {
    container.innerHTML = '';
    const gseLbl = document.createElement('span');
    gseLbl.className = 'gss-section-lbl'; gseLbl.textContent = 'Nivel socioeconómico';
    container.appendChild(gseLbl);
    vals.forEach((v, i) => {
      if (i === 6) {
        const sep = document.createElement('hr'); sep.className = 'gss-section-sep'; container.appendChild(sep);
        const edLbl = document.createElement('span'); edLbl.className = 'gss-section-lbl'; edLbl.textContent = 'Rango etario'; container.appendChild(edLbl);
      }
      const pct = maxAll > 0 && v != null ? (v / maxAll * 100) : 0;
      const wrap = document.createElement('div'); wrap.style.cssText = 'display:flex;flex-direction:column;gap:2px';
      wrap.innerHTML =
        '<div class="gss-card"><div class="gss-card-dot" style="background:' + BSP_COLORS[i] + '"></div>' +
        '<span class="gss-card-lbl">' + BSP_SEG_LABELS[i] + '</span>' +
        '<span class="gss-card-val">' + fmtV(v) + '</span></div>' +
        '<div class="gss-bar-wrap"><div class="gss-bar-fill" style="width:' + pct + '%;background:' + BSP_COLORS[i] + '"></div></div>';
      container.appendChild(wrap);
    });
  }

  renderCards(cardsA, sideA.vals);
  renderCards(cardsB, sideB.vals);

  // Deltas
  deltasCol.innerHTML = '';
  sideA.vals.forEach((va, i) => {
    if (i === 6) {
      const sep = document.createElement('hr'); sep.className = 'gss-section-sep'; sep.style.visibility = 'hidden'; deltasCol.appendChild(sep);
    }
    const vb = sideB.vals[i];
    const diff = (va != null && vb != null) ? va - vb : null;
    const el = document.createElement('div'); el.className = 'cmp-delta';
    if (diff == null) {
      el.innerHTML = '<span style="color:var(--muted)">—</span>';
    } else {
      const span = document.createElement('span');
      span.style.color = diff > 0 ? '#f59e0b' : diff < 0 ? EMP_B : 'var(--muted)';
      span.textContent = (diff > 0 ? '+' : '') + diff.toFixed(1);
      el.appendChild(span);
    }
    deltasCol.appendChild(el);
  });

  // Chart
  const chartWrap = document.createElement('div');
  chartWrap.className = 'bsp-chart-wrap'; chartWrap.style.marginTop = '20px';
  const canvas = document.createElement('canvas'); canvas.id = 'chart-compare'; canvas.height = 100;
  chartWrap.appendChild(canvas); panel.appendChild(chartWrap);
  panel.style.display = 'block';

  setTimeout(() => {
    if (window._cmpChart) { window._cmpChart.destroy(); window._cmpChart = null; }
    const ctxEl = document.getElementById('chart-compare');
    if (!ctxEl) return;
    window._cmpChart = new Chart(ctxEl.getContext('2d'), {
      type: 'bar',
      data: {
        labels: BSP_SEG_LABELS,
        datasets: [
          { label: sideA.label, data: sideA.vals.map(v => v || 0), backgroundColor: EMP_A + 'bb', borderRadius: 3 },
          { label: sideB.label, data: sideB.vals.map(v => v || 0), backgroundColor: EMP_B + 'bb', borderRadius: 3 },
        ]
      },
      options: {
        responsive: true,
        plugins: {
          legend: { display: true, labels: { font: { family: 'Syne Mono' }, color: '#6b6760' } },
          tooltip: { callbacks: { label: c => ' ' + (c.parsed.y || 0).toFixed(1) + ' personas' } }
        },
        scales: {
          x: { grid: { display: false }, ticks: { font: { family: 'Syne Mono', size: 9 }, color: '#8a867e' } },
          y: { grid: { color: '#ece8e0' }, ticks: { font: { family: 'Syne Mono', size: 9 }, color: '#8a867e' } }
        }
      }
    });
  }, 50);
}

// renderComparePanel alias
function renderComparePanel(idA, idB) {
  if (!gpsLayers[idA] || !gpsLayers[idB]) return;
  _renderCmpCols(
    { label: _fmtCamionLabel(gpsLayers[idA].feature.properties), vals: _avgStatsForIds([idA]), color: EMP_A },
    { label: _fmtCamionLabel(gpsLayers[idB].feature.properties), vals: _avgStatsForIds([idB]), color: EMP_B }
  );
}
