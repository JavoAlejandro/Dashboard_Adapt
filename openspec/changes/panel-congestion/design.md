# Design: Congestion Panel for Empresa and Camión

## Design Revision (PR2 apply — schema correction & drill-down redesign)

The sections below (Vehicle Cross-link Design, Data Flow, Interfaces, Module
state) were written against a "one row per vehicle" `congestion/vehiculos.csv`
schema, itself already a Phase 0 correction of the originally-frozen contract.
Both versions were derived from an extracted UI sample
(`window.DASH.vehicles[]`), not from the real file. During PR2 implementation
the actual `congestion/vehiculos.csv` (verified against `datos_congestion/`)
turned out to be **trip-grained**: one row per `id_viaje`
(`id_viaje, owner_id, account_id, km_recorridos, mecc_veh_s`), with no
precomputed per-vehicle or per-company rollup columns beyond what
`empresas.csv` already provides.

This forced two structural changes, applied in this PR and documented here
after the fact for traceability:

1. **Aggregation moved client-side, but only for two fields.** Since
   `vehiculos.csv` no longer carries precomputed `km`/`mecc`/`iev`/`n_pasadas`
   per vehicle, Camión-level and (for the vehicle table) company-level totals
   are now derived in `js/congestion.js` by summing `km_recorridos` and
   `mecc_veh_s` grouped by `owner_id`/`account_id`. This is the one narrow
   exception to the "no client-side re-derivation" rule below — see
   `congestion-data-contract`'s amended requirement.
2. **The flat vehicle table became a 3-level cascading drill-down.** Without
   per-vehicle rows to list directly, the UI now resolves scope through three
   cascading `<select>`s — Empresa → Camión → Viaje — backed by
   `_congPopulateEmpresaSel` / `_congPopulateCamionSel` / `_congPopulateViajeSel`
   and `congOnEmpresaChange` / `congOnCamionChange` / `congOnViajeChange`, each
   rendering a different level via `_congRenderEmpresaLevel` /
   `_congRenderCamionLevel` / `_congRenderViajeLevel`. The explicit "Ver en
   Exposición" cross-link button (see below) was dropped in favor of a live
   map overlay, `_congRenderVehicleRouteOverlay`, that draws the focused
   Camión's real GPS route directly on the shared footprint map — a more
   direct visual cross-reference than a button that only jumped the user to
   another tab.

The "Vehicle Cross-link Design", "Data Flow", "Interfaces / Contracts", and
"Module state" sections further down have been updated in place to reflect
this revision — they now describe the actually-shipped trip-grained schema,
drill-down, and map-overlay mechanism, not the original plan.

## Technical Approach

One new domain file `js/congestion.js` owns fetch + aggregation + render for both levels, mirroring the established one-file-per-domain convention (`ruido.js`, `temporal.js`). It lazy-loads once on first open of either Congestión surface (`ruidoEnsureLoaded()` idiom), pulls the `congestion/` CSVs + geojson additively through `core.js` `fetchParseCsv`/`r2Fetch`, reuses `TOKENS` and the `comparativas.js` percentile-gauge precedent, and degrades gracefully when data is absent (`ruido.js` mirror). Zero architecture drift: no build step, fixed `<script>` order preserved, all I/O token-gated. Firm constraints 1–4 from the proposal are treated as fixed.

## Architecture Decisions

### Decision: Load-order slot — after `ruido.js`, before `init.js`

**Choice.** `core.js → r2.js → gps.js → animation.js → comparativas.js → temporal.js → h3overlay.js → ruido.js → **congestion.js** → init.js`.
**Alternatives.** After `temporal.js` near `h3overlay.js` (proposal candidate) — rejected.
**Rationale.** `congestion.js` reads `gpsLayers` (gps.js) for the vehicle cross-link and reuses the gauge helpers/`cmpMap` conventions from `comparativas.js`, so it must load after both. It does **not** depend on `h3overlay.js` (the footprint map is a fresh layer, see below), so proximity to it is irrelevant. `init.js` must stay last (it wires `switchTab`/`switchSubTab` and boot). Placing `congestion.js` as the final feature module before `init.js` puts it after every dependency while keeping the boot file last.

### Decision: Sub-tab integration — reuse each group's own selector, do not touch the global `.sub-tab-panel` clear

**Choice.** Camión→Congestión fills the existing `#sub-tab-congestion` body (nav already wired, no `switchSubTab` change beyond an optional lazy-load trigger). Empresa→Congestión adds a 3rd button in `#sub-tabs-empresa` + `<div id="cmp-subpanel-congestion" class="sub-tab-panel">`, switched by the existing `switchCmpSubTab` which already targets its own `[id^="cmp-subpanel-"]` selector (comparativas.js:7), not `.sub-tab-panel`.
**Alternatives.** Refactor `switchSubTab`'s global `document.querySelectorAll('.sub-tab-panel')` clear (init.js:8) to be group-scoped — rejected.
**Rationale.** The global clear is a latent-but-harmless coupling: it strips `active` from Empresa's `cmp-subpanel-*` too, but those are gated by a different parent `.tab-panel` (invisible while in Camión) and are re-activated by `switchCmpSubTab`'s own selector on entry. A 3rd Empresa panel changes nothing about that invariant. Refactoring the shared clear is out-of-scope churn that risks the working Camión/Ruido flow. Verification: confirm at apply time that entering Empresa→Congestión then Camion→any sub-tab then back leaves exactly one active panel per group.

### Decision: Rank/benchmark consumes BOTH — `referencia.csv` for the gauge, `empresas.csv` fields for the rank card

**Choice.** Promote `congestion/referencia.csv` (p10…p90 per metric) from *optional* to **required for the gauge visual**; keep `rank`/`iev_global`/`n_comparables` from `congestion/empresas.csv` for a discrete textual rank card ("hallazgos").
**Alternatives.** Rank/iev_global fields alone (no distribution file) — rejected.
**Rationale.** This change explicitly reuses the `comparativas.js:910+` KPI-velocímetro precedent, which **requires** a p10–p90 reference to position needle + scale (`_kpiRefData` two-file pattern: `dashboard_kpis_empresa.csv` + `dashboard_kpis_referencia.csv`). The `empresa-temporal-flota-percentiles` design set the same precedent — a distribution is genuinely rendered via a `referencia`+`empresa` file pair, not a precomputed scalar. Without `referencia.csv` the gauge would have to invent a scale. So: percentiles power the gauge; the precomputed `rank`/`iev_global` power a separate discrete "rank N of n_comparables" card that renders even if `referencia.csv` is absent (gauge hidden, card stays — graceful degradation).

### Decision: Footprint map — 100% new Leaflet `L.geoJSON` polyline layer, reusing only the ramp idiom

**Choice.** A fresh `L.geoJSON` LineString layer with a locally-scoped `CONGEST_RAMP` (interpolation copied from `ruido.js`'s `RUIDO_RAMP`, not added to frozen `TOKENS`). Default paint = 24h aggregate of `mecc_veh_s[]`; an optional hour slider re-styles the **same** layer via `setStyle` from the pre-parsed 24-array (O(1), no rebuild — `ruido.js` per-hour-paint idiom). Map is **network-level and shared** by both levels; it is not company/fleet-filtered.
**Alternatives.** Extend `h3overlay.js` — rejected (that is H3-hexagon `L.polygon` geometry; the footprint is LineString/edge geometry, a different Leaflet concern). Per-company edge filtering — rejected as unsupported by the source.
**Rationale.** `04_mecc_red_imputada_sectra.geojson` carries `properties.mecc_veh_s[24]` at network-edge grain with **no company/vehicle dimension**, so the map cannot be scoped per company from this source; company/fleet scoping lives in the KPIs and vehicle table, not the map. The map provides shared network context on both surfaces. The ramp interpolation is the only reusable piece of the H3/ruido color logic; geometry rendering is genuinely new.

## Vehicle Cross-link Design (Camión ↔ gps.js) — GPS route overlay, not a button

`gpsLayers` is keyed by `bus_id` with the vehicle owner in `feature.properties.owner_id` (gps.js `p.owner_id || p.bus_id`). The verified real schema confirms `congestion/vehiculos.csv.owner_id` is the same owner identifier space. Therefore the contract's `owner_id` **must equal `gps.js` `feature.properties.owner_id`** (a vehicle owner may map to multiple `bus_id`, one per día, and to multiple `id_viaje` trip rows in `vehiculos.csv`).

Resolution = an **in-memory reverse index rebuilt on every vehicle-panel render** (`_congBuildByOwner`), not a persisted join. Unlike the original plan, the cross-link is not a clickable button in a detail row — it is a **live overlay on the shared footprint map**, drawn whenever a Camión is in focus:

```
Congestión Camión open ──► congEnsureLoaded()
      │ fetchParseCsv('congestion/vehiculos.csv')  ──► _congVehData (row[], one per trip)
      ▼
congRenderVehiclePanel():
  _congBuildByOwner() → _congByOwner : Map<String(owner_id), bus_id[]>   from gpsLayers
      │  (empty if Camión/Exposición data not yet loaded)
  ownerId = #cong-camion-sel value ('all' → null)
  _congRenderVehicleRouteOverlay(ownerId):
      ownerId == null (Empresa level)  → clear any existing overlay, re-fit map to full footprint
      ownerId set, busIds = _congByOwner.get(ownerId)
        busIds found  → draw those gpsLayers[busId].feature geometries as an
                         L.geoJSON overlay on the shared #map-cong footprint map,
                         fit bounds to the route
        no match / gpsLayers empty → no overlay drawn, footprint renders alone (no error)
```

If `gpsLayers` is empty (Exposición never opened), the footprint map still renders; the overlay is simply absent and re-resolvable on the next render after GPS data loads. No hard dependency, no error. This replaces the original "Ver en Exposición" button design, which assumed a flat per-vehicle detail row to attach an action to — that row no longer exists once `vehiculos.csv` is trip-grained (see Design Revision above).

## Data Flow

```
(offline, out-of-band → R2)  congestion/empresas.csv (per-company) · vehiculos.csv (per-TRIP) · referencia.csv · red_mecc.geojson

Browser — first open of either Congestión surface:
  congEnsureLoaded()  (mirrors ruidoEnsureLoaded: loaded/loading flags, status text)
     │ Promise.allSettled([ empresas, vehiculos, referencia (csv), red_mecc (geojson) ])
     ▼
  _congEmpData Map<account_id,row>  _congVehData row[] (1/trip)  _congRefData Map<metric,{p10..p90}>  _congGeo
     │                                  │                                │                              │
     ▼                                  ▼                                ▼                              ▼
  Empresa KPIs + gauge + rank card   Camión: #cong-empresa-sel →     gauge scale             new L.geoJSON layer
  (PR3, not yet built — gauge        #cong-camion-sel → #cong-viaje-sel                       + CONGEST_RAMP
   from _congRefData; card from      cascading drill-down:                                    (shared, both levels)
   empresas.csv rank)                  Camión=all  → _congRenderEmpresaLevel
                                        (aggregates _congVehData by owner_id,
                                         via _congAggByOwner)
                                        Viaje=all   → _congRenderCamionLevel
                                        (sums that owner_id's trip rows)
                                        Viaje set   → _congRenderViajeLevel
                                        (single trip row detail)
                                      + _congRenderVehicleRouteOverlay(ownerId)
                                        draws the focused Camión's real GPS
                                        route on the shared footprint map via
                                        _congByOwner (built by _congBuildByOwner
                                        from gpsLayers)
     │  on any 404/fail: flag stays false → that widget's empty-state; siblings render
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `js/congestion.js` | Create | Fetch + aggregate (PR1) + Camión Empresa/Camión/Viaje cascading drill-down + GPS route overlay (PR2) + footprint layer; `congEnsureLoaded`, `_congByOwner`/`_congBuildByOwner`, `CONGEST_RAMP`, local module state |
| `index.html` | Modify | Fill `#sub-tab-congestion` body (KPI row, sortable table, detail card, map, `map-cong-empty`); add `#cong-empresa-sel`/`#cong-camion-sel`/`#cong-viaje-sel` to the shared `gps-topbar`; (PR3) add Empresa `switchCmpSubTab('congestion',…)` button + `<div id="cmp-subpanel-congestion" class="sub-tab-panel">`; add `<script src="js/congestion.js">` before `init.js` |
| `js/comparativas.js` | Modify (PR3, pending) | Add `congestion` branch to `switchCmpSubTab` (map invalidate on enter, trigger `congEnsureLoaded`); reuse gauge helpers |
| `js/init.js` | Modify | `switchSubTab` lazy-load trigger for `name==='congestion'` (mirror `ruidoOnTabEnter`); show/hide the shared `gps-topbar`'s GPS-only vs Congestión-only fields (`GPS_ONLY_TOPBAR_FIELDS`/`CONG_ONLY_TOPBAR_FIELDS`) and force `#gps-filters` visible while in Congestión even without a loaded Archivo |
| `js/gps.js` | Modify | `initGPSMap()`: `#map-gps-wrap` (Exposición map) display toggle intentionally commented out — kept hidden pending a later revision, unrelated to Congestión |
| `js/r2.js` | Modify | New `congestion/` path prefix constant / guarded trigger (mirror `temporalLoadFlota`) |
| `css/styles.css` | Modify | KPI row (`.cong-kpi*`, incl. bar/rank/delta variants), sortable table (`.cong-table`), detail card (`.cong-detalle-*`), map/ramp legend containers |
| R2 bucket (manual) | New data | User uploads `congestion/*` out-of-band |

## Interfaces / Contracts (frozen exactly by sdd-spec)

The offline generator MUST emit these. Types are load-bearing, not just names.

### `congestion/empresas.csv` — one row per company
```
account_id:string, n_veh:int, km:number, mecc:number, iev:number,
rank:int, hwy_share:number(0..1), peak_share:number(0..1),
calles_top_share:number(0..1), n_comparables:int, iev_global:number
```
`account_id` string-safe join key (matches `_congVehData.account_id` and `_kpiEmpData` convention).

### `congestion/vehiculos.csv` — one row per TRIP (corrected, PR2)
```
id_viaje:string, owner_id:string  (MUST equal gps.js feature.properties.owner_id),
account_id:string, km_recorridos:number, mecc_veh_s:number
```
Header exactly `id_viaje,owner_id,account_id,km_recorridos,mecc_veh_s`, verified directly against the real `datos_congestion/` source data (supersedes the earlier `gps_vehicle_id,account_id,km,mecc,iev,n_pasadas,hwy_share,peak_share` per-vehicle version, which was based on an extracted UI sample that did not match the real file — see "Design Revision" above). `owner_id` is the load-bearing reconciliation column for both the Camión/Empresa drill-down aggregation and the GPS route overlay cross-link; without it neither is possible. A single `owner_id` normally has multiple rows (one per trip).

**Binding note (all later tasks, amended):** `empresas.csv` rows remain fully aggregated upstream (mirroring `window.DASH.company`) and MUST NOT be re-derived. `vehiculos.csv` rows are raw per-trip records — `js/congestion.js` MUST NOT re-derive any metric from them EXCEPT summing `km_recorridos`/`mecc_veh_s` grouped by `owner_id` (Camión level) or `account_id` (company-level vehicle table), which is the one permitted client-side aggregation. No mean, weighted metric, or any field absent from the raw rows may be derived.

### `congestion/referencia.csv` — fleet percentile reference (required for gauge)
```
metrica:string(one of the gauge metric ids), n_empresas:int,
p10:number, p25:number, p50:number, p75:number, p90:number
```
One row per metric; join key `metrica`. Mirrors `ruido/dashboard_kpis_referencia.csv`.

### `congestion/red_mecc.geojson` — network LineString edges
```
FeatureCollection of LineString, properties:{
  id_sntg:string, nombre:string, clase:string, largo_m:number,
  mecc_veh_s:number[24]   (hourly load, index 0..23)
}
```
Network-level, no company dimension (map is shared, not per-company scoped).

### Module state (congestion.js) and `TOKENS`
```
_congLoaded / _congLoading : bool          _congEmpData : Map<account_id,row>
_congVehData : row[] (one per trip)         _congRefData : Map<metrica,{p10..p90}>
_congGeo : geojson                          _congByOwner : Map<owner_id,bus_id[]> (rebuilt per render)
_congMap / _congLayer : Leaflet             _congRouteLayer : Leaflet (GPS route overlay, focused Camión)
_congTableState : {rows,cols,sort}          CONGEST_RAMP : [{t,color}] (local, NOT in frozen TOKENS)
(current painted table, rebuilt per level)
```
Reads `TOKENS.empresaA/B` + neutrals for gauges/KPIs; the color ramp stays module-local exactly as `RUIDO_RAMP` does (TOKENS is `Object.freeze`d and not in this change's affected-areas beyond consumption).

## Graceful Degradation (per-artifact, `ruido.js` mirror)

| Missing artifact | UI behavior |
|------|------|
| `empresas.csv` | Empresa-level KPI cards show `—`/absent fields; Camión-level table (summed from `vehiculos.csv`) still renders |
| `vehiculos.csv` | Empresa/Camión/Viaje selects and drill-down show empty-state (`#cong-veh-empty`); Empresa-level KPI card block hidden |
| `referencia.csv` | Gauge hidden (PR3); **rank card still renders** from `empresas.csv` `rank`/`iev_global` |
| `red_mecc.geojson` | `map-cong-empty` placeholder shown, map wrap hidden (mirror `map-ruido-empty`) |
| GPS not loaded / no `owner_id` match | Footprint map renders without the GPS route overlay; re-resolves on next render |

`Promise.allSettled` isolates each fetch so one 404 never blocks the others; flags default false; no `console.error` crash path.

## Testing Strategy

No test runner exists (confirmed by both prior changes). Manual in-browser checklist:

| # | Scenario | Expected |
|---|---|---|
| 1 | All `congestion/*` present, open Camión→Congestión, select a company | Empresa-level KPIs (from `empresas.csv`) + Camión table (summed from `vehiculos.csv`) + footprint map render |
| 2 | Select a Camión in `#cong-camion-sel` | Camión-level totals + Viaje table render; if a matching `gpsLayers` `owner_id` exists, its real GPS route overlays the footprint map |
| 3 | Select a Viaje in `#cong-viaje-sel` | Viaje-level detail card renders that trip's `km_recorridos`/`mecc_veh_s`, no KPI cards/table |
| 4 | Selected Camión has no `gpsLayers` match / GPS not loaded | Camión/Viaje levels still render fully; footprint map renders without a route overlay, no error |
| 5 | Open Empresa→Congestión (PR3) | Company KPIs + gauge (p10–p90 scale) + rank card + shared map |
| 6 | Any single `congestion/*` 404 | That widget shows empty-state; siblings render; no console error |
| 7 | `referencia.csv` absent (PR3) | Gauge hidden, rank card still shows from `empresas.csv` |
| 8 | Enter Empresa→Congestión → Camión sub-tab → back | Exactly one active panel per group (no `.sub-tab-panel` leak) |

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or process-integration boundary. Client-side static app performing additive read-only `fetchParseCsv`/`r2Fetch` GETs against the existing authenticated R2 proxy. The offline generator is out of scope.

## Migration / Rollout

No migration. `congestion/*` files are additive R2 data uploaded manually; the dashboard runs in graceful-degradation (empty-state) mode until they exist. Rollback = revert the branch (restores the empty placeholder + two-sub-tab Empresa panel); no persisted state or schema touched. `js/congestion.js` is a new file with no other callers.

## Open Questions — RESOLVED

- [x] Load-order slot: after `ruido.js`, before `init.js`.
- [x] Rank/benchmark source: `referencia.csv` (gauge) + `empresas.csv` rank fields (card) — both.
- [x] Footprint map: fresh `L.geoJSON` polyline layer, shared network-level, hour re-style via `setStyle`; reuses only the ramp idiom.
- [x] Vehicle cross-link key: `gps_vehicle_id === gps.js owner_id`, resolved via lazy in-memory reverse index.
- [ ] None blocking. Confirm at apply time the `.sub-tab-panel` invariant (test #8) and that `referencia.csv` gauge-metric ids match the chosen KPI list (sdd-spec freezes them).
