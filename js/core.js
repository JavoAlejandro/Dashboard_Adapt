'use strict';
// ══════════════════════════════════════════════════════════════════════════════
// core.js — Shared app-wide foundation. Loaded FIRST (before r2.js).
//
// Holds:
//   - TOKENS            — single source of truth for empresa/segment colors
//   - _injectTokenVars() — pushes TOKENS colors onto :root as CSS custom props
//   - r2Fetch(path)      — authenticated fetch against the R2 proxy (moved from r2.js)
//   - fetchParseCsv(path) — r2Fetch + Papa.parse → Promise<rows[]>
//
// Load order: core.js → r2.js → gps.js → animation.js → comparativas.js →
//             temporal.js → h3overlay.js → ruido.js → init.js
// ══════════════════════════════════════════════════════════════════════════════

// ── TOKENS ───────────────────────────────────────────────────────────────────
// Seeded verbatim from the pre-refactor values (source lines cited per value,
// historical). Single source of truth: gps.js, temporal.js and comparativas.js
// all read TOKENS directly (their former local color copies were removed as
// each file's refactor phase landed).
const TOKENS = Object.freeze({
  // Formerly comparativas.js EMP_A / EMP_B (dropped in Phase 6 — this object
  // is now the sole source; comparativas.js reads TOKENS.empresaA/B directly)
  empresaA: '#e8a020',   // dorado
  empresaB: '#4a6fa5',   // azul slate
  // css/styles.css :root --emp-a-soft / --emp-b-soft (documented fallback pair)
  empresaASoft: 'rgba(232,160,32,0.07)',
  empresaBSoft: 'rgba(74,111,165,0.07)',

  // gps.js:244-294 and gps.js:2305-2308 define TWO distinct GSE/EDAD palettes
  // today (BSP_* for bus-stop segment display, EST_* for estimadores). Their
  // EDAD arrays already match; their GSE arrays do not. Consolidating them
  // into one canonical palette is gps.js's own refactor phase (Phase 5) — out
  // of scope here. Both are captured verbatim below so that phase can decide
  // the merge deliberately instead of this file silently picking a winner.
  segmentColors: {
    bsp: {
      // gps.js:292-293 (BSP_COLORS_GSE / BSP_COLORS_EDAD)
      gse:  ['#8b5cf6', '#6366f1', '#3b82f6', '#0ea5e9', '#06b6d4', '#14b8a6'],
      edad: ['#f59e0b', '#f97316', '#ef4444', '#ec4899', '#a855f7', '#6366f1'],
    },
    est: {
      // gps.js:2307-2308 (EST_GSE_COLORS / EST_EDAD_COLORS)
      gse:  ['#7c3aed', '#4f46e5', '#2563eb', '#0891b2', '#059669', '#16a34a'],
      edad: ['#f59e0b', '#f97316', '#ef4444', '#ec4899', '#a855f7', '#6366f1'],
    },
  },

  // temporal.js:26-29 (EMP_COLORS) — cycling palette for per-company series
  companySeriesColors: [
    '#f5a623', '#4af0a0', '#7c3aed', '#2563eb', '#e11d48',
    '#0891b2', '#16a34a', '#f97316', '#a855f7', '#84cc16',
  ],
});

// ── :root CUSTOM-PROPERTY INJECTION ─────────────────────────────────────────
// JS (TOKENS) is authoritative; push its values onto :root so CSS custom
// properties stay in lockstep instead of being hand-synced.
function _injectTokenVars() {
  const root = document.documentElement.style;
  root.setProperty('--emp-a', TOKENS.empresaA);
  root.setProperty('--emp-b', TOKENS.empresaB);
  root.setProperty('--emp-a-soft', TOKENS.empresaASoft);
  root.setProperty('--emp-b-soft', TOKENS.empresaBSoft);
}
_injectTokenVars();

// ── FETCH AUTENTICADO (moved verbatim from r2.js) ───────────────────────────
async function r2Fetch(path) {
  const res = await fetch(`${R2_BASE}/${path}`, {
    headers: { 'Authorization': `Bearer ${_r2Token}` },
  });
  if (res.status === 403) throw new Error('TOKEN_INVALIDO');
  if (!res.ok)            throw new Error(`HTTP ${res.status}`);
  return res;
}

// ── FETCH + PARSE CSV ────────────────────────────────────────────────────────
// Wraps r2Fetch + Papa.parse into a single Promise<rows[]> helper, replacing
// the repeated inline Papa.parse-over-fetch pattern.
function fetchParseCsv(path) {
  return r2Fetch(path)
    .then(res => res.text())
    .then(csvText => new Promise((resolve, reject) => {
      Papa.parse(csvText, {
        header: true, dynamicTyping: true, skipEmptyLines: true,
        complete({ data: rows }) { resolve(rows); },
        error(err) { reject(err); },
      });
    }));
}
