# Temporal Fleet Benchmark Specification

## Purpose

Cross-company percentile benchmarking of Temporal sub-tab metrics (p/h and GSE/edad breakdowns) against a precomputed fleet-wide distribution, per `mes`. Lets a company see where its metric value sits relative to all companies for the same month, via a percentile band overlaid on the existing evolution chart.

## Requirements

### Requirement: Fleet Reference CSV Schema

The precompute script MUST emit `flota/percentiles_referencia.csv` with exactly these columns, one row per (`mes`, `metrica`) pair: `mes` (integer 1-12), `metrica` (string, one of the 14 `#temp-metrica-sel` value identifiers, e.g. `total_ph`, `gse_ab_ph`, `edad_menor_25_ph`, `total_personas`), `n_empresas` (integer, count of companies contributing to that mes's distribution), `p10`, `p25`, `p50`, `p75`, `p90` (floats — fleet-wide quantiles of `metrica` across all companies for that `mes`). This schema is frozen and MUST NOT change without a new spec revision.

#### Scenario: Script output matches frozen schema

- GIVEN the precompute script has run against `DATA/IMPACTOS/impactos_*.csv`
- WHEN `flota/percentiles_referencia.csv` is opened
- THEN its header is exactly `mes,metrica,n_empresas,p10,p25,p50,p75,p90`
- AND every row has a numeric value in each quantile column

### Requirement: Per-Company Percentile CSV Schema

The precompute script MUST emit `flota/percentiles_empresa.csv` with exactly these columns, one row per (`account_id`, `mes`, `metrica`) triple: `account_id` (string, joins to `_tempData`'s `account_id ?? owner_id`), `mes` (integer), `metrica` (same identifier space as the reference file), `valor` (float, company's mean of `metrica` for that `mes`, zero/NaN rows excluded — same denominator semantics as `_avgBy`), `percentil` (float 0-100, company's percentile rank within the fleet distribution for that `mes`×`metrica`). This schema is frozen and MUST NOT change without a new spec revision. The reference file's `p50` for the same (`mes`, `metrica`) key is the join-time source of the fleet median — it MUST NOT be duplicated as a redundant column in this file.

#### Scenario: Per-company file matches frozen schema

- GIVEN the precompute script has run
- WHEN `flota/percentiles_empresa.csv` is opened
- THEN its header is exactly `account_id,mes,metrica,valor,percentil`

### Requirement: Additive, Non-Blocking Reference Fetch

Temporal MUST fetch both `flota/*.csv` files via `core.js`'s `fetchParseCsv`, as a fetch separate from `temporalIngest(rows)`. This fetch MUST NOT block or delay the initial render of KPIs, evolution chart, día-semana chart, or summary table.

#### Scenario: Reference loads after core view

- GIVEN a company's `impactos_*.csv` has been ingested via `temporalIngest`
- WHEN the Temporal sub-tab first renders
- THEN KPIs, evolution chart, día-semana chart, and table render immediately using existing data
- AND the percentile band appears once the reference fetch resolves, without re-triggering a full re-render of unrelated views

### Requirement: Graceful Degradation When Reference Is Absent

IF either `flota/*.csv` fetch fails or 404s, the benchmark UI (percentile band, percentile labels) MUST be hidden. All other Temporal behavior MUST remain fully functional and unaffected.

#### Scenario: Reference CSV not yet uploaded

- GIVEN `flota/percentiles_referencia.csv` does not exist in R2
- WHEN the Temporal sub-tab loads a company
- THEN the raw evolution chart, KPIs, día-semana chart, and table render normally
- AND no percentile band, error dialog, or blocking message appears

### Requirement: Percentile Band on Evolution Chart

WHEN dimension = `mes` AND a single company is selected (not "Todas las empresas") AND reference data is loaded, the evolution chart MUST render the fleet's p10-p90 band and p50 marker for the selected `metrica`, using the actual `p10`/`p25`/`p50`/`p75`/`p90` values from the reference row per `mes` shown. Parsing these columns without rendering them does not satisfy this requirement (this design MUST NOT repeat Ruido's dead-column pattern).

#### Scenario: Band renders for selected metric and company

- GIVEN reference data is loaded and a single company + `total_ph` + dimension `mes` are selected
- WHEN the evolution chart renders
- THEN a shaded band spans p10-p90 per `mes` on the x-axis
- AND a distinct p50 marker/line is visible within the band

#### Scenario: Band hidden for non-mes dimensions

- GIVEN dimension = `dia_semana` or `hora_salida`
- WHEN the evolution chart renders
- THEN no percentile band is shown, because the fleet reference has no `dia_semana`/`hora_salida` breakout

#### Scenario: Band hidden when all companies selected

- GIVEN "Todas las empresas" is selected
- WHEN the evolution chart renders
- THEN the percentile band MUST NOT render (a fleet-vs-fleet band with multiple overlapping company lines is not a meaningful single-company comparison)
