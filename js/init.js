
function switchSubTab(name, btn) {
  // Deactivate all sub-tabs and panels within the same group
  const group = btn.closest('.sub-tabs');
  if (group) {
    group.querySelectorAll('.sub-tab').forEach(b => b.classList.remove('active'));
  }
  document.querySelectorAll('.sub-tab-panel').forEach(p => p.classList.remove('active'));
  btn.classList.add('active');
  const panel = document.getElementById('sub-tab-' + name);
  if (panel) panel.classList.add('active');

  // Invalidate GPS map when switching back to exposicion
  if (name === 'exposicion' && typeof gpsMap !== 'undefined' && gpsMap) {
    setTimeout(() => {
      gpsMap.invalidateSize();
      if (typeof scheduleImpactDraw === 'function' && _impactCanvas)
        scheduleImpactDraw(gpsMap);
    }, 80);
  }

  // Mes/Día del gps-topbar no aplican a los datos de ruido (ruta_arcos_por_vehiculo.csv
  // y hexagonos_hora no se filtran por dia/mes) ni a los de congestión (vehiculos.csv
  // no trae mes/día) — ocultarlos en ambos sub-tabs.
  ['gps-mes-lbl', 'gps-mes-sel', 'gps-dia-lbl', 'gps-dia-sel'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = (name === 'ruido' || name === 'congestion') ? 'none' : '';
  });

  // Congestión reemplaza Archivo/Empresa/Camión del gps-topbar compartido por
  // su propio scope Empresa/Camión/Viaje (congestion/vehiculos.csv: id_viaje,
  // owner_id, account_id — universo separado del Archivo GPS cargado arriba).
  // Mismo topbar, solo cambian los campos visibles — mirror del hide/show que
  // ya hace Ruido con Mes/Día, sin crear una barra nueva.
  const GPS_ONLY_TOPBAR_FIELDS = [
    'r2-sel-lbl', 'r2-empresa-sel', 'gps-status', 'stats-csv-status', 'h3-csv-status',
    'gps-empresa-lbl', 'gps-empresa-sel', 'gps-bus-lbl', 'gps-bus-sel', 'btn-reset-filters',
  ];
  const CONG_ONLY_TOPBAR_FIELDS = [
    'cong-empresa-lbl', 'cong-empresa-sel', 'cong-camion-lbl', 'cong-camion-sel',
    'cong-viaje-lbl', 'cong-viaje-sel',
  ];
  GPS_ONLY_TOPBAR_FIELDS.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = (name === 'congestion') ? 'none' : '';
  });
  CONG_ONLY_TOPBAR_FIELDS.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = (name === 'congestion') ? '' : 'none';
  });

  // #gps-filters normalmente permanece oculto hasta que se carga un Archivo
  // GPS (ver gps.js). Congestión no depende de eso — fuerza su visibilidad
  // para que los 3 selects propios sean visibles incluso sin Archivo cargado;
  // al salir, restaura según haya o no datos GPS cargados.
  const gpsFiltersEl = document.getElementById('gps-filters');
  if (gpsFiltersEl) {
    gpsFiltersEl.style.display = (name === 'congestion') ? 'flex'
      : (typeof gpsLayers === 'object' && Object.keys(gpsLayers).length ? 'flex' : 'none');
  }

  // Entrando al sub-tab Ruido: inicializar mapa propio + cargar CSV (lazy) +
  // sincronizar con el camión actualmente seleccionado en Exposición
  if (name === 'ruido' && typeof ruidoOnTabEnter === 'function') {
    ruidoOnTabEnter();
  }

  // Entrando al sub-tab Congestión: cargar congestion/* (lazy, una sola vez)
  // + pintar la huella de red compartida (mirror ruidoOnTabEnter)
  if (name === 'congestion' && typeof congOnTabEnter === 'function') {
    congOnTabEnter();
  }
}


function switchTab(name, btn) {
  document.querySelectorAll('.main-tab').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('tab-' + name).classList.add('active');
  if (name === 'gps' && typeof gpsMap !== 'undefined' && gpsMap)
    setTimeout(() => gpsMap.invalidateSize(), 80);
  if (name === 'comparativas') {
    if (typeof initCmpTab === 'function') initCmpTab();
    if (typeof cmpMap !== 'undefined' && cmpMap) setTimeout(() => cmpMap.invalidateSize(), 80);
  }
}
