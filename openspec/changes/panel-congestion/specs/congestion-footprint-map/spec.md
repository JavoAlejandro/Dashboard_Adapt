# Congestion Footprint Map Specification

## Purpose

Shared Leaflet rendering of the road-network congestion footprint (`congestion/red_mecc.geojson`) reused, unmodified in rendering logic, by both `congestion-empresa` and `congestion-camion`. Renders LineString edges colored by congestion load, distinct from the H3-hexagon `h3overlay.js` pattern.

## Requirements

### Requirement: Footprint Layer Rendering

The system MUST render each `congestion/red_mecc.geojson` feature as a Leaflet polyline, colored by a locally-scoped ramp (mirrors `RUIDO_RAMP`, not added to shared `TOKENS`) driven by that edge's congestion load (`mecc_veh_s`).

#### Scenario: Edges render colored by load

- GIVEN `congestion/red_mecc.geojson` has loaded
- WHEN the footprint layer renders
- THEN each LineString edge is drawn as a polyline
- AND its color reflects its `mecc_veh_s` load via the local ramp

### Requirement: Aggregate Load View

The system MUST render at least one aggregate (non-hourly) view of the footprint — e.g., a daily/overall load value per edge — as the default. Hourly breakdown (e.g., a time slider over the `mecc_veh_s[24]` array) is an optional enhancement (MAY) left to `sdd-design`.

#### Scenario: Default view shows aggregate load

- GIVEN the footprint layer is shown for the first time
- WHEN it renders
- THEN edges are colored using an aggregate load value, without requiring the user to pick an hour first

### Requirement: Shared, Unfiltered Network Geometry

Because `congestion/red_mecc.geojson` carries no per-company join key, the system MUST render the same underlying network geometry regardless of whether the map is shown from the Empresa or Camión Congestión surface. "Company-scoped" framing (per the calling capability) refers to the surrounding KPI/table context, not a geometric filter of edges.

#### Scenario: Same edges shown from either surface

- GIVEN the same `congestion/red_mecc.geojson` payload is loaded
- WHEN the footprint map is opened from Empresa→Congestión and, separately, from Camión→Congestión
- THEN the same set of edges is drawn in both cases

### Requirement: Graceful Degradation When Geojson Is Absent

IF `congestion/red_mecc.geojson` fails to fetch or 404s, the footprint map MUST be hidden or replaced with an empty-state message. Calling KPI/table sections MUST remain fully functional.

#### Scenario: Geojson not yet uploaded

- GIVEN `congestion/red_mecc.geojson` does not exist in R2
- WHEN a Congestión surface renders
- THEN KPI cards and/or the vehicle table render normally
- AND the footprint map area shows an empty-state message instead of a broken map
