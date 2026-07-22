# Congestion Data Contract Specification

## Purpose

The frozen `congestion/` R2 file/column contract that the out-of-scope offline generator MUST satisfy. This is an interface specification, not an implementation: `dashboard_r2` only consumes these files via `fetchParseCsv`/`r2Fetch`; it does not produce them.

## Requirements

### Requirement: Company CSV Schema

`congestion/empresas.csv` MUST have exactly one row per company with header `account_id,n_veh,km,mecc,iev,rank,hwy_share,peak_share,calles_top_share,n_comparables,iev_global`, derived from the verified `09_dashboard_empresas.csv` source.

#### Scenario: Company file matches frozen schema

- GIVEN `congestion/empresas.csv` exists in R2
- WHEN it is parsed
- THEN its header is exactly `account_id,n_veh,km,mecc,iev,rank,hwy_share,peak_share,calles_top_share,n_comparables,iev_global`
- AND each row has a non-empty `account_id`

### Requirement: Trip-Level Vehicle CSV Schema with Owner Cross-Reference

> **Amendment (PR2 apply, post-hoc correction):** The schema below supersedes an
> earlier "one row per vehicle" version of this requirement (`gps_vehicle_id,
> account_id,km,mecc,iev,n_pasadas,hwy_share,peak_share`), which was itself a
> Phase 0 correction of the originally-frozen contract. Both prior versions were
> based on an extracted UI sample (`window.DASH.vehicles[]`) that turned out not
> to match the real `congestion/vehiculos.csv` file. The real file was verified
> directly against `datos_congestion/` during PR2 implementation and is one row
> per TRIP, not per vehicle. See `design.md`'s "Design Revision" note for full
> context.

`congestion/vehiculos.csv` MUST have exactly one row per TRIP (not per vehicle) with header exactly `id_viaje,owner_id,account_id,km_recorridos,mecc_veh_s`, verified against the real `datos_congestion/` source data. Each row's `owner_id` MUST be drawn from the same ID space `gps.js` uses for Camión→Exposición vehicles (`feature.properties.owner_id`); a single `owner_id` MAY have multiple `id_viaje` rows (one per trip) and, via `gps.js`, MAY map to multiple `bus_id` entries. `dashboard_r2` MUST NOT re-derive any field from this file EXCEPT deriving Camión-level and company-level totals by summing `km_recorridos` and `mecc_veh_s` grouped by `owner_id` (and `account_id`) — no other client-side aggregation (mean, weighted metrics, or any field not present in the raw rows) is permitted.

#### Scenario: Vehicle file is trip-grained and carries a gps.js-compatible owner ID

- GIVEN `congestion/vehiculos.csv` exists in R2
- WHEN it is parsed
- THEN its header is exactly `id_viaje,owner_id,account_id,km_recorridos,mecc_veh_s`
- AND multiple rows MAY share the same `owner_id` (one row per trip)
- AND `owner_id` values are of the same type/format as `gps.js`'s existing vehicle owner IDs (`feature.properties.owner_id`)

#### Scenario: Camión-level and company-level totals are derived by summing trip rows

- GIVEN two or more `congestion/vehiculos.csv` rows share the same `owner_id` (or `account_id`)
- WHEN a Camión-level or company-level view aggregates that scope's metrics
- THEN its `km` and `mecc` totals equal the sum of `km_recorridos`/`mecc_veh_s` across only that scope's trip rows
- AND no other metric is invented, averaged, or otherwise derived client-side

### Requirement: Footprint Geojson Schema

`congestion/red_mecc.geojson` MUST be a FeatureCollection of LineString features, each with `properties` including at least `id_sntg`, `nombre`, and `mecc_veh_s` (a 24-element hourly load array), matching the verified shape of `04_mecc_red_imputada_sectra.geojson`.

#### Scenario: Geojson matches frozen shape

- GIVEN `congestion/red_mecc.geojson` exists in R2
- WHEN a feature is inspected
- THEN its geometry type is `LineString`
- AND its properties include `id_sntg`, `nombre`, and a 24-length `mecc_veh_s` array

### Requirement: Optional Reference CSV Schema

`congestion/referencia.csv` is OPTIONAL. IF present, it MUST carry a fleet-wide percentile distribution (`p10`-`p90`) per metric, mirroring the shape of `flota/percentiles_referencia.csv`. Its absence MUST NOT be treated as an error by any consuming panel (see `congestion-empresa`'s benchmark requirement).

#### Scenario: Reference file is absent by default

- GIVEN `congestion/referencia.csv` has not been uploaded
- WHEN any Congestión surface loads
- THEN no fetch failure for this file blocks or errors any other Congestión rendering
