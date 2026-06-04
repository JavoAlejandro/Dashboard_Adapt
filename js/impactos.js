'use strict';

'use strict';

const LABELS   = ['GSE AB','GSE C1a','GSE C2','GSE C3','GSE D','GSE E','<25','25–34','35–44','45–54','55–64','>65'];
const SHORT    = ['AB','C1a','C2','C3','D','E','<25','25-34','35-44','45-54','55-64','>65'];
// New CSV: one column per segment, suffix _personas, no hombres/mujeres split, no conteo
const COL_KEYS = ['gse_ab','gse_c1a','gse_c2','gse_c3','gse_d','gse_e',
                  'edad_menor_25','edad_25_34','edad_35_44','edad_45_54','edad_55_64','edad_mayor_65'];
// Two modes: promedio diario (_personas) vs total acumulado (_personas_totales)
const COL_SUFFIX = '_personas';
function colSuffix() { return COL_SUFFIX; }

const PALETTES = {
  viridis: ['#440154','#31688e','#35b779','#fde725'],
  plasma:  ['#0d0887','#7e03a8','#cc4778','#f89540','#f0f921'],
  heat:    ['#000080','#0000ff','#00ffff','#ffff00','#ff0000'],
  blues:   ['#f7fbff','#9ecae1','#2171b5','#08306b'],
  rdylgn:  ['#d73027','#fc8d59','#fee08b','#d9ef8b','#1a9850'],
};

let csvData  = null;   // { corriente: Map<h3id,row>, alternativa: Map<h3id,row> }
let activeSeg = 0;
let leafMaps  = { corr: null, alt: null };
let layerGrps = { corr: null, alt: null };
let syncing   = false;

// ── LOAD ──────────────────────────────────────────────────────────────────
function loadCSV(ev) {
  const file = ev.target.files[0];
  if (!file) return;
  document.getElementById('file-status').textContent = '⏳ Procesando…';

  Papa.parse(file, {
    header: true,
    dynamicTyping: true,
    skipEmptyLines: true,
    complete({ data: rows }) {
      const corr = new Map(), alt = new Map();
      rows.forEach(r => {
        const t  = String(r.tipo || '').trim().toLowerCase();
        const id = String(r.h3_9 || '').trim();
        if (!id) return;
        if (t.includes('corriente'))   corr.set(id, r);
        else if (t.includes('altern')) alt.set(id, r);
      });

      csvData = { corriente: corr, alternativa: alt };

      // Total personas por tipo (sum across all segments and hexagons)
      const totalPersonas = (dataMap) => {
        let s = 0;
        dataMap.forEach(row => COL_KEYS.forEach(k => { s += parseFloat(row[k+colSuffix()]) || 0; }));
        return s;
      };

      document.getElementById('sp-ch').textContent = corr.size.toLocaleString();
      document.getElementById('sp-cc').textContent = fmtN(totalPersonas(corr));
      document.getElementById('sp-ah').textContent = alt.size.toLocaleString();
      document.getElementById('sp-ac').textContent = fmtN(totalPersonas(alt));
      document.getElementById('file-status').textContent =
        `✓ ${file.name} · corriente: ${corr.size} hex · alternativa: ${alt.size} hex`;

      initMaps();
      updateAll();
    },
    error(e) {
      document.getElementById('file-status').textContent = '✗ Error al leer CSV';
      console.error(e);
    }
  });
}

// ── H3 → polygon coords ────────────────────────────────────────────────────
// h3-js v4: cellToBoundary returns [[lat,lng], ...]  (WGS84)
function h3Coords(id) {
  try { return h3.cellToBoundary(id); }
  catch(e) { console.warn('H3 inválido:', id); return null; }
}

function h3Center(id) {
  try { return h3.cellToLatLng(id); }
  catch(e) { return null; }
}

// ── COLOR ──────────────────────────────────────────────────────────────────
function hexToRgb(h) { return { r:parseInt(h.slice(1,3),16), g:parseInt(h.slice(3,5),16), b:parseInt(h.slice(5,7),16) }; }
function lerpColor(t, stops) {
  const n = stops.length - 1;
  const i = Math.min(Math.floor(t * n), n - 1);
  const f = t * n - i;
  const a = hexToRgb(stops[i]), b = hexToRgb(stops[i+1]);
  return `rgb(${Math.round(a.r+(b.r-a.r)*f)},${Math.round(a.g+(b.g-a.g)*f)},${Math.round(a.b+(b.b-a.b)*f)})`;
}
function gradCSS(pal) { return `linear-gradient(to right,${pal.join(',')})`; }

// ── GET VALUE ──────────────────────────────────────────────────────────────
function getVal(row, si) {
  // New CSV: single column per segment, already absolute (personas)
  const k = COL_KEYS[si];
  return parseFloat(row[k + colSuffix()]) || 0;
}

// ── INIT MAPS ──────────────────────────────────────────────────────────────
function initMaps() {
  // Center from union of all H3 ids
  let sLat=0, sLon=0, cnt=0;
  new Set([...csvData.corriente.keys(), ...csvData.alternativa.keys()]).forEach(id => {
    const c = h3Center(id);
    if (c) { sLat += c[0]; sLon += c[1]; cnt++; }
  });
  const cLat = cnt ? sLat/cnt : -23.65;
  const cLon = cnt ? sLon/cnt : -70.40;

  ['corr','alt'].forEach(key => {
    document.getElementById(`map-${key}-empty`).style.display = 'none';
    document.getElementById(`map-${key}`).style.display = 'block';
    if (leafMaps[key]) { leafMaps[key].remove(); leafMaps[key] = null; }

    const map = L.map(`map-${key}`, {
      zoomControl: key === 'corr',
      attributionControl: false,
      preferCanvas: false   // SVG for polygons
    }).setView([cLat, cLon], 13);

    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      subdomains:'abcd', maxZoom:19
    }).addTo(map);

    leafMaps[key]  = map;
    layerGrps[key] = L.layerGroup().addTo(map);
    setTimeout(() => map.invalidateSize(), 80);
  });

  // Sync pan/zoom both ways
  syncing = false;
  ['corr','alt'].forEach(src => {
    const tgt = src === 'corr' ? 'alt' : 'corr';
    leafMaps[src].on('move', () => {
      if (syncing) return;
      syncing = true;
      leafMaps[tgt].setView(leafMaps[src].getCenter(), leafMaps[src].getZoom(), {animate:false});
      syncing = false;
    });
  });
}

// ── RENDER MAPS ────────────────────────────────────────────────────────────
function renderMaps() {
  if (!csvData) return;

  const si      = activeSeg;
  const palette = PALETTES[document.getElementById('sel-pal').value];
  const segLbl = LABELS[si];

  document.getElementById('lbl-corr').textContent = segLbl;
  document.getElementById('lbl-alt').textContent  = segLbl;

  // Shared global min/max (log scale)
  let gMin = Infinity, gMax = -Infinity;
  [csvData.corriente, csvData.alternativa].forEach(m => m.forEach(row => {
    const v = getVal(row, si);
    if (isFinite(v) && v > 0) { if (v < gMin) gMin = v; if (v > gMax) gMax = v; }
  }));
  const logMin   = Math.log(gMin > 0 ? gMin : 1e-9);
  const logMax   = Math.log(gMax > 0 ? gMax : 1);
  const logRange = logMax - logMin || 1;

  const sets = { corr: csvData.corriente, alt: csvData.alternativa };
  Object.entries(sets).forEach(([key, dataMap]) => {
    layerGrps[key].clearLayers();
    dataMap.forEach((row, h3id) => {
      const coords = h3Coords(h3id);
      if (!coords || coords.length < 3) return;
      const val    = getVal(row, si);
      const logVal = val > 0 ? Math.log(val) : logMin;
      const t      = Math.max(0, Math.min(1, (logVal - logMin) / logRange));
      const col    = lerpColor(t, palette);

      L.polygon(coords, {
        fillColor: col, fillOpacity: 0.80,
        color: '#0000001a', weight: 0.5
      })
      .bindTooltip(
        `<b style="font-family:'Syne Mono',monospace;font-size:11px">${h3id}</b><br>` +
        `${segLbl}: <b>${val.toFixed(2)} personas</b>`,
        { sticky: true, className: 'leaflet-tip' }
      )
      .addTo(layerGrps[key]);
    });
    setTimeout(() => leafMaps[key].invalidateSize(), 40);
  });

  // Colorbar
  document.getElementById('cb-row').classList.add('vis');
  document.getElementById('cb-bar').style.background = gradCSS(palette);
  document.getElementById('cb-note').textContent = `${segLbl} · escala logarítmica · personas`;

  // Log-spaced tick labels
  const ticks = document.getElementById('cb-ticks');
  const nTicks = 5;
  let tickHTML = '';
  for (let i = 0; i <= nTicks; i++) {
    const t = i / nTicks;
    const rv = Math.exp(logMin + t * logRange);
    tickHTML += `<span>${rv >= 10 ? rv.toFixed(1) : rv >= 1 ? rv.toFixed(2) : rv.toFixed(3)}</span>`;
  }
  ticks.innerHTML = tickHTML;
}

// ── UI CONTROLS ────────────────────────────────────────────────────────────
function selectCat(btn) {
  document.querySelectorAll('.cat-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  activeSeg = parseInt(btn.dataset.idx);
  document.getElementById('mcat-title').textContent = LABELS[activeSeg];
  updateAll();
}

// gender selection removed — single _personas column

// ── CHARTS ─────────────────────────────────────────────────────────────────
Chart.defaults.color = '#9a9590';
Chart.defaults.font.family = "'Epilogue', sans-serif";
const GRID = { color:'rgba(0,0,0,0.05)', drawBorder:false };
const TICK = { color:'#9a9590', font:{ size:10, family:"'Syne Mono', monospace" } };
const TTIP = {
  backgroundColor:'#fff', borderColor:'#d8d4ce', borderWidth:1,
  titleColor:'#1a1814', bodyColor:'#4a4640',
  titleFont:{ family:"'Syne Mono',monospace", size:11 }
};

let chartBars = null, chartRadar = null;

// Sum total personas per segment across all hexagons
function segTotals() {
  if (!csvData) return { corr: Array(12).fill(0), alt: Array(12).fill(0) };
  const sum = (dataMap) => COL_KEYS.map(k => {
    let s = 0;
    dataMap.forEach(row => { s += parseFloat(row[k + colSuffix()]) || 0; });
    return s;
  });
  return { corr: sum(csvData.corriente), alt: sum(csvData.alternativa) };
}

function mkBars(d) {
  return [
    { label:'Corriente',   data:d.corr, backgroundColor:'#c0392b33', borderColor:'#c0392b', borderWidth:1.5, borderRadius:2 },
    { label:'Alternativa', data:d.alt,  backgroundColor:'#1a6b4a33', borderColor:'#1a6b4a', borderWidth:1.5, borderRadius:2 },
  ];
}

function mkRadar(d) {
  const norm = a => { const mx = Math.max(...a)||1; return a.map(v=>v/mx*100); };
  return [
    { label:'Corriente',   data:norm(d.corr), borderColor:'#c0392b', backgroundColor:'#c0392b18', borderWidth:2, pointBackgroundColor:'#c0392b', pointRadius:3 },
    { label:'Alternativa', data:norm(d.alt),  borderColor:'#1a6b4a', backgroundColor:'#1a6b4a18', borderWidth:2, pointBackgroundColor:'#1a6b4a', pointRadius:3 },
  ];
}

function buildCharts() {
  const d = segTotals();
  chartBars = new Chart(document.getElementById('chart-bars').getContext('2d'), {
    type:'bar', data:{ labels:SHORT, datasets:mkBars(d) },
    options:{ responsive:true, animation:{ duration:400 },
      plugins:{ legend:{ labels:{ color:'#4a4640', font:{size:11}, boxWidth:10, padding:14 } }, tooltip:TTIP },
      scales:{ x:{ grid:GRID, ticks:TICK }, y:{ grid:GRID, ticks:TICK, beginAtZero:true } } }
  });
  chartRadar = new Chart(document.getElementById('chart-radar').getContext('2d'), {
    type:'radar', data:{ labels:SHORT, datasets:mkRadar(d) },
    options:{ responsive:true, animation:{ duration:400 },
      plugins:{ legend:{ labels:{ color:'#4a4640', font:{size:11}, boxWidth:10 } } },
      scales:{ r:{ grid:{ color:'rgba(0,0,0,0.07)' }, angleLines:{ color:'rgba(0,0,0,0.07)' },
        ticks:{ backdropColor:'transparent', color:'#9a9590', font:{size:9} },
        pointLabels:{ color:'#4a4640', font:{size:10, family:"'Syne Mono',monospace"} } } } }
  });
}

function updateCharts() {
  const d = segTotals();
  chartBars.data.datasets  = mkBars(d);  chartBars.update();
  chartRadar.data.datasets = mkRadar(d); chartRadar.update();
  // Update chart subtitle
  document.querySelector('.ccrd.bars .csub').textContent =
    'Promedio diario por segmento · corriente vs alternativa';
  // Delta cards — total personas for active segment
  const si = activeSeg, lbl = LABELS[si];
  const fmt = v => v >= 1000 ? v.toFixed(1) : v.toFixed(2);
  document.getElementById('dc-cm').textContent = fmt(d.corr[si]);
  document.getElementById('dc-cf').textContent = fmt(d.alt[si]);
  document.getElementById('dc-am').textContent = fmt(d.corr[si] - d.alt[si]);
  document.getElementById('dc-af').textContent = ((d.alt[si]/d.corr[si]-1)*100).toFixed(1)+'%';
  ['cm','cf','am','af'].forEach(id => {
    const el = document.getElementById(`dc-${id}-s`);
    if (el) el.textContent = lbl;
  });
}

function updateAll() { updateCharts(); if (csvData) renderMaps(); }

function fmtN(v) { return v>=1e6?(v/1e6).toFixed(1)+'M':v>=1e3?(v/1e3).toFixed(1)+'K':String(Math.round(v)); }

// ── MAIN TAB SWITCH ────────────────────────────────────────────────────────
function switchTab(name, btn) {
  document.querySelectorAll('.main-tab').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('tab-' + name).classList.add('active');
  // Invalidate maps on switch so Leaflet recalculates size
  if (name === 'gps' && gpsMap) setTimeout(() => gpsMap.invalidateSize(), 80);
  if (name === 'comparativas') { if (typeof initCmpTab === 'function') initCmpTab(); if (typeof cmpMap !== 'undefined' && cmpMap) setTimeout(() => cmpMap.invalidateSize(), 80); }
  if (name === 'impactos') {
    if (leafMaps.corr) setTimeout(() => leafMaps.corr.invalidateSize(), 80);
    if (leafMaps.alt)  setTimeout(() => leafMaps.alt.invalidateSize(), 80);
  }
}

