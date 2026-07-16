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

let _congMap      = null;        // instancia Leaflet propia del mapa de huella (Fase 2)
let _congLayer    = null;        // L.geoJSON con los tramos de red coloreados (Fase 2)

// CONGEST_RAMP se define en la sección de mapa de huella (Fase 2), más abajo.

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

// ─── ENTRADA A CUALQUIER SUPERFICIE CONGESTIÓN (Camión o Empresa) ────────────
// Llamado desde switchSubTab (Camión) y, en PR3, desde switchCmpSubTab (Empresa).
async function congOnTabEnter() {
  await congEnsureLoaded();
}
