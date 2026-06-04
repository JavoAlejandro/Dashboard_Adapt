'use strict';
// ══════════════════════════════════════════════════════════════════════════════
// H3 OVERLAY — Visualización de impacto por hexágono sobre el mapa GPS
//
// Carga el CSV generado por calcular_impactos_h3() y pinta hexágonos H3
// coloreados por total_ph_hex (personas/hora promedio en ese hexágono).
//
// Formato esperado del CSV:
//   owner_id, account_id, dia, mes, ano, hora_salida, h3_9,
//   n_pings_hex, pct_cobertura_hex, total_personas_hex, total_ph_hex,
//   gse_ab_personas_hex, ..., gse_ab_ph_hex, ...
// ══════════════════════════════════════════════════════════════════════════════

let _h3Data      = [];          // raw rows from CSV
let _h3Visible   = false;       // toggle state
let _h3LayerGrp  = null;        // L.layerGroup with hex polygons
let _h3FilterKey = null;        // current (owner_id, dia, mes, ano) filter

// ─── COLOR RAMP ───────────────────────────────────────────────────────────────
// Azul (bajo) → verde → ámbar → rojo (alto)
const H3_RAMP = [
  { t: 0.00, r: 59,  g: 130, b: 246 },  // blue-400
  { t: 0.33, r: 34,  g: 197, b: 94  },  // green-500
  { t: 0.66, r: 245, g: 158, b: 11  },  // amber-500
  { t: 1.00, r: 239, g: 68,  b: 68  },  // red-500
];

function _h3Color(norm) {
  let lo = H3_RAMP[0], hi = H3_RAMP[H3_RAMP.length - 1];
  for (let i = 1; i < H3_RAMP.length; i++) {
    if (norm <= H3_RAMP[i].t) { lo = H3_RAMP[i - 1]; hi = H3_RAMP[i]; break; }
  }
  const f = (norm - lo.t) / Math.max(hi.t - lo.t, 1e-9);
  return [
    Math.round(lo.r + (hi.r - lo.r) * f),
    Math.round(lo.g + (hi.g - lo.g) * f),
    Math.round(lo.b + (hi.b - lo.b) * f),
  ];
}

function _h3CssColor(norm, alpha = 0.55) {
  const [r, g, b] = _h3Color(norm);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ─── H3 → LEAFLET POLYGON ─────────────────────────────────────────────────────
function _h3ToLatLngs(hexId) {
  try {
    // h3-js v4 UMD: h3.cellToBoundary → [[lat,lng], ...]
    // h3-js v3 UMD: h3.h3ToGeoBoundary → [[lat,lng], ...]
    if (typeof h3 === 'undefined') return null;
    const fn = h3.cellToBoundary || h3.h3ToGeoBoundary;
    if (!fn) return null;
    return fn(hexId);  // [[lat, lng], ...]
  } catch (e) {
    // Silently skip invalid indices
    return null;
  }
}

// ─── LOAD CSV ─────────────────────────────────────────────────────────────────
function loadH3CSV(ev) {
  const file = ev.target.files[0];
  if (!file) return;
  const statusEl = document.getElementById('h3-csv-status');
  statusEl.textContent = '⏳ Procesando…';

  Papa.parse(file, {
    header: true,
    dynamicTyping: true,
    skipEmptyLines: true,
    complete({ data: rows }) {
      const required = ['h3_9', 'owner_id', 'total_ph_hex'];
      const cols = Object.keys(rows[0] || {});
      const missing = required.filter(c => !cols.includes(c));
      if (missing.length) {
        statusEl.textContent = `✗ Columnas faltantes: ${missing.join(', ')}`;
        return;
      }

      _h3Data = rows.filter(r => r.h3_9 && r.total_ph_hex != null);

      const nHex   = new Set(_h3Data.map(r => r.h3_9)).size;
      const nRutas = new Set(_h3Data.map(r => `${r.owner_id}_${r.dia}_${r.mes}`)).size;
      statusEl.textContent =
        `✓ ${_h3Data.length.toLocaleString()} registros · ${nHex.toLocaleString()} hexágonos · ${nRutas.toLocaleString()} rutas`;

      // Auto-show if toggle is on
      if (document.getElementById('h3-overlay-toggle')?.checked) {
        drawH3Overlay();
      }
    },
    error(e) {
      statusEl.textContent = '✗ Error al leer CSV: ' + e.message;
    }
  });
}

// ─── TOGGLE ───────────────────────────────────────────────────────────────────
function toggleH3Overlay(on) {
  _h3Visible = on;

  // Sync checkbox state in case called programmatically
  const cb = document.getElementById('h3-overlay-toggle');
  if (cb && cb.checked !== on) cb.checked = on;

  // Update button visual state
  const btn = document.getElementById('h3-toggle-btn');
  if (btn) {
    btn.style.background = on ? 'var(--accent)' : '';
    btn.style.color      = on ? 'var(--bg)'     : '';
    btn.textContent      = on ? '⬡ Hexágonos ON' : '⬡ Hexágonos';
  }

  if (on) drawH3Overlay();
  else    clearH3Overlay();
}

// Called from the toggle button in the HTML
function h3ToggleBtn() {
  const cb = document.getElementById('h3-overlay-toggle');
  if (cb) {
    cb.checked = !cb.checked;
    toggleH3Overlay(cb.checked);
  }
}

function clearH3Overlay() {
  if (_h3LayerGrp && gpsMap) {
    gpsMap.removeLayer(_h3LayerGrp);
    _h3LayerGrp = null;
  }
  const leg = document.getElementById('h3-legend');
  if (leg) leg.style.display = 'none';
}

// ─── DRAW ─────────────────────────────────────────────────────────────────────
function drawH3Overlay(filterKey) {
  if (!gpsMap || !_h3Visible || !_h3Data.length) return;

  // Guard: h3-js must be loaded
  if (typeof h3 === 'undefined' || (!h3.cellToBoundary && !h3.h3ToGeoBoundary)) {
    // Retry after CDN loads
    console.warn('h3-js not ready, retrying in 500ms...');
    setTimeout(() => drawH3Overlay(filterKey), 500);
    return;
  }

  clearH3Overlay();

  // Filter rows by active route if provided
  // filterKey: { owner_id, dia, mes, ano } or null = show all visible routes
  let rows = _h3Data;
  if (filterKey) {
    rows = _h3Data.filter(r =>
      String(r.owner_id) === String(filterKey.owner_id) &&
      String(r.dia)      === String(filterKey.dia)      &&
      String(r.mes)      === String(filterKey.mes)      &&
      (filterKey.ano == null || String(r.ano) === String(filterKey.ano))
    );
  } else {
    // Show hexagons for all currently visible routes
    const visibleKeys = new Set(
      Object.entries(gpsLayers)
        .filter(([, e]) => e.visible)
        .map(([, e]) => {
          const p = e.feature.properties;
          return `${p.owner_id}_${p.dia}_${p.mes}`;
        })
    );
    if (visibleKeys.size > 0) {
      rows = _h3Data.filter(r =>
        visibleKeys.has(`${r.owner_id}_${r.dia}_${r.mes}`)
      );
    }
  }

  if (!rows.length) return;

  // Normalize total_ph_hex across shown rows
  const vals  = rows.map(r => +r.total_ph_hex || 0);
  const maxV  = Math.max(...vals);
  const minV  = Math.min(...vals.filter(v => v > 0), maxV);
  const range = maxV - minV || 1;

  // Aggregate by h3_9 (average if multiple routes share same hex)
  const byHex = {};
  rows.forEach(r => {
    const k = r.h3_9;
    if (!byHex[k]) byHex[k] = { sum: 0, count: 0, rows: [] };
    byHex[k].sum   += (+r.total_ph_hex || 0);
    byHex[k].count += 1;
    byHex[k].rows.push(r);
  });

  _h3LayerGrp = L.layerGroup();

  // Ensure hex pane exists and sits between tiles and routes
  if (!gpsMap.getPane('h3Pane')) {
    const p = gpsMap.createPane('h3Pane');
    p.style.zIndex       = '300';
    p.style.pointerEvents = 'none';
  }

  Object.entries(byHex).forEach(([hexId, agg]) => {
    const latlngs = _h3ToLatLngs(hexId);
    if (!latlngs) return;

    const avgPh = agg.sum / agg.count;
    const norm  = Math.max(0, Math.min(1, (avgPh - minV) / range));
    const fill  = _h3CssColor(norm, 0.50);
    const stroke = _h3CssColor(norm, 0.80);

    // Build tooltip content
    const sample = agg.rows[0];
    const fmtN   = v => v >= 1000 ? (v/1000).toFixed(1) + 'k' : (+v || 0).toFixed(1);
    const tipLines = [
      `<b style="font-family:'Syne Mono',monospace;font-size:10px">${hexId.slice(-8)}</b>`,
      `${fmtN(avgPh)} p/h · ${agg.count} ruta(s)`,
      `Pings: ${agg.rows.reduce((s,r) => s + (+r.n_pings_hex||0), 0).toLocaleString()}`,
    ];
    if (sample.pct_cobertura_hex != null) {
      tipLines.push(`Cobertura: ${(+sample.pct_cobertura_hex * 100).toFixed(0)}%`);
    }

    const poly = L.polygon(latlngs, {
      fillColor:   fill,
      fillOpacity: 1,
      color:       stroke,
      weight:      1,
      interactive: false,
      pane:        'h3Pane',
    });

    _h3LayerGrp.addLayer(poly);
  });

  _h3LayerGrp.addTo(gpsMap);

  // Update legend
  _h3UpdateLegend(minV, maxV);
}

// ─── LEGEND ───────────────────────────────────────────────────────────────────
function _h3UpdateLegend(minV, maxV) {
  let leg = document.getElementById('h3-legend');
  if (!leg) {
    leg = document.createElement('div');
    leg.id = 'h3-legend';
    leg.style.cssText = [
      'position:absolute','bottom:80px','left:12px','z-index:500',
      'background:var(--surface)','border:1px solid var(--border)',
      'border-radius:4px','padding:8px 12px',
      'font-family:Syne Mono,monospace','font-size:9px',
      'color:var(--muted)','min-width:140px','pointer-events:none',
    ].join(';');
    document.getElementById('map-gps').appendChild(leg);
  }

  const fmtN = v => v >= 1000 ? (v/1000).toFixed(1)+'k' : v.toFixed(0);
  const gradStops = H3_RAMP
    .map(s => `rgb(${s.r},${s.g},${s.b}) ${(s.t * 100).toFixed(0)}%`)
    .join(',');

  leg.innerHTML = `
    <div style="letter-spacing:0.1em;text-transform:uppercase;margin-bottom:5px">
      Impacto H3 p/h
    </div>
    <div style="height:8px;border-radius:2px;background:linear-gradient(to right,${gradStops});margin-bottom:4px"></div>
    <div style="display:flex;justify-content:space-between">
      <span>${fmtN(minV)}</span><span>${fmtN(maxV)}</span>
    </div>`;

  leg.style.display = _h3Visible && _h3Data.length ? 'block' : 'none';
}

// ─── HOOK INTO EXISTING FILTERS ───────────────────────────────────────────────
// Called after applyFilters() changes visible layers
function h3OnFilterChange() {
  if (_h3Visible && _h3Data.length) drawH3Overlay();
}

// Called when user clicks a specific route (showBusStats)
function h3OnRouteSelect(ownerId, dia, mes, ano) {
  if (_h3Visible && _h3Data.length) {
    drawH3Overlay({ owner_id: ownerId, dia, mes, ano });
  }
}
