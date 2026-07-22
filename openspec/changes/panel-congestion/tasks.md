# Tasks: Congestion Panel for Empresa and Camión

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 650-900 |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 (foundation+map) → PR 2 (Camión) → PR 3 (Empresa) |
| Delivery strategy | ask-on-risk → resolved: chained (3 PRs) |
| Chain strategy | stacked-to-main (user-confirmed) |

Decision needed before apply: No — resolved: 3 chained PRs, stacked-to-main (PR1→main, PR2→main, PR3→main in order)
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Data-contract fix + `congestion.js` core (fetch/state/lazy-load/trigger) + shared footprint map | PR 1 | N/A — no test runner | Open `index.html`; confirm `congEnsureLoaded` fires on first Congestión open, map layer paints | Revert `js/congestion.js`, its `<script>` tag, `r2.js`/`init.js` trigger lines |
| 2 | Camión→Congestión: fleet KPIs, vehicle table+detail, GPS cross-link | PR 2 | N/A | Open Camión→Congestión with real R2 data; click a vehicle row; check unmatched-vehicle case | Revert `#sub-tab-congestion` body diff + vehicle-table functions in `congestion.js`; PR 1 stands alone |
| 3 | Empresa→Congestión: sub-tab, KPIs, gauge/rank card | PR 3 | N/A | Open Empresa→Congestión; toggle with/without `referencia.csv` | Revert new Empresa sub-tab button/panel + `comparativas.js` branch + KPI/gauge functions; PR 1+2 stand alone |

**Bottleneck**: `js/congestion.js` is shared across all 3 units (state/map in PR1, vehicle rendering in PR2, KPI/gauge rendering in PR3) — land in order, rebase PR2/PR3 rather than parallel-branch.

## Phase 0: Data Contract Correction (pre-implementation)

- [x] 0.1 Update `specs/congestion-data-contract/spec.md` "Vehicle CSV Schema" requirement + scenario: real header is `gps_vehicle_id, account_id, km, mecc, iev, n_pasadas, hwy_share, peak_share` (verified from extracted `window.DASH.vehicles[]`), replacing the vague `km_recorridos, mecc_veh_s, …` placeholder.
- [x] 0.2 Update `design.md` Interfaces section's `congestion/vehiculos.csv` column block to match 0.1.
- [x] 0.3 Note (binding for all later tasks): `vehiculos.csv` rows and `empresas.csv` rows are already fully aggregated upstream (`window.DASH.vehicles[]` / `window.DASH.company`). `js/congestion.js` MUST NOT re-derive KPI metrics (no mean/sum of raw fields) — it only fetches, filters, sorts, and renders these precomputed fields.

## Phase 1: Foundation — `js/congestion.js` core + wiring

- [x] 1.1 Create `js/congestion.js`: module state (`_congLoaded/_congLoading`, `_congEmpData` Map, `_congVehData` array, `_congRefData` Map, `_congGeo`, `_congByOwner` Map, `_congMap/_congLayer`, `CONGEST_RAMP`).
- [x] 1.2 Implement `congEnsureLoaded()`: `Promise.allSettled` over `fetchParseCsv('congestion/empresas.csv')`, `fetchParseCsv('congestion/vehiculos.csv')`, `fetchParseCsv('congestion/referencia.csv')`, `r2Fetch('congestion/red_mecc.geojson')`; each failure isolated, no thrown error.
- [x] 1.3 Add `<script src="js/congestion.js">` to `index.html` after `js/ruido.js`, before `js/init.js`.
- [x] 1.4 `js/r2.js`: add guarded call `if (typeof congEnsureLoaded === 'function') …` mirroring `temporalLoadFlota` trigger convention (fire-and-forget, non-blocking).
- [x] 1.5 `js/init.js` `switchSubTab`: add lazy-load trigger for `name === 'congestion'` (mirror `ruidoOnTabEnter`).

## Phase 2: Footprint Map (shared layer, `congestion-footprint-map`)

- [x] 2.1 In `congestion.js`, build `CONGEST_RAMP` (interpolation copied from `ruido.js` `RUIDO_RAMP`, module-local).
- [x] 2.2 Render `_congGeo` as `L.geoJSON` polylines colored by aggregate (24h sum/avg) `mecc_veh_s`; default view, no hour picker required.
- [x] 2.3 Add `map-cong-empty` placeholder markup in both panels; show it and hide the map wrap when `_congGeo` is absent/404.

  Note: PR1 mounts `map-cong-empty`/`map-cong-wrap` only in Camión→Congestión (`#sub-tab-congestion`), the sole surface in scope for this PR. The Empresa panel mount point lands with the new Empresa sub-tab in PR3 (Phase 4), reusing the same `congRenderFootprint()`/`congInitMap()` functions unmodified.

## Phase 3: Camión→Congestión (`congestion-camion`)

- [x] 3.1 `index.html`: replace `#sub-tab-congestion` body (KPI row, sortable table, detail card, map + `map-cong-empty`); add `#cong-empresa-sel`/`#cong-camion-sel`/`#cong-viaje-sel` cascading selects to the shared `gps-topbar`.
- [x] 3.2 `congestion.js`: scope-appropriate KPI cards — Empresa level from precomputed `empresas.csv` fields, Camión level from summed `km_recorridos`/`mecc_veh_s` of that Camión's trip rows (per amended Phase 0.3 — summation by `owner_id`/`account_id` is the one permitted client-side aggregation).
- [x] 3.3 Render sortable table (Camión-level: one row per Camión, aggregated via `_congAggByOwner`; Viaje-level: one row per trip); row click drills into that row's level (`congOnCamionChange`/`congOnViajeChange`).
- [x] 3.4 Build `_congByOwner` (Map `String(owner_id) → bus_id[]` from `gpsLayers`, via `_congBuildByOwner`), rebuilt per render; when a Camión is in focus, overlay its real GPS route on the shared footprint map (`_congRenderVehicleRouteOverlay`) instead of a per-row cross-link button; no match / GPS not loaded → footprint renders alone, no error.
- [x] 3.5 Empty state when `_congVehData` has no rows for the selected company scope (`#cong-empresa-sel`).

  Note (apply-time decision, not explicit in design.md): Camión Congestión does
  not reuse the shared `#gps-empresa-sel`/`_r2CurrentArchivo` GPS filters for
  scope resolution. It has its own independent `#cong-empresa-sel` populated
  directly from the distinct `account_id` values in `_congVehData`
  (`_congPopulateEmpresaSel`), so Congestión scope is decoupled from whatever
  Archivo/company is loaded in Exposición.

## Phase 3.5: Post-hoc schema correction and drill-down redesign (pre-commit, PR2 rework)

Applied after Phase 3 was first marked done, before the PR2 branch was
committed — reconciles code and docs with the real `congestion/vehiculos.csv`
schema discovered while wiring PR2 against real data. See `design.md`'s
"Design Revision" note and the amended `congestion-data-contract`/
`congestion-camion` specs for full detail.

- [x] 3.5.1 Correct `congestion/vehiculos.csv` schema across specs/design: real file is one row per TRIP (`id_viaje, owner_id, account_id, km_recorridos, mecc_veh_s`), not one row per vehicle with precomputed `iev`/`n_pasadas`/`hwy_share`/`peak_share` — that Phase 0 correction was itself based on an extracted UI sample (`window.DASH.vehicles[]`), not the real file.
- [x] 3.5.2 Redesign the flat vehicle table into a 3-level cascading drill-down (`#cong-empresa-sel` → `#cong-camion-sel` → `#cong-viaje-sel`), since per-vehicle rows no longer exist in the raw data — `_congPopulateEmpresaSel`/`_congPopulateCamionSel`/`_congPopulateViajeSel` + `congOnEmpresaChange`/`congOnCamionChange`/`congOnViajeChange` + `_congRenderEmpresaLevel`/`_congRenderCamionLevel`/`_congRenderViajeLevel`.
- [x] 3.5.3 Replace the "Ver en Exposición" cross-link button with `_congRenderVehicleRouteOverlay(ownerId)`: draws the focused Camión's real GPS route directly on the shared footprint map via the existing `owner_id → bus_id` reverse index.
- [x] 3.5.4 `js/init.js`: wire the shared `gps-topbar` to show/hide GPS-only vs Congestión-only fields per sub-tab (`GPS_ONLY_TOPBAR_FIELDS`/`CONG_ONLY_TOPBAR_FIELDS`), and force `#gps-filters` visible while in Congestión regardless of whether an Archivo GPS is loaded.
- [x] 3.5.5 Update `css/styles.css` for the new KPI card variants (bar/rank/delta) and the sortable table; remove now-unused `.cong-detalle-link`/`.cong-detalle-nomatch` styles from the dropped cross-link button.

## Phase 4: Empresa→Congestión (`congestion-empresa`)

- [ ] 4.1 `index.html`: add 3rd `#sub-tabs-empresa` button + `<div id="cmp-subpanel-congestion" class="sub-tab-panel">`.
- [ ] 4.2 `comparativas.js`: extend `switchCmpSubTab`/`initCmpTab` with a `congestion` branch (map invalidate on enter, call `congEnsureLoaded`).
- [ ] 4.3 KPI cards for `mecc, iev, n_veh, km, hwy_share, peak_share` from `_congEmpData.get(account_id)`.
- [ ] 4.4 Gauge from `_congRefData` (p10-p90, hidden if absent) + discrete rank card from `rank/iev_global/n_comparables` (always renders if company row exists), reusing `comparativas.js` gauge helpers.
- [ ] 4.5 Empty state when `_congEmpData` has no row for the selected `account_id`.

## Phase 5: CSS (`css/styles.css`)

- [~] 5.1 KPI + rank/"hallazgos" card styles (Camión + Empresa). — Camión fleet KPI cards (`.cong-kpi-row`/`.cong-kpi*`) done in PR2; Empresa rank/"hallazgos" card styles remain for PR3.
- [x] 5.2 Vehicle table + detail panel styles. (`.cong-table`, `.cong-tr-veh`, `.cong-detalle-*`)
- [x] 5.3 Footprint map wrap + `map-cong-empty` + ramp legend styles. (landed in PR1 alongside Phase 2; confirmed present, marking complete here)

## Phase 6: Manual Verification (browser checklist, no test runner)

- [ ] 6.1 All `congestion/*` present → Camión→Congestión renders KPIs, table, detail, map.
- [ ] 6.2 Empresa→Congestión renders KPIs, gauge, rank card, map.
- [ ] 6.3 Camión with a matching `gpsLayers` `owner_id` selected → its real GPS route overlays the shared footprint map.
- [ ] 6.4 Camión with no GPS match / GPS not loaded → Camión/Viaje levels render fully, no route overlay, no error.
- [ ] 6.5 Company with no `congestion/empresas.csv` row → Empresa empty-state, no broken cards.
- [ ] 6.6 `referencia.csv` absent → gauge hidden, rank card still renders.
- [ ] 6.7 `vehiculos.csv` or `red_mecc.geojson` 404 → that widget's empty-state shows, siblings unaffected, no console error.
- [ ] 6.8 Enter Empresa→Congestión → Camión sub-tab → back → exactly one active panel per group.
