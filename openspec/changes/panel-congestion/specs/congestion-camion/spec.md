# Congestion Camión Specification

## Purpose

Fleet-level congestion analysis replacing the Camión→Congestión placeholder: fleet KPIs, a per-vehicle table with detail view, and the footprint map. Vehicles MUST be cross-referable with the same vehicle universe used by `gps.js` (Camión→Exposición). Consumes `congestion/vehiculos.csv` (see `congestion-data-contract`) and the shared layer defined in `congestion-footprint-map`.

## Requirements

### Requirement: Camión Congestión Panel Body

The system MUST replace the `#sub-tab-congestion` placeholder body with real content: fleet KPI cards, a vehicle table, a vehicle detail view, and the footprint map. Existing nav wiring (`index.html:119-124` button) is unchanged.

#### Scenario: Placeholder is replaced

- GIVEN the Camión tab's Congestión sub-tab is opened
- WHEN the panel renders
- THEN fleet KPI cards, the vehicle table, and the footprint map are visible instead of the empty placeholder

### Requirement: Fleet-Level KPI Cards

The system MUST show fleet-aggregate KPI cards (at minimum: vehicle count, total/average `km`, average congestion metric) computed from the `congestion/vehiculos.csv` rows for the currently selected company scope.

#### Scenario: Fleet KPIs computed from vehicle rows

- GIVEN `congestion/vehiculos.csv` rows for the selected company scope
- WHEN the panel renders
- THEN KPI cards show the vehicle count and aggregate metrics derived from those rows

### Requirement: Vehicle Table

The system MUST render a table with one row per vehicle from `congestion/vehiculos.csv`, showing at minimum `gps_vehicle_id`, `km_recorridos`, and `mecc_veh_s`. Selecting a row MUST open that vehicle's detail view.

#### Scenario: Selecting a vehicle opens detail

- GIVEN the vehicle table is populated
- WHEN the user clicks a vehicle row
- THEN a detail view for that vehicle's `gps_vehicle_id` opens, showing its per-vehicle congestion metrics

### Requirement: Vehicle Identity Cross-Reference with gps.js

Each vehicle row's `gps_vehicle_id` MUST be matched against `gps.js`'s existing vehicle ID space (the same universe used in Camión→Exposición). WHEN a match exists, the vehicle detail view MUST expose the cross-link (e.g., a way to identify/jump to the corresponding GPS entity). WHEN no match exists, the vehicle row and detail view MUST still render, without the cross-link.

#### Scenario: Vehicle has a GPS match

- GIVEN a congestion vehicle row whose `gps_vehicle_id` matches an existing `gps.js` vehicle ID
- WHEN its detail view opens
- THEN the cross-link to the matching GPS entity is shown

#### Scenario: Vehicle has no GPS match

- GIVEN a congestion vehicle row whose `gps_vehicle_id` has no match in `gps.js`'s vehicle IDs
- WHEN its detail view opens
- THEN the detail view still renders all congestion metrics for that vehicle
- AND no cross-link, error, or blocking message appears

### Requirement: Fleet-Scoped Footprint Map

The Camión Congestión panel MUST render the shared footprint layer defined in `congestion-footprint-map`, in the context of the selected company's fleet.

#### Scenario: Footprint map renders alongside the vehicle table

- GIVEN `congestion/red_mecc.geojson` has loaded
- WHEN the panel renders
- THEN the footprint map appears alongside the fleet KPIs and vehicle table

### Requirement: Lazy Load on First Open

`congestion/vehiculos.csv` and `congestion/red_mecc.geojson` MUST be fetched only on the first open of either Congestión surface (Camión or Empresa), not on initial page load. Subsequent opens MUST reuse the already-fetched data.

#### Scenario: Data fetch is deferred until first open

- GIVEN the dashboard has just loaded and no Congestión surface has been opened
- WHEN the user opens Camión→Congestión for the first time
- THEN the `congestion/*` fetch is triggered at that moment, not before

### Requirement: Graceful Degradation When Fleet Has No Congestion Data

IF `congestion/vehiculos.csv` has no rows for the selected company scope, the panel MUST show an empty state instead of an empty/broken table.

#### Scenario: Company's fleet has no congestion rows

- GIVEN `congestion/vehiculos.csv` has no rows matching the selected company's vehicles
- WHEN the panel renders
- THEN an empty-state message is shown in place of the KPI cards, vehicle table, and footprint map
- AND no error dialog or blocking failure appears
