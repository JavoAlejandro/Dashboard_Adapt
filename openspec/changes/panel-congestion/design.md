# Design: Congestion Panel for Empresa and Camión

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

## Vehicle Cross-link Design (Camión ↔ gps.js)

`gpsLayers` is keyed by `bus_id` with the vehicle owner in `feature.properties.owner_id` (gps.js:1179/1220 `p.owner_id || p.bus_id`). The verified schema confirms `08_dashboard_viajes.csv.owner_id === vehicles[].id`. Therefore the contract's `gps_vehicle_id` **must equal `gps.js` `feature.properties.owner_id`** (a vehicle owner may map to multiple `bus_id`, one per día).

Resolution = an **in-memory reverse index built lazily on first vehicle-table render**, not a persisted join:

```
Congestión Camión open ──► congEnsureLoaded()
      │ fetchParseCsv('congestion/vehiculos.csv')  ──► _congVehData (array of rows)
      ▼
renderVehTable():
  build _gpsByOwner : Map<String(owner_id), bus_id[]>   from Object.values(gpsLayers)
      │  (empty if Camión/Exposición data not yet loaded)
  for each cong row:
      match = _gpsByOwner.get(String(row.gps_vehicle_id))
      match?  → render row WITH "Ver en Exposición" action (selects that bus_id)
      no match / index empty → render row WITHOUT the cross-link (detail still
                               renders from congestion data alone)
```

If `gpsLayers` is empty (Exposición never opened), rows still render; the cross-link is simply inactive and re-resolvable on the next render after GPS data loads. No hard dependency, no error.

## Data Flow

```
(offline, out-of-band → R2)  congestion/empresas.csv · vehiculos.csv · referencia.csv · red_mecc.geojson

Browser — first open of either Congestión surface:
  congEnsureLoaded()  (mirrors ruidoEnsureLoaded: loaded/loading flags, status text)
     │ Promise.allSettled([ empresas, vehiculos, referencia (csv), red_mecc (geojson) ])
     ▼
  _congEmpData Map<account_id,row>  _congVehData rows[]  _congRefData Map<metric,{p10..p90}>  _congGeo
     │                                  │                        │                              │
     ▼                                  ▼                        ▼                              ▼
  Empresa KPIs + gauge + rank card   Camión fleet KPIs +    gauge scale             new L.geoJSON layer
  (gauge from _congRefData;          vehicle table + detail                         + CONGEST_RAMP
   card from empresas.csv rank)      (cross-link via _gpsByOwner)                   (shared, both levels)
     │  on any 404/fail: flag stays false → that widget's empty-state; siblings render
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `js/congestion.js` | Create | Fetch + aggregate + render both levels + footprint layer; `congEnsureLoaded`, `_congByOwner` index, `CONGEST_RAMP`, local module state |
| `index.html` | Modify | Fill `#sub-tab-congestion` body (fleet KPIs, vehicle table+detail, map, `map-cong-empty`); add Empresa `switchCmpSubTab('congestion',…)` button + `<div id="cmp-subpanel-congestion" class="sub-tab-panel">`; add `<script src="js/congestion.js">` before `init.js` |
| `js/comparativas.js` | Modify | Add `congestion` branch to `switchCmpSubTab` (map invalidate on enter, trigger `congEnsureLoaded`); reuse gauge helpers |
| `js/init.js` | Modify | Optional lazy-load trigger in `switchSubTab` for `name==='congestion'` (mirror `ruidoOnTabEnter`); re-verify global `.sub-tab-panel` clear vs 3rd Empresa sub-tab |
| `js/r2.js` | Modify | New `congestion/` path prefix constant / guarded trigger (mirror `temporalLoadFlota`) |
| `css/styles.css` | Modify | KPI/hallazgos cards, vehicle table + detail, map/ramp legend containers |
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

### `congestion/vehiculos.csv` — one row per vehicle
```
gps_vehicle_id:string  (MUST equal gps.js feature.properties.owner_id),
account_id:string, km:number, mecc:number,
iev:number, n_pasadas:int, hwy_share:number(0..1), peak_share:number(0..1)
```
Header exactly `gps_vehicle_id,account_id,km,mecc,iev,n_pasadas,hwy_share,peak_share`, verified against the extracted `window.DASH.vehicles[]` source. `gps_vehicle_id` is the load-bearing reconciliation column; without it cross-linking is impossible.

**Binding note (all later tasks):** `vehiculos.csv` rows and `empresas.csv` rows are already fully aggregated upstream (mirroring `window.DASH.vehicles[]` / `window.DASH.company`). `js/congestion.js` MUST NOT re-derive KPI metrics (no client-side mean/sum of raw fields) — it only fetches, filters, sorts, and renders these precomputed fields.

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
_congVehData : row[]                        _congRefData : Map<metrica,{p10..p90}>
_congGeo : geojson                          _congByOwner : Map<owner_id,bus_id[]> (rebuilt per render)
_congMap / _congLayer : Leaflet             CONGEST_RAMP : [{t,color}] (local, NOT in frozen TOKENS)
```
Reads `TOKENS.empresaA/B` + neutrals for gauges/KPIs; the color ramp stays module-local exactly as `RUIDO_RAMP` does (TOKENS is `Object.freeze`d and not in this change's affected-areas beyond consumption).

## Graceful Degradation (per-artifact, `ruido.js` mirror)

| Missing artifact | UI behavior |
|------|------|
| `empresas.csv` | Empresa→Congestión shows empty-state; no KPIs/gauge/card; no console error |
| `vehiculos.csv` | Camión vehicle table + detail show empty-state; fleet KPIs derived from it hidden |
| `referencia.csv` | Gauge hidden; **rank card still renders** from `empresas.csv` `rank`/`iev_global` |
| `red_mecc.geojson` | `map-cong-empty` placeholder shown, map wrap hidden (mirror `map-ruido-empty`) |
| GPS not loaded | Vehicle rows render without cross-link; re-resolves on next render |

`Promise.allSettled` isolates each fetch so one 404 never blocks the others; flags default false; no `console.error` crash path.

## Testing Strategy

No test runner exists (confirmed by both prior changes). Manual in-browser checklist:

| # | Scenario | Expected |
|---|---|---|
| 1 | All `congestion/*` present, open Camión→Congestión | Fleet KPIs, vehicle table+detail, footprint map render |
| 2 | Open Empresa→Congestión | Company KPIs + gauge (p10–p90 scale) + rank card + shared map |
| 3 | Vehicle with `gps_vehicle_id` matching a loaded `owner_id` | "Ver en Exposición" action jumps to that entity |
| 4 | Vehicle with no gps match / GPS not loaded | Row + detail render, no cross-link, no error |
| 5 | Hour slider on footprint | Same layer re-styles per-hour; no rebuild; ramp legend updates |
| 6 | Any single `congestion/*` 404 | That widget shows empty-state; siblings render; no console error |
| 7 | `referencia.csv` absent | Gauge hidden, rank card still shows from `empresas.csv` |
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
