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

## Phase 4: Company Congestion KPIs in Empresa→Global (`congestion-empresa`)

Text below described the FIRST Global-grid integration attempt (velocímetro
grid), itself later superseded by Phase 4.6 (card system). Kept for the
record — see Phase 4.6 for the as-shipped state. The original sub-tab task
text these bullets replaced is preserved verbatim in Phase 4.5 for the
record.

- [x] 4.1 (superseded by 4.6.4) `index.html`: add `#cmp-cong-kpi-section` (`#cmp-cong-kpi-grid-a`/`#cmp-cong-kpi-grid-b`, plus head/note/status elements) inside the existing `#cmp-subpanel-global` panel, immediately after `#cmp-kpi-section` (Ruido) — mirroring that section's exact two-column head/grid/note/status markup structure. No new sub-tab button or panel.
- [x] 4.2 (superseded by 4.6.5) `comparativas.js`: wire `_congKpiUpdateGrids()` (congestion.js) into the existing `_kpiUpdateGrids()` via a guarded, unawaited call at its end — fires on the same `#cmp-emp-a`/`#cmp-emp-b` `onchange` trigger already used by the Ruido grid (`onCmpEmpChange()`/`runComparativaEmpresas()`), non-blocking so it never delays the Ruido grid's own render. No `switchCmpSubTab` branch (there is no dedicated sub-tab to enter).
- [x] 4.3 (superseded by 4.6.2/4.6.3) `congestion.js`: `CONG_KPI_LIST` array (parallel to Ruido's `KPI_LIST`) covering `mecc, iev, n_veh, km, hwy_share, peak_share` — the six `empresas.csv` fields with no period/month dependency. `rank`, `calles_top_share`, `n_comparables`, `iev_global` are intentionally excluded; `_congKpiRenderGrid(containerId, accountId)` renders it, mirroring `_kpiRenderGrid()`'s exact structure and CSS classes (`.kpi-gauge-card`/`.kpi-gl`/`.kpi-gv`/`.kpi-gp`) but reading from `_congEmpData` instead of `_kpiEmpData`.
- [x] 4.4 (superseded — dropped, see Phase 4.6) Percentile gauge position: reuses `_kpiSvgGauge()` from `comparativas.js` unmodified (pure SVG builder). Since `congestion/empresas.csv` carries no precomputed `*_actual_pct` column (unlike the ruido precedent), the position is computed by linear interpolation against `congestion/referencia.csv`'s p10..p90 anchors (`_congPctFromRef()`, kept from the original sub-tab implementation) — a rendering/positioning calc, not a re-derivation of a business metric, so it doesn't conflict with the vehiculos.csv-scoped "no client-side aggregation" binding note. When `referencia.csv` is absent for a metric, the gauge still renders using `_kpiSvgGauge()`'s existing `pct ?? 50` fallback (needle at the median) — no new fallback logic needed, no discrete rank card (dropped, see Phase 4.5).
- [x] 4.5 (superseded by 4.6.6) Graceful degradation: `_congKpiRenderGrid()` always renders all six gauge cards for a selected company, mirroring `_kpiRenderGrid()`'s exact convention — `—` for value/percentile when `_congEmpData` has no row for that `account_id`, rather than hiding the section (`congestion-empresa` spec: "Graceful Degradation When Company Has No Congestion Data").

## Phase 4.6: Post-hoc redesign — velocímetro grid rejected, reuse `_congRenderKpis` card system (pre-commit, PR3 second rework)

Applied after Phase 4 (velocímetro grid) was implemented, before the PR3
branch was committed — the user rejected forcing congestion KPIs into a
gauge grid before it was even shown in-browser: *"unicamente usa la mejor
visualización para ellos"* (use the best visualization per metric). See
`design.md`'s second "Design Revision (PR3 apply, second refinement)"
section and the amended `congestion-empresa` spec (Amendment 2) for full
detail.

- [x] 4.6.1 Remove the gauge-grid apparatus from `congestion.js`: `CONG_KPI_LIST`, `_congKpiRenderGrid()`, `_congKpiUpdateGrids()`, `_congPctFromRef()` (existed only to feed the gauge needle position — no longer needed once the gauge is gone). Remove the guarded `_congKpiUpdateGrids()` call from `comparativas.js`'s `_kpiUpdateGrids()`. Remove the `#cmp-cong-kpi-grid-a`/`#cmp-cong-kpi-grid-b` grid markup from `index.html`. Confirm `_kpiSvgGauge()` itself (Ruido's own function) is untouched — only no longer called by congestion code.
- [x] 4.6.2 Extract `_congBuildCompanyCards(accountId)` out of `_congRenderEmpresaLevel`'s inline card-construction logic (Camión→Congestión's own Empresa-level view, Phase 3) — pure extraction, identical cards/order/values before and after, `_congRenderEmpresaLevel` now calls `_congRenderKpis(_congBuildCompanyCards(accountId))`.
- [x] 4.6.3 Add `hwy_share` and `peak_share` to `_congBuildCompanyCards` as two more `kind: 'stat'` cards with a `%` unit (not `kind: 'bar'` — reasoning: `'bar'` in this module always encodes a comparison against an external reference/scale (IEV vs `iev_global`, rank vs `n_comparables`); these two fields are self-contained percentages with nothing to compare against, so a self-referential 0–100% bar would be redundant with the `%`-suffixed number).
- [x] 4.6.4 `index.html`: replace the removed `#cmp-cong-kpi-grid-a`/`#cmp-cong-kpi-grid-b` with two `.cong-kpi-row` containers, `#cmp-cong-kpi-row-a`/`#cmp-cong-kpi-row-b`, inside the existing `#cmp-cong-kpi-section` — same `.cong-kpi`/`.cong-kpi-row` CSS Camión's own `#cong-kpi-row` already uses, no new CSS.
- [x] 4.6.5 `congestion.js`: add `_congCompanyCardsUpdate()` (renamed from `_congKpiUpdateGrids()`), same trigger/show-hide/header logic, now calling `_congRenderKpis(_congBuildCompanyCards(accountId), containerId)` per company. `comparativas.js`'s `_kpiUpdateGrids()` calls it via the same guarded `typeof` fire-and-forget pattern.
- [x] 4.6.6 Graceful degradation: no `_congEmpData` row for a company → `_congBuildCompanyCards` returns `[]` → `_congRenderKpis([], containerId)` clears that company's card row (same convention as the Viaje-level `_congRenderKpis([])` call) — no throw. Deliberate behavior change from the gauge grid's always-6-dashed-cards convention; documented in `congestion-empresa` spec Amendment 2.
- [x] 4.6.7 Update `congestion-empresa/spec.md` with Amendment 2 (dated, reasoned) superseding the gauge-grid requirements with the card-system requirements, including the corrected element ids and the now-included rank card. Update `design.md` with a second "Design Revision" section appended after the first PR3 revision — does not delete that history.
- [x] 4.6.8 Update `tasks.md` (this file) and `state.yaml` to record the refinement, keeping Phase 4's original velocímetro-grid task text intact (marked superseded) rather than deleting it.

  Untestable against real data this session: `congestion/empresas.csv` may
  not exist in R2 yet. Verified by code-trace, `node --check`, and
  dangling-reference greps only — not exercised in a browser against real
  rows.

## Phase 4.5: Post-hoc redesign — Empresa sub-tab reverted, Global-grid integration (pre-commit, PR3 rework)

Applied after Phase 4 was first implemented and marked done as a dedicated
Empresa "Congestión" sub-tab (exactly per the original task text below,
preserved for the record), before the PR3 branch was committed — the user
reviewed the sub-tab in-browser and rejected it: company-level congestion
KPIs with no time-period dependency belong in the Empresa tab's existing
Global sub-tab, styled like the Ruido KPI gauge grid, not in a fourth
surface. See `design.md`'s "Design Revision — PR3 apply" and the amended
`congestion-empresa`/`congestion-footprint-map` specs for full detail.

**Original Phase 4 task text (superseded, kept for the record):**

> 4.1 `index.html`: add 3rd `#sub-tabs-empresa` button (`#cmp-subtab-congestion`) + `<div id="cmp-subpanel-congestion" class="sub-tab-panel">`.
> 4.2 `comparativas.js`: extend `switchCmpSubTab` with a `congestion` branch calling `congOnEmpresaTabEnter()` on entry.
> 4.3 KPI cards for `mecc, iev, n_veh, km, hwy_share, peak_share` from `_congEmpData.get(account_id)`, rendered via `_congRenderKpis(cards, containerId)`, reusing the `.cong-kpi*` markup/CSS shipped for Camión.
> 4.4 Gauge from `_congRefData` (p10-p90, hidden if absent) + discrete rank card from `rank/iev_global/n_comparables`, reusing `_kpiSvgGauge()`. Footprint map relocated into Empresa via a new `_congMountFootprintMap(slotId)` helper and a `cong-map-slot-empresa` mount point.
> 4.5 Empty state (`#cmp-cong-empty`/`#cmp-cong-content`) via a dedicated `#cmp-cong-empresa-sel`, decoupled from `#cmp-emp-a`/`#cmp-emp-b` and `#temp-empresa-sel`.

- [x] 4.5.1 Remove the sub-tab UI: `#cmp-subtab-congestion` button and `#cmp-subpanel-congestion` panel (`index.html`); `switchCmpSubTab`'s `congestion` branch (`comparativas.js`).
- [x] 4.5.2 Remove now-dead Empresa-only functions from `congestion.js`: `congOnEmpresaTabEnter()`, `_congPopulateCmpEmpresaSel()`, `congOnCmpEmpresaChange()`, `_congBuildCompanyKpiCards()`, `congRenderEmpresaCongPanel()`, `_congRenderEmpresaGauges()`, `CONG_GAUGE_METRICS`. Verified each was genuinely unreferenced elsewhere (`_congMountFootprintMap()` was checked and kept — Camión→Congestión's own `congOnTabEnter()` still calls it for `cong-map-slot-camion`; only the Empresa call site and the `cong-map-slot-empresa` mount point were removed).
- [x] 4.5.3 Keep and reuse `_congPctFromRef()` unmodified — still needed for the new grid's gauge positioning.
- [x] 4.5.4 Build the new Global-integrated grid: `CONG_KPI_LIST`, `_congKpiRenderGrid()`, `_congKpiUpdateGrids()` — see rewritten Phase 4.1-4.5 above for the final task text.
- [x] 4.5.5 Update `congestion-empresa/spec.md` with an explicit amendment note (dated, reasoned) superseding the sub-tab requirements with the Global-grid requirements, and a new requirement documenting that Temporal integration is not currently applicable (no period-dependent congestion field exists in `congestion-data-contract` today). Update `congestion-footprint-map/spec.md` with an amendment noting the Empresa mount point no longer exists (Camión-only, for now).
- [x] 4.5.6 Update `design.md` with a new "Design Revision — PR3 apply" section (this file), appended after the existing PR2 revision section — does not delete or rewrite the PR2 history.

  Untestable against real data this session: `congestion/empresas.csv` /
  `referencia.csv` may not exist in R2 yet. Verified by code-trace,
  `node --check`, and dangling-reference greps only — not exercised in a
  browser against real rows.

## Phase 5: CSS (`css/styles.css`)

- [x] 5.1 KPI + rank/"hallazgos" card styles (Camión). — Camión fleet KPI cards (`.cong-kpi-row`/`.cong-kpi*`, incl. the `kind:'rank'` bar variant) done in PR2. Empresa (PR3/Phase 4, reworked twice) went through two states: first it did NOT use `.cong-kpi*` at all (reused `.kpi-gauge-card`/`.kpi-gl`/`.kpi-gv`/`.kpi-gp` for a velocímetro grid); Phase 4.6's card-system rework changed this — the Global-integrated card rows (`#cmp-cong-kpi-row-a`/`b`) now DO reuse `.cong-kpi`/`.cong-kpi-row` (the same classes as Camión's `#cong-kpi-row`), and no longer touch `.kpi-gauge-card`/`.kpi-g*`. No new CSS was required in either state — both reused pre-existing classes.
- [x] 5.2 Vehicle table + detail panel styles. (`.cong-table`, `.cong-tr-veh`, `.cong-detalle-*`)
- [x] 5.3 Footprint map wrap + `map-cong-empty` + ramp legend styles. (landed in PR1 alongside Phase 2; confirmed present, marking complete here)

## Phase 6: Manual Verification (browser checklist, no test runner)

- [ ] 6.1 All `congestion/*` present → Camión→Congestión renders KPIs, table, detail, map.
- [ ] 6.2 Empresa→Global sub-tab, with two companies selected in `#cmp-emp-a`/`#cmp-emp-b` → the congestion card rows (`#cmp-cong-kpi-row-a`/`b` inside `#cmp-cong-kpi-section`) render a stat/bar/rank card set per company (MECC, Distancia, Vehículos, % vías rápidas, % hora punta as `stat`; IEV as `bar` with a delta line; Ranking as `rank`), below/after the Ruido grid, in the same Global panel (no navigation to another sub-tab needed).
- [ ] 6.3 Camión with a matching `gpsLayers` `owner_id` selected → its real GPS route overlays the shared footprint map.
- [ ] 6.4 Camión with no GPS match / GPS not loaded → Camión/Viaje levels render fully, no route overlay, no error.
- [ ] 6.5 Company with no `congestion/empresas.csv` row selected in `#cmp-emp-a`/`#cmp-emp-b` → that company's `.cong-kpi-row` container renders empty (no cards, no error) — deliberately different from the superseded gauge grid's `—`-dashed-card convention; Camión→Congestión's own empty-state is unaffected.
- [ ] 6.6 Confirm Camión→Congestión's own Empresa-level KPI cards (`#cong-kpi-row`, entered via the Camión tab) are pixel-for-pixel/value-for-value identical to before the `_congBuildCompanyCards` extraction — same cards, same order, same values, for the same company.
- [ ] 6.7 `vehiculos.csv` or `red_mecc.geojson` 404 → Camión→Congestión's own widgets show their empty-state, siblings unaffected, no console error; the Global congestion card rows are unaffected either way (they only read `empresas.csv`).
- [ ] 6.8 Confirm no `#cmp-subtab-congestion`/`#cmp-subpanel-congestion` exist anywhere in the DOM; Empresa tab shows only Global and Temporal sub-tabs; Camión→Congestión sub-tab panel switching is unaffected (exactly one active panel per group, as before).
- [ ] 6.9 Confirm zero references remain to `CONG_KPI_LIST`/`_congKpiRenderGrid`/`_congKpiUpdateGrids`/`_congPctFromRef`/`#cmp-cong-kpi-grid-a`/`#cmp-cong-kpi-grid-b` anywhere in `js/`, `index.html` (dangling-reference grep).
