'use strict';
// ══════════════════════════════════════════════════════════════════════════════
// r2.js — Carga de datos via Cloudflare Worker (R2 privado)
//
// Soporta dos modos definidos en index.json:
//   modo: "mezclado"  → selector por archivo (rutas_1…rutas_38), temporal
//   modo: "empresa"   → selector por empresa (account_id), definitivo
//
// Para migrar de modo mezclado a empresa: solo cambiar index.json en R2.
// ══════════════════════════════════════════════════════════════════════════════

let _r2Token          = null;
let _r2CurrentArchivo = null;
let _r2Index          = null;
let _r2Modo           = null;   // "mezclado" | "empresa"

// ── FETCH AUTENTICADO ────────────────────────────────────────────────────────
async function r2Fetch(path) {
  const res = await fetch(`${R2_BASE}/${path}`, {
    headers: { 'Authorization': `Bearer ${_r2Token}` },
  });
  if (res.status === 403) throw new Error('TOKEN_INVALIDO');
  if (!res.ok)            throw new Error(`HTTP ${res.status}`);
  return res;
}

// ── MODAL DE TOKEN ───────────────────────────────────────────────────────────
function r2MostrarModalToken(onSuccess) {
  let modal = document.getElementById('r2-token-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'r2-token-modal';
    modal.style.cssText = [
      'position:fixed','inset:0','z-index:9999',
      'background:rgba(0,0,0,0.7)',
      'display:flex','align-items:center','justify-content:center',
    ].join(';');
    modal.innerHTML = `
      <div style="
        background:var(--surface);border:1px solid var(--border);
        border-radius:8px;padding:32px 36px;
        min-width:340px;max-width:420px;
        font-family:'Epilogue',sans-serif;
      ">
        <div style="font-family:'Syne',sans-serif;font-weight:700;font-size:16px;margin-bottom:6px">
          Acceso requerido
        </div>
        <div style="font-size:12px;color:var(--muted);margin-bottom:20px;line-height:1.5">
          Introduce el token de acceso para cargar los datos.<br>
          Este token no se guarda en ningún archivo.
        </div>
        <input id="r2-token-input" type="password"
          placeholder="Token de acceso…"
          style="
            width:100%;box-sizing:border-box;
            background:var(--bg);border:1px solid var(--border);
            border-radius:4px;padding:10px 12px;
            font-family:'Syne Mono',monospace;font-size:13px;
            color:var(--ink);outline:none;margin-bottom:8px;
          "
          onkeydown="if(event.key==='Enter') r2ConfirmarToken()">
        <div id="r2-token-error"
          style="font-size:11px;color:#e8382a;min-height:16px;margin-bottom:12px"></div>
        <button onclick="r2ConfirmarToken()" style="
          width:100%;padding:10px;border:none;border-radius:4px;
          background:var(--accent);color:var(--bg);
          font-family:'Syne',sans-serif;font-weight:700;font-size:13px;cursor:pointer;
        ">Acceder</button>
      </div>`;
    document.body.appendChild(modal);
  }
  modal.style.display  = 'flex';
  modal._onSuccess     = onSuccess;
  document.getElementById('r2-token-error').textContent = '';
  setTimeout(() => document.getElementById('r2-token-input')?.focus(), 50);
}

function r2ConfirmarToken() {
  const input = document.getElementById('r2-token-input');
  const token = input?.value?.trim();
  if (!token) return;
  _r2Token = token;
  document.getElementById('r2-token-modal').style.display = 'none';
  input.value = '';
  const cb = document.getElementById('r2-token-modal')._onSuccess;
  if (typeof cb === 'function') cb();
}

// ── INIT ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  r2MostrarModalToken(() => r2LoadIndex());
});

async function r2LoadIndex() {
  const sel    = document.getElementById('r2-empresa-sel');
  const status = document.getElementById('gps-status');
  try {
    status.textContent = '⏳ Conectando…';
    const res  = await r2Fetch('index.json');
    _r2Index   = await res.json();
    _r2Modo    = _r2Index.modo || 'empresa';   // default: empresa

    sel.innerHTML = '<option value="">— Selecciona —</option>';

    if (_r2Modo === 'mezclado') {
      // ── Modo temporal: listar archivos mezclados ──────────────────────────
      const archivos = _r2Index.archivos_mezclados || [];
      archivos.forEach(a => {
        const opt        = document.createElement('option');
        opt.value        = a.id;          // ej: "rutas_1"
        opt.textContent  = a.label;       // ej: "Archivo 1 (Enero)"
        sel.appendChild(opt);
      });
      status.textContent = `${archivos.length} archivos disponibles — selecciona uno`;

      // Cambiar label del selector
      const lbl = document.getElementById('r2-sel-lbl');
      if (lbl) lbl.textContent = 'Archivo';

    } else {
      // ── Modo empresa: listar por account_id ───────────────────────────────
      const lbl = document.getElementById('r2-sel-lbl');
      if (lbl) lbl.textContent = 'Empresa';
      const empresas = _r2Index.empresas || [];
      empresas.forEach(e => {
        if (!e.tiene_rutas) return;
        const opt        = document.createElement('option');
        opt.value        = e.account_id;
        opt.textContent  = `Empresa ${e.account_id}`;
        sel.appendChild(opt);
      });
      status.textContent =
        `${empresas.filter(e => e.tiene_rutas).length} empresas disponibles — selecciona una`;
    }

  } catch (err) {
    if (err.message === 'TOKEN_INVALIDO') {
      document.getElementById('r2-token-error').textContent = 'Token incorrecto, intenta de nuevo';
      _r2Token = null;
      r2MostrarModalToken(() => r2LoadIndex());
    } else {
      status.textContent = `✗ Error al conectar: ${err.message}`;
    }
  }
}

// ── CARGA AL SELECCIONAR ──────────────────────────────────────────────────────
async function r2LoadEmpresa(valor) {
  if (!valor || valor === _r2CurrentArchivo) return;
  _r2CurrentArchivo = valor;

  const status     = document.getElementById('gps-status');
  const h3Status   = document.getElementById('h3-csv-status');
  const tempStatus = document.getElementById('temp-csv-status');

  h3Status.textContent = '';

  let urlRutas, urlImpactos, urlH3, label, tieneImpactos;

  if (_r2Modo === 'mezclado') {
    const archivo  = _r2Index.archivos_mezclados?.find(a => a.id === valor);
    label          = archivo?.label || valor;

    // Extraer número base ignorando sufijos como _parte1, _parte2, etc.
    // "rutas_10"        → "10"
    // "rutas_10_parte1" → "10"
    // Si el index tiene "archivo_base" explícito, usarlo primero
    const numBase  = archivo?.archivo_base
                   || valor.replace('rutas_', '').replace(/_parte\d+$/, '');

    urlRutas       = `mezclado/rutas/${valor}.geojson`;
    urlImpactos    = `mezclado/impactos/impactos_${numBase}.csv`;
    urlH3          = `mezclado/h3/impactos_h3_${numBase}.csv`;
    tieneImpactos  = archivo?.tiene_impactos ?? true;
  } else {
    // valor = account_id
    const empInfo  = _r2Index.empresas?.find(e => String(e.account_id) === String(valor));
    label          = `empresa ${valor}`;
    urlRutas       = `rutas/empresa_${valor}.geojson`;
    urlImpactos    = `impactos/empresa_${valor}.csv`;
    urlH3          = `h3/empresa_${valor}.csv`;
    tieneImpactos  = empInfo?.tiene_impactos ?? false;
  }

  status.textContent = `⏳ Cargando ${label}…`;

  const [rutasRes, impactosRes, h3Res] = await Promise.allSettled([
    r2Fetch(urlRutas),
    tieneImpactos ? r2Fetch(urlImpactos) : Promise.reject('sin impactos'),
    tieneImpactos ? r2Fetch(urlH3)       : Promise.reject('sin h3'),
  ]);

  // ── GeoJSON ───────────────────────────────────────────────────────────────
  if (rutasRes.status === 'fulfilled') {
    try {
      gpsData = await rutasRes.value.json();
      if (!gpsData.features?.length) throw new Error('GeoJSON vacío');
      initGPSMap();
      status.textContent = `✓ ${gpsData.features.length.toLocaleString()} rutas · ${label}`;
    } catch (err) {
      status.textContent = `✗ Error en GeoJSON: ${err.message}`;
    }
  } else {
    const msg = rutasRes.reason?.message || rutasRes.reason || 'error';
    status.textContent = `✗ No se encontraron rutas: ${msg}`;
  }

  // ── CSV impactos ──────────────────────────────────────────────────────────
  if (impactosRes.status === 'fulfilled') {
    try {
      const csvText = await impactosRes.value.text();
      Papa.parse(csvText, {
        header: true, dynamicTyping: true, skipEmptyLines: true,
        complete({ data: rows }) {
          _r2ProcesarImpactos(rows, label, tempStatus);
        },
      });
    } catch (err) {
      console.error('[R2] Error cargando impactos:', err);
    }
  } else {
    if (tempStatus) tempStatus.textContent = `Sin datos de impactos para ${label}`;
  }

  // ── CSV H3 ────────────────────────────────────────────────────────────────
  if (h3Res.status === 'fulfilled') {
    try {
      const csvText = await h3Res.value.text();
      Papa.parse(csvText, {
        header: true, dynamicTyping: true, skipEmptyLines: true,
        complete({ data: rows }) {
          const required = ['h3_9', 'owner_id', 'total_ph_hex'];
          const cols     = Object.keys(rows[0] || {});
          const missing  = required.filter(c => !cols.includes(c));
          if (missing.length) {
            h3Status.textContent = `✗ H3: columnas faltantes: ${missing.join(', ')}`;
            return;
          }
          _h3Data = rows.filter(r => r.h3_9 && r.total_ph_hex != null);
          const nHex   = new Set(_h3Data.map(r => r.h3_9)).size;
          const nRutas = new Set(_h3Data.map(r => `${r.owner_id}_${r.dia}_${r.mes}`)).size;
          h3Status.textContent =
            `✓ H3: ${_h3Data.length.toLocaleString()} registros · ${nHex.toLocaleString()} hexágonos · ${nRutas.toLocaleString()} rutas`;
          // Re-dibujar si el toggle está activo
          if (document.getElementById('h3-overlay-toggle')?.checked) {
            drawH3Overlay();
          }
        },
      });
    } catch (err) {
      console.error('[R2] Error cargando H3:', err);
    }
  } else {
    h3Status.textContent = '';   // silencioso si no hay H3
  }
}

// ── PROCESAR CSV → statsData + _tempData ──────────────────────────────────
function _r2ProcesarImpactos(rows, label, tempStatusEl) {
  if (!rows.length) return;

  statsData = {};
  rows.forEach(r => {
    const id = r.owner_id, dia = r.dia;
    if (id == null || dia == null) return;
    if (r.mes != null) statsData[`${id}_${dia}_${r.mes}`] = r;
    statsData[`${id}_${dia}`] = r;
  });
  calcEstimadores(rows);

  _tempData = rows.filter(r => r.owner_id != null && r.mes != null);
  const nOwners = new Set(_tempData.map(r => r.owner_id)).size;
  if (tempStatusEl) {
    tempStatusEl.textContent =
      `✓ ${_tempData.length.toLocaleString()} registros · ${nOwners} camiones · ${label}`;
  }

  const emps = [...new Set(_tempData.map(r => String(r.account_id ?? r.owner_id)))].sort();
  _tempEmpConf = emps.map((id, i) => ({ id, color: EMP_COLORS[i % EMP_COLORS.length] }));

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

  const busSel = document.getElementById('gps-bus-sel');
  if (busSel?.value && busSel.value !== 'all') {
    if (typeof showBusStats === 'function') showBusStats(busSel.value);
  }
}
