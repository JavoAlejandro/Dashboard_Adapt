# Temporal Period Comparison Specification

## Purpose

Same-company period-A-vs-period-B self-comparison in the Temporal sub-tab. Lets a company place two `mes` values side by side and read whether a metric improved or worsened, using the raw per-company data already ingested via `temporalIngest` — no fleet reference dependency.

## Requirements

### Requirement: Period Selectors Scoped to One Company

The Temporal sub-tab MUST offer two period selectors ("Periodo A", "Periodo B"), each populated with the distinct `mes` values present in `_tempData` for the currently selected company. The comparison UI MUST be available only when a single company (not "Todas las empresas") is selected. Comparison scope is limited to two `mes` values of the same company; no `dia_semana` crossing.

#### Scenario: Selectors populate from company's own months

- GIVEN a single company is selected and its data spans months 3, 4, 5
- WHEN the period-comparison UI renders
- THEN Periodo A and Periodo B selectors each list 3, 4, 5 as options

#### Scenario: Comparison hidden for "all companies"

- GIVEN "Todas las empresas" is selected
- WHEN the Temporal sub-tab renders
- THEN the period-comparison UI is hidden or disabled

### Requirement: Per-Metric Comparison Output, All Temporal Metrics

WHEN Periodo A and Periodo B are both selected and differ, the system MUST display, for every metric in `#temp-metrica-sel` (not only the currently-selected one), the selected company's average value for each period and the delta (B minus A), computed from already-ingested raw rows (no new fetch required). WHEN fleet reference data (`temporal-fleet-benchmark`) is loaded, the row MAY additionally show each period's fleet percentile rank (`percentil` from `flota/percentiles_empresa.csv`); this is an enhancement, not a precondition — the comparison MUST work using only raw `_tempData` when reference data is absent.

#### Scenario: Two distinct periods selected

- GIVEN Periodo A = mes 3 and Periodo B = mes 5 for company X
- WHEN the comparison renders
- THEN it shows, per metric, company X's average for mes 3, for mes 5, and the delta between them

#### Scenario: Percentile columns present when reference data is loaded

- GIVEN `flota/percentiles_empresa.csv` is loaded and Periodo A/B are selected
- WHEN the comparison renders
- THEN each metric row additionally shows the fleet percentile rank for mes A and mes B

#### Scenario: Comparison works when reference data is absent

- GIVEN `flota/percentiles_empresa.csv` has not loaded (absent/404)
- WHEN the comparison renders
- THEN per-metric averages and deltas still render using raw `_tempData`; percentile columns are omitted or shown as unavailable

### Requirement: Directional Delta Display With Impact Polarity

The delta (B minus A) MUST be shown with a direction indicator (e.g. an up/down arrow) and its signed magnitude. The system MUST apply impact-polarity styling: since these are exposure/impact metrics (p/h, personas), a higher value is a **worse** outcome and MUST render in a "negative" color (e.g. red); a lower value is a **better** outcome and MUST render in a "positive" color (e.g. green). This polarity is uniform across all 14 metrics (`total_ph`, `gse_*_ph`, `edad_*_ph`, `total_personas`) — resolved by the user on 2026-07-14.

#### Scenario: Delta shown with worse-is-higher polarity

- GIVEN Periodo B's average is higher than Periodo A's average for a metric
- WHEN the comparison renders
- THEN the delta shows an upward direction indicator, its magnitude, and "negative"/worse styling (e.g. red)

#### Scenario: Delta shown with better-is-lower polarity

- GIVEN Periodo B's average is lower than Periodo A's average for a metric
- WHEN the comparison renders
- THEN the delta shows a downward direction indicator, its magnitude, and "positive"/better styling (e.g. green)

#### Scenario: Same period selected twice

- GIVEN Periodo A and Periodo B are set to the same `mes`
- WHEN the comparison would render
- THEN the system MUST show a zero/no-change state rather than a directional indicator
