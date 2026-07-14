# Delta for temporal-subtab

No formal spec file exists yet for this domain (`openspec/specs/temporal-subtab/spec.md` is absent). The `ADDED Requirements` below establish a baseline of current, unaffected behavior read from `js/temporal.js`. The `REMOVED` section formalizes this change's `hora_salida` de-emphasis.

**Scope decision**: the resolved proposal decision (question round #3) commits only to deleting `_renderHoraChart` — the dedicated always-on chart. It does not commit to removing the `hora_salida` *option* from `#temp-dim-sel`. Per `design.md`'s "Keep `hora_salida` in the dimension selector; delete only the dedicated chart" decision, the selector option is retained: it is opt-in (the user must actively choose it) and is one of several equal choices, so it does not carry the "outsized, always-on prominence" the decision targets. This spec therefore has no `MODIFIED Requirements` section — the evolution chart's dimension set is unchanged (`mes`, `dia_semana`, `hora_salida`), it simply never receives a percentile band for the latter two dimensions (see `temporal-fleet-benchmark`).

## ADDED Requirements

### Requirement: Company and Metric Selection

The Temporal sub-tab MUST let the user select a company (or "Todas las empresas") via `#temp-empresa-sel` and a metric via `#temp-metrica-sel`, populated from ingested `impactos_*.csv` rows. Changing either selector MUST re-render KPIs, evolution chart, día-semana chart, and summary table via `tempApplyFilters()`.

#### Scenario: Selecting a company filters all views

- GIVEN data has been ingested for multiple companies
- WHEN the user selects one company in `#temp-empresa-sel`
- THEN KPIs, the evolution chart, the día-semana chart, and the summary table all recompute using only that company's rows

### Requirement: KPI Summary Cards

The system MUST show four KPI cards for the filtered rows and selected metric: average value, maximum value, count of distinct `mes` with data, and coverage percentage (`pct_cobertura`).

#### Scenario: KPIs computed for filtered data

- GIVEN filtered rows with a selected metric
- WHEN `_renderKPIs` runs
- THEN the four KPI cards show the mean, max, distinct-month count, and coverage percentage for that metric

### Requirement: Evolution Chart with Selectable Dimension

The system MUST render a line chart of the selected metric's average, one series per company shown, grouped by a user-selectable dimension via `#temp-dim-sel`. The available dimensions are `mes`, `dia_semana`, and `hora_salida`, unchanged by this change.

#### Scenario: Evolution by month

- GIVEN dimension = `mes`
- WHEN the evolution chart renders
- THEN the x-axis shows the distinct months present in the filtered data, one line per company shown

#### Scenario: hora_salida remains selectable

- GIVEN the dimension selector `#temp-dim-sel`
- WHEN its options are inspected
- THEN `mes`, `dia_semana`, and `hora_salida` are all present

### Requirement: Día de Semana Distribution Chart

The system MUST render a bar chart of the selected metric's average per `dia_semana`, one series per company shown, always visible regardless of the dimension selector's value.

#### Scenario: Día-semana chart always renders

- GIVEN filtered rows exist
- WHEN `tempApplyFilters` runs
- THEN the día-semana bar chart renders alongside the evolution chart, independent of the dimension selector's value

### Requirement: Summary Table

The system MUST render a table with one row per company, showing average and maximum of the selected metric, distinct month count, average coverage percentage, and average operating hours, sorted descending by average metric value.

#### Scenario: Table sorted by average metric

- GIVEN multiple companies are shown
- WHEN the summary table renders
- THEN rows are sorted descending by the selected metric's average value

## REMOVED Requirements

### Requirement: Hora de Salida Distribution Chart

(Reason: `hora_salida` had outsized prominence via a dedicated, always-rendered `_renderHoraChart` bar chart; the user explicitly requested this always-on chart be removed entirely, not demoted, per the resolved proposal decision. The `hora_salida` option in `#temp-dim-sel` is opt-in and retained — see scope decision above.)
(Migration: None. `_renderHoraChart`, its call site in `tempApplyFilters`, and its `#temp-chart-hora` canvas/card in `index.html` are deleted entirely. No replacement chart or collapsed/secondary view is introduced; the día-semana chart and the evolution chart (still selectable by `mes`, `dia_semana`, or `hora_salida`) remain as the retained temporal views.)
