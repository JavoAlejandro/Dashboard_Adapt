'use strict';

// ══════════════════════════════════════════════════════════════════════════════
// TEMPORAL PANEL
// Analiza el CSV de impactos (output de calcular_impactos.py) y muestra:
//   - KPIs globales
//   - Evolución por mes / día de semana / hora de salida (líneas por empresa)
//   - Distribución por día de semana (barras)
//   - Distribución por hora de salida (barras)
//   - Tabla resumen por empresa
//
// Formato esperado del CSV:
//   owner_id, account_id, dia, mes, dia_semana, hora_salida, horas_operacion,
//   gse_ab_personas, ..., gse_ab_ph, ..., total_personas, total_ph, pct_cobertura
// ══════════════════════════════════════════════════════════════════════════════

let _tempData    = [];        // raw rows from CSV
let _tempCharts  = {};        // Chart.js instances keyed by canvas id
let _tempEmpConf = [];        // [{account_id, color}]

// Ordered labels
const DIAS_ORDER = ['Lunes','Martes','Miercoles','Jueves','Viernes','Sabado','Domingo'];
const MESES_LBL  = ['','Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];

// ── FLOTA REFERENCE (additive, non-blocking) ────────────────────────────────
// Fleet-wide percentile reference (flota/percentiles_referencia.csv) and each
// company's percentile rank within it (flota/percentiles_empresa.csv).
// Fetched via core.js's fetchParseCsv, deliberately NOT routed through
// temporalIngest(rows) — this is fleet-wide reference data, a different
// shape/lifecycle than the per-company row ingest temporalIngest owns.
// Degrades silently (empty Maps, no thrown/console.error) when either CSV is
// absent/404 — the expected state until the user manually uploads them to R2.
const FLOTA_REF_PATH = 'flota/percentiles_referencia.csv';
const FLOTA_EMP_PATH = 'flota/percentiles_empresa.csv';

let _flotaRef = new Map();   // "${mes}|${metrica}" → {p10,p25,p50,p75,p90,n_empresas}
let _flotaEmp = new Map();   // "${account_id}|${mes}|${metrica}" → {valor, percentil}

// Neutral muted styling for the fleet-percentile band overlay on
// _renderEvolChart (Work Unit C). Deliberately local constants, NOT a
// core.js TOKENS addition — TOKENS is Object.freeze'd and out of scope per
// design.md's "no TOKENS edit" decision. A desaturated gray reads as a
// reference range, not another company hue (TOKENS.companySeriesColors).
const FLOTA_BAND_LINE    = 'rgba(138,134,126,0.35)';
const FLOTA_BAND_FILL    = 'rgba(138,134,126,0.10)';
const FLOTA_BAND_LABEL   = 'Rango flota (p10–p90)';
const FLOTA_MEDIAN_LABEL = 'Mediana flota (p50)';

// Additive fleet-percentile loader. Fire-and-forget from r2.js (never
// awaited) — must not block/delay KPIs, evolution chart, día-semana chart or
// tabla, all of which render from temporalIngest's primary path. On success,
// populates _flotaRef/_flotaEmp and re-runs tempApplyFilters() (if data has
// already been ingested) so any later consumer (band overlay / period
// comparison, out of scope for this change) picks the values up without a
// full page reload. On failure (404/network/parse error) for either file,
// leaves that Map empty and logs at info level only — never console.error,
// never throws.
function temporalLoadFlota() {
  return Promise.allSettled([
    fetchParseCsv(FLOTA_REF_PATH),
    fetchParseCsv(FLOTA_EMP_PATH),
  ]).then(([refRes, empRes]) => {
    if (refRes.status === 'fulfilled') {
      const m = new Map();
      refRes.value.forEach(r => {
        if (r.mes == null || r.metrica == null) return;
        m.set(`${+r.mes}|${r.metrica}`, {
          p10: +r.p10, p25: +r.p25, p50: +r.p50, p75: +r.p75, p90: +r.p90,
          n_empresas: +r.n_empresas,
        });
      });
      _flotaRef = m;
    } else {
      console.info('[Temporal] flota/percentiles_referencia.csv no disponible:', refRes.reason?.message || refRes.reason);
    }

    if (empRes.status === 'fulfilled') {
      const m = new Map();
      empRes.value.forEach(r => {
        if (r.account_id == null || r.mes == null || r.metrica == null) return;
        m.set(`${String(r.account_id)}|${+r.mes}|${r.metrica}`, {
          valor: +r.valor, percentil: +r.percentil,
        });
      });
      _flotaEmp = m;
    } else {
      console.info('[Temporal] flota/percentiles_empresa.csv no disponible:', empRes.reason?.message || empRes.reason);
    }

    if (_tempData.length && typeof tempApplyFilters === 'function') tempApplyFilters();
  });
}

// ── empresa-source ingest target ────────────────────────────────────────────
// Called by r2.js's _empresaSourceIngest(rows) (guarded with a `typeof`
// check there, since temporal.js loads after r2.js). Owns every write to this
// file's own state (_tempData, _tempEmpConf) and DOM (#temp-empresa-sel,
// #temp-filters) instead of having r2.js reach in from outside — that
// encapsulation is the point of this interface. Returns counts so the caller
// (which alone knows the load `label`) can build its own status text.
function temporalIngest(rows) {
  _tempData = rows.filter(r => r.owner_id != null && r.mes != null);

  // Build empresa config
  const emps = [...new Set(_tempData.map(r => String(r.account_id ?? r.owner_id)))].sort();
  _tempEmpConf = emps.map((id, i) => ({
    id, color: TOKENS.companySeriesColors[i % TOKENS.companySeriesColors.length],
  }));

  // Populate empresa selector
  const sel = document.getElementById('temp-empresa-sel');
  if (sel) {
    sel.innerHTML = '<option value="all">Todas las empresas</option>';
    emps.forEach(id => {
      const o = document.createElement('option');
      o.value = id; o.textContent = id; sel.appendChild(o);
    });
  }

  const filtersEl = document.getElementById('temp-filters');
  if (filtersEl) filtersEl.style.display = 'flex';
  if (typeof tempApplyFilters === 'function') tempApplyFilters();

  const nOwners = new Set(_tempData.map(r => r.owner_id)).size;
  return { count: _tempData.length, nOwners };
}

// ── FILTERS ──────────────────────────────────────────────────────────────────
function tempApplyFilters() {
  const empresa  = document.getElementById('temp-empresa-sel').value;
  const metrica  = document.getElementById('temp-metrica-sel').value;
  const dim      = document.getElementById('temp-dim-sel').value;

  const filtered = empresa === 'all'
    ? _tempData
    : _tempData.filter(r => String(r.account_id ?? r.owner_id) === empresa);

  if (!filtered.length) return;

  document.getElementById('temp-empty').style.display   = 'none';
  document.getElementById('temp-content').style.display = 'block';

  _renderKPIs(filtered, metrica);
  _renderEvolChart(filtered, metrica, dim);
  _renderDiaSemChart(filtered, metrica);
  _renderHoraChart(filtered, metrica);
  _renderTabla(filtered, metrica);
}

// ── KPIs ─────────────────────────────────────────────────────────────────────
function _renderKPIs(rows, metrica) {
  const vals = rows.map(r => +r[metrica] || 0).filter(v => v > 0);
  if (!vals.length) return;

  const mean   = vals.reduce((a,b) => a+b, 0) / vals.length;
  const max    = Math.max(...vals);
  const nMeses = new Set(rows.map(r => r.mes)).size;
  const cobPct = rows.length
    ? (rows.filter(r => (r.pct_cobertura || 0) > 0).length / rows.length * 100) : 0;

  const kpis = [
    { val: mean.toFixed(1), lbl: 'Promedio p/h·día',     sub: metrica },
    { val: max.toFixed(1),  lbl: 'Máximo p/h·día',       sub: 'pico histórico' },
    { val: nMeses,          lbl: 'Meses con datos',       sub: `${rows.length.toLocaleString()} registros` },
    { val: cobPct.toFixed(0) + '%', lbl: 'Cobertura socio', sub: 'pings con datos H3' },
  ];

  const container = document.getElementById('temp-kpi-row');
  container.innerHTML = '';
  kpis.forEach(k => {
    const el = document.createElement('div');
    el.className = 'temp-kpi';
    el.innerHTML = `<div class="temp-kpi-val">${k.val}</div>
      <div class="temp-kpi-lbl">${k.lbl}</div>
      <div class="temp-kpi-sub">${k.sub}</div>`;
    container.appendChild(el);
  });
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
function _avgBy(rows, groupFn, metrica) {
  const groups = {};
  rows.forEach(r => {
    const k = groupFn(r);
    if (k == null) return;
    if (!groups[k]) groups[k] = [];
    const v = +r[metrica];
    if (!isNaN(v) && v > 0) groups[k].push(v);
  });
  const result = {};
  for (const [k, vals] of Object.entries(groups)) {
    result[k] = vals.length ? vals.reduce((a,b) => a+b,0) / vals.length : 0;
  }
  return result;
}

function _destroyChart(id) {
  if (_tempCharts[id]) { _tempCharts[id].destroy(); delete _tempCharts[id]; }
}

function _chartDefaults() {
  return {
    responsive: true,
    plugins: {
      legend: { labels: { font: { family: 'Syne Mono', size: 10 }, color: '#6b6760', boxWidth: 12 } },
      tooltip: { callbacks: { label: c => ' ' + (c.parsed.y ?? c.parsed).toFixed(1) + ' p/h' } }
    },
    scales: {
      x: { grid: { display: false }, ticks: { font: { family: 'Syne Mono', size: 9 }, color: '#8a867e' } },
      y: { grid: { color: '#ece8e0' }, ticks: { font: { family: 'Syne Mono', size: 9 }, color: '#8a867e' } }
    }
  };
}

// ── CHART 1: Evolución principal ──────────────────────────────────────────────
function _renderEvolChart(rows, metrica, dim) {
  _destroyChart('temp-chart-evol');

  const empresa = document.getElementById('temp-empresa-sel').value;

  // Labels depend on dimension
  let labels, groupFn, mesesArr;
  if (dim === 'mes') {
    mesesArr = [...new Set(rows.map(r => +r.mes))].sort((a,b) => a-b);
    labels   = mesesArr.map(m => MESES_LBL[m] || m);
    groupFn  = r => +r.mes;
  } else if (dim === 'dia_semana') {
    labels  = DIAS_ORDER;
    groupFn = r => r.dia_semana;
  } else {
    const horas = [...new Set(rows.map(r => +r.hora_salida).filter(h => !isNaN(h)))].sort((a,b)=>a-b);
    labels  = horas.map(h => `${String(h).padStart(2,'0')}:00`);
    groupFn = r => +r.hora_salida;
  }

  // One dataset per empresa (or single if filtered)
  const empsToShow = empresa === 'all'
    ? _tempEmpConf
    : _tempEmpConf.filter(e => e.id === empresa);

  const datasets = empsToShow.map(emp => {
    const empRows = rows.filter(r => String(r.account_id ?? r.owner_id) === emp.id);
    const byDim   = _avgBy(empRows, groupFn, metrica);

    const data = dim === 'mes'
      ? mesesArr.map(m => byDim[m] ?? null)
      : dim === 'dia_semana'
        ? DIAS_ORDER.map(d => byDim[d] ?? null)
        : [...new Set(rows.map(r => +r.hora_salida).filter(h => !isNaN(h)))].sort((a,b)=>a-b).map(h => byDim[h] ?? null);

    return {
      label:       emp.id,
      data,
      borderColor: emp.color,
      backgroundColor: emp.color + '22',
      borderWidth: 2.5,
      pointRadius: 4,
      pointHoverRadius: 6,
      tension: 0.3,
      fill: empsToShow.length === 1,
      spanGaps: true,
    };
  });

  // ── Fleet-percentile band overlay (Work Unit C, FB-5) ───────────────────
  // Only when dim === 'mes' (the flota reference is per-mes only — FB-5
  // "Band hidden for non-mes dimensions"), exactly one company is selected
  // (empsToShow.length === 1, i.e. empresa !== 'all' — FB-5 "Band hidden
  // when all companies selected"), and _flotaRef actually has a matching
  // key for the current metrica across the meses shown (empty/no-match
  // _flotaRef — the current real state, since flota/*.csv are not yet
  // uploaded to R2 — must produce zero extra datasets, not empty/broken
  // ones). Prepended to the front of `datasets` so the per-company line(s)
  // stay drawn last/on top, and so p10 (index 0) sits immediately before
  // p90 (index 1) for Chart.js Filler's relative `fill: '-1'` to resolve
  // to the p10 dataset, per design.md's exact mechanism.
  if (dim === 'mes' && empsToShow.length === 1 && _flotaRef.size) {
    const refPoints = mesesArr.map(m => _flotaRef.get(`${m}|${metrica}`) || null);
    const hasBand   = refPoints.some(p => p != null);

    if (hasBand) {
      const p10Data = refPoints.map(p => p ? p.p10 : null);
      const p90Data = refPoints.map(p => p ? p.p90 : null);
      const p50Data = refPoints.map(p => p ? p.p50 : null);

      datasets.unshift(
        {
          // Lower bound — no fill of its own; exists so p90's fill:'-1'
          // has a target immediately preceding it in the array.
          label: FLOTA_BAND_LABEL,
          data: p10Data,
          borderColor: FLOTA_BAND_LINE,
          backgroundColor: FLOTA_BAND_FILL,
          borderWidth: 1,
          pointRadius: 0,
          tension: 0.3,
          fill: false,
          spanGaps: true,
        },
        {
          // Upper bound — fills toward the p10 dataset directly above
          // (relative index -1), which is how Chart.js's built-in Filler
          // plugin paints the p10–p90 band.
          label: FLOTA_BAND_LABEL,
          data: p90Data,
          borderColor: FLOTA_BAND_LINE,
          backgroundColor: FLOTA_BAND_FILL,
          borderWidth: 1,
          pointRadius: 0,
          tension: 0.3,
          fill: '-1',
          spanGaps: true,
        },
        {
          // Dashed fleet median, drawn on top of the band fill (but below
          // the company line(s), which are appended after this in the
          // datasets array).
          label: FLOTA_MEDIAN_LABEL,
          data: p50Data,
          borderColor: FLOTA_BAND_LINE,
          backgroundColor: 'transparent',
          borderWidth: 1.5,
          borderDash: [4, 3],
          pointRadius: 0,
          tension: 0.3,
          fill: false,
          spanGaps: true,
        }
      );
    }
  }

  const dimLabels = { mes: 'mes', dia_semana: 'día de semana', hora_salida: 'hora de salida' };
  document.getElementById('temp-chart1-title').textContent =
    `Evolución por ${dimLabels[dim]}`;
  document.getElementById('temp-chart1-sub').textContent =
    `${metrica} — promedio por ${dimLabels[dim]}`;

  const ctx = document.getElementById('temp-chart-evol').getContext('2d');
  const baseDefaults = _chartDefaults();
  _tempCharts['temp-chart-evol'] = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    options: {
      ...baseDefaults,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        ...baseDefaults.plugins,
        legend: {
          ...baseDefaults.plugins.legend,
          labels: {
            ...baseDefaults.plugins.legend.labels,
            // The band's lower (p10) and upper/fill (p90) datasets share
            // FLOTA_BAND_LABEL so the fill target and its legend text stay
            // coupled, but the legend itself should show that label once —
            // keep only the fill (p90) dataset's entry.
            filter: (item, data) => {
              if (item.text !== FLOTA_BAND_LABEL) return true;
              const ds = data.datasets[item.datasetIndex];
              return !!ds && ds.fill === '-1';
            },
          },
        },
      },
    },
  });
}

// ── CHART 2: Por día de semana ────────────────────────────────────────────────
function _renderDiaSemChart(rows, metrica) {
  _destroyChart('temp-chart-diasem');

  const empresa = document.getElementById('temp-empresa-sel').value;
  const empsToShow = empresa === 'all'
    ? _tempEmpConf
    : _tempEmpConf.filter(e => e.id === empresa);

  const datasets = empsToShow.map(emp => {
    const empRows = rows.filter(r => String(r.account_id ?? r.owner_id) === emp.id);
    const byDay   = _avgBy(empRows, r => r.dia_semana, metrica);
    return {
      label: emp.id,
      data:  DIAS_ORDER.map(d => byDay[d] ?? 0),
      backgroundColor: emp.color + 'cc',
      borderRadius: 3,
    };
  });

  const ctx = document.getElementById('temp-chart-diasem').getContext('2d');
  _tempCharts['temp-chart-diasem'] = new Chart(ctx, {
    type: 'bar',
    data: { labels: DIAS_ORDER.map(d => d.slice(0,3)), datasets },
    options: { ..._chartDefaults(), plugins: { ..._chartDefaults().plugins, legend: { display: empsToShow.length > 1, labels: { font: { family:'Syne Mono', size:9 }, boxWidth:10 } } } }
  });
}

// ── CHART 3: Por hora de salida ───────────────────────────────────────────────
function _renderHoraChart(rows, metrica) {
  _destroyChart('temp-chart-hora');

  const empresa = document.getElementById('temp-empresa-sel').value;
  const empsToShow = empresa === 'all'
    ? _tempEmpConf
    : _tempEmpConf.filter(e => e.id === empresa);

  const horas = [...new Set(rows.map(r => +r.hora_salida).filter(h => !isNaN(h) && h >= 0))].sort((a,b)=>a-b);
  const horaLabels = horas.map(h => `${String(h).padStart(2,'0')}h`);

  const datasets = empsToShow.map(emp => {
    const empRows = rows.filter(r => String(r.account_id ?? r.owner_id) === emp.id);
    const byHora  = _avgBy(empRows, r => +r.hora_salida, metrica);
    return {
      label: emp.id,
      data:  horas.map(h => byHora[h] ?? 0),
      backgroundColor: emp.color + 'cc',
      borderRadius: 3,
    };
  });

  const ctx = document.getElementById('temp-chart-hora').getContext('2d');
  _tempCharts['temp-chart-hora'] = new Chart(ctx, {
    type: 'bar',
    data: { labels: horaLabels, datasets },
    options: { ..._chartDefaults(), plugins: { ..._chartDefaults().plugins, legend: { display: empsToShow.length > 1, labels: { font: { family:'Syne Mono', size:9 }, boxWidth:10 } } } }
  });
}

// ── TABLA RESUMEN ─────────────────────────────────────────────────────────────
function _renderTabla(rows, metrica) {
  const container = document.getElementById('temp-tabla');

  // Aggregate per empresa
  const byEmp = {};
  rows.forEach(r => {
    const id = String(r.account_id ?? r.owner_id ?? '—');
    if (!byEmp[id]) byEmp[id] = { vals: [], cobertura: [], horas: [], meses: new Set() };
    const v = +r[metrica];
    if (!isNaN(v) && v > 0) byEmp[id].vals.push(v);
    byEmp[id].cobertura.push(+(r.pct_cobertura || 0));
    byEmp[id].horas.push(+(r.horas_operacion || 0));
    if (r.mes) byEmp[id].meses.add(+r.mes);
  });

  const avg  = arr => arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0;
  const fmtN = v => v >= 1000 ? (v/1000).toFixed(1)+'k' : v.toFixed(1);

  let html = `<table class="temp-table">
    <thead><tr>
      <th>Empresa</th>
      <th>Promedio ${metrica}</th>
      <th>Máximo</th>
      <th>Meses</th>
      <th>Cobertura socio</th>
      <th>Horas op. prom.</th>
    </tr></thead><tbody>`;

  const sorted = Object.entries(byEmp).sort((a,b) => avg(b[1].vals) - avg(a[1].vals));
  sorted.forEach(([id, d]) => {
    const empColor = (_tempEmpConf.find(e => e.id === id) || {}).color || 'var(--accent)';
    const avgVal   = avg(d.vals);
    const maxVal   = d.vals.length ? Math.max(...d.vals) : 0;
    const cobPct   = avg(d.cobertura) * 100;
    const horasProm = avg(d.horas);
    html += `<tr>
      <td><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${empColor};margin-right:6px"></span>${id}</td>
      <td class="td-num td-accent">${fmtN(avgVal)}</td>
      <td class="td-num">${fmtN(maxVal)}</td>
      <td class="td-num">${d.meses.size}</td>
      <td class="td-num">${cobPct.toFixed(0)}%</td>
      <td class="td-num">${horasProm.toFixed(1)}h</td>
    </tr>`;
  });
  html += '</tbody></table>';
  container.innerHTML = html;
}
