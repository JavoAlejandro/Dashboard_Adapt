# Design: Fleet Percentiles & Period Comparison for the Temporal Sub-tab

## Technical Approach

Two decoupled halves, per the proposal. **Offline**: a new standalone `Definitos/build_flota_percentiles.py` reads `DATA/IMPACTOS/impactos_*.csv`, computes per-`mes` fleet quantiles and per-company percentile ranks for the 14 Temporal metrics, and emits two long-format CSVs. **In-browser**: `temporal.js` fetches those two CSVs additively via `core.js` `fetchParseCsv` (never through `temporalIngest`), joins them by `mes`+`metrica`(+`account_id`), overlays a percentile band on the existing `_renderEvolChart` Chart.js line chart, and adds a period-A-vs-B comparison card. `_renderHoraChart` and its DOM are deleted. Everything degrades gracefully when the `flota/` CSVs are absent (they will be, until the user uploads them).

Binding decisions 1-7 from the proposal question round are treated as fixed.

## Architecture Decisions

### Decision: CSV shape — long/tidy, not wide
**Choice**: One row per key tuple, with a `metrica` column holding the exact metric identifier.
**Alternatives**: Ruido-style wide (one row per key, 14×5 percentile columns).
**Rationale**: The dashboard renders one selected `metrica` at one `mes` at a time; a `Map` keyed `${mes}|${metrica}` is a trivial O(1) join. Long format keeps the schema stable if metrics are added and avoids a 70-column reference file. The `metrica` values are byte-identical to the existing `#temp-metrica-sel` option values and impactos column names, so no mapping table is needed — this is the main drift-avoidance guarantee for the parallel `sdd-spec` agent to reconcile against.

### Decision: Percentile band via Chart.js Filler (two bounding datasets)
**Choice**: Render the band as three extra line datasets on the existing chart — a lower bound (p10), an upper bound (p90) with `fill: '-1'` (fills toward the dataset one index below → the p10 line), and a dashed p50 median line. Uses only the built-in Filler plugin of the already-vendored Chart.js 4.4.0.
**Alternatives**: a separate chart; a custom canvas plugin; a radial gauge (explicitly rejected by decision 2).
**Rationale**: Zero new dependencies, stays inside the one line chart, honors decision 7 (distribution genuinely rendered). Band only draws when `dim === 'mes'` (reference is per-`mes`) and a single company is selected (percentile is per-company); otherwise it is silently omitted.

### Decision: Band color — neutral muted treatment, not a company hue, no TOKENS edit
**Choice**: Style the band with the chart's existing muted neutrals (`#8a867e` line at ~0.35 alpha, fill `rgba(138,134,126,0.10)`), labeled "Rango flota (p10–p90)" / "Mediana flota (p50)".
**Alternatives**: add a `TOKENS.referenceBand` key; reuse a `companySeriesColors` entry.
**Rationale**: `TOKENS` is `Object.freeze`d and `core.js` is intentionally **not** in the proposal's affected-areas table, so no token is added. A desaturated gray band is visually unmistakable as a reference range next to the saturated brand company lines — it does not read as "another company." Constants live locally in `temporal.js`.

### Decision: Keep `hora_salida` in the dimension selector; delete only the dedicated chart
**Choice**: Delete `_renderHoraChart`, its `#temp-chart-hora` canvas, and its card in `index.html`. **Keep** the `hora_salida` `<option>` in `#temp-dim-sel` and the `hora_salida` branch in `_renderEvolChart`.
**Rationale**: Decision 3 targets the *dedicated, always-on* chart ("outsized prominence"), which is what carried the weight. The selector option is opt-in — the user must actively pick it, and it sits as one of three equal choices, so it does not confer prominence. Removing it would delete a legitimate on-demand view for no benefit and require extra code churn. This satisfies the intent (de-emphasis) while preserving optionality. The band does not apply when `dim === 'hora_salida'`, which is fine.

### Decision: `flota/` fetch triggered from r2.js, owned by temporal.js
**Choice**: `temporal.js` owns the `flota/` path constants and a `temporalLoadFlota()` async loader (cache + graceful-degrade). `r2.js` adds one guarded line in its empresa-load flow — `if (typeof temporalLoadFlota === 'function') temporalLoadFlota();` — so the reference loads in parallel with the empresa CSVs.
**Rationale**: Matches the affected-areas table (r2.js = "new CSV path prefix / trigger"; temporal.js = fetch+render). Keeps r2.js as the fetch orchestrator without letting it reach into temporal state (consistent with the completed refactor's encapsulation).

## Data Flow

```
Definitos/build_flota_percentiles.py   (offline, manual run + manual R2 upload)
   DATA/IMPACTOS/impactos_*.csv
        │  group by account_id,mes → per-company-per-mes mean of each metric
        │  per mes,metrica: quantile([.1,.25,.5,.75,.9]) across companies
        │  per company: percentileofscore within that mes,metrica distribution
        ▼
   flota/percentiles_referencia.csv   flota/percentiles_empresa.csv   → R2

Browser:
   r2.js empresa load ──► temporalIngest(rows)        (PRIMARY render, unchanged)
                    └───► temporalLoadFlota()          (ADDITIVE, non-blocking)
                              │ fetchParseCsv ×2 (Promise.allSettled)
                              ▼
                    _flotaRef Map  +  _flotaEmp Map  ──► re-run tempApplyFilters()
                              │ (on fail/404: flags stay false, band omitted)
                              ▼
   tempApplyFilters ─► _renderEvolChart (+band) ─► _renderTabla ─► _renderPeriodoCmp
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `Definitos/build_flota_percentiles.py` | Create | argparse script; reads `DATA/IMPACTOS/impactos_*.csv`, emits both `flota/*.csv`. Mirrors `build_dashboard_kpis.py` `fleet_reference()`/`percentile_of()` patterns. |
| `js/temporal.js` | Modify | Add `flota/` constants, `temporalLoadFlota()`, `_flotaRef`/`_flotaEmp` caches, band datasets in `_renderEvolChart`, `_renderPeriodoCmp`; **delete** `_renderHoraChart` + its call in `tempApplyFilters`. |
| `js/r2.js` | Modify | One guarded `temporalLoadFlota()` trigger in the empresa-load flow. |
| `index.html` | Modify | Delete `#temp-chart-hora` card; add period-A/B selectors + `#temp-periodo-cmp` card. Keep `hora_salida` option. |
| `css/styles.css` | Modify | Styles for the period-comparison table / delta cells. |
| R2 bucket (manual) | New data | User uploads both `flota/*.csv` out-of-band. |

## Interfaces / Contracts

### `flota/percentiles_referencia.csv` (fleet distribution, per metric per mes)
```
mes, metrica, n_empresas, p10, p25, p50, p75, p90
```
- `mes`: integer 1–12.
- `metrica`: exactly one of the 14 identifiers — `total_ph, gse_ab_ph, gse_c1a_ph, gse_c2_ph, gse_c3_ph, gse_d_ph, gse_e_ph, edad_menor_25_ph, edad_25_34_ph, edad_35_44_ph, edad_45_54_ph, edad_55_64_ph, edad_mayor_65_ph, total_personas`.
- `n_empresas`: company count in that mes's distribution (for degrade/thin-data display).
- `p10…p90`: quantiles of the across-company distribution. One row per (mes, metrica).

### `flota/percentiles_empresa.csv` (per-company rank, per metric per mes)
```
account_id, mes, metrica, valor, percentil
```
- `account_id`: company id (string-safe join; matches `_tempData` `account_id ?? owner_id`).
- `valor`: that company's mean of `metrica` over its rows in that `mes`.
- `percentil`: 0–100 rank of `valor` within the (mes, metrica) fleet distribution.

### Dashboard join maps (temporal.js)
```
_flotaRef : Map "${mes}|${metrica}"                → {p10,p25,p50,p75,p90,n_empresas}
_flotaEmp : Map "${account_id}|${mes}|${metrica}"  → {valor, percentil}
```

### Python aggregation logic (implementer-level)
```
df = concat(read impactos_*.csv)
# 1 per-company-per-mes metric mean
g = df.groupby(['account_id','mes'])[METRICS].mean().reset_index()
# 2 reference: for each mes,metric → quantiles across companies
for mes, sub in g.groupby('mes'):
    for m in METRICS:
        s = sub[m].dropna(); s = s[s > 0]           # ignore zeros (matches _avgBy)
        emit ref row: mes,m,len(s), s.quantile([.1,.25,.5,.75,.9])
# 3 per-company percentile within that same distribution
        for aid, val in zip(sub['account_id'], sub[m]):
            pct = scipy/manual percentileofscore(s, val)   # or rank-based
            emit emp row: aid,mes,m,val,pct
```
Zero/NaN handling mirrors the dashboard's `_avgBy` (only `v > 0` counted) so `valor` and the band share the same denominator semantics.

## Period-A-vs-B Comparison UI

- New controls inside `#temp-content` (a `temp-periodo-card` after the tabla), visible **only when a single company is selected** (self-comparison needs one company; hidden when `empresa === 'all'`).
- Two `<select>`: `#temp-periodo-a`, `#temp-periodo-b`, populated from the `mes` values present for the selected company (labels via `MESES_LBL`).
- `_renderPeriodoCmp(rows, empresa)` renders a table reusing `_renderTabla`'s row shape, **doubled by period**, one row per metric:

| Métrica | Mes A valor | pctl A | Mes B valor | pctl B | Δ valor |
|---------|-------------|--------|-------------|--------|---------|

- `valor`/`pctl` read from `_flotaEmp` when loaded; otherwise `valor` is computed inline from `_tempData` (`_avgBy` over that company+mes) and `pctl` shows `—`. Δ shown with a direction arrow (↑/↓) and polarity coloring.
- **Polarity (resolved 2026-07-14)**: higher p/h is **worse** (these are exposure/impact metrics — more people/hour affected is a worse outcome) — an increase from Mes A to Mes B renders red, a decrease renders green, applied uniformly across all 14 metrics (`total_ph`, `gse_*_ph`, `edad_*_ph`, `total_personas`).

## `hora_salida` Removal — exact targets

- `js/temporal.js`: delete `_renderHoraChart` (lines ~238–267) and its call in `tempApplyFilters` (line 77).
- `index.html`: delete the second column of `.temp-charts-2col` — the card containing `<canvas id="temp-chart-hora">` (lines ~759–765). Promote "Por día de semana" to full width or keep the 2-col grid with the band-explainer as the second cell (implementer choice; tasks to specify).
- **Keep**: `#temp-dim-sel` `hora_salida` option (line 722) and the `hora_salida` branch in `_renderEvolChart` (lines ~161–165, 180).

## Testing Strategy

No test runner exists anywhere in this repo (confirmed). Manual in-browser checklist:

| # | Scenario | Expected |
|---|----------|----------|
| 1 | Both `flota/*.csv` present, single company, `dim=mes` | p10–p90 gray band + dashed p50 render behind the company line; band label reads as fleet reference, not a company. |
| 2 | Switch `metrica` and `mes`-based company | Band updates to the selected metric; values plausible vs company line. |
| 3 | `flota/*.csv` absent / 404 | No console error; company line + KPIs + tabla render exactly as today; band simply not drawn. |
| 4 | `dim=dia_semana` or `hora_salida` | No band drawn (per-mes only); chart otherwise normal. |
| 5 | Single company, pick Mes A + Mes B | Comparison table shows both periods per metric with directional Δ; increase renders red, decrease renders green, consistently across all 14 metrics. |
| 6 | `empresa=all` | Period-comparison card hidden. |
| 7 | Whole tab | `#temp-chart-hora` canvas/card gone; `hora_salida` still selectable in "Ver por"; no console errors. |

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or process-integration boundary. The Python script is a standalone offline batch job with no callers in the dashboard; the dashboard performs only additive read-only `fetchParseCsv` GETs against the existing authenticated R2 proxy.

## Migration / Rollout

No migration. The `flota/*.csv` files are additive R2 data uploaded manually by the user; the dashboard runs in graceful-degradation (raw) state until they exist. Rollback = revert the branch; no persisted state or schema change.

## Open Questions — RESOLVED

- [x] Δ polarity semantics for period comparison: **higher p/h = worse** (confirmed by user 2026-07-14). Increase → red, decrease → green, uniform across all metrics.
- [x] Percentile-rank method in Python: **pure pandas** (`rank(pct=True)` or equivalent) — confirmed no sibling script in `Definitos/` imports `scipy`, and no `requirements.txt` exists there; adding scipy would be a new, unnecessary dependency.
