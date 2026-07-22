# Congestion Camión Specification

## Purpose

Fleet-level congestion analysis replacing the Camión→Congestión placeholder: a cascading Empresa→Camión→Viaje drill-down over `congestion/vehiculos.csv` (trip-grained), scope-appropriate KPI cards, a sortable table, a detail card, and the shared footprint map. The selected Camión's real GPS route is overlaid directly on that map — see the "GPS Route Overlay Cross-Link" requirement below — instead of a separate cross-link button. Consumes `congestion/vehiculos.csv` (see `congestion-data-contract`) and the shared layer defined in `congestion-footprint-map`.

> **Amendment (PR2 apply):** This spec originally described a flat single-level
> fleet KPI row + sortable vehicle table + detail panel, with vehicle identity
> cross-referenced to `gps.js` via an explicit "Ver en Exposición" button. Both
> assumptions were invalidated once the real `congestion/vehiculos.csv` schema
> (trip-grained, no precomputed per-vehicle rollups) was verified during PR2
> implementation: a flat vehicle table cannot exist because vehicles aren't rows,
> trips are — and vehicle detail needed a drill-down through the trip dimension
> instead of a single flat row. The requirements below describe the resulting
> 3-level cascading design instead.

## Requirements

### Requirement: Camión Congestión Panel Body

The system MUST replace the `#sub-tab-congestion` placeholder body with real content: cascading `Empresa/Camión/Viaje` `<select>`s (`#cong-empresa-sel`, `#cong-camion-sel`, `#cong-viaje-sel`, mounted in the shared `gps-topbar`), scope-appropriate KPI cards, a sortable table, a detail card, and the shared footprint map. Existing nav wiring (`index.html` Congestión sub-tab button) is unchanged.

#### Scenario: Placeholder is replaced

- GIVEN the Camión tab's Congestión sub-tab is opened
- WHEN the panel renders
- THEN the Empresa/Camión/Viaje selects, scope-appropriate KPI cards, the table, and the footprint map are visible instead of the empty placeholder

### Requirement: Cascading Empresa → Camión → Viaje Scope Selection

The system MUST expose three cascading `<select>` controls scoped to Congestión only (`#cong-empresa-sel`, `#cong-camion-sel`, `#cong-viaje-sel`), independent of the shared Archivo/Empresa/Camión GPS filters above them. `#cong-empresa-sel` MUST be populated with the distinct `account_id` values present in `_congVehData` (`_congPopulateEmpresaSel`). Selecting a company MUST populate `#cong-camion-sel` with the distinct `owner_id` values for that company (`_congPopulateCamionSel`, `congOnEmpresaChange`). Selecting a Camión (or leaving it at "Todos") MUST populate `#cong-viaje-sel` with that Camión's `id_viaje` values (`_congPopulateViajeSel`, `congOnCamionChange`). Selecting a Viaje (or leaving it at "Todos") MUST re-render the panel (`congOnViajeChange`) without repopulating the other selects.

#### Scenario: Selecting a company populates its vehicles

- GIVEN `congestion/vehiculos.csv` has rows for a selected `account_id`
- WHEN the user selects that company in `#cong-empresa-sel`
- THEN `#cong-camion-sel` is populated with that company's distinct `owner_id` values and enabled

#### Scenario: Selecting a vehicle populates its trips

- GIVEN a company and one of its `owner_id` values are selected
- WHEN the user selects that Camión in `#cong-camion-sel`
- THEN `#cong-viaje-sel` is populated with that Camión's `id_viaje` values and enabled

### Requirement: Empresa-Level KPIs and Camión Table (Camión = "Todos")

WHEN `#cong-camion-sel` is at "Todos los camiones", the system MUST render company-level KPI cards from the precomputed `congestion/empresas.csv` row for the selected `account_id` (IEV gauge, MECC, distance, vehicle count, city ranking — `_congRenderEmpresaLevel`), and a table with one row per Camión, aggregated by summing `km_recorridos`/`mecc_veh_s` per `owner_id` across that company's trip rows (`_congAggByOwner`). Clicking a table row MUST select that Camión in `#cong-camion-sel` and drill down (`congOnCamionChange`).

#### Scenario: Empresa-level KPIs and table render

- GIVEN a company is selected and Camión is "Todos"
- WHEN the panel renders
- THEN KPI cards show that company's precomputed `congestion/empresas.csv` fields
- AND the table shows one row per Camión with `km`/`mecc` summed from its trip rows
- AND clicking a Camión row drills into that Camión's level

### Requirement: Camión-Level Totals and Viaje Table (Camión selected, Viaje = "Todos")

WHEN a Camión is selected and `#cong-viaje-sel` is at "Todos los viajes", the system MUST render that Camión's totals (trip count, summed `km`, summed `mecc`) derived only from its own trip rows (`_congRenderCamionLevel`), a table with one row per trip (`id_viaje`, `km`, `mecc`), and a detail card with the same totals. Clicking a trip row MUST select that Viaje in `#cong-viaje-sel` and drill down (`congOnViajeChange`).

#### Scenario: Camión-level totals and trip table render

- GIVEN a Camión is selected and Viaje is "Todos"
- WHEN the panel renders
- THEN KPI cards show that Camión's trip count and summed `km`/`mecc`
- AND the table shows one row per trip belonging to that Camión
- AND clicking a trip row drills into that trip's level

### Requirement: Viaje-Level Detail

WHEN a specific Viaje is selected, the system MUST render a detail card showing that single trip row's `km_recorridos` and `mecc_veh_s`, with no KPI cards or table shown at this level (`_congRenderViajeLevel`).

#### Scenario: Viaje detail renders

- GIVEN a Camión and one of its `id_viaje` values are selected
- WHEN the panel renders
- THEN the detail card shows that trip's `km_recorridos` and `mecc_veh_s`
- AND no KPI cards or table are shown

### Requirement: GPS Route Overlay Cross-Link

WHEN a Camión (a specific `owner_id`) is in focus — i.e. `#cong-camion-sel` is not "Todos" — the system MUST overlay that Camión's real GPS route(s) on the shared footprint map (`_congRenderVehicleRouteOverlay`), resolving `owner_id → bus_id[]` via a reverse index built from `gpsLayers` (`_congBuildByOwner`, keyed by `feature.properties.owner_id`, mirroring the `gps.js` cross-reference used elsewhere in this panel). WHEN no Camión is in focus (Empresa level), any existing route overlay MUST be cleared and the map MUST re-fit to the full network footprint. WHEN the selected Camión has no `gpsLayers` match (Exposición not loaded, or no matching `owner_id`), the map MUST render the footprint alone, without error.

#### Scenario: Selecting a Camión overlays its GPS route

- GIVEN Exposición has loaded GPS data whose `feature.properties.owner_id` matches the selected Camión
- WHEN the user selects that Camión in `#cong-camion-sel`
- THEN its real GPS route is drawn as an overlay on the shared footprint map

#### Scenario: Selecting a Camión with no GPS match

- GIVEN Exposición has not loaded GPS data, or no `gpsLayers` entry matches the selected Camión's `owner_id`
- WHEN the user selects that Camión in `#cong-camion-sel`
- THEN the footprint map renders without a route overlay
- AND no error or blocking message appears

#### Scenario: Returning to Empresa level clears the overlay

- GIVEN a Camión's GPS route is currently overlaid on the footprint map
- WHEN the user returns `#cong-camion-sel` to "Todos los camiones"
- THEN the route overlay is removed
- AND the map re-fits to the full network footprint

### Requirement: Fleet-Scoped Footprint Map

The Camión Congestión panel MUST render the shared footprint layer defined in `congestion-footprint-map`, in the context of the selected company's fleet.

#### Scenario: Footprint map renders alongside the KPIs and table

- GIVEN `congestion/red_mecc.geojson` has loaded
- WHEN the panel renders
- THEN the footprint map appears alongside the KPI cards and table for the active scope level

### Requirement: Lazy Load on First Open

`congestion/vehiculos.csv` and `congestion/red_mecc.geojson` MUST be fetched only on the first open of either Congestión surface (Camión or Empresa), not on initial page load. Subsequent opens MUST reuse the already-fetched data.

#### Scenario: Data fetch is deferred until first open

- GIVEN the dashboard has just loaded and no Congestión surface has been opened
- WHEN the user opens Camión→Congestión for the first time
- THEN the `congestion/*` fetch is triggered at that moment, not before

### Requirement: Graceful Degradation When Fleet Has No Congestion Data

IF `congestion/vehiculos.csv` has no rows for the selected company scope, the panel MUST show an empty state instead of an empty/broken table.

#### Scenario: Company's fleet has no congestion rows

- GIVEN `congestion/vehiculos.csv` has no rows matching the selected company's `account_id`
- WHEN the panel renders
- THEN an empty-state message is shown in place of the KPI cards, table, and footprint map/overlay
- AND no error dialog or blocking failure appears
