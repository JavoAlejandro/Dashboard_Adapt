# Congestion Empresa Specification

## Purpose

Company-level congestion analysis inside Empresa's new "Congestión" sub-tab: KPI cards, rank/benchmark against comparable companies, and a company-scoped footprint map. Consumes `congestion/empresas.csv` (see `congestion-data-contract`) and the shared layer defined in `congestion-footprint-map`.

## Requirements

### Requirement: Empresa Congestión Sub-Tab

The system MUST add a third sub-tab button to `#sub-tabs-empresa` and a matching `#cmp-subpanel-congestion` panel, wired through `switchCmpSubTab`/`initCmpTab` alongside the existing Global and Temporal sub-tabs.

#### Scenario: Sub-tab is selectable

- GIVEN the Empresa tab is active
- WHEN the user clicks the Congestión sub-tab button
- THEN `#cmp-subpanel-congestion` becomes visible and the other Empresa sub-panels are hidden

### Requirement: Company Congestion KPI Cards

For the selected `account_id`, the system MUST show KPI cards for `mecc`, `iev`, `n_veh`, `km`, `hwy_share`, and `peak_share`, sourced from `congestion/empresas.csv`.

#### Scenario: KPIs render for a selected company

- GIVEN `congestion/empresas.csv` is loaded and a company with a matching `account_id` row is selected
- WHEN the Congestión sub-tab renders
- THEN all six KPI cards show that row's values

### Requirement: Rank and Benchmark Against Comparable Companies

The system MUST show the company's `rank`, `iev_global`, and `n_comparables` as rank/benchmark cards ("hallazgos"), reusing the gauge/rank-card rendering precedent from `comparativas.js`. IF `congestion/referencia.csv` is present, the system MAY additionally render a percentile band for `mecc`/`iev` against the fleet-wide distribution.

#### Scenario: Rank cards render from precomputed fields

- GIVEN a company row with `rank`, `iev_global`, and `n_comparables` values
- WHEN the rank/benchmark section renders
- THEN it shows the company's rank position and `iev_global`, labeled against `n_comparables` peer companies

#### Scenario: Percentile band is optional

- GIVEN `congestion/referencia.csv` does not exist in R2
- WHEN the rank/benchmark section renders
- THEN the rank cards still render from `congestion/empresas.csv` alone, with no percentile band and no error

### Requirement: Company-Scoped Footprint Map

The Empresa Congestión sub-tab MUST render the shared footprint layer defined in `congestion-footprint-map`, in the context of the selected company.

#### Scenario: Footprint map renders alongside KPIs

- GIVEN a company is selected and `congestion/red_mecc.geojson` has loaded
- WHEN the Congestión sub-tab renders
- THEN the footprint map appears below or beside the KPI/rank cards

### Requirement: Lazy Load on First Open

Congestion data (`congestion/empresas.csv`, `congestion/red_mecc.geojson`, optional `congestion/referencia.csv`) MUST be fetched only on the first open of either Congestión surface (Empresa or Camión), not on initial page load. Subsequent opens MUST reuse the already-fetched data.

#### Scenario: Data fetch is deferred

- GIVEN the dashboard has just loaded and no Congestión surface has been opened
- WHEN the user switches to a different tab/sub-tab (not Congestión)
- THEN no `congestion/*` fetch has been triggered

### Requirement: Graceful Degradation When Company Has No Congestion Data

IF `congestion/empresas.csv` has no row for the selected `account_id`, the Empresa Congestión sub-tab MUST show an empty state (mirroring `ruido.js`'s absent-data behavior) instead of blank/broken cards.

#### Scenario: Company without congestion data

- GIVEN `congestion/empresas.csv` has no row for the selected company's `account_id`
- WHEN the Congestión sub-tab renders
- THEN an empty-state message is shown in place of KPI cards, rank cards, and the footprint map
- AND no error dialog or blocking failure appears
