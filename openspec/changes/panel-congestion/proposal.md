# Proposal: Congestion Panel for Empresa and Camión

## Intent

Both the Empresa tab and the Camión tab currently offer **no congestion view**. Camión→Congestión is a wired-but-empty placeholder (`index.html:119-124` button + `:369-379` panel body) and Empresa has no Congestión sub-tab at all. The congestion source data (per-company `mecc`/`iev` indices, per-trip vehicle metrics, and a road-network footprint geojson) already exists in `datos_congestion/` but is unreachable from the product.

This change surfaces congestion as a first-class, two-level analysis so a company can answer: **"How much road congestion does my fleet cause, how do I rank against comparable companies, and which of my vehicles drive it?"** — reusing the same token-gated R2 fetch pipeline every other dataset in `dashboard_r2` already uses. It lands the capability the prior `empresa-temporal-flota-percentiles` change explicitly deferred ("Congestión / Emisión gauges — deferred to a later, separate change").

## Scope

### In Scope
- **Camión→Congestión** — replace the `#sub-tab-congestion` placeholder body with a real panel: fleet-level congestion KPIs, a **vehicle table + per-vehicle detail** view, and the road-network **footprint map** (huella) from the geojson.
- **Empresa→Congestión** — a **new** third sub-tab in `#sub-tabs-empresa` (button + `#cmp-subpanel-congestion` div mirroring `cmp-subpanel-global`/`cmp-subpanel-temporal`): company-level congestion KPIs, rank/benchmark against comparable companies ("hallazgos"/rank cards, reusing the `comparativas.js` gauge precedent), and the same footprint map scoped to the company.
- **Data via R2 only** — both levels consume precomputed tidy CSVs + the geojson through `core.js` `fetchParseCsv`/`r2Fetch`, under a new `congestion/` path prefix (mirrors `ruido/`, `flota/`). Lazy-load-on-first-open (mirrors `ruidoEnsureLoaded()`).
- **Vehicle identity is cross-referable with `gps.js`** — the per-vehicle congestion rows MUST carry the **same vehicle ID** that `gps.js` uses in Camión→Exposición, so a congestion vehicle can be matched to its GPS entity (same universe, not a parallel dataset).
- A new **`js/congestion.js`** (one-file-per-domain convention) owning fetch + aggregation + render for both levels.

### Out of Scope
- **The offline precompute script** (`Definitos/build_congestion_*.py`) that reshapes `datos_congestion/*` (incl. the 268 `empresa_<id>.js` inside `02_datos_empresas.rar`) into the R2 CSVs. This change **defines the data contract** those files must satisfy but does **not** build the generator. CSVs are assumed to exist in R2, uploaded manually (same out-of-band process as `ruido/` and `flota/`).
- Porting the standalone prototype `01_dashboard_empresa.html` (per-company injected `<script>` bundles) — it is a **UX/visual reference only**, incompatible with the token-gated fetch model.
- Any metric, chart, or feature not mapped in `exploration.md`. Emisión sub-tab stays a placeholder.
- R2 upload automation; a test runner (none exists — verification stays manual/browser).

## Capabilities

### New Capabilities
- `congestion-empresa`: company-level congestion KPIs + rank/benchmark against comparable companies in a new Empresa sub-tab.
- `congestion-camion`: fleet-level congestion KPIs + cross-referable per-vehicle table/detail in the Camión→Congestión panel.
- `congestion-footprint-map`: Leaflet rendering of the road-network congestion footprint (LineString/edge geojson with hourly load), shared by both levels.
- `congestion-data-contract`: the frozen R2 file/column/type contract the offline generator must satisfy (interface spec, not implementation).

### Modified Capabilities
None (both sub-tab shells pre-exist in nav; no spec-level requirement of another capability changes).

## Data Contract (required in R2 — generated out-of-band)

New `congestion/` prefix. Column names derive from the verified source headers in `exploration.md`.

| File | Grain | Columns (source-derived; frozen in sdd-spec) |
|------|-------|----------------------------------------------|
| `congestion/empresas.csv` | one row per company | `account_id, n_veh, km, mecc, iev, rank, hwy_share, peak_share, calles_top_share, n_comparables, iev_global` (from `09_dashboard_empresas.csv`) |
| `congestion/vehiculos.csv` | one row per vehicle | `gps_vehicle_id` (MUST equal the `gps.js` ID), `account_id`, plus per-vehicle congestion metrics (`km_recorridos`, `mecc_veh_s`, …) derived from `08_dashboard_viajes.csv` + per-company files |
| `congestion/red_mecc.geojson` | LineString edges | edge geometry + hourly `mecc_veh_s[24]` load (from `04_mecc_red_imputada_sectra.geojson`) |
| `congestion/referencia.csv` *(optional)* | fleet percentile reference | `p10..p90` per metric, if the rank/benchmark visual consumes a distribution (mirrors `flota/percentiles_referencia.csv`) |

`sdd-spec` freezes exact columns/types before either half is implemented. The `gps_vehicle_id` reconciliation column is the load-bearing contract term: without it, cross-linking is impossible.

## Approach

New `js/congestion.js` lazy-loads once on first open of either Congestión surface, fetches the `congestion/` CSVs + geojson additively via `fetchParseCsv`/`r2Fetch`, and renders two levels from a shared aggregation core, reusing `TOKENS` colors and the `comparativas.js` gauge/rank-card precedent. The footprint map is a **new Leaflet polyline layer** (edge/LineString + a locally-scoped color ramp, à la `RUIDO_RAMP`), not an extension of the H3-hexagon `h3overlay.js`. Load-order slot for `congestion.js` is a design question (candidate: after `temporal.js`, near `h3overlay.js`). The dependency-free static architecture, fixed `<script>` load order, and Worker+bearer-token auth are preserved.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `index.html` | Modified | Fill `#sub-tab-congestion` body; add Empresa Congestión button + `#cmp-subpanel-congestion` div |
| `js/congestion.js` | New | Fetch + aggregate + render both levels + footprint map |
| `js/comparativas.js` | Modified | Extend `switchCmpSubTab`/`initCmpTab` for the new sub-tab; reuse gauge/rank rendering |
| `js/init.js` | Modified | Verify global `.sub-tab-panel` clearing vs new Empresa sub-tab; trigger lazy-load |
| `js/r2.js` | Modified | New `congestion/` path prefix + guarded trigger |
| `css/styles.css` | Modified | KPI/hallazgos cards, vehicle table + detail, map/chart containers |
| R2 bucket (manual) | New data | User uploads generated `congestion/*` files out-of-band |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Per-vehicle CSV cannot carry a `gps.js`-matching ID (RAR schema unverified) → cross-link impossible | Med | Freeze `gps_vehicle_id` as a contract requirement; verify RAR-extracted schema before sdd-spec locks columns; degrade to a non-linked table if unmatchable |
| Congestion vehicle has no match in `gps.js` | Med | Show the vehicle row without the GPS cross-link (detail still renders from congestion data) |
| Empresa/company with no congestion data | Med | Graceful degradation (panel hidden/empty-state), mirroring `ruido.js` absent-data behavior |
| Footprint geojson (LineString/edge) is new Leaflet territory, not an `h3overlay.js` reuse | Med | Treat as a fresh polyline-layer design task; prototype the ramp early |
| Data-contract columns drift from generator output | Med | Freeze the `congestion/` schema in sdd-spec before either half is built |
| `switchSubTab` global `.sub-tab-panel` selector coupling breaks with a 3rd Empresa sub-tab | Low | Re-verify parent `.tab-panel` gating once the sub-tab exists |
| Change likely exceeds the 400-line single-PR budget | Med | `sdd-tasks` forecasts and plans chained delivery, splitting along the Empresa/Camión two-level structure |
| No automated tests | High | Manual in-browser verification checklist (project convention) |

## Rollback Plan

File-scoped on one branch; no persisted state or schema migration. Revert the branch/commits to restore the empty placeholder + the two-sub-tab Empresa panel. The `congestion/*` files in R2 are additive data — not uploading/deleting them leaves the dashboard in graceful-degradation (empty-state) mode. `js/congestion.js` is a new file with no other callers.

## Dependencies

- `core.js` `fetchParseCsv`/`r2Fetch` + `TOKENS` (existing) — unchanged.
- Papa Parse, Leaflet, Chart.js (already vendored) — unchanged.
- The `congestion/*` R2 files, produced out-of-band by the deferred offline script against the frozen contract.
- Resolution of the open decisions below before sdd-design freezes the schema.

## Success Criteria

- [ ] Camión→Congestión renders fleet KPIs, a vehicle table + per-vehicle detail, and the footprint map from `congestion/*`.
- [ ] Empresa→Congestión renders company KPIs + rank/benchmark against comparables and the company-scoped footprint map.
- [ ] A congestion vehicle is matched to its `gps.js` entity via `gps_vehicle_id`; unmatched vehicles still render without the cross-link.
- [ ] Both surfaces consume `congestion/*` via `fetchParseCsv`/`r2Fetch` and degrade gracefully when data is absent.
- [ ] Architecture unchanged: no build step, fixed load order preserved, all I/O through the token-gated Worker.

## Proposal question round

**Resolved as firm constraints (user, pre-proposal):**
1. **Data strategy** — tidy CSVs via R2 + `fetchParseCsv` (ruido/flota pattern). Prototype `01_dashboard_empresa.html` is visual reference only, not a code source.
2. **Vehicle identity** — the Congestión "Camión" is the **same** vehicle universe as `gps.js` (Camión→Exposición), cross-referable by shared ID. Reconciling the congestion source ID with the `gps.js` ID is in scope for this front-end change; the contract carries a `gps_vehicle_id` column.
3. **Scope** — **front-end only**. The offline CSV generator is out of scope; this proposal defines the R2 data contract it must satisfy.
4. **Delivery** — `ask-on-risk` (cached); PR-cut decided later by `sdd-tasks` with a real forecast.

**Open for sdd-spec / sdd-design (do not block this proposal):**
- Exact schema of the 268 `empresa_<id>.js` (inside `02_datos_congestion.rar`/`02_datos_empresas.rar`) — hourly-array field names, Lorenz/concentration shape — must be extracted and inspected before the CSV schema is frozen.
- Whether the rank/benchmark visual consumes a percentile distribution (adds `congestion/referencia.csv`) or only the precomputed `rank`/`iev_global` fields already in `09_dashboard_empresas.csv`.
- `js/congestion.js` load-order slot in `index.html`.
- Footprint map interaction model (hourly slider vs aggregate, company-scoped filtering).
