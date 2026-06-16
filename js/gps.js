'use strict';


// ── Utility: format large numbers ────────────────────────────────────────
function fmtN(v) { return v>=1e6?(v/1e6).toFixed(1)+'M':v>=1e3?(v/1e3).toFixed(1)+'k':String(v); }
// ── GPS DATA & MAP ─────────────────────────────────────────────────────────
let gpsData   = null;   // raw GeoJSON FeatureCollection
let gpsMap    = null;
let gpsLayers = {};     // bus_id → L.polyline

// ── IMPACT HEATMAP HELPERS ────────────────────────────────────────────────
// Approach: ONE L.polyline per route (no memory explosion).
// Impact coloring is painted on a single shared SVG overlay via
// a custom Leaflet layer that runs after the map tiles settle.
// Per-route impact is stored in entry.impactSegs and drawn on demand.

const IMPACT_RAMP = [
  { t: 0.00, r: 166, g: 206, b: 227 },  // azul claro   (Paired #1)
  { t: 0.20, r:  31, g: 120, b: 180 },  // azul oscuro  (Paired #2)
  { t: 0.40, r: 178, g: 223, b: 138 },  // verde claro  (Paired #3)
  { t: 0.55, r:  51, g: 160, b:  44 },  // verde oscuro (Paired #4)
  { t: 0.70, r: 253, g: 191, b: 111 },  // naranja claro(Paired #7)
  { t: 0.85, r: 227, g:  26, b:  28 },  // rojo         (Paired #6)
  { t: 1.00, r: 106, g:  61, b: 154 },  // vino/morado  (Paired #9)
];

function _impactColor(norm) {
  let lo = IMPACT_RAMP[0], hi = IMPACT_RAMP[IMPACT_RAMP.length - 1];
  for (let i = 1; i < IMPACT_RAMP.length; i++) {
    if (norm <= IMPACT_RAMP[i].t) { lo = IMPACT_RAMP[i - 1]; hi = IMPACT_RAMP[i]; break; }
  }
  const range = hi.t - lo.t || 1;
  const f = (norm - lo.t) / range;
  return `rgb(${Math.round(lo.r+(hi.r-lo.r)*f)},${Math.round(lo.g+(hi.g-lo.g)*f)},${Math.round(lo.b+(hi.b-lo.b)*f)})`;
}

function _parseViasConIndices(props) {
  let v = props.vias_con_indices;
  if (!v) return null;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return null; } }
  if (!Array.isArray(v) || v.length === 0) return null;
  if (v[0].desde === undefined) return null;
  return v.some(s => s.personas_hora != null && s.personas_hora > 0) ? v : null;
}

// Pre-compute normalized impact data for a route.
// Returns lightweight array of {desde, hasta, norm, color} or null.
// NO Leaflet objects created here — just plain data.
function parseImpactData(props) {
  const segs = _parseViasConIndices(props);
  if (!segs) return null;
  const vals = segs.map(s => s.personas_hora || 0);
  const maxV = Math.max(...vals);
  const minV = Math.min(...vals.filter(v => v > 0), maxV);
  const range = maxV - minV || 1;
  return segs.map(seg => {
    const ph   = seg.personas_hora || 0;
    const norm = maxV > 0 ? Math.max(0, Math.min(1, (ph - minV) / range)) : 0;
    return { desde: seg.desde, hasta: seg.hasta, norm, color: _impactColor(norm) };
  });
}

// ── Single shared canvas overlay for impact drawing ──────────────────────
// Key insight: Leaflet's overlayPane is repositioned via CSS transform during
// pan/zoom animations. We must counter that transform so our canvas stays aligned.
// Solution: place canvas in a NEW pane (not overlayPane) at z-index between
// tilePane and overlayPane, OR use the map container directly and reposition.
// Simplest correct approach: use map.latLngToContainerPoint() instead of
// map.project() - this always returns coords relative to the map container,
// regardless of pane transforms.

let _impactCanvas    = null;
let _impactCtx       = null;
let _impactScheduled = false;

function _ensureImpactCanvas(map) {
  if (_impactCanvas) return;

  // Attach to map container directly (not a pane) so no pane transforms affect it
  const container = map.getContainer();
  _impactCanvas = document.createElement('canvas');
  _impactCanvas.style.cssText =
    'position:absolute;top:0;left:0;pointer-events:none;z-index:400;width:100%;height:100%';
  container.style.position = 'relative'; // ensure container is positioned
  container.appendChild(_impactCanvas);
  _impactCtx = _impactCanvas.getContext('2d');

  // Hide during zoom animation to avoid misalignment flash
  map.on('zoomstart',  () => { if (_impactCanvas) _impactCanvas.style.opacity = '0'; });
  map.on('moveend zoomend resize', () => {
    if (_impactCanvas) _impactCanvas.style.opacity = '1';
    scheduleImpactDraw(map);
  });

}  // end _ensureImpactCanvas

function scheduleImpactDraw(map) {
  if (_impactScheduled) return;
  _impactScheduled = true;
  requestAnimationFrame(() => {
    _impactScheduled = false;
    drawImpactOverlay(map);
  });
}

function drawImpactOverlay(map) {
  if (!_impactCanvas || !_impactCtx) return;

  // Match canvas pixel size to container (handles retina via devicePixelRatio)
  const container = map.getContainer();
  const dpr  = window.devicePixelRatio || 1;
  const cw   = container.clientWidth;
  const ch   = container.clientHeight;

  _impactCanvas.width  = cw * dpr;
  _impactCanvas.height = ch * dpr;

  const ctx = _impactCtx;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);  // scale for retina
  ctx.clearRect(0, 0, cw, ch);

  Object.values(gpsLayers).forEach(entry => {
    if (!entry.visible || !entry.impactData) return;
    const coords = entry.coords;
    const segs   = entry.impactData;

    segs.forEach(seg => {
      const slice = coords.slice(seg.desde, Math.min(seg.hasta + 2, coords.length));
      if (slice.length < 2) return;

      ctx.beginPath();
      ctx.strokeStyle = seg.color;
      ctx.lineWidth   = 2.5 + seg.norm * 3.5;
      ctx.globalAlpha = 0.6 + seg.norm * 0.35;
      ctx.lineCap     = 'round';
      ctx.lineJoin    = 'round';

      let started = false;
      slice.forEach(([lat, lon]) => {
        // latLngToContainerPoint always correct regardless of zoom/pan/pane transforms
        const pt = map.latLngToContainerPoint(L.latLng(lat, lon));
        if (!started) { ctx.moveTo(pt.x, pt.y); started = true; }
        else            ctx.lineTo(pt.x, pt.y);
      });
      ctx.stroke();
    });
  });
  ctx.globalAlpha = 1;
}
// ── END IMPACT HEATMAP HELPERS ────────────────────────────────────────────

function _getOrCreatePingTooltip() {
  let tip = document.getElementById('ping-tooltip');
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'ping-tooltip';
    tip.style.cssText = [
      'position:absolute', 'z-index:1000', 'pointer-events:none',
      'background:rgba(26,24,20,0.92)', 'color:#f0ece4',
      'font-family:Syne Mono,monospace', 'font-size:11px', 'font-weight:600',
      'padding:4px 10px', 'border-radius:3px',
      'white-space:nowrap', 'display:none',
      'letter-spacing:0.06em', 'box-shadow:0 2px 8px rgba(0,0,0,0.3)'
    ].join(';');
    const mapContainer = document.getElementById('map-gps');
    if (mapContainer) mapContainer.appendChild(tip);
  }
  return tip;
}

let statsData  = {};    // "objectId_dia" → row from stats CSV
let estPropGSE  = null;  // avg population proportions per GSE segment (from calcEstimadores)
let estPropEdad = null;  // avg population proportions per edad segment
let mesKey     = null;  // actual property name for mes (detected at load time)
let chartBusStats = null;

// Color palette for camion lines (distinct colors cycling)
const BUS_COLORS_CORR = ['#c0392b','#e74c3c','#c0392b','#96281b','#d98880','#f1948a'];
const BUS_COLORS_ALT  = ['#1a6b4a','#27ae60','#1e8449','#145a32','#52be80','#82e0aa'];
const BUS_COLORS_DEF  = ['#2563a8','#8e44ad','#d35400','#16a085','#f39c12','#7f8c8d',
                          '#2980b9','#8e44ad','#e67e22','#1abc9c','#e74c3c','#95a5a6'];

function busColor(feature, idx) {
  const tipo = String(feature.properties.tipo || '').toLowerCase();
  if (tipo.includes('corriente'))   return BUS_COLORS_CORR[idx % BUS_COLORS_CORR.length];
  if (tipo.includes('altern'))      return BUS_COLORS_ALT[idx % BUS_COLORS_ALT.length];
  return BUS_COLORS_DEF[idx % BUS_COLORS_DEF.length];
}

// ── STATS CSV ─────────────────────────────────────────────────────────────
function loadStatsCSV(ev) {
  const file = ev.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const rows = Papa.parse(e.target.result, { header: true, dynamicTyping: true, skipEmptyLines: true }).data;
    statsData = {};
    rows.forEach(r => {
      // Support all formats:
      // old:  objectId + dia            → key "1_4"
      // new:  owner_id + dia            → key "902_3"
      // new+: owner_id + dia + mes      → key "902_3_7"  (also store "902_3" for fallback)
      const id  = r.owner_id != null ? r.owner_id : r.objectId;
      const dia = r.dia;
      if (id == null || dia == null) return;
      // Primary key includes mes if present
      if (r.mes != null) {
        statsData[`${id}_${dia}_${r.mes}`] = r;
      }
      // Fallback key without mes (most recent row wins)
      statsData[`${id}_${dia}`] = r;
    });
    const n = Object.keys(statsData).length;
    const sample = rows[0] || {};
    const hasMes = sample.mes != null;
    const fmt = sample.owner_id != null
      ? `nuevo (owner_id${hasMes ? '+mes' : ''})`
      : 'clásico (objectId)';
    document.getElementById('stats-csv-status').textContent = `✓ ${rows.length} registros · formato ${fmt}`;
    document.getElementById('stats-csv-status').style.display = '';
    // Compute population estimators from all CSV rows
    calcEstimadores(rows);
    // Refresh stats panel if a camion is currently focused
    const sel = document.getElementById('gps-bus-sel').value;
    const busInput = document.getElementById('srch-bus').value.trim();
    const diaInput = document.getElementById('srch-dia').value.trim();
    const activeId = (sel && sel !== 'all') ? sel
                   : (busInput && diaInput) ? `${busInput}_${diaInput}` : null;
    const hora = document.getElementById('gps-viaje-sel') ? document.getElementById('gps-viaje-sel').value : 'all';
    const tipo = document.getElementById('gps-tipo-sel') ? document.getElementById('gps-tipo-sel').value : 'all';
    const mes  = document.getElementById('gps-mes-sel')  ? document.getElementById('gps-mes-sel').value  : 'all';
    if (activeId) {
      showBusStats(activeId);
    } else if (hora !== 'all' || tipo !== 'all' || mes !== 'all') {
      showGroupStats();
    }
  };
  reader.readAsText(file);
  ev.target.value = '';
}

// ── SHOW BUS STATS ─────────────────────────────────────────────────────────
const BSP_SEG_LABELS = ['GSE AB','GSE C1a','GSE C2','GSE C3','GSE D','GSE E','<25','25–34','35–44','45–54','55–64','>65'];
const BSP_SEG_KEYS   = ['gse_ab_personas','gse_c1a_personas','gse_c2_personas','gse_c3_personas','gse_d_personas','gse_e_personas',
                         'edad_menor_25_personas','edad_25_34_personas','edad_35_44_personas','edad_45_54_personas','edad_55_64_personas','edad_mayor_65_personas'];
const BSP_KEYS_GSE  = BSP_SEG_KEYS.slice(0, 6);   // indices 0–5
const BSP_KEYS_EDAD = BSP_SEG_KEYS.slice(6);       // indices 6–11

function setTotals(vals, horas, tiempoMuerto, tiempoMov) {
  if (!vals) {
    document.getElementById('bsp-totals').style.display = 'none';
    return;
  }
  const fmtV = v => v >= 1000 ? v.toLocaleString('es-CL', {maximumFractionDigits:0}) : v.toFixed(1);
  const fmtH = v => v == null ? '—' : (v >= 100 ? v.toFixed(0) : v.toFixed(1));

  const totalEdad   = vals.slice(6).reduce((a, b) => a + b, 0);
  const perHoraEdad = (horas && horas > 0) ? totalEdad / horas : null;

  if (perHoraEdad != null) {
    document.getElementById('bsp-total-edad').innerHTML =
      `<span class="bsp-per-hora" style="font-size:22px;padding:6px 14px">${fmtH(perHoraEdad)} p/h</span>`;
    const subEl = document.getElementById('bsp-total-sub');
    if (subEl) {
      const hayMuertos = tiempoMuerto != null && tiempoMuerto > 0.01;
      // Tiempo en movimiento: siempre visible si hay horas de operación
      const movStr = tiempoMov != null
        ? `<span style="color:#4af0a0;font-weight:700">${fmtH(tiempoMov)}h mov.</span>`
        : '';
      const muertosStr = hayMuertos
        ? `<span style="color:#e8382a">${fmtH(tiempoMuerto)}h muertos</span> · `
        : '';
      const tiempoLine = (muertosStr || movStr)
        ? `<br>${muertosStr}${movStr}` : '';
      subEl.innerHTML =
        `<span style="font-family:'Syne Mono',monospace;font-size:9px;color:var(--muted);letter-spacing:0.08em;line-height:1.8">
          ${fmtV(totalEdad)} personas · ${fmtH(horas)}h operación${tiempoLine}
        </span>`;
    }
  } else {
    document.getElementById('bsp-total-edad').innerHTML =
      `<span style="font-family:'Syne',sans-serif;font-weight:800;font-size:28px;color:var(--accent)">${fmtV(totalEdad)}</span>
       <span style="font-family:'Syne Mono',monospace;font-size:10px;color:var(--muted);margin-left:4px">personas</span>`;
    const subEl = document.getElementById('bsp-total-sub');
    if (subEl) subEl.innerHTML = '';
  }
  document.getElementById('bsp-totals').style.display = 'flex';
}
const BSP_COLORS_GSE  = ['#8b5cf6','#6366f1','#3b82f6','#0ea5e9','#06b6d4','#14b8a6'];
const BSP_COLORS_EDAD = ['#f59e0b','#f97316','#ef4444','#ec4899','#a855f7','#6366f1'];
const BSP_COLORS = [...BSP_COLORS_GSE, ...BSP_COLORS_EDAD];


// ── TREND ARROW vs ESTIMADOR POBLACIONAL ────────────────────────────────
// Returns arrow HTML span: ↑ verde si >+1pp, ↓ rojo si <-1pp, — gris si dentro
function _trendArrow(camionPct, estPct) {
  if (estPct == null || camionPct == null || isNaN(camionPct) || isNaN(estPct)) return '';
  const diff = (camionPct - estPct) * 100; // difference in percentage points
  if (diff > 1) {
    return `<span class="trend-arrow trend-up" title="Por encima del estimador (+${diff.toFixed(1)}pp)">↑</span>`;
  } else if (diff < -1) {
    return `<span class="trend-arrow trend-down" title="Por debajo del estimador (${diff.toFixed(1)}pp)">↓</span>`;
  } else {
    return `<span class="trend-arrow trend-flat" title="Dentro del rango estimado (${diff > 0 ? '+' : ''}${diff.toFixed(1)}pp)">—</span>`;
  }
}

// Compute camion % for index i given vals array (all 12 segments)
function _camionPct(vals, i) {
  // GSE total = sum of first 6, edad total = sum of last 6
  // Use the appropriate total depending on segment group
  const isEdad = i >= 6;
  const start  = isEdad ? 6 : 0;
  const end    = isEdad ? 12 : 6;
  const total  = vals.slice(start, end).reduce((a, b) => a + (b || 0), 0);
  return total > 0 ? (vals[i] || 0) / total : null;
}

// ── GROUP STATS (promedio de camiones visibles) ───────────────────────────────
function showGroupStats() {
  clearStays();
  const sidePanel  = document.getElementById('gps-side-stats');
  const chartPanel = document.getElementById('bus-stats-panel');

  // Collect statsData rows for all currently visible camiones
  const visibleIds = Object.keys(gpsLayers).filter(id => gpsLayers[id].visible);
  const rows = visibleIds.map(id => {
    const p   = gpsLayers[id] && gpsLayers[id].feature.properties;
    if (!p) return statsData[id];
    const oid = String(p.owner_id != null ? p.owner_id : (p.objectId || ''));
    const dia = String(p.dia != null ? p.dia : '');
    const mes = p.mes != null ? String(Math.round(parseFloat(p.mes))) : null;
    const ano = p.ano != null ? p.ano : (p.anio != null ? p.anio : (p.year || null));
    return (mes && ano ? statsData[`${oid}_${dia}_${mes}_${ano}`] : null)
        || (mes        ? statsData[`${oid}_${dia}_${mes}`]        : null)
        ||                statsData[`${oid}_${dia}`]
        ||                statsData[id];
  }).filter(Boolean);

  if (rows.length === 0) {
    sidePanel.style.display  = 'none';
    chartPanel.style.display = 'none';
    return;
  }

  // Average each segment across all matching rows
  const vals = BSP_SEG_KEYS.map(k => {
    const sum = rows.reduce((acc, r) => acc + (parseFloat(r[k]) || 0), 0);
    return sum / rows.length;
  });
  const maxVal = Math.max(...vals);

  // Horas operación: desde hora_salida (o hora_inicio) hasta hora_fin
  const horasDurations = visibleIds.map(id => {
    const p = gpsLayers[id] && gpsLayers[id].feature.properties;
    if (!p) return null;
    const ini = p.hora_salida != null ? parseFloat(p.hora_salida)
              : p.hora_inicio != null ? parseFloat(p.hora_inicio) : null;
    const fin = p.hora_fin != null ? parseFloat(p.hora_fin) : null;
    return (ini != null && fin != null && fin >= ini) ? fin - ini : null;
  }).filter(v => v != null);
  const horasAvg = horasDurations.length > 0
    ? horasDurations.reduce((a, b) => a + b, 0) / horasDurations.length
    : null;

  // Tiempos muertos (stays) promedio entre rutas visibles
  const muertosAvg = (() => {
    const vals2 = visibleIds.map(id => {
      const stays = gpsLayers[id] && gpsLayers[id].feature.properties.stays;
      if (!stays || !Array.isArray(stays)) return 0;
      return stays.reduce((s, st) => s + ((st.duration_minutes || 0) / 60), 0);
    });
    return vals2.length ? vals2.reduce((a, b) => a + b, 0) / vals2.length : 0;
  })();

  // Build title from current cascade filters
  const fv = _getFilterVals();
  const MESES_G = ['','Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  const empLbl = fv.empresa !== 'all' ? ` · ${fv.empresa}` : '';
  const busLbl = fv.bus     !== 'all' ? ` · Camión ${fv.bus}` : '';
  const mesLbl = fv.mes     !== 'all' ? ` · ${MESES_G[parseInt(fv.mes)] || 'Mes '+fv.mes}` : '';
  const diaLbl = fv.dia     !== 'all' ? ` · Día ${fv.dia}` : '';

  document.getElementById('bsp-title').textContent = `Grupo${empLbl}${busLbl}${mesLbl}${diaLbl}`;
  document.getElementById('bsp-sub').textContent   =
    `PROMEDIO DE ${rows.length} BUS${rows.length > 1 ? 'ES' : ''} · ${visibleIds.length - rows.length > 0 ? `(${visibleIds.length - rows.length} sin datos CSV)` : 'TODOS CON DATOS'}`;
  setTotals(vals, horasAvg, muertosAvg, horasAvg != null ? Math.max(0, horasAvg - muertosAvg) : null);

  // Side cards with GSE/edad separator
  const cards = document.getElementById('bsp-cards');
  cards.innerHTML = '';

  const gseLblG = document.createElement('span');
  gseLblG.className = 'gss-section-lbl';
  gseLblG.textContent = 'Nivel socioeconómico';
  cards.appendChild(gseLblG);

  vals.forEach((v, i) => {
    if (i === 6) {
      const sep = document.createElement('hr');
      sep.className = 'gss-section-sep';
      cards.appendChild(sep);
      const edadLbl = document.createElement('span');
      edadLbl.className = 'gss-section-lbl';
      edadLbl.textContent = 'Rango etario';
      cards.appendChild(edadLbl);
    }
    const pct = maxVal > 0 ? (v / maxVal * 100) : 0;
    const _cpct  = _camionPct(vals, i);
    const _estPr = i < 6 ? (estPropGSE ? estPropGSE[i] : null) : (estPropEdad ? estPropEdad[i-6] : null);
    const _arrow = _trendArrow(_cpct, _estPr);
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:2px';
    wrap.innerHTML = `
      <div class="gss-card">
        <div class="gss-card-dot" style="background:${BSP_COLORS[i]}"></div>
        <span class="gss-card-lbl">${BSP_SEG_LABELS[i]}</span>
        <span class="gss-card-val">${v >= 100 ? v.toFixed(0) : v.toFixed(1)}${_arrow}</span>
      </div>
      <div class="gss-bar-wrap"><div class="gss-bar-fill" style="width:${pct}%;background:${BSP_COLORS[i]}"></div></div>`;
    cards.appendChild(wrap);
  });

  // Bar chart
  const ctx = document.getElementById('chart-bus-stats').getContext('2d');
  if (chartBusStats) chartBusStats.destroy();
  chartBusStats = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: BSP_SEG_LABELS,
      datasets: [{ data: vals, backgroundColor: BSP_COLORS, borderRadius: 3, borderSkipped: false }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => ` ${ctx.parsed.y.toFixed(2)} personas (promedio)` } }
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { family:"'Syne Mono'", size: 9 }, color: '#8a867e' } },
        y: { grid: { color: '#ece8e0' }, ticks: { font: { family:"'Syne Mono'", size: 9 }, color: '#8a867e' },
             title: { display: true, text: 'Personas (promedio)', font: { family:"'Syne Mono'", size: 9 }, color: '#8a867e' } }
      }
    }
  });

  sidePanel.style.display  = 'flex';
  chartPanel.style.display = 'block';
  setTimeout(() => { if (gpsMap) gpsMap.invalidateSize(); }, 50);
}

function showBusStats(busId, mesOverride) {
  const sidePanel  = document.getElementById('gps-side-stats');
  const chartPanel = document.getElementById('bus-stats-panel');
  if (!busId || busId === 'all') {
    sidePanel.style.display  = 'none';
    chartPanel.style.display = 'none';
    return;
  }

  // Derive display values from GeoJSON properties (not from the internal layer key)
  const entry0raw = gpsLayers[busId];
  const props0    = entry0raw ? entry0raw.feature.properties : {};
  const objId = String(props0.owner_id != null ? props0.owner_id : (props0.objectId != null ? props0.objectId : busId.split('_')[0]));
  const dia   = props0.dia != null ? String(props0.dia) : busId.split('_').slice(-1)[0];

  // Look up stats row — most specific key first: id+dia+mes+ano → id+dia+mes → id+dia
  const entry0    = gpsLayers[busId];
  const mesProp   = mesOverride != null
    ? mesOverride
    : (entry0 ? entry0.feature.properties[mesKey || 'mes'] : null);
  const anoProp2  = entry0 ? (entry0.feature.properties.ano ?? entry0.feature.properties.anio ?? entry0.feature.properties.year ?? null) : null;
  const mesRound  = mesProp != null ? Math.round(parseFloat(mesProp)) : null;
  const quadKey   = (mesRound != null && anoProp2 != null) ? `${objId}_${dia}_${mesRound}_${anoProp2}` : null;
  const tripleKey = mesRound != null ? `${objId}_${dia}_${mesRound}` : null;
  let row = (quadKey   && statsData[quadKey])
          || (tripleKey && statsData[tripleKey])
          || statsData[busId]
          || statsData[`${parseInt(objId)}_${parseInt(dia)}`];

  if (!row) {
    const nKeys = Object.keys(statsData).length;
    // Resolve entry for vias/stays even without CSV row
    const entryNoRow = gpsLayers[busId];
    if (nKeys === 0) {
      sidePanel.style.display = 'flex';
      chartPanel.style.display = 'none';
      document.getElementById('bsp-title').textContent = `Camión ${objId} · Día ${dia}`;
      document.getElementById('bsp-sub').textContent   = 'SIN DATOS ESTADÍSTICOS';
      setTotals(null);
      document.getElementById('bsp-cards').innerHTML =
        `<div style="font-family:'Syne Mono',monospace;font-size:10px;color:var(--muted);line-height:1.7;margin-top:8px">
          Carga el CSV de estadísticas con el botón verde para ver los datos de personas impactadas.
        </div>`;
    } else {
      sidePanel.style.display = 'flex';
      chartPanel.style.display = 'none';
      document.getElementById('bsp-title').textContent = `Camión ${objId} · Día ${dia}`;
      document.getElementById('bsp-sub').textContent   = 'SIN REGISTRO EN CSV';
      setTotals(null);
      const availKeys = Object.keys(statsData)
        .filter(k => k.startsWith(`${objId}_`) && k.split('_').length <= 4)
        .map(k => { const p = k.split('_'); return p.length === 3 ? `día ${p[1]} mes ${p[2]}` : `día ${p[1]}`; })
        .filter((v, i, a) => a.indexOf(v) === i)
        .sort();
      document.getElementById('bsp-cards').innerHTML =
        `<div style="font-family:'Syne Mono',monospace;font-size:10px;color:var(--muted);line-height:1.7;margin-top:8px">
          Par <b style="color:var(--ink)">${objId}·${dia}</b> no encontrado.<br>
          ${availKeys.length ? `Registros disponibles:<br><b style="color:var(--ink)">${availKeys.join(', ')}</b>` : 'Este camión no aparece en el CSV.'}
        </div>`;
    }
    // Still show vias and stays even without CSV
    renderVias(entryNoRow ? entryNoRow.feature.properties.vias_recorridas : null);
    renderStays(entryNoRow ? entryNoRow.feature.properties.stays : null);
    return;
  }

  // Header
  const entry = gpsLayers[busId];
  const tipo  = entry ? (entry.feature.properties.tipo || '') : '';
  const p     = entry ? entry.feature.properties : {};
  const horaIni = p.hora_inicio != null ? formatHora(p.hora_inicio) : null;
  const horaFin = p.hora_fin   != null ? formatHora(p.hora_fin)    : null;
  const horaSalida = entry ? entry.horaSalida : null;

  // Title: Camión ID · Día N · Mes Ene/Feb/…
  const MESES_CORTO = ['','Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  const mesPropVal  = entry
    ? (entry.feature.properties[mesKey || 'mes'] ?? props0.mes ?? null)
    : props0.mes ?? null;
  const mesNorm     = mesPropVal != null ? Math.round(parseFloat(mesPropVal)) : null;
  const mesLabel2   = mesNorm != null && mesNorm >= 1 && mesNorm <= 12
    ? ` · ${MESES_CORTO[mesNorm]}`
    : (mesPropVal != null ? ` · Mes ${mesPropVal}` : '');
  const anoProp  = entry ? (entry.feature.properties.ano ?? entry.feature.properties.anio ?? entry.feature.properties.year ?? null) : null;
  const anoLabel = anoProp != null ? ` · ${anoProp}` : '';
  document.getElementById('bsp-title').textContent = `Camión ${objId} · Día ${dia}${mesLabel2}${anoLabel}`;
  if (typeof h3OnRouteSelect === 'function') h3OnRouteSelect(objId, dia, mesPropVal, anoProp);

  // Sub: only schedule info (no tipo)
  const subParts = [
    horaSalida != null ? `Salida ${formatHora(horaSalida)}` : '',
    (horaIni && horaFin) ? `${horaIni} – ${horaFin}` : ''
  ].filter(Boolean);
  document.getElementById('bsp-sub').textContent = subParts.join(' · ');
  const vals   = BSP_SEG_KEYS.map(k => row[k] || 0);
  const maxVal = Math.max(...vals);

  // Horas operación: hora_salida (o hora_inicio) → hora_fin (último ping)
  const horaInicioOp = p.hora_salida != null ? parseFloat(p.hora_salida)
                     : p.hora_inicio != null  ? parseFloat(p.hora_inicio) : null;
  const horaFinOp    = p.hora_fin != null ? parseFloat(p.hora_fin) : null;
  const horas = (horaInicioOp != null && horaFinOp != null && horaFinOp >= horaInicioOp)
    ? horaFinOp - horaInicioOp : null;

  // Tiempos muertos: suma de duración de stays (en horas)
  const staysArr      = Array.isArray(p.stays) ? p.stays : [];
  const tiempoMuerto  = staysArr.reduce((s, st) => s + ((st.duration_minutes || 0) / 60), 0);
  const tiempoMov     = horas != null ? Math.max(0, horas - tiempoMuerto) : null;

  setTotals(vals, horas, tiempoMuerto, tiempoMov);

  // Compact side cards — one row per segment with GSE/edad separator
  const cards = document.getElementById('bsp-cards');
  cards.innerHTML = '';

  // GSE section label
  const gseLbl = document.createElement('span');
  gseLbl.className = 'gss-section-lbl';
  gseLbl.textContent = 'Nivel socioeconómico';
  cards.appendChild(gseLbl);

  vals.forEach((v, i) => {
    // Insert separator + label before first edad item (index 6)
    if (i === 6) {
      const sep = document.createElement('hr');
      sep.className = 'gss-section-sep';
      cards.appendChild(sep);
      const edadLbl = document.createElement('span');
      edadLbl.className = 'gss-section-lbl';
      edadLbl.textContent = 'Rango etario';
      cards.appendChild(edadLbl);
    }
    const pct = maxVal > 0 ? (v / maxVal * 100) : 0;
    const _cpct  = _camionPct(vals, i);
    const _estPr = i < 6 ? (estPropGSE ? estPropGSE[i] : null) : (estPropEdad ? estPropEdad[i-6] : null);
    const _arrow = _trendArrow(_cpct, _estPr);
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:2px';
    wrap.innerHTML = `
      <div class="gss-card">
        <div class="gss-card-dot" style="background:${BSP_COLORS[i]}"></div>
        <span class="gss-card-lbl">${BSP_SEG_LABELS[i]}</span>
        <span class="gss-card-val">${v >= 100 ? v.toFixed(0) : v.toFixed(1)}${_arrow}</span>
      </div>
      <div class="gss-bar-wrap"><div class="gss-bar-fill" style="width:${pct}%;background:${BSP_COLORS[i]}"></div></div>`;
    cards.appendChild(wrap);
  });

  // Bar chart (full width below)
  const ctx = document.getElementById('chart-bus-stats').getContext('2d');
  if (chartBusStats) chartBusStats.destroy();
  chartBusStats = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: BSP_SEG_LABELS,
      datasets: [{ data: vals, backgroundColor: BSP_COLORS, borderRadius: 3, borderSkipped: false }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => ` ${ctx.parsed.y.toFixed(2)} personas` } }
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { family:"'Syne Mono'", size: 9 }, color: '#8a867e' } },
        y: { grid: { color: '#ece8e0' }, ticks: { font: { family:"'Syne Mono'", size: 9 }, color: '#8a867e' },
             title: { display: true, text: 'Personas', font: { family:"'Syne Mono'", size: 9 }, color: '#8a867e' } }
      }
    }
  });

  sidePanel.style.display  = 'flex';
  chartPanel.style.display = 'block';

  // Vías recorridas
  renderVias(entry ? entry.feature.properties.vias_recorridas : null);
  const staysProp = entry ? entry.feature.properties.stays : null;
  console.log('stays property:', staysProp ? (Array.isArray(staysProp) ? staysProp.length + ' stays' : typeof staysProp) : 'null/undefined');
  renderStays(staysProp);

  // Invalidate map size since layout shifted
  setTimeout(() => { if (gpsMap) gpsMap.invalidateSize(); }, 50);
}

// ── VIA FILTER ────────────────────────────────────────────────────────────
let allVias       = [];    // sorted unique via names across all loaded camiones
let activeVia     = null;  // currently applied via filter (string or null)
let viaFilteredIds = [];   // ids matching the current via filter
let viaSugIdx     = -1;    // keyboard nav index in suggestions

function buildViasIndex() {
  try {
    const set = new Set();
    let checked = 0;
    Object.values(gpsLayers).forEach(e => {
      checked++;
      let vias = e.feature && e.feature.properties && e.feature.properties.vias_recorridas;
      if (typeof vias === 'string') {
        try { vias = JSON.parse(vias); } catch { vias = []; }
      }
      if (Array.isArray(vias)) vias.forEach(v => { if (v) set.add(String(v).trim()); });
    });
    allVias = [...set].sort((a, b) => a.localeCompare(b, 'es'));
    console.log('Via index built:', allVias.length, 'vías. Checked:', checked, 'entries. Sample:', allVias.slice(0, 3));
    const row = document.getElementById('gps-hover-row');
    if (row) row.style.display = allVias.length > 0 ? 'flex' : 'none';
  } catch(err) {
    console.error('buildViasIndex error:', err);
  }
}

function onViaInput() {
  const q = document.getElementById('via-input').value.trim().toLowerCase();
  const box = document.getElementById('via-suggestions');
  viaSugIdx = -1;
  if (!q) { box.style.display = 'none'; return; }
  const matches = allVias.filter(v => v.toLowerCase().includes(q)).slice(0, 30);
  if (matches.length === 0) { box.style.display = 'none'; return; }
  box.innerHTML = matches.map((v, i) => {
    const esc = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const hl  = v.replace(new RegExp(`(${esc.replace(esc, q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'))})`, 'gi'), '<mark>$1</mark>');
    // simpler highlight
    const idx = v.toLowerCase().indexOf(q);
    const highlighted = idx >= 0
      ? v.slice(0, idx) + '<mark>' + v.slice(idx, idx + q.length) + '</mark>' + v.slice(idx + q.length)
      : v;
    return `<div class="via-sug-item" data-via="${v.replace(/"/g,'&quot;')}" onclick="selectViaSuggestion('${v.replace(/'/g,"\\'")}')">${highlighted}</div>`;
  }).join('');
  box.style.display = 'block';
}

function onViaKeydown(e) {
  const box   = document.getElementById('via-suggestions');
  const items = box.querySelectorAll('.via-sug-item');
  if (!items.length) {
    if (e.key === 'Enter') applyViaFilter();
    return;
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    viaSugIdx = Math.min(viaSugIdx + 1, items.length - 1);
    items.forEach((el, i) => el.classList.toggle('active', i === viaSugIdx));
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    viaSugIdx = Math.max(viaSugIdx - 1, -1);
    items.forEach((el, i) => el.classList.toggle('active', i === viaSugIdx));
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (viaSugIdx >= 0 && items[viaSugIdx]) {
      selectViaSuggestion(items[viaSugIdx].dataset.via);
    } else {
      applyViaFilter();
    }
  } else if (e.key === 'Escape') {
    box.style.display = 'none';
  }
}

function selectViaSuggestion(via) {
  document.getElementById('via-input').value = via;
  document.getElementById('via-suggestions').style.display = 'none';
  applyViaFilter();
}

function applyViaFilter() {
  const q = document.getElementById('via-input').value.trim();
  document.getElementById('via-suggestions').style.display = 'none';
  if (!q) { clearViaFilter(); return; }

  activeVia = q.toLowerCase();
  let count = 0;
  viaFilteredIds = [];

  Object.entries(gpsLayers).forEach(([id, entry]) => {
    let vias = entry.feature.properties.vias_recorridas;
    if (typeof vias === 'string') { try { vias = JSON.parse(vias); } catch { vias = []; } }
    const match = Array.isArray(vias) && vias.some(v => String(v).toLowerCase().includes(activeVia));

    entry.visible = match;

    try { gpsMap.removeLayer(entry.layer); } catch {}
    if (match) { entry.layer.addTo(gpsMap); viaFilteredIds.push(id); count++; }

    const chip = document.querySelector(`.bus-chip[data-bus-id="${id}"]`);
    if (chip) chip.classList.toggle('hidden-bus', !match);
  });

  document.getElementById('gps-bus-sel').value = 'all';
  document.getElementById('via-clear-btn').style.display = 'inline-flex';
  document.getElementById('btn-random-route').style.display = count > 0 ? 'inline-flex' : 'none';

  const status = document.getElementById('via-status');
  if (count > 0) {
    status.textContent = `${count} camión${count > 1 ? 'es' : ''} vía (ruta${count > 1 ? 's' : ''}) transitan esta vía`;
    status.className   = 'via-status found';
  } else {
    status.textContent = 'Ningún camión día (ruta) transita esta vía';
    status.className   = 'via-status notfound';
  }

  if (count > 0) fitAllBuses();
}

function clearViaFilter() {
  activeVia      = null;
  viaFilteredIds = [];
  document.getElementById('via-input').value = '';
  document.getElementById('via-suggestions').style.display = 'none';
  document.getElementById('via-clear-btn').style.display = 'none';
  document.getElementById('btn-random-route').style.display = 'none';
  document.getElementById('via-status').textContent = '';
  document.getElementById('via-status').className = 'via-status';
  // Force remove then re-add all layers
  updateMarkerVisibility(null);  // hide all markers
  Object.entries(gpsLayers).forEach(([id, entry]) => {
    entry.visible = true;
    try { gpsMap.removeLayer(entry.layer); } catch {}
    entry.layer.addTo(gpsMap);
    const chip = document.querySelector(`.bus-chip[data-bus-id="${id}"]`);
    if (chip) chip.classList.remove('hidden-bus');
  });
  fitAllBuses();
}

function pickRandomRoute() {
  // Special curated set for "Camino La Pólvora"
  const POLVORA_TRIOS = [
    [80194,  19, 7],
    [142394, 16, 1],
    [329068,  8, 8],
    [298728, 10, 6],
    [38364,   7, 3],
  ];
  const viaInput = document.getElementById('via-input');
  const isPolvora = viaInput && viaInput.value.toLowerCase().includes('pólvora');

  let pool;
  if (isPolvora) {
    // Match against gpsLayers using GeoJSON properties
    pool = Object.keys(gpsLayers).filter(id => {
      const p = gpsLayers[id].feature.properties;
      const oid = parseInt(p.owner_id || p.objectId || 0);
      const dia = parseInt(p.dia || 0);
      const mes = parseInt(p.mes || 0);
      return POLVORA_TRIOS.some(([o, d, m]) => o === oid && d === dia && m === mes);
    });
    if (pool.length === 0) {
      // Fallback to via-filtered pool if none of the trios found
      pool = viaFilteredIds.length > 0 ? viaFilteredIds
           : Object.keys(gpsLayers).filter(id => gpsLayers[id].visible);
    }
  } else {
    pool = viaFilteredIds.length > 0 ? viaFilteredIds
         : Object.keys(gpsLayers).filter(id => gpsLayers[id].visible);
  }

  if (pool.length === 0) return;

  const randomId = pool[Math.floor(Math.random() * pool.length)];
  const entry    = gpsLayers[randomId];

  // Reset animation first — prevents animReset from restoring the previous route
  animState.targetId = null;
  animReset();

  // Force remove ALL layers, then show only the selected one
  Object.entries(gpsLayers).forEach(([id, e]) => {
    const show = id === randomId;
    e.visible = show;
    try { gpsMap.removeLayer(e.layer); } catch {}
    if (show) e.layer.addTo(gpsMap);
    const chip = document.querySelector(`.bus-chip[data-bus-id="${id}"]`);
    if (chip) chip.classList.toggle('hidden-bus', !show);
  });
  updateMarkerVisibility(randomId);

  // Fit map to this route
  gpsMap.fitBounds(entry.layer.getBounds(), { padding: [50, 50] });

  // Sync search fields using GeoJSON properties (handles triple keys correctly)
  const p = entry.feature.properties;
  document.getElementById('srch-bus').value = String(p.owner_id || p.objectId || '');
  document.getElementById('srch-dia').value = String(p.dia != null ? p.dia : '');
  const srchMes = document.getElementById('srch-mes');
  if (srchMes) srchMes.value = p.mes != null ? String(p.mes) : '';
  document.getElementById('srch-clear').style.display = 'inline-flex';
  document.getElementById('gps-bus-sel').value = randomId;

  animSetTarget(randomId);
  showBusStats(randomId);
  if (!compareState.active) showCompareButton(randomId);

  // Update status
  const oid2     = p.owner_id || p.objectId || randomId;
  const _MESES_CORTO = ['','Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  const _mesNorm2 = p.mes != null ? Math.round(parseFloat(p.mes)) : null;
  const _mesLbl2  = _mesNorm2 != null && _mesNorm2 >= 1 && _mesNorm2 <= 12 ? ` · ${_MESES_CORTO[_mesNorm2]}` : '';
  const busLabel = `Camión ${oid2} · Día ${p.dia != null ? p.dia : ''}${_mesLbl2}`;
  const status   = document.getElementById('via-status');
  status.textContent = `↪ Aleatoria: ${busLabel}`;
  status.className   = 'via-status found';
}

// Hide suggestions when clicking outside
document.addEventListener('click', e => {
  if (!e.target.closest('.via-input-wrap')) {
    const box = document.getElementById('via-suggestions');
    if (box) box.style.display = 'none';
  }
});

// ── COORD PICKER ───────────────────────────────────────────────────────────
let coordPickerActive = false;
let lastCoords        = null;

function toggleCoordPicker() {
  coordPickerActive = !coordPickerActive;
  const btn = document.getElementById('btn-coord');
  const disp = document.getElementById('coord-display');
  if (coordPickerActive) {
    btn.classList.add('active');
    disp.textContent = 'Haz clic en el mapa…';
    disp.className   = 'coord-display empty';
    if (gpsMap) gpsMap.getContainer().style.cursor = 'crosshair';
  } else {
    btn.classList.remove('active');
    if (gpsMap) gpsMap.getContainer().style.cursor = '';
    if (!lastCoords) {
      disp.textContent = 'Haz clic en el mapa';
      disp.className   = 'coord-display empty';
    }
  }
}

function onMapClick(e) {
  if (!coordPickerActive) return;
  const lat = e.latlng.lat.toFixed(6);
  const lng = e.latlng.lng.toFixed(6);
  lastCoords = { lat, lng };
  const disp = document.getElementById('coord-display');
  disp.textContent = `${lat}, ${lng}`;
  disp.className   = 'coord-display';
  document.getElementById('coord-copy').style.display = 'inline-flex';
}

function copyCoords() {
  if (!lastCoords) return;
  const text = `${lastCoords.lat}, ${lastCoords.lng}`;
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.getElementById('coord-copy');
    const orig = btn.innerHTML;
    btn.textContent = '✓ Copiado';
    setTimeout(() => { btn.innerHTML = orig; }, 1500);
  }).catch(() => {
    prompt('Copia estas coordenadas:', text);
  });
}

// ── STAYS ──────────────────────────────────────────────────────────────────
let stayMarkers       = [];   // current L.circleMarker instances on map
let staysVisible      = false;
let currentStays      = [];   // stays array for single-bus mode
let staysColorOverride = null;
let compareStaysData  = null; // {a: [{stays, color}], b: [{stays, color}]} in compare mode

function renderStays(stays, colorOverride) {
  // In compare mode, don't clear — let renderCompareStays handle it
  if (!colorOverride) {
    stayMarkers.forEach(m => { try { gpsMap.removeLayer(m); } catch {} });
    stayMarkers = [];
    currentStays = [];
  }

  const btn = document.getElementById('btn-stays');

  // Parse if JSON string
  if (typeof stays === 'string') {
    try { stays = JSON.parse(stays); } catch { stays = []; }
  }

  console.log('renderStays called, stays:', Array.isArray(stays) ? stays.length + ' items' : stays);

  if (!stays || !Array.isArray(stays) || stays.length === 0) {
    if (!colorOverride) {
      if (btn) { btn.style.display = 'none'; btn.innerHTML = '<svg viewBox="0 0 16 16" fill="currentColor" style="width:10px;height:10px;margin-right:4px"><circle cx="8" cy="8" r="4"/></svg> Stays'; }
      staysVisible = false;
    }
    return;
  }

  if (!colorOverride) {
    currentStays = stays;
    staysVisible = true;
    if (btn) {
      btn.style.display = 'inline-flex';
      btn.style.background = '#f59e0b22';
      btn.innerHTML = '<svg viewBox="0 0 16 16" fill="currentColor" style="width:10px;height:10px;margin-right:4px"><circle cx="8" cy="8" r="4"/></svg> Ocultar stays';
    }
    drawStays();
  } else {
    // Compare mode: draw with specific color without affecting currentStays
    drawStaysWithColor(stays, colorOverride);
  }
}

function drawStaysWithColor(stays, color) {
  stays.forEach((s, i) => {
    const lat = parseFloat(s.lat);
    const lon = parseFloat(s.lon);
    if (isNaN(lat) || isNaN(lon)) return;
    const dur    = s.duration_minutes != null ? parseFloat(s.duration_minutes).toFixed(1) : '?';
    const time   = s.start_time ? String(s.start_time).slice(11, 16) : '?';
    const radius = Math.max(6, Math.min(18, Math.sqrt(parseFloat(dur || 1)) * 1.5));
    _ensureStaysPane();
    const marker = L.circleMarker([lat, lon], {
      radius, fillColor: color, fillOpacity: 0.85, color: '#fff', weight: 2,
      interactive: false,
      pane: 'staysPane',
    });
    marker.addTo(gpsMap);
    stayMarkers.push(marker);
  });
}

function drawStays() {
  stayMarkers.forEach(m => { try { gpsMap.removeLayer(m); } catch {} });
  stayMarkers = [];

  currentStays.forEach((s, i) => {
    const lat = parseFloat(s.lat);
    const lon = parseFloat(s.lon);
    if (isNaN(lat) || isNaN(lon)) return;

    const dur  = s.duration_minutes != null ? parseFloat(s.duration_minutes).toFixed(1) : '?';
    const time = s.start_time ? String(s.start_time).slice(11, 16) : '?';
    const radius = Math.max(6, Math.min(18, Math.sqrt(parseFloat(dur || 1)) * 1.5));

    _ensureStaysPane();
    const marker = L.circleMarker([lat, lon], {
      radius,
      fillColor:   '#f59e0b',
      fillOpacity: 0.85,
      color:       '#fff',
      weight:      2,
      interactive: false,
      pane: 'staysPane',
    });
    marker.addTo(gpsMap);
    stayMarkers.push(marker);
  });
}

function toggleStays() {
  staysVisible = !staysVisible;
  const btn = document.getElementById('btn-stays');
  if (staysVisible) {
    stayMarkers.forEach(m => { try { gpsMap.removeLayer(m); } catch {} });
    stayMarkers = [];
    if (compareStaysData) {
      // Compare mode: redraw both routes' stays
      if (compareStaysData.a) drawStaysWithColor(compareStaysData.a, '#c0392b');
      if (compareStaysData.b) drawStaysWithColor(compareStaysData.b, '#1a6b4a');
    } else {
      drawStays();
    }
    if (btn) { btn.style.background = '#f59e0b22'; btn.innerHTML = '<svg viewBox="0 0 16 16" fill="currentColor" style="width:10px;height:10px;margin-right:4px"><circle cx="8" cy="8" r="4"/></svg> Ocultar stays'; }
  } else {
    stayMarkers.forEach(m => { try { gpsMap.removeLayer(m); } catch {} });
    stayMarkers = [];
    if (btn) { btn.style.background = 'transparent'; btn.innerHTML = '<svg viewBox="0 0 16 16" fill="currentColor" style="width:10px;height:10px;margin-right:4px"><circle cx="8" cy="8" r="4"/></svg> Stays'; }
  }
}

function _ensureStaysPane() {
  if (!gpsMap || gpsMap.getPane('staysPane')) return;
  // staysPane: z=350, no pointer-events (purely visual)
  const sp = gpsMap.createPane('staysPane');
  sp.style.zIndex       = '350';
  sp.style.pointerEvents = 'none';

  // routesPane: z=401, pointer-events enabled so polylines catch mouse
  if (!gpsMap.getPane('routesPane')) {
    const rp = gpsMap.createPane('routesPane');
    rp.style.zIndex       = '401';
    rp.style.pointerEvents = 'auto';
  }
}

function clearStays() {
  stayMarkers.forEach(m => { try { gpsMap.removeLayer(m); } catch {} });
  stayMarkers = [];
  currentStays = [];
  compareStaysData = null;
  staysVisible = false;
  const btn = document.getElementById('btn-stays');
  if (btn) { btn.style.display = 'none'; btn.style.background = 'transparent'; }
}

// ── VÍAS RECORRIDAS ────────────────────────────────────────────────────────
function renderVias(vias) {
  const container = document.getElementById('gss-vias');
  const list      = document.getElementById('gss-vias-list');
  if (typeof vias === 'string') { try { vias = JSON.parse(vias); } catch { vias = []; } }
  if (!vias || !Array.isArray(vias) || vias.length === 0) {
    container.style.display = 'none';
    return;
  }
  list.innerHTML = vias.map(v => `<li>${v}</li>`).join('');
  container.style.display = 'block';
}

function loadGeoJSON(ev) {
  const file = ev.target.files[0];
  if (!file) return;
  document.getElementById('gps-status').textContent = '⏳ Cargando…';
  const reader = new FileReader();
  reader.onload = e => {
    try {
      gpsData = JSON.parse(e.target.result);
      if (!gpsData.features || !gpsData.features.length) throw new Error('Sin features');
      initGPSMap();
    } catch(err) {
      document.getElementById('gps-status').textContent = '✗ GeoJSON inválido: ' + err.message;
    }
  };
  reader.readAsText(file);
}

function initGPSMap() {
  const features = gpsData.features;

  // Stats — computed once from full dataset, fixed cells never change
  const nPings = features.reduce((s,f) => s + (f.properties.n_pings_original || f.geometry.coordinates.length), 0);
  const empresaSet = new Set(features.map(f => f.properties.account_id).filter(v => v != null && v !== ''));
  const nEmpresas  = empresaSet.size;
  const avgPorEmpresa = nEmpresas > 0 ? (features.length / nEmpresas).toFixed(1) : '—';
  // Unique owner_ids across all data
  const allBusSet = new Set(features.map(f => {
    const p = f.properties;
    return String(p.owner_id ?? p.objectId ?? '');
  }).filter(Boolean));

  // Fixed cells (never filter-dependent)
  document.getElementById('gs-avg-empresa').textContent  = nEmpresas > 0 ? avgPorEmpresa : '—';
  document.getElementById('gs-pings').textContent        = fmtN(nPings);
  document.getElementById('gps-stats-row').style.display = 'grid';

  // Dynamic cells — initialize to full-dataset values
  updateStatsCells();

  // Camión selector now populated via populateBusSel() in PHASE 2

  document.getElementById('gps-filters').style.display = 'flex';
  document.dispatchEvent(new CustomEvent('gpsDataLoaded'));

  // Init map
  document.getElementById('map-gps-empty').style.display = 'none';
  document.getElementById('map-gps').style.display = 'block';
  document.getElementById('map-gps-wrap').style.display = 'block';
  if (gpsMap) { gpsMap.remove(); gpsMap = null; }
  activeVia = null;
  allVias   = [];
  const viaRow = document.getElementById('gps-hover-row');
  if (viaRow) viaRow.style.display = 'none';
  const viaClear = document.getElementById('via-clear-btn');
  if (viaClear) viaClear.style.display = 'none';
  const viaStatus = document.getElementById('via-status');
  if (viaStatus) { viaStatus.textContent = ''; viaStatus.className = 'via-status'; }
  const viaInput = document.getElementById('via-input');
  if (viaInput) viaInput.value = '';
  gpsMap = L.map('map-gps', { zoomControl: true, attributionControl: false, preferCanvas: true });
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    subdomains:'abcd', maxZoom:19
  }).addTo(gpsMap);
  const canvasRenderer = L.canvas({ padding: 0.5 });

  // Wire coord picker
  gpsMap.on('click', onMapClick);
  coordPickerActive = false;
  lastCoords = null;
  const coordBar = document.getElementById('coord-bar');
  if (coordBar) coordBar.style.display = 'flex';
  const coordDisp = document.getElementById('coord-display');
  if (coordDisp) { coordDisp.textContent = 'Haz clic en el mapa'; coordDisp.className = 'coord-display empty'; }
  const coordCopy = document.getElementById('coord-copy');
  if (coordCopy) coordCopy.style.display = 'none';
  const btnCoord = document.getElementById('btn-coord');
  if (btnCoord) btnCoord.classList.remove('active');

  // Detect if any feature has a mes property — determines key strategy globally
  // Detect if any feature has a mes property
  const hasMesInFeatures = features.some(f => f.properties.mes != null);
  const hasAnoInFeatures = features.some(f =>
    f.properties.ano != null || f.properties.anio != null || f.properties.year != null);
  console.log('hasMesInFeatures:', hasMesInFeatures, '| hasAno:', hasAnoInFeatures);

  // ── PHASE 1: build gpsLayers data (fast, no Leaflet objects yet) ─────────
  gpsLayers = {};
  features.forEach((f, i) => {
    const props = f.properties;
    let id;
    if (hasMesInFeatures && props.mes != null) {
      const oid  = props.owner_id != null ? props.owner_id : (props.objectId != null ? props.objectId : (props.bus_id || i));
      const dia  = props.dia != null ? props.dia : (String(props.bus_id || '').split('_')[1] || i);
      const hora = props.hora_salida != null && props.hora_salida !== '' ? `_h${parseFloat(props.hora_salida)}` : '';
      const ano  = props.ano != null ? props.ano : (props.anio ?? props.year ?? null);
      id = `${oid}_${dia}_${Math.round(parseFloat(props.mes))}${ano != null ? '_' + ano : ''}${hora}`;
    } else {
      id = String(props.bus_id || props.objectId || i);
    }
    const color     = busColor(f, i);
    const coords    = f.geometry.coordinates.map(([lon,lat]) => [lat,lon]);
    const horaSalida = (props.hora_salida != null && props.hora_salida !== '') ? parseFloat(props.hora_salida) : null;
    gpsLayers[id] = { layer: null, startMarker: null, endMarker: null, color, feature: f, visible: true, coords, horaSalida, _built: false };
  });

  // ── PHASE 2: populate selectors / indexes (no map needed) ────────────────
  // Camión selector: unique owner_ids (dia/mes are separate cascade filters)
  populateBusSel();

  buildBusIndex();

  // Hora
  (function() {
    const sel = document.getElementById('gps-viaje-sel');
    if (!sel) return;
    const counts = {};
    Object.values(gpsLayers).forEach(e => {
      const raw = e.feature.properties.hora_salida;
      const h = (raw != null && raw !== '') ? Math.floor(parseFloat(raw)) : NaN;
      if (isNaN(h)) return;
      const key = String(h).padStart(2,'0') + ':00';
      counts[key] = (counts[key] || 0) + 1;
    });
    const sorted = Object.keys(counts).sort((a,b) => parseInt(a,10) - parseInt(b,10));
    sel.innerHTML = '<option value="all">Todas las horas</option>';
    sorted.forEach(b => { const opt = document.createElement('option'); opt.value = b; opt.textContent = `${b}  (${counts[b]})`; sel.appendChild(opt); });
    console.log('Hora blocks:', sorted.length);
  })();

  // Empresa (account_id)
  (function() {
    const sel = document.getElementById('gps-empresa-sel');
    const lbl = document.getElementById('gps-empresa-lbl');
    if (!sel) return;
    const counts = {};
    Object.values(gpsLayers).forEach(e => {
      const raw = e.feature && e.feature.properties && e.feature.properties.account_id;
      if (raw == null || raw === '') return;
      const key = String(raw);
      counts[key] = (counts[key] || 0) + 1;
    });
    const sorted = Object.keys(counts).sort((a, b) => a.localeCompare(b));
    if (sorted.length === 0) {
      if (lbl) lbl.style.display = 'none';
      sel.style.display = 'none';
      return;
    }
    if (lbl) lbl.style.removeProperty('display');
    sel.style.removeProperty('display');
    sel.innerHTML = '<option value="all">Todas las empresas</option>';
    sorted.forEach(emp => {
      const opt = document.createElement('option');
      opt.value = emp;
      opt.textContent = `${emp} (${counts[emp]})`;
      sel.appendChild(opt);
    });
    console.log('Empresas:', sorted.length);
  })();

  // Mes
  const firstProps = Object.keys(Object.values(gpsLayers)[0]?.feature?.properties || {});
  const MES_KEY = firstProps.find(k => k.toLowerCase() === 'mes') || null;
  mesKey = MES_KEY;
  (function() {
    const sel = document.getElementById('gps-mes-sel');
    const lbl = document.getElementById('gps-mes-lbl');
    if (!sel) return;
    const MESES = ['','Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
    const counts = {};
    Object.values(gpsLayers).forEach(e => {
      const raw = e.feature && e.feature.properties && e.feature.properties[MES_KEY || 'mes'];
      if (raw == null || raw === '') return;
      const m = Math.round(parseFloat(raw));
      if (isNaN(m) || m < 1 || m > 12) return;
      counts[m] = (counts[m] || 0) + 1;
    });
    const sorted = Object.keys(counts).map(Number).sort((a,b) => a-b);
    if (sorted.length === 0) { if (lbl) lbl.style.display = 'none'; sel.style.display = 'none'; return; }
    if (lbl) lbl.style.removeProperty('display'); sel.style.removeProperty('display');
    sel.innerHTML = '<option value="all">Todos los meses</option>';
    sorted.forEach(m => { const opt = document.createElement('option'); opt.value = m; opt.textContent = `${MESES[m]}  (${counts[m]})`; sel.appendChild(opt); });
    console.log('Meses:', sorted);
    const mw = document.getElementById('srch-mes-wrap'); const mwb = document.getElementById('srch-mes-wrap-b');
    if (mw) mw.style.display = ''; if (mwb) mwb.style.display = '';
  })();

  // Vias
  (function() {
    try {
      const set = new Set();
      Object.values(gpsLayers).forEach(e => {
        let vias = e.feature && e.feature.properties && e.feature.properties.vias_recorridas;
        if (typeof vias === 'string') { try { vias = JSON.parse(vias); } catch { vias = []; } }
        if (Array.isArray(vias)) vias.forEach(v => { if (v) set.add(String(v).trim()); });
      });
      allVias = [...set].sort((a,b) => a.localeCompare(b,'es'));
      console.log('Via index:', allVias.length, 'vías.');
      const row = document.getElementById('gps-hover-row');
      if (row) row.style.display = allVias.length > 0 ? 'flex' : 'none';
    } catch(err) { console.error('Via index error:', err); }
  })();

  buildHoraSelect(); buildMesSelect(); buildViasIndex(); buildBusChips();
  
  document.getElementById('gps-filters').style.display = 'flex';
  document.dispatchEvent(new CustomEvent('gpsDataLoaded'));
  document.getElementById('anim-bar').style.display = 'flex';
  animReset();

  document.getElementById('gps-status').textContent = `Cargando ${features.length} camiones día (rutas)…`;

  // ── PHASE 3: render Leaflet layers in batches of 200 ─────────────────────
  const BATCH = 200;
  const layerIds = Object.keys(gpsLayers);
  let batchIdx = 0;
  const allBounds = [];

  function renderBatch() {
    const end = Math.min(batchIdx + BATCH, layerIds.length);
    for (let i = batchIdx; i < end; i++) {
      const id    = layerIds[i];
      const entry = gpsLayers[id];
      if (entry._built) continue;

      const p      = entry.feature.properties;
      const coords = entry.coords;

      // Always a single polyline — impact coloring painted separately on canvas overlay
      _ensureStaysPane();  // ensure panes exist
      const line = L.polyline(coords, {
        color: entry.color, weight: 2.5, opacity: 0.75,
        smoothFactor: 1.5, renderer: canvasRenderer,
        pane: 'routesPane',
      });
      // No Leaflet tooltip — info shown via custom hover tooltip below
      line.addTo(gpsMap);

      // Store pre-computed impact data (plain objects, no Leaflet layers)
      entry.impactData = parseImpactData(p);  // null if no vias_con_indices

      // Hover: mostrar hora del ping más cercano al cursor
      const coordTs = p.coord_timestamps;
      if (coordTs && Array.isArray(coordTs) && coordTs.length > 0) {
        line.on('mousemove', function(e) {
          const tip    = _getOrCreatePingTooltip();
          const latLng = e.latlng;

          // Find closest coordinate to cursor
          let bestDist = Infinity, bestIdx = 0;
          entry.coords.forEach((c, i) => {
            const d = gpsMap.distance(latLng, L.latLng(c[0], c[1]));
            if (d < bestDist) { bestDist = d; bestIdx = i; }
          });
          const hora = coordTs[bestIdx] || '—';

          // Build combined tooltip: camion ID + hora del ping
          const pid   = p.owner_id || p.bus_id || id;
          const pSal  = p.hora_salida != null ? formatHora(p.hora_salida) : null;
          const nPings = (p.n_pings_original || '?').toLocaleString();
          tip.innerHTML =
            `<span style="font-weight:700;font-size:12px">Camión ${pid}</span>` +
            (pSal ? `<span style="color:rgba(255,255,255,0.6);margin-left:8px">${pSal}</span>` : '') +
            `<br><span style="font-size:14px;font-weight:800">${hora}</span>` +
            `<span style="color:rgba(255,255,255,0.5);font-size:9px;margin-left:6px">${nPings} pings</span>`;
          // Check if near a stay marker — append stay info if so
          let stayInfo = '';
          if (currentStays && currentStays.length > 0) {
            let bestStayDist = 60, bestStay = null;  // 60m threshold
            currentStays.forEach(s => {
              const d = gpsMap.distance(latLng, L.latLng(parseFloat(s.lat), parseFloat(s.lon)));
              if (d < bestStayDist) { bestStayDist = d; bestStay = s; }
            });
            if (bestStay) {
              const dur  = bestStay.duration_minutes ? parseFloat(bestStay.duration_minutes).toFixed(1) : '?';
              const time = bestStay.start_time ? String(bestStay.start_time).slice(11, 16) : '?';
              stayInfo = `<br><span style="color:#f59e0b;font-size:10px">⏱ Stay ${time} · ${dur} min</span>`;
            }
          }
          tip.innerHTML =
            `<span style="font-weight:700;font-size:12px">Camión ${pid}</span>` +
            (pSal ? `<span style="color:rgba(255,255,255,0.6);margin-left:8px">${pSal}</span>` : '') +
            `<br><span style="font-size:14px;font-weight:800">${hora}</span>` +
            `<span style="color:rgba(255,255,255,0.5);font-size:9px;margin-left:6px">${nPings} pings</span>` +
            stayInfo;
          const pt = gpsMap.latLngToContainerPoint(latLng);
          tip.style.display = 'block';
          tip.style.left    = (pt.x + 16) + 'px';
          tip.style.top     = (pt.y - 36) + 'px';
        });
        line.on('mouseout', () => {
          const tip = document.getElementById('ping-tooltip');
          if (tip) tip.style.display = 'none';
        });
      } else {
        // No coord_timestamps: still show camion info on hover (without hora)
        line.on('mousemove', function(e) {
          const tip   = _getOrCreatePingTooltip();
          const pid   = p.owner_id || p.bus_id || id;
          const pSal  = p.hora_salida != null ? formatHora(p.hora_salida) : null;
          const pFin  = p.hora_fin   != null ? formatHora(p.hora_fin)    : null;
          const nPings = (p.n_pings_original || '?').toLocaleString();
          tip.innerHTML =
            `<span style="font-weight:700;font-size:12px">Camión ${pid}</span>` +
            (pSal ? `<span style="color:rgba(255,255,255,0.6);margin-left:8px">${pSal}${pFin ? ' – ' + pFin : ''}</span>` : '') +
            `<br><span style="color:rgba(255,255,255,0.5);font-size:9px">${nPings} pings</span>`;
          const pt = gpsMap.latLngToContainerPoint(e.latlng);
          tip.style.display = 'block';
          tip.style.left    = (pt.x + 16) + 'px';
          tip.style.top     = (pt.y - 36) + 'px';
        });
        line.on('mouseout', () => {
          const tip = document.getElementById('ping-tooltip');
          if (tip) tip.style.display = 'none';
        });
      }

      // Start/end markers created but NOT added to map — only shown when camion is selected
      const mkIcon = (cls) => {
        const isStart = cls === 'marker-start';
        return L.divIcon({
          className: '',
          iconSize:   isStart ? [16, 14] : [13, 13],
          iconAnchor: isStart ? [8, 14]  : [6, 6],   // triángulo: base centrada; cuadrado: centro
          html: `<div class="${cls}"></div>`
        });
      };
      const startMarker = L.marker(coords[0], { icon: mkIcon('marker-start'), zIndexOffset: 1000 });
      const endMarker   = L.marker(coords[coords.length-1], { icon: mkIcon('marker-end'), zIndexOffset: 1000 });
      startMarker.bindTooltip(`⚫ Inicio${p.hora_salida != null ? ' · ' + formatHora(p.hora_salida) : ''}`, { className:'leaflet-tip', direction:'top' });
      endMarker.bindTooltip('⚪ Fin', { className:'leaflet-tip', direction:'top' });

      entry.layer = line; entry.startMarker = startMarker; entry.endMarker = endMarker;
      entry._built = true; entry._markersOnMap = false;
      try { allBounds.push(line.getBounds()); } catch {}
    }
    batchIdx = end;

    const pct = Math.round(batchIdx / layerIds.length * 100);
    document.getElementById('gps-status').textContent = `Cargando camiones día (rutas)… ${pct}% (${batchIdx}/${layerIds.length})`;

    if (batchIdx < layerIds.length) {
      setTimeout(renderBatch, 0);
    } else {
      if (allBounds.length > 0) {
        let b = allBounds[0]; allBounds.forEach(bb => { try { b = b.extend(bb); } catch {} });
        gpsMap.fitBounds(b, { padding:[30,30] });
      }
      setTimeout(() => gpsMap.invalidateSize(), 80);
      document.getElementById('gps-status').textContent = `✓ ${features.length} camiones día (rutas) · ${fmtN(nPings)} pings originales`;
      console.log('All layers rendered.');
      // Init canvas overlay and draw impact heatmap
      const hasImpact = Object.values(gpsLayers).some(e => e.impactData);
      const legend = document.getElementById('impact-legend');
      if (legend) legend.classList.toggle('visible', hasImpact);
      if (hasImpact) {
        _ensureImpactCanvas(gpsMap);
        scheduleImpactDraw(gpsMap);
      }
    }
  }

  setTimeout(renderBatch, 0);
}

function buildBusChips() {
  const chips = document.getElementById('bus-chips');
  chips.innerHTML = '';
  Object.entries(gpsLayers).forEach(([id, {color, feature}]) => {
    const chip = document.createElement('div');
    chip.className = 'bus-chip';
    chip.dataset.busId = id;
    chip.innerHTML = `<div class="bus-chip-dot" style="background:${color}"></div>${id}`;
    chip.onclick = () => toggleBusChip(chip, id);
    chips.appendChild(chip);
  });
}

// ── SEARCH BY BUS+DIA ──────────────────────────────────────────────────────
// Index: busId (string) → Set of dias available
let busIndex = {};   // { "1": Set{"4","5",...}, ... }

// ── HORA SALIDA HELPERS ────────────────────────────────────────────────────
function formatHora(h) {
  if (h == null || isNaN(h)) return '—';
  const hh = Math.floor(h);
  const mm  = Math.round((h - hh) * 60);
  return mm === 0 ? `${String(hh).padStart(2,'0')}:00` : `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}`;
}

function horaBlock(h) {
  if (h == null || isNaN(h)) return null;
  return String(Math.floor(h)).padStart(2,'0') + ':00';
}

function buildHoraSelect() {
  try {
    const sel = document.getElementById('gps-viaje-sel');
    if (!sel) { console.warn('gps-viaje-sel not found'); return; }
    const counts = {};
    Object.values(gpsLayers).forEach(e => {
      const raw = e.feature && e.feature.properties && e.feature.properties.hora_salida;
      const h   = (raw != null && raw !== '') ? parseFloat(raw) : NaN;
      if (isNaN(h)) return;
      const hh  = Math.floor(h);
      const key = String(hh).padStart(2, '0') + ':00';
      counts[key] = (counts[key] || 0) + 1;
    });
    const sorted = Object.keys(counts).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
    sel.innerHTML = '<option value="all">Todas las horas</option>';
    sorted.forEach(b => {
      const opt = document.createElement('option');
      opt.value = b;
      opt.textContent = `${b}  (${counts[b]} camión${counts[b] > 1 ? 'es' : ''})`;
      sel.appendChild(opt);
    });
    console.log('Hora blocks found:', sorted, 'counts:', counts);
  } catch(err) {
    console.error('buildHoraSelect error:', err);
  }
}

function buildMesSelect() {
  // This is called after gps-filters is visible — the inline IIFE above handles initial population.
  // This function re-syncs if needed (e.g. after a reload).
  try {
    const sel = document.getElementById('gps-mes-sel');
    const lbl = document.getElementById('gps-mes-lbl');
    if (!sel || sel.options.length > 1) return;  // already populated by IIFE, skip
    const MESES = ['','Enero','Febrero','Marzo','Abril','Mayo','Junio',
                   'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
    const counts = {};
    Object.values(gpsLayers).forEach(e => {
      const raw = e.feature && e.feature.properties && e.feature.properties.mes;
      if (raw == null || raw === '') return;
      const m = Math.round(parseFloat(raw));
      if (isNaN(m) || m < 1 || m > 12) return;
      counts[m] = (counts[m] || 0) + 1;
    });
    const sorted = Object.keys(counts).map(Number).sort((a, b) => a - b);
    if (sorted.length === 0) {
      if (lbl) lbl.style.display = 'none';
      sel.style.display = 'none';
      return;
    }
    if (lbl) lbl.style.removeProperty('display');
    sel.style.removeProperty('display');
    sel.innerHTML = '<option value="all">Todos los meses</option>';
    sorted.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = `${MESES[m]}  (${counts[m]})`;
      sel.appendChild(opt);
    });
  } catch(err) {
    console.error('buildMesSelect error:', err);
  }
}

function buildBusIndex() {
  busIndex = {};
  Object.entries(gpsLayers).forEach(([bus_id, entry]) => {
    const p   = entry.feature.properties;
    const obj = String(p.owner_id || p.objectId || '');
    const dia = String(p.dia != null ? p.dia : '');
    if (!obj || !dia) return;
    if (!busIndex[obj]) busIndex[obj] = new Set();
    busIndex[obj].add(dia);
  });
}

function onSearchInput() {
  // Clear notif and error state on typing
  const notif = document.getElementById('srch-notif');
  notif.style.display = 'none';
  document.getElementById('srch-bus').classList.remove('input-error','input-ok');
  document.getElementById('srch-dia').classList.remove('input-error','input-ok');
}

function searchRoute() {
  const busRaw = document.getElementById('srch-bus').value.trim();
  const diaRaw = document.getElementById('srch-dia').value.trim();
  const notif  = document.getElementById('srch-notif');
  const busInp = document.getElementById('srch-bus');
  const diaInp = document.getElementById('srch-dia');

  // Reset states
  busInp.classList.remove('input-error','input-ok');
  diaInp.classList.remove('input-error','input-ok');
  notif.style.display = 'none';

  if (!busRaw || !diaRaw) {
    showNotif('info', '⚠️', '<b>Completa ambos campos</b> — ID Camión y Día son requeridos.');
    if (!busRaw) busInp.classList.add('input-error');
    if (!diaRaw) diaInp.classList.add('input-error');
    return;
  }

  const mesRaw = document.getElementById('srch-mes') ? document.getElementById('srch-mes').value.trim() : '';

  // Find matching layer by GeoJSON properties (handles triple/double key transparently)
  const fuzzyMatches = Object.keys(gpsLayers).filter(id => {
    const p   = gpsLayers[id].feature.properties;
    const oid = String(p.owner_id || p.objectId || '');
    const dia = String(p.dia != null ? p.dia : '');
    if (oid !== busRaw || dia !== diaRaw) return false;
    // If mes field given, must also match
    if (mesRaw) {
      const m = p.mes != null ? String(Math.round(parseFloat(p.mes))) : null;
      return m === mesRaw;
    }
    return true;
  });

  const resolvedTarget = fuzzyMatches.length > 0 ? fuzzyMatches[0] : null;

  // Exact match
  if (resolvedTarget) {
    busInp.classList.add('input-ok');
    diaInp.classList.add('input-ok');
    // Hide all, show only this one
    Object.entries(gpsLayers).forEach(([id, entry]) => {
      entry.visible = (id === resolvedTarget);
      try { gpsMap.removeLayer(entry.layer); } catch {}
      if (entry.visible) entry.layer.addTo(gpsMap);
      const chip = document.querySelector(`.bus-chip[data-bus-id="${id}"]`);
      if (chip) chip.classList.toggle('hidden-bus', !entry.visible);
    });
    updateMarkerVisibility(resolvedTarget);
    gpsMap.fitBounds(gpsLayers[resolvedTarget].layer.getBounds(), { padding:[50,50] });
    document.getElementById('gps-bus-sel').value = resolvedTarget;
    document.getElementById('srch-clear').style.display = 'inline-flex';
    animSetTarget(resolvedTarget);
    showBusStats(resolvedTarget, mesRaw || null);
    if (!compareState.active) showCompareButton(resolvedTarget);

    const p = gpsLayers[resolvedTarget].feature.properties;
    const _MC = ['','Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  const _mn = mesRaw ? Math.round(parseFloat(mesRaw)) : null;
  const _ml = _mn && _mn >= 1 && _mn <= 12 ? ` · ${_MC[_mn]}` : (mesRaw ? ` · Mes ${mesRaw}` : '');
  showNotif('ok', '✓',
      `<b>Camión ${busRaw} · Día ${diaRaw}${_ml}</b> encontrado — ` +
      `${p.tipo || ''} · ${p.n_pings_original || '?'} pings originales · ` +
      `${p.n_puntos_simplificado || '?'} puntos renderizados` +
      (p.dia_semana ? ` · ${p.dia_semana}` : '')
    );
    return;
  }

  // Not found — diagnose why
  const busExists = !!busIndex[busRaw];
  const diasDisp  = busExists ? [...busIndex[busRaw]].sort((a,b)=>+a-+b) : [];

  if (!busExists) {
    busInp.classList.add('input-error');
    // Suggest similar camion IDs
    const allBuses = Object.keys(busIndex).sort();
    const similar  = allBuses.filter(b => b.includes(busRaw) || busRaw.includes(b)).slice(0, 8);
    const hint = similar.length
      ? `<div class="srch-avail" style="margin-top:8px"><span style="opacity:0.6;font-size:10px">Camiones disponibles similares:</span>${similar.map(b=>`<span class="srch-avail-chip" style="color:#c0392b" onclick="document.getElementById('srch-bus').value='${b}';onSearchInput()">${b}</span>`).join('')}</div>`
      : `<br><span style="opacity:0.7;font-size:10px">Camiones disponibles: ${allBuses.slice(0,12).join(', ')}${allBuses.length>12?' …':''}</span>`;
    showNotif('error', '✗',
      `No existe el camión <b>${busRaw}</b> en los datos.${hint}`
    );
  } else {
    diaInp.classList.add('input-error');
    busInp.classList.add('input-ok');
    const chips = diasDisp.map(d =>
      `<span class="srch-avail-chip" style="color:#1a6b4a" onclick="document.getElementById('srch-dia').value='${d}';searchRoute()">${d}</span>`
    ).join('');
    showNotif('error', '✗',
      `El camión <b>${busRaw}</b> existe pero <b>no tiene datos para el día ${diaRaw}</b>.<br>` +
      `<div class="srch-avail"><span style="opacity:0.6;font-size:10px">Días disponibles para este camión:</span>${chips}</div>`
    );
  }
}

function showNotif(type, icon, html) {
  const notif = document.getElementById('srch-notif');
  notif.className = `srch-notif notif-${type}`;
  notif.innerHTML = `<span class="srch-notif-icon">${icon}</span><div class="srch-notif-body">${html}</div>`;
  notif.style.display = 'flex';
}

function clearSearch() {
  document.getElementById('srch-bus').value = '';
  document.getElementById('srch-dia').value = '';
  const srchMes = document.getElementById('srch-mes');
  if (srchMes) srchMes.value = '';
  document.getElementById('srch-bus').classList.remove('input-error','input-ok');
  document.getElementById('srch-dia').classList.remove('input-error','input-ok');
  document.getElementById('srch-notif').style.display = 'none';
  document.getElementById('srch-clear').style.display = 'none';
  const _bc = document.getElementById('btn-compare'); if (_bc) _bc.style.display = 'none';
  document.getElementById('gps-bus-sel').value = 'all';
  // Restore all visible
  updateMarkerVisibility(null);
  Object.entries(gpsLayers).forEach(([id, entry]) => {
    entry.visible = true;
    entry.layer.addTo(gpsMap);
    const chip = document.querySelector(`.bus-chip[data-bus-id="${id}"]`);
    if (chip) chip.classList.remove('hidden-bus');
  });
  animReset();
  animState.targetId = null;
  document.getElementById('anim-note').textContent = 'Selecciona un camión para animar';
  document.getElementById('gps-side-stats').style.display  = 'none';
  document.getElementById('bus-stats-panel').style.display = 'none';
  renderVias(null);
  clearStays();
  fitAllBuses();
}

// Enter key triggers search
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && (document.activeElement.id === 'srch-bus' || document.activeElement.id === 'srch-dia')) {
    searchRoute();
  }
  if (e.key === 'Enter' && (document.activeElement.id === 'srch-bus-b' || document.activeElement.id === 'srch-dia-b')) {
    searchRouteB();
  }
});

// ── COMPARE MODE ──────────────────────────────────────────────────────────
let compareState = {
  active: false,
  busIdA: null,   // first camion (already found)
  busIdB: null,   // second camion
  layerB: null,   // highlighted layer for B
};
let chartCompare = null;

// Show "Comparar" button after camion A is found
function showCompareButton(busId) {
  compareState.busIdA = busId;
  const btn = document.getElementById('btn-compare');
  if (!btn) return;
  btn.style.removeProperty('display');
  btn.style.display = 'inline-flex';
  console.log('showCompareButton called, btn display now:', btn.style.display, 'offsetParent:', btn.offsetParent);
}

function enterCompareMode() {
  compareState.active = true;
  compareState.busIdB = null;
  { const _g_cmp_vs=document.getElementById('cmp-vs'); if(_g_cmp_vs) _g_cmp_vs.style.display='flex'; }
  { const _g_cmp_slot_b=document.getElementById('cmp-slot-b'); if(_g_cmp_slot_b) _g_cmp_slot_b.style.display='flex'; }
  const _bc = document.getElementById('btn-compare'); if (_bc) _bc.style.display = 'none';
  document.getElementById('srch-clear').style.display  = 'none';
  document.getElementById('srch-notif').style.display  = 'none';
  document.getElementById('srch-label-a').textContent  = 'Camión día A';
  // Hide single stats panels
  document.getElementById('gps-side-stats').style.display  = 'none';
  document.getElementById('bus-stats-panel').style.display = 'none';
}

function exitCompareMode() {
  compareState.active = false;
  compareState.busIdB = null;
  { const _g_cmp_vs=document.getElementById('cmp-vs'); if(_g_cmp_vs) _g_cmp_vs.style.display='none'; }
  { const _g_cmp_slot_b=document.getElementById('cmp-slot-b'); if(_g_cmp_slot_b) _g_cmp_slot_b.style.display='none'; }
  const _cp = document.getElementById('cmp-panel-emp'); if (_cp) _cp.style.display = 'none';
  const _bc = document.getElementById('btn-compare'); if (_bc) _bc.style.display = 'none';
  document.getElementById('srch-label-a').textContent  = 'Buscar camión día (ruta)';
  document.getElementById('srch-bus-b').value = '';
  document.getElementById('srch-dia-b').value = '';
  if (chartCompare) { chartCompare.destroy(); chartCompare = null; }
  // Restore original colors on all layers
  Object.entries(gpsLayers).forEach(([id, e]) => {
    if (e.layer) {
      try { e.layer.setStyle({ color: e.color, weight: 2.5, opacity: 0.75 }); } catch {}
    }
  });
  clearSearch();
}

function onSearchInputB() {
  document.getElementById('srch-bus-b').classList.remove('input-error','input-ok');
  document.getElementById('srch-dia-b').classList.remove('input-error','input-ok');
}

function searchRouteB() {
  const busRaw = document.getElementById('srch-bus-b').value.trim();
  const diaRaw = document.getElementById('srch-dia-b').value.trim();
  const busInp = document.getElementById('srch-bus-b');
  const diaInp = document.getElementById('srch-dia-b');
  busInp.classList.remove('input-error','input-ok');
  diaInp.classList.remove('input-error','input-ok');

  if (!busRaw || !diaRaw) {
    showNotif('info','⚠️','<b>Completa ambos campos</b> para el segundo camión día (ruta).');
    if (!busRaw) busInp.classList.add('input-error');
    if (!diaRaw) diaInp.classList.add('input-error');
    return;
  }

  const mesRawB = document.getElementById('srch-mes-b') ? document.getElementById('srch-mes-b').value.trim() : '';

  // Find by GeoJSON properties (handles triple/double key)
  const matchesB = Object.keys(gpsLayers).filter(id => {
    const p   = gpsLayers[id].feature.properties;
    const oid = String(p.owner_id || p.objectId || '');
    const dia = String(p.dia != null ? p.dia : '');
    if (oid !== busRaw || dia !== diaRaw) return false;
    if (mesRawB) {
      const m = p.mes != null ? String(Math.round(parseFloat(p.mes))) : null;
      return m === mesRawB;
    }
    return true;
  });

  const resolvedB = matchesB.length > 0 ? matchesB[0] : null;

  if (!resolvedB) {
    const busExists = !!busIndex[busRaw];
    if (!busExists) {
      busInp.classList.add('input-error');
      showNotif('error','✗',`No existe el camión <b>${busRaw}</b> en los datos.`);
    } else {
      diaInp.classList.add('input-error');
      const dias = [...busIndex[busRaw]].sort((a,b)=>+a-+b);
      showNotif('error','✗',
        `Camión <b>${busRaw}</b> no tiene datos para el día <b>${diaRaw}</b>.<br>` +
        `<div class="srch-avail"><span style="opacity:0.6;font-size:10px">Días disponibles:</span>${dias.map(d=>`<span class="srch-avail-chip" style="color:var(--alt)" onclick="document.getElementById('srch-dia-b').value='${d}';searchRouteB()">${d}</span>`).join('')}</div>`
      );
    }
    return;
  }

  busInp.classList.add('input-ok');
  diaInp.classList.add('input-ok');
  compareState.busIdB = resolvedB;
  document.getElementById('srch-notif').style.display = 'none';

  // Show both routes on map
  showComparePair(compareState.busIdA, resolvedB);
  renderComparePanel(compareState.busIdA, resolvedB);
}

function showComparePair(idA, idB) {
  updateMarkerVisibility(null);
  // Hide all except A and B, color them distinctly
  Object.entries(gpsLayers).forEach(([id, e]) => {
    const show = id === idA || id === idB;
    e.visible = show;
    if (e.layer) {
      try { gpsMap.removeLayer(e.layer); } catch {}
      if (show) {
        // Recolor for compare: A=red, B=green
        const col = id === idA ? '#c0392b' : '#1a6b4a';
        e.layer.setStyle({ color: col, weight: 4, opacity: 1 });
        e.layer.addTo(gpsMap);
      }
    }
    const chip = document.querySelector(`.bus-chip[data-bus-id="${id}"]`);
    if (chip) chip.classList.toggle('hidden-bus', !show);
  });
  // Fit both — guard against null layers (still rendering)
  try {
    const la = gpsLayers[idA] && gpsLayers[idA].layer;
    const lb = gpsLayers[idB] && gpsLayers[idB].layer;
    if (la && lb) gpsMap.fitBounds(la.getBounds().extend(lb.getBounds()), { padding:[40,40] });
    else if (la) gpsMap.fitBounds(la.getBounds(), { padding:[40,40] });
  } catch {}

  // Set animation target to A by default
  selectCmpAnim('a', idA, idB);
}

function selectCmpAnim(which, idA, idB) {
  // Use stored compare IDs if not passed
  const a = idA || compareState.busIdA;
  const b = idB || compareState.busIdB;
  const targetId = which === 'a' ? a : b;

  document.getElementById('cmp-anim-a').classList.toggle('active', which === 'a');
  document.getElementById('cmp-anim-b').classList.toggle('active', which === 'b');

  animReset();
  animState.targetId = null;
  if (targetId) animSetTarget(targetId);
}

// renderComparePanel moved to comparativas.js


function toggleBusChip(chip, id) {
  const entry = gpsLayers[id];
  if (!entry) return;
  entry.visible = !entry.visible;
  if (entry.visible) {
    entry.layer.addTo(gpsMap);
    chip.classList.remove('hidden-bus');
  } else {
    try { gpsMap.removeLayer(entry.layer); } catch {}
    chip.classList.add('hidden-bus');
  }
}

// Markers for a single selected camion, hide for all others
function updateMarkerVisibility(singleId) {
  Object.entries(gpsLayers).forEach(([id, e]) => {
    const shouldShow = (id === singleId);
    const isOnMap    = e._markersOnMap;
    if (shouldShow && !isOnMap && e.startMarker) {
      e.startMarker.addTo(gpsMap);
      e.endMarker.addTo(gpsMap);
      e._markersOnMap = true;
    } else if (!shouldShow && isOnMap && e.startMarker) {
      try { gpsMap.removeLayer(e.startMarker); } catch {}
      try { gpsMap.removeLayer(e.endMarker); }   catch {}
      e._markersOnMap = false;
    }
  });
}

// ── CASCADE FILTER SYSTEM ────────────────────────────────────────────────────
// Order: Empresa → Camión → Mes → Día
// Each selector repopulates the next ones based on current selection.
// applyFilters() is the single source of truth for what's visible on the map.

function _getFilterVals() {
  return {
    empresa: (document.getElementById('gps-empresa-sel')   || {value:'all'}).value,
    bus:     (document.getElementById('gps-bus-sel')       || {value:'all'}).value,
    mes:     (document.getElementById('gps-mes-sel')       || {value:'all'}).value,
    dia:     (document.getElementById('gps-dia-sel')       || {value:'all'}).value,
    viaje:   (document.getElementById('gps-viaje-sel')     || {value:'all'}).value,
  };
}

// Returns true if a layer entry matches the given filter values
function _entryMatches(entry, {empresa, bus, mes, dia, viaje = 'all'}) {
  const p = entry.feature.properties;
  const oid = String(p.owner_id ?? p.objectId ?? '');
  if (empresa !== 'all' && String(p.account_id || '') !== empresa) return false;
  if (bus     !== 'all' && oid !== bus) return false;
  if (mes     !== 'all') {
    const rawMes = mesKey ? p[mesKey] : p.mes;
    if (rawMes == null) return false;
    if (String(Math.round(parseFloat(rawMes))) !== String(mes)) return false;
  }
  if (dia !== 'all') {
    if (p.dia == null) return false;
    if (String(p.dia) !== String(dia)) return false;
  }
  if (typeof viaje !== 'undefined' && viaje !== 'all') {
    const hs = p.hora_salida != null ? String(parseFloat(p.hora_salida)) : null;
    if (hs !== viaje) return false;
  }
  return true;
}

// Repopulate Camión selector filtered by current empresa selection
function populateBusSel(keepVal) {
  const sel = document.getElementById('gps-bus-sel');
  if (!sel) return;
  const empresa = (document.getElementById('gps-empresa-sel') || {value:'all'}).value;
  const seen = new Set();
  const opts = [];
  Object.values(gpsLayers).forEach(entry => {
    const p = entry.feature.properties;
    if (empresa !== 'all' && String(p.account_id || '') !== empresa) return;
    const oid = String(p.owner_id ?? p.objectId ?? '');
    if (!oid || seen.has(oid)) return;
    seen.add(oid);
    opts.push(oid);
  });
  opts.sort((a,b) => isNaN(a) || isNaN(b) ? a.localeCompare(b) : Number(a)-Number(b));
  sel.innerHTML = '<option value="all">Todos los camiones</option>';
  opts.forEach(oid => {
    const o = document.createElement('option');
    o.value = oid; o.textContent = `Camión ${oid}`;
    sel.appendChild(o);
  });
  if (keepVal && [...sel.options].some(o => o.value === keepVal)) sel.value = keepVal;
}

// Repopulate Mes selector filtered by empresa + camion
function populateMesSel(keepVal) {
  const sel = document.getElementById('gps-mes-sel');
  if (!sel) return;
  const {empresa, bus} = _getFilterVals();
  const MESES = ['','Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  const counts = {};
  Object.values(gpsLayers).forEach(entry => {
    if (!_entryMatches(entry, {empresa, bus, mes:'all', dia:'all'})) return;
    const rawMes = mesKey ? entry.feature.properties[mesKey] : entry.feature.properties.mes;
    if (rawMes == null) return;
    const m = String(Math.round(parseFloat(rawMes)));
    counts[m] = (counts[m] || 0) + 1;
  });
  const sorted = Object.keys(counts).sort((a,b) => parseInt(a)-parseInt(b));
  sel.innerHTML = '<option value="all">Todos los meses</option>';
  sorted.forEach(m => {
    const o = document.createElement('option');
    o.value = m;
    const label = parseInt(m) >= 1 && parseInt(m) <= 12 ? MESES[parseInt(m)] : `Mes ${m}`;
    o.textContent = `${label} (${counts[m]})`;
    sel.appendChild(o);
  });
  if (keepVal && [...sel.options].some(o => o.value === keepVal)) sel.value = keepVal;
}

// Repopulate Día selector filtered by empresa + camion + mes
function populateDiaSel(keepVal) {
  const sel = document.getElementById('gps-dia-sel');
  if (!sel) return;
  const {empresa, bus, mes} = _getFilterVals();
  const counts = {};
  Object.values(gpsLayers).forEach(entry => {
    if (!_entryMatches(entry, {empresa, bus, mes, dia:'all'})) return;
    const d = entry.feature.properties.dia;
    if (d == null) return;
    const key = String(d);
    counts[key] = (counts[key] || 0) + 1;
  });
  const sorted = Object.keys(counts).sort((a,b) => parseInt(a)-parseInt(b));
  sel.innerHTML = '<option value="all">Todos los días</option>';
  sorted.forEach(d => {
    const o = document.createElement('option');
    o.value = d; o.textContent = `Día ${d} (${counts[d]})`;
    sel.appendChild(o);
  });
  if (keepVal && [...sel.options].some(o => o.value === keepVal)) sel.value = keepVal;
}

// Apply current filter state to map
function applyFilters() {
  const fv = _getFilterVals();
  const anyActive = Object.values(fv).some(v => v !== 'all');
  const btn = document.getElementById('btn-reset-filters');
  if (btn) btn.style.display = anyActive ? 'inline-flex' : 'none';

  // If a specific camion+mes+dia is selected, try to focus a single layer
  let singleId = null;
  if (fv.bus !== 'all') {
    const candidates = Object.entries(gpsLayers).filter(([,e]) => _entryMatches(e, fv));
    if (candidates.length === 1) singleId = candidates[0][0];
  }

  Object.entries(gpsLayers).forEach(([id, entry]) => {
    const show = _entryMatches(entry, fv);
    entry.visible = show;
    try { gpsMap.removeLayer(entry.layer); } catch {}
    if (show) { try { entry.layer.addTo(gpsMap); } catch {} }
    const chip = document.querySelector(`.bus-chip[data-bus-id="${id}"]`);
    if (chip) chip.classList.toggle('hidden-bus', !show);
  });
  updateMarkerVisibility(singleId);

  if (singleId) {
    const entry = gpsLayers[singleId];
    gpsMap.fitBounds(entry.layer.getBounds(), { padding: [40, 40] });
    animSetTarget(singleId);
    showBusStats(singleId);
    if (!compareState.active) showCompareButton(singleId);
    // Sincronizar panel de Ruido si está activo (o cuando se entre a él)
    if (typeof ruidoSyncRoute === 'function') ruidoSyncRoute(singleId);
  } else if (anyActive && Object.keys(statsData).length > 0) {
    showGroupStats();
  } else if (!anyActive) {
    document.getElementById('gps-side-stats').style.display  = 'none';
    document.getElementById('bus-stats-panel').style.display = 'none';
  }
  // Update dynamic stat cells to reflect current visible set
  updateStatsCells();
  // Redraw impact canvas after visibility change
  if (_impactCanvas && gpsMap) scheduleImpactDraw(gpsMap);
  if (typeof h3OnFilterChange === 'function') h3OnFilterChange();
}

// ── CASCADE HANDLERS ──
function populateViajeSel(keepVal) {
  const sel = document.getElementById('gps-viaje-sel');
  const lbl = document.getElementById('gps-viaje-lbl');
  if (!sel) return;

  // Read current filter values (empresa/bus/mes/dia — ignore viaje to avoid recursion)
  const fv0 = _getFilterVals();
  const empresa = fv0.empresa, bus = fv0.bus, mes = fv0.mes, dia = fv0.dia;

  // Only show when camion AND dia are both selected
  if (bus === 'all' || dia === 'all') {
    sel.style.display = 'none';
    if (lbl) lbl.style.display = 'none';
    sel.value = 'all';
    return;
  }

  // Collect unique hora_salida values for matching entries
  const seen = {};
  Object.values(gpsLayers).forEach(entry => {
    if (!_entryMatches(entry, {empresa, bus, mes, dia})) return;
    const p  = entry.feature.properties;
    const hs = (p.hora_salida != null && p.hora_salida !== '')
      ? String(parseFloat(p.hora_salida)) : null;
    if (hs) seen[hs] = (seen[hs] || 0) + 1;
  });

  const sorted = Object.keys(seen).sort((a,b) => parseFloat(a)-parseFloat(b));

  // Only one trip (or none with hora_salida) — keep hidden
  if (sorted.length <= 1) {
    sel.style.display = 'none';
    if (lbl) lbl.style.display = 'none';
    sel.value = 'all';
    return;
  }

  // Multiple trips — show selector
  if (lbl) { lbl.style.removeProperty('display'); }
  sel.style.removeProperty('display');
  sel.innerHTML = '<option value="all">Todos los viajes (' + sorted.length + ')</option>';
  sorted.forEach(hs => {
    const opt = document.createElement('option');
    opt.value = hs;
    const h  = parseFloat(hs);
    const hh = String(Math.floor(h)).padStart(2,'0');
    const mm = String(Math.round((h % 1) * 60)).padStart(2,'0');
    opt.textContent = 'Salida ' + hh + ':' + mm;
    sel.appendChild(opt);
  });
  if (keepVal && [...sel.options].some(o => o.value === keepVal)) sel.value = keepVal;
}

function onViajeChange() { applyFilters(); }

function onEmpresaChange() {
  populateBusSel();
  populateMesSel();
  populateDiaSel();
  populateViajeSel();
  applyFilters();
}
function onBusChange() {
  populateMesSel();
  populateDiaSel();
  populateViajeSel();
  applyFilters();
}
function onMesChange() {
  populateDiaSel();
  populateViajeSel();
  applyFilters();
}
function onDiaChange() {
  populateViajeSel();
  applyFilters();
}

function resetFilters() {
  ['gps-empresa-sel','gps-bus-sel','gps-mes-sel','gps-dia-sel','gps-viaje-sel'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = 'all';
  });
  // Repopulate all selectors to full set
  populateBusSel();
  populateMesSel();
  populateDiaSel();
  applyFilters();
}

// ── DYNAMIC STATS CELLS ──────────────────────────────────────────────────────
// Updates the 3 filter-dependent cells (Camiones día totales, Empresas, Camiones únicos)
// based on what is currently visible on the map.
function updateStatsCells() {
  // Always recount using _entryMatches to get the exact filtered count
  // (avoids singleId/visible inconsistency)
  const fv = _getFilterVals();
  const anyActive = Object.values(fv).some(v => v !== 'all');
  const visible = Object.values(gpsLayers).filter(e => _entryMatches(e, fv));

  // Count filtered routes (exact match to all active filters)
  const nVisible = visible.length;

  // Count unique empresas among visible
  const empSet = new Set(visible.map(e => {
    const a = e.feature.properties.account_id;
    return (a != null && a !== '') ? String(a) : null;
  }).filter(Boolean));

  // Count unique camiones (owner_id) among visible
  const busSet = new Set(visible.map(e => {
    const p = e.feature.properties;
    return String(p.owner_id ?? p.objectId ?? '');
  }).filter(Boolean));

  // Update cells
  const totalEl = document.getElementById('gs-total');
  const totalLbl = document.getElementById('gs-total-lbl');
  const empEl   = document.getElementById('gs-empresas');
  const empLbl  = document.getElementById('gs-empresas-lbl');
  const busEl   = document.getElementById('gs-buses-empresa');
  const busLbl  = document.getElementById('gs-buses-empresa-lbl');

  if (totalEl) totalEl.textContent = nVisible.toLocaleString('es-CL');
  if (totalLbl) {
    const allSpecific = fv.bus !== 'all' && fv.dia !== 'all' && fv.viaje === 'all';
    if (!anyActive)            totalLbl.textContent = 'Camiones día (rutas) totales';
    else if (allSpecific && nVisible > 1) totalLbl.textContent = 'Viajes ese día';
    else if (fv.viaje !== 'all')          totalLbl.textContent = 'Camión día (ruta) seleccionada';
    else                                   totalLbl.textContent = 'Camiones día (rutas) filtradas';
  }

  if (empEl) empEl.textContent = empSet.size > 0 ? empSet.size : '—';
  if (empLbl) {
    empLbl.textContent = fv.empresa !== 'all' ? 'Empresa seleccionada' : 'Empresas';
  }

  if (busEl) busEl.textContent = busSet.size > 0 ? busSet.size : '—';
  if (busLbl) {
    busLbl.textContent = fv.empresa !== 'all' ? 'Camiones de la empresa' : 'Camiones únicos';
  }

  // ── Toggle fixed cells vs dynamic avg-por-camion ──
  const cellAvgEmpresa = document.getElementById('gs-cell-avg-empresa');
  const cellPings      = document.getElementById('gs-cell-pings');
  const cellAvgCamion  = document.getElementById('gs-cell-avg-camion');
  const avgCamionEl    = document.getElementById('gs-avg-camion');
  const avgCamionLbl   = document.getElementById('gs-avg-camion-lbl');

  if (!anyActive) {
    // No filters: show the two original fixed cells
    if (cellAvgEmpresa) cellAvgEmpresa.style.display = '';
    if (cellPings)      cellPings.style.display      = '';
    if (cellAvgCamion)  cellAvgCamion.style.display  = 'none';
  } else {
    // Filters active: hide fixed cells, show avg-por-camion
    if (cellAvgEmpresa) cellAvgEmpresa.style.display = 'none';
    if (cellPings)      cellPings.style.display      = 'none';
    if (cellAvgCamion)  cellAvgCamion.style.display  = '';

    // Calculate: total visible routes / unique camiones
    const nCam = busSet.size;
    const avg  = nCam > 0 ? (nVisible / nCam) : null;
    if (avgCamionEl) avgCamionEl.textContent = avg != null
      ? avg.toLocaleString('es-CL', {maximumFractionDigits: 1})
      : '—';

    // Label adapts to filter context
    if (avgCamionLbl) {
      if (fv.empresa !== 'all' && fv.bus === 'all')
        avgCamionLbl.textContent = 'Camiones día · promedio por camión de la empresa';
      else if (fv.bus !== 'all')
        avgCamionLbl.textContent = 'Camiones día · total del camión filtrado';
      else
        avgCamionLbl.textContent = 'Camiones día · promedio por camión';
    }
  }
}

// Legacy alias kept so any remaining call to filterBuses() still works
function filterBuses() { applyFilters(); }
function focusBus()    { onBusChange(); }



// ══════════════════════════════════════════════════════════════════════════
// ESTIMADORES POBLACIONALES
// Para cada camión día (ruta) con datos CSV:
//   1. Suma total = Σ gse_*_personas (o Σ edad_*_personas — deben coincidir)
//   2. Proporción de cada segmento = segmento / total
//   3. Promedio global = media de todas las proporciones por segmento
// ══════════════════════════════════════════════════════════════════════════

const EST_GSE_KEYS = [
  'gse_ab_personas','gse_c1a_personas','gse_c2_personas',
  'gse_c3_personas','gse_d_personas','gse_e_personas'
];
const EST_EDAD_KEYS = [
  'edad_menor_25_personas','edad_25_34_personas','edad_35_44_personas',
  'edad_45_54_personas','edad_55_64_personas','edad_mayor_65_personas'
];
const EST_GSE_LABELS  = ['GSE AB','GSE C1a','GSE C2','GSE C3','GSE D','GSE E'];
const EST_EDAD_LABELS = ['<25','25–34','35–44','45–54','55–64','>65'];
const EST_GSE_COLORS  = ['#7c3aed','#4f46e5','#2563eb','#0891b2','#059669','#16a34a'];
const EST_EDAD_COLORS = ['#f59e0b','#f97316','#ef4444','#ec4899','#a855f7','#6366f1'];

function calcEstimadores(rows) {
  // rows: raw CSV rows (Papa.parse output)
  // Use only rows where we can compute a valid total from GSE keys
  const gseProportions  = EST_GSE_KEYS.map(() => []);
  const edadProportions = EST_EDAD_KEYS.map(() => []);
  let validRows = 0;
  let totalPersonasSum = 0;

  rows.forEach(r => {
    const gseVals  = EST_GSE_KEYS.map(k  => parseFloat(r[k])  || 0);
    const edadVals = EST_EDAD_KEYS.map(k => parseFloat(r[k]) || 0);

    const gseTotal  = gseVals.reduce((a, b) => a + b, 0);
    const edadTotal = edadVals.reduce((a, b) => a + b, 0);

    // Use GSE total as canonical total (skip rows with 0 total)
    if (gseTotal <= 0) return;
    validRows++;
    totalPersonasSum += gseTotal;

    gseVals.forEach((v, i)  => gseProportions[i].push(v / gseTotal));
    edadVals.forEach((v, i) => edadProportions[i].push(v / (edadTotal > 0 ? edadTotal : gseTotal)));
  });

  if (validRows === 0) return;

  // Average proportions
  const avgGse  = gseProportions.map(arr  => arr.reduce((a,b) => a+b, 0) / arr.length);
  const avgEdad = edadProportions.map(arr => arr.reduce((a,b) => a+b, 0) / arr.length);

  // Average absolute personas per via
  const avgPersonasPorVia = totalPersonasSum / validRows;

  // Store globally for card comparison arrows
  estPropGSE  = avgGse;
  estPropEdad = avgEdad;
  renderEstimadores(avgGse, avgEdad, avgPersonasPorVia, validRows);
}

function renderEstimadores(avgGse, avgEdad, avgPersonasPorVia, n) {
  const panel = document.getElementById('estimadores-panel');
  const sub   = document.getElementById('estimadores-sub');
  if (!panel) return;

  sub.textContent = `Distribución porcentual promedio · ${n} camiones día (rutas) con datos · ${avgPersonasPorVia.toFixed(1)} personas promedio/vía`;
  panel.style.display = 'block';

  const maxGse  = Math.max(...avgGse);
  const maxEdad = Math.max(...avgEdad);

  function buildGrid(gridId, labels, values, colors, maxVal) {
    const grid = document.getElementById(gridId);
    if (!grid) return;
    // Keep the section label (first child), remove the rest
    while (grid.children.length > 1) grid.removeChild(grid.lastChild);

    values.forEach((pct, i) => {
      const card = document.createElement('div');
      card.className = 'est-card';

      const lbl = document.createElement('div');
      lbl.className = 'est-card-label';
      lbl.textContent = labels[i];

      const pctEl = document.createElement('div');
      pctEl.className = 'est-card-pct';
      pctEl.textContent = (pct * 100).toFixed(1) + '%';
      pctEl.style.color = colors[i];

      const abs = document.createElement('div');
      abs.className = 'est-card-abs';
      abs.textContent = (pct * avgPersonasPorVia).toFixed(1) + ' p/vía';

      const bar = document.createElement('div');
      bar.className = 'est-bar';
      bar.style.background = colors[i];
      bar.style.width = (maxVal > 0 ? (pct / maxVal * 100) : 0) + '%';

      card.appendChild(lbl);
      card.appendChild(pctEl);
      card.appendChild(abs);
      card.appendChild(bar);
      grid.appendChild(card);
    });
  }

  buildGrid('est-grid-gse',  EST_GSE_LABELS,  avgGse,  EST_GSE_COLORS,  maxGse);
  buildGrid('est-grid-edad', EST_EDAD_LABELS, avgEdad, EST_EDAD_COLORS, maxEdad);
}

function toggleEstimadores() {
  const body = document.getElementById('estimadores-body');
  const btn  = document.getElementById('btn-estimadores-toggle');
  if (!body || !btn) return;
  const open = body.style.display !== 'none';
  body.style.display = open ? 'none' : 'block';
  btn.textContent    = open ? '▼ Ver' : '▲ Ocultar';
}
