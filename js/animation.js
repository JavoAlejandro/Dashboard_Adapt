'use strict';

// ── ANIMATION ENGINE ───────────────────────────────────────────────────────
let animState = {
  active:    false,
  progress:  0,      // 0..1
  targetId:  null,   // bus_id being animated (null = all visible)
  animLayer: null,   // L.polyline drawn so far
  animDot:   null,   // moving dot marker
  rafId:     null,
  lastTs:    null,
};

function animSetTarget(busId) {
  animReset();
  animState.targetId = busId;
  const entry = gpsLayers[busId];
  if (entry) {
    const p    = entry.feature.properties;
    const oid  = p.owner_id != null ? p.owner_id : (p.objectId != null ? p.objectId : busId.split('_')[0]);
    const dia  = p.dia != null ? p.dia : '';
    document.getElementById('anim-note').textContent =
      `Camión ${oid} · Día ${dia} · ${entry.coords.length} puntos`;
  }
}

function animPlay() {
  if (animState.active) {
    // Pause
    animState.active = false;
    cancelAnimationFrame(animState.rafId);
    document.getElementById('anim-icon-play').style.display  = '';
    document.getElementById('anim-icon-pause').style.display = 'none';
    return;
  }

  // Need a focused camion to animate
  const targetId = animState.targetId || (() => {
    const visible = Object.keys(gpsLayers).filter(id => gpsLayers[id].visible);
    return visible.length === 1 ? visible[0] : null;
  })();

  if (!targetId || !gpsLayers[targetId]) {
    document.getElementById('anim-note').textContent = '⚠ Selecciona un camión único para animar';
    return;
  }

  animState.targetId = targetId;
  animState.active   = true;
  animState.lastTs   = null;
  if (animState.progress >= 1) animState.progress = 0;

  document.getElementById('anim-icon-play').style.display  = 'none';
  document.getElementById('anim-icon-pause').style.display = '';

  // Quitar la ruta del mapa mientras se anima. A diferencia de capas con
  // tooltips bind-eados (L.geoJSON), aquí los hovers son listeners .on()
  // añadidos directamente sobre la polyline — sobreviven a removeLayer/addTo
  // porque viven en el objeto JS de Leaflet, no en el DOM del mapa.
  const entry = gpsLayers[targetId];
  try { gpsMap.removeLayer(entry.layer); } catch {}

  if (!animState.animLayer) {
    animState.animLayer = L.polyline([], {
      color: entry.color, weight: 4, opacity: 1, smoothFactor: 1
    }).addTo(gpsMap);
  }
  if (!animState.animDot) {
    animState.animDot = L.circleMarker(entry.coords[0], {
      radius: 7, fillColor: entry.color, fillOpacity: 1,
      color: '#fff', weight: 2
    }).addTo(gpsMap);
  }

  // Show via indicator (always, even before first frame)
  animShowVia(entry);

  animState.rafId = requestAnimationFrame(animFrame);
}

function animFrame(ts) {
  if (!animState.active) return;

  // First frame: just record timestamp and schedule next
  if (animState.lastTs === null) {
    animState.lastTs = ts;
    animState.rafId = requestAnimationFrame(animFrame);
    return;
  }

  const dt = Math.min((ts - animState.lastTs) / 1000, 0.1); // cap at 100ms
  animState.lastTs = ts;

  const speed  = parseFloat(document.getElementById('anim-speed').value);
  const entry  = gpsLayers[animState.targetId];
  const coords = entry.coords;
  const n      = coords.length;

  // Progress: Normal (1×) → ~20s regardless of route length
  // Using 20s base so short routes (100 pts) still feel smooth
  animState.progress = Math.min(1, animState.progress + speed * dt / 20);

  // How many points to show
  const shown = Math.max(2, Math.floor(animState.progress * (n - 1)) + 1);
  animState.animLayer.setLatLngs(coords.slice(0, shown));

  // Move dot to current head
  animState.animDot.setLatLng(coords[shown - 1]);

  // Update progress bar
  const pct = (animState.progress * 100).toFixed(0);
  document.getElementById('anim-fill').style.width  = pct + '%';
  document.getElementById('anim-thumb').style.left  = pct + '%';
  document.getElementById('anim-label').textContent = pct + '%';

  // Update via name
  animUpdateVia(entry, shown - 1, n);

  if (animState.progress >= 1) {
    animState.active = false;
    document.getElementById('anim-icon-play').style.display  = '';
    document.getElementById('anim-icon-pause').style.display = 'none';
    document.getElementById('anim-note').textContent = '✓ Recorrido completo';
    animHideVia();
    const e = gpsLayers[animState.targetId];
    if (e && e.visible && typeof _buildRouteLine === 'function') {
      // Reconstruir el layer desde cero (no reciclar el removido): un layer
      // nuevo garantiza que el canvas renderer compartido registre el hit-test
      // de hover correctamente. removeLayer/addTo del mismo objeto no lo hacía.
      _buildRouteLine(animState.targetId, e);
    }
    if (animState.animLayer) { gpsMap.removeLayer(animState.animLayer); animState.animLayer = null; }
    if (animState.animDot)   { gpsMap.removeLayer(animState.animDot);   animState.animDot   = null; }
    return;
  }

  animState.rafId = requestAnimationFrame(animFrame);
}

function animReset() {
  animState.active   = false;
  animState.progress = 0;
  if (animState.rafId) cancelAnimationFrame(animState.rafId);
  if (animState.animLayer && gpsMap) { gpsMap.removeLayer(animState.animLayer); animState.animLayer = null; }
  if (animState.animDot   && gpsMap) { gpsMap.removeLayer(animState.animDot);   animState.animDot   = null; }
  // Reconstruir el layer desde cero si fue removido durante la animación —
  // garantiza que el hover quede funcionando (ver nota en animFrame).
  if (animState.targetId && gpsLayers[animState.targetId]) {
    const entry = gpsLayers[animState.targetId];
    if (entry.visible && gpsMap && !gpsMap.hasLayer(entry.layer) && typeof _buildRouteLine === 'function') {
      _buildRouteLine(animState.targetId, entry);
    }
  }
  // Guard all DOM — animReset() can be called before map UI renders
  const _fill  = document.getElementById('anim-fill');
  const _thumb = document.getElementById('anim-thumb');
  const _label = document.getElementById('anim-label');
  const _play  = document.getElementById('anim-icon-play');
  const _pause = document.getElementById('anim-icon-pause');
  if (_fill)  _fill.style.width    = '0%';
  if (_thumb) _thumb.style.left    = '0%';
  if (_label) _label.textContent   = '0%';
  if (_play)  _play.style.display  = '';
  if (_pause) _pause.style.display = 'none';
  animHideVia();
}

function fitAllBuses() {
  if (!gpsMap) return;
  const bounds = [];
  Object.values(gpsLayers).forEach(({layer, visible}) => {
    if (visible) try { bounds.push(layer.getBounds()); } catch {}
  });
  if (!bounds.length) return;
  const combined = bounds.reduce((acc, b) => acc.extend(b), bounds[0]);
  gpsMap.fitBounds(combined, { padding: [30, 30] });
}

// ── VÍA INDICATOR HELPERS ──────────────────────────────────────────────────

let _animLastViaIdx = -1;

// ── VÍA LOOKUP ────────────────────────────────────────────────────────────
// Supports two GeoJSON formats:
//
//   EXACT (preferred) — vias_con_indices: each via has the ping range it covers
//   [{ "nombre": "Ruta 68", "desde": 0, "hasta": 34 }, ...]
//
//   APPROXIMATE (fallback) — vias_recorridas: ordered list of names only
//   ["Ruta 68", "Undécimo", ...]
//   → ping range inferred by dividing total points equally among vias
//
// To generate the exact format, update procesar_gps.py to emit vias_con_indices
// alongside (or instead of) vias_recorridas.

function _animGetViasExact(entry) {
  if (!entry || !entry.feature) return null;
  let v = entry.feature.properties.vias_con_indices;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return null; } }
  if (!Array.isArray(v) || v.length === 0) return null;
  // Validate shape: each item must have nombre, desde, hasta
  if (v[0].nombre === undefined || v[0].desde === undefined) return null;
  return v;
}

function _animGetViasApprox(entry) {
  if (!entry || !entry.feature) return null;
  let v = entry.feature.properties.vias_recorridas;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return null; } }
  return Array.isArray(v) && v.length > 0 ? v : null;
}

// Returns { nombre, idx, total, exact } for a given ping index
function _animResolveVia(entry, pointIdx, totalPoints) {
  // ── Try exact format first ──
  const exact = _animGetViasExact(entry);
  if (exact) {
    const match = exact.find(v => pointIdx >= v.desde && pointIdx <= v.hasta)
      || exact[exact.length - 1]; // fallback to last if beyond range
    const matchIdx = exact.indexOf(match);
    return { nombre: match.nombre, idx: matchIdx, total: exact.length, exact: true };
  }

  // ── Fallback: approximate by dividing evenly ──
  const approx = _animGetViasApprox(entry);
  if (!approx) return null;
  const viaIdx = Math.min(
    approx.length - 1,
    Math.floor((pointIdx / Math.max(totalPoints - 1, 1)) * approx.length)
  );
  return { nombre: approx[viaIdx], idx: viaIdx, total: approx.length, exact: false };
}

function _animHasVias(entry) {
  return !!(_animGetViasExact(entry) || _animGetViasApprox(entry));
}

function animShowVia(entry) {
  const el = document.getElementById('via-indicator');
  if (!el) return;
  if (!_animHasVias(entry)) { el.style.display = 'none'; return; }
  // Resolve and display first via immediately
  const first = _animResolveVia(entry, 0, 1);
  if (!first) { el.style.display = 'none'; return; }
  const nameEl = document.getElementById('via-indicator-name');
  const idxEl  = document.getElementById('via-indicator-idx');
  if (nameEl) nameEl.textContent = first.nombre;
  if (idxEl)  idxEl.textContent  = `${first.idx + 1} / ${first.total}${first.exact ? '' : ' ~'}`;
  el.style.display = 'flex';
  _animLastViaIdx = first.idx;
}

function animHideVia() {
  const el = document.getElementById('via-indicator');
  if (el) el.style.display = 'none';
  _animLastViaIdx = -1;
}

function animUpdateVia(entry, pointIdx, totalPoints) {
  const resolved = _animResolveVia(entry, pointIdx, totalPoints);
  if (!resolved) return;

  // Only update DOM when via changes
  if (resolved.idx === _animLastViaIdx) return;
  _animLastViaIdx = resolved.idx;

  const nameEl = document.getElementById('via-indicator-name');
  const idxEl  = document.getElementById('via-indicator-idx');
  if (nameEl) nameEl.textContent = resolved.nombre;
  // Show ~ suffix when approximate to signal to the user it's estimated
  if (idxEl)  idxEl.textContent  = `${resolved.idx + 1} / ${resolved.total}${resolved.exact ? '' : ' ~'}`;
}
