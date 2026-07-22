# Congestion Footprint Map Specification

## Amendment (2026-07-22) — Empresa integration no longer mounts this map

The original Purpose/requirements below describe this layer as shared between
`congestion-empresa` and `congestion-camion`. That was accurate while
`congestion-empresa` was a dedicated sub-tab with its own footprint map mount
point (`cong-map-slot-empresa`). That sub-tab was reverted (see
`congestion-empresa/spec.md`'s own amendment and `design.md`'s "Design
Revision — Phase 4 pivot"): company-level congestion KPIs now live in the
Empresa tab's Global sub-tab as a KPI gauge grid only, with **no footprint
map** of their own. This layer is therefore, as of this amendment, mounted
and consumed **only by `congestion-camion`** (`#cong-map-slot-camion`). The
rendering functions (`congInitMap()`, `congRenderFootprint()`) and the
relocation helper (`_congMountFootprintMap(slotId)`) remain genuinely
unmodified and generic — a future Empresa-side surface could still reuse them
via a second slot — but no such second mount point currently exists in the
DOM. The requirements below are left as originally written (still literally
true: the layer supports being opened "from Empresa or Camión" in principle,
via the generic `slotId` parameter), except where explicitly called out.

## Purpose

Shared Leaflet rendering of the road-network congestion footprint (`congestion/red_mecc.geojson`), currently mounted only by `congestion-camion` (see Amendment above for why the original Empresa mount point was removed). Renders LineString edges colored by congestion load, distinct from the H3-hexagon `h3overlay.js` pattern.

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

Because `congestion/red_mecc.geojson` carries no per-company join key, the system MUST render the same underlying network geometry without any company-based filter of edges, regardless of which mount point (`slotId`) the layer is relocated into via `_congMountFootprintMap()`. "Company-scoped" framing (where it applies, per the calling capability) refers to the surrounding KPI/table context, not a geometric filter of edges.

#### Scenario: Edges are never filtered by company

- GIVEN the same `congestion/red_mecc.geojson` payload is loaded
- WHEN the footprint map renders inside Camión→Congestión (the only mount
  point that currently exists — see Amendment above)
- THEN the full set of network edges is drawn, with no company/account_id
  filter applied to the geometry

### Requirement: Graceful Degradation When Geojson Is Absent

IF `congestion/red_mecc.geojson` fails to fetch or 404s, the footprint map MUST be hidden or replaced with an empty-state message. Calling KPI/table sections MUST remain fully functional.

#### Scenario: Geojson not yet uploaded

- GIVEN `congestion/red_mecc.geojson` does not exist in R2
- WHEN a Congestión surface renders
- THEN KPI cards and/or the vehicle table render normally
- AND the footprint map area shows an empty-state message instead of a broken map
