# Congestion Empresa Specification

## Amendment (2026-07-22) — sub-tab design superseded by Global-grid integration

The original version of this spec (Requirements below, pre-amendment)
described a dedicated third "Congestión" sub-tab under Empresa
(`#cmp-subtab-congestion` / `#cmp-subpanel-congestion`), with its own
company selector, KPI cards, rank/benchmark card, gauge, and a company-scoped
mount of the shared footprint map. That sub-tab was implemented once (Phase 4
of `tasks.md`), then **reverted** after the user reviewed it in-browser and
rejected the extra-panel approach: company-level congestion KPIs with no time
dependency should live in the Empresa tab's existing **Global** sub-tab,
alongside (not instead of) the existing Ruido KPI gauge grid
(`cmp-kpi-grid-a`/`cmp-kpi-grid-b`, built by `KPI_LIST`/`_kpiRenderGrid`/
`_kpiSvgGauge` in `js/comparativas.js`) — no new sub-tab or panel.

The first amendment rewrote the Requirements below to describe that
Global-grid integration. It supersedes the sub-tab design without deleting
the historical record — see `design.md`'s "Design Revision — Phase 4 pivot"
and `tasks.md`'s Phase 4 rework note for the full before/after and the
reasoning.

## Amendment 2 (2026-07-22, same day) — velocímetro grid superseded by the `_congRenderKpis` card system

The Global-grid integration described by Amendment 1 was implemented once
exactly as written: a `CONG_KPI_LIST`-driven velocímetro grid
(`_congKpiRenderGrid()`/`_congKpiUpdateGrids()`), mounted at
`#cmp-cong-kpi-grid-a`/`#cmp-cong-kpi-grid-b`, mirroring Ruido's
`_kpiSvgGauge()` pattern. **The user rejected forcing congestion KPIs into a
gauge grid at all**, before it was shown in-browser: *"unicamente usa la
mejor visualización para ellos"* (use the best visualization per metric, not
necessarily a gauge grid).

The as-shipped replacement reuses Camión→Congestión's own proven multi-format
card system (`_congRenderKpis(cards, containerId)`, with `stat`/`bar`/`rank`
card kinds — originally built for that surface's own Empresa-level
drill-down) instead of a gauge, via a new shared builder
`_congBuildCompanyCards(accountId)`. This second amendment rewrites the
Requirements below again to describe this **as-shipped** card-based
integration; it supersedes Amendment 1's gauge-grid requirements without
deleting the historical record — see `design.md`'s second "Design Revision"
note (PR3 apply, second refinement) for the full before/after and reasoning.

## Purpose

Company-level congestion KPIs that have **no time-period dependency**
(`mecc`, `iev`, `n_veh`, `km`, `hwy_share`, `peak_share` from
`congestion/empresas.csv`, see `congestion-data-contract`) are integrated into
the Empresa tab's existing **Global** sub-tab, as a second row of KPI cards
per company, built from the same `stat`/`bar`/`rank` card system
(`_congRenderKpis`) already used and proven by Camión→Congestión's own
Empresa-level drill-down — not a gauge grid. They are driven by the same
`#cmp-emp-a`/`#cmp-emp-b` selection already used by the Global sub-tab's
Ruido comparison. No dedicated Congestión sub-tab, no company-scoped
footprint map mount, and no percentile-gauge/`referencia.csv` dependency
exist in this integration — see "Explicitly Out of Scope" below for what was
deliberately dropped from the original design.

## Requirements

### Requirement: Congestion KPI Cards in the Global Sub-Tab

The system MUST render `congestion/empresas.csv`-backed KPI cards
(`#cmp-cong-kpi-section`, containing `.cong-kpi-row` containers
`#cmp-cong-kpi-row-a` and `#cmp-cong-kpi-row-b`) inside the existing
`#cmp-subpanel-global` panel, alongside the pre-existing Ruido KPI grid
(`#cmp-kpi-section`). Each row MUST be populated by the same
`_congRenderKpis(cards, containerId)` function and `.cong-kpi`/
`.cong-kpi-row` CSS that Camión→Congestión's own `#cong-kpi-row` uses — not
the Ruido `_kpiSvgGauge()`/`.kpi-gauge-card` system, and not a structurally
separate rendering function: both surfaces call the same
`_congRenderKpis()`.

#### Scenario: Congestion cards render alongside the Ruido grid

- GIVEN the Empresa tab's Global sub-tab is active and two companies are
  selected in `#cmp-emp-a`/`#cmp-emp-b`
- WHEN `congestion/empresas.csv` has rows for the selected companies
- THEN both the Ruido KPI grid (`cmp-kpi-grid-a`/`b`) and the Congestion KPI
  card rows (`cmp-cong-kpi-row-a`/`b`) render in the same Global sub-tab,
  without requiring the user to navigate to another sub-tab or panel

### Requirement: Company Congestion Cards — No Period Dependency, Best Visualization Per Metric

For each selected `account_id`, the system MUST show, via
`_congBuildCompanyCards(accountId)`: `stat` cards for `mecc`, `km` (as
"Distancia"), `n_veh` (as "Vehículos"), `hwy_share` and `peak_share` (both as
percentages with a `%` unit); a `bar` card for `iev` comparing it against
`emp.iev_global` (city-wide average) with a delta line; and a `rank` card for
`rank`/`n_comparables` showing city ranking with a position bar. All fields
sourced from `congestion/empresas.csv` MUST have no period/month dependency
in the current data contract (see "Temporal Integration Is Not Currently
Applicable" below). The card kind per metric MUST NOT be forced into a
single uniform visual (e.g. a gauge grid) — each metric uses whichever of
`stat`/`bar`/`rank` best fits whether it is a plain value, a comparison
against a reference, or a position/ranking.

#### Scenario: Cards render for a selected company

- GIVEN `congestion/empresas.csv` is loaded and a company with a matching
  `account_id` row is selected in `#cmp-emp-a` or `#cmp-emp-b`
- WHEN the Global sub-tab's congestion card row renders
- THEN the row shows the MECC/Distancia/Vehículos/% vías rápidas/% hora punta
  `stat` cards, the IEV `bar` card (with a delta line vs `iev_global`), and
  the Ranking `rank` card, with that company's values

### Requirement: Shared Card Builder — Single Source of Truth

`_congBuildCompanyCards(accountId)` MUST be the single function that builds
a company's congestion card set. Both Camión→Congestión's own Empresa-level
drill-down (`_congRenderEmpresaLevel`) and the Global sub-tab integration
(`_congCompanyCardsUpdate`) MUST call this same builder rather than
duplicating card-construction logic — the card set (kinds, order, computed
values) for a given `account_id` MUST be identical regardless of which
surface renders it.

#### Scenario: Camión-tab and Global-tab cards are identical for the same company

- GIVEN a company `account_id` with a `congestion/empresas.csv` row
- WHEN `_congBuildCompanyCards(accountId)` is called from Camión→Congestión's
  own Empresa-level view and from the Global sub-tab's card-row update
- THEN both calls produce the same array of cards (same kinds, same order,
  same values) — the two surfaces are not allowed to diverge in what a
  company's congestion cards show

### Requirement: Lazy Load on First Need

Congestion data (`congestion/empresas.csv`, `congestion/vehiculos.csv`,
`congestion/red_mecc.geojson`, `congestion/referencia.csv`) MUST be fetched
only on first need by either Congestión surface — Camión→Congestión's own
sub-tab, or the Global sub-tab's congestion card rows — not on initial page
load. The Global sub-tab's card rows trigger the fetch
(`congEnsureLoaded()`, via `_congCompanyCardsUpdate()`) the first time
`#cmp-emp-a`/`#cmp-emp-b` selection changes, not merely on Global sub-tab
entry (a company must actually be selected to need the data).

#### Scenario: Data fetch is deferred

- GIVEN the dashboard has just loaded and neither Congestión surface has
  triggered a load
- WHEN the user opens the Empresa tab's Global sub-tab but has not yet
  selected a company in `#cmp-emp-a`/`#cmp-emp-b`
- THEN no `congestion/*` fetch has been triggered

### Requirement: Graceful Degradation When Company Has No Congestion Data

IF `congestion/empresas.csv` has no row for a selected `account_id`,
`_congBuildCompanyCards` MUST return an empty array, and
`_congRenderKpis([], containerId)` MUST clear that company's card row (no
cards rendered) — the same convention already used by Camión→Congestión's
own Viaje-level view (`_congRenderKpis([])`) — instead of throwing an error
or leaving a stale previous render in place. This is a deliberate change from
the superseded gauge grid, which always rendered six dashed-out (`—`) cards;
an empty card row was judged the more honest degradation for a card system
that can legitimately have zero cards for a company with no data.

#### Scenario: Company without congestion data

- GIVEN `congestion/empresas.csv` has no row for the selected company's
  `account_id`
- WHEN the congestion card row renders
- THEN that company's `.cong-kpi-row` container renders empty, with no error
  dialog or blocking failure

### Requirement: Temporal Integration Is Not Currently Applicable

The frozen `congestion-data-contract` spec defines `congestion/empresas.csv`
(header `account_id,n_veh,km,mecc,iev,rank,hwy_share,peak_share,
calles_top_share,n_comparables,iev_global`) and `congestion/vehiculos.csv`
(header `id_viaje,owner_id,account_id,km_recorridos,mecc_veh_s`) with **no
month/period column in either file**. Therefore no period-dependent
congestion metric currently exists to integrate into the Empresa tab's
Temporal sub-tab. This is a documented fact about the current data contract,
not unbuilt scope — the system MUST NOT invent a synthetic period dimension
to force a Temporal integration. Temporal integration becomes applicable
only if/when a future revision of `congestion-data-contract` adds a
period-dependent congestion field.

#### Scenario: Temporal sub-tab has no congestion content

- GIVEN the current `congestion-data-contract` (no period column on
  `empresas.csv` or `vehiculos.csv`)
- WHEN the user opens the Empresa tab's Temporal sub-tab
- THEN no congestion-specific content is expected or shown there; congestion
  KPIs remain exclusively in the Global sub-tab per this spec

### Requirement: Explicitly Out of Scope (superseded design elements)

The following elements of the original (pre-amendment) sub-tab design are
explicitly OUT OF SCOPE for this integration and MUST NOT be reintroduced
without a new design decision: a dedicated Empresa "Congestión" sub-tab
button/panel; a company-scoped mount of the shared footprint map inside
Empresa; and any dependency on `congestion/referencia.csv`/percentile-gauge
positioning (superseded by Amendment 2 — the card system needs no
distribution reference, unlike the gauge grid it replaced). Camión→
Congestión's own footprint map and drill-down (a separate capability,
`congestion-camion`) are unaffected by this amendment.

Note (Amendment 2): unlike Amendment 1, a rank card (`rank`/`n_comparables`)
IS now part of this integration's card set — see "Company Congestion Cards"
above — because it is part of the shared `_congBuildCompanyCards()` builder
also used by Camión→Congestión's own view, not a separately-designed
"hallazgos" card. `iev_global` also participates, via the IEV `bar` card's
delta line, not as a standalone card.

#### Scenario: No dedicated Empresa Congestión sub-tab exists

- GIVEN the Empresa tab's sub-tab bar (`#sub-tabs-empresa`)
- WHEN the user inspects the available sub-tabs
- THEN only "Global" and "Temporal" are present; no "Congestión" sub-tab
  button or panel exists under Empresa
