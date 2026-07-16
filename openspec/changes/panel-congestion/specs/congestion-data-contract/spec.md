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

### Requirement: Vehicle CSV Schema with GPS Cross-Reference

`congestion/vehiculos.csv` MUST have exactly one row per vehicle with header exactly `gps_vehicle_id,account_id,km,mecc,iev,n_pasadas,hwy_share,peak_share`, verified against the extracted `window.DASH.vehicles[]` source. The `gps_vehicle_id` column's values MUST be drawn from the same ID space `gps.js` uses for Camión→Exposición vehicles (`feature.properties.owner_id`). All columns are precomputed/aggregated upstream — `dashboard_r2` MUST NOT re-derive any of these metrics (no client-side mean/sum of raw fields); it only fetches, filters, sorts, and renders them.

#### Scenario: Vehicle file carries a gps.js-compatible ID

- GIVEN `congestion/vehiculos.csv` exists in R2
- WHEN it is parsed
- THEN its header is exactly `gps_vehicle_id,account_id,km,mecc,iev,n_pasadas,hwy_share,peak_share`
- AND `gps_vehicle_id` values are of the same type/format as `gps.js`'s existing vehicle IDs (`feature.properties.owner_id`)

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
