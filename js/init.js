
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
