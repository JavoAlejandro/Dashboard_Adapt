# Tasks: Fleet Percentiles & Period Comparison for the Temporal Sub-tab

Two decoupled halves, two different projects/languages, one shared frozen data contract
(`flota/percentiles_referencia.csv`, `flota/percentiles_empresa.csv`). No code-level
interdependency — the dashboard half must be independently testable via graceful
degradation before the CSVs exist in R2.

Requirement-ID legend used in the "Spec link" column:
- `FB-n` = `specs/temporal-fleet-benchmark/spec.md`, Requirement #n in file order
- `PC-n` = `specs/temporal-period-comparison/spec.md`, Requirement #n in file order
- `ST-n` = `specs/temporal-subtab/spec.md`, Requirement #n in file order (ADDED/REMOVED)

---

## Work Unit A — Python precompute script (`Definitos/`)

Independently verifiable offline. No dashboard dependency. Suggested as its own PR
(different language/project, no shared reviewers needed with Work Unit B).

### A1. Scaffold `Definitos/build_flota_percentiles.py` [x]
- Create the new standalone script file (confirmed name/location: `design.md` File
  Changes table, "Python script location" resolved decision in `proposal.md`).
- argparse-driven, mirroring `DATA/RUIDO/.../build_dashboard_kpis.py`'s CLI shape
  (`--out-dir`, `--format` optional, `--impactos-glob` or similar input override).
- Input resolution: glob `DATA/IMPACTOS/impactos_*.csv` relative to repo root (confirmed
  path convention from `Definitos/publicar_rutas.py`'s `--impactos ../DATA/IMPACTOS/impactos_<N>.csv`
  usage — script runs from `Definitos/`, so default glob is `../DATA/IMPACTOS/impactos_*.csv`
  with a `--impactos-glob` override for portability).
- Declare the frozen `METRICS` list of exactly the 14 identifiers (verbatim from the
  proposal's frozen contract): `total_ph, gse_ab_ph, gse_c1a_ph, gse_c2_ph, gse_c3_ph,
  gse_d_ph, gse_e_ph, edad_menor_25_ph, edad_25_34_ph, edad_35_44_ph, edad_45_54_ph,
  edad_55_64_ph, edad_mayor_65_ph, total_personas`.
- No new dependency beyond `pandas` (already used by sibling scripts); explicitly do
  **not** import `scipy` (resolved decision, `design.md` Open Questions — RESOLVED #2).
- Spec link: `FB-1`, `FB-2` (schema-bearing script), `proposal.md` Dependencies section.
- Parallel: yes, standalone with A2/A3 (same file, but can be scaffolded before logic lands).

### A2. Implement per-company-per-mes aggregation + fleet quantiles [x]
- `df = pd.concat([pd.read_csv(f) for f in glob(...)])`.
- `g = df.groupby(['account_id','mes'])[METRICS].mean().reset_index()` — matches
  `design.md`'s "Python aggregation logic" pseudocode.
- Zero/NaN handling: drop NaN and `v <= 0` per metric **before** computing quantiles,
  mirroring the dashboard's `_avgBy` semantics (`js/temporal.js:112-126`, `v > 0` filter)
  — this is called out explicitly in `design.md` line 107 as a cross-language contract
  that must match so `valor` and the band share the same denominator.
- For each `(mes, metrica)`: `s.quantile([.1,.25,.5,.75,.9])`, `n_empresas = len(s)`.
  Reuse the `fleet_reference()`-style helper pattern from `build_dashboard_kpis.py:122-137`
  (round to a sane precision, e.g. 2 decimals — reference script uses 4).
- Emit `flota/percentiles_referencia.csv` with header exactly
  `mes,metrica,n_empresas,p10,p25,p50,p75,p90` (frozen, `FB-1`).
- Spec link: `FB-1` (Fleet Reference CSV Schema + its scenario).
- Depends on: A1.
- Parallel: no (sequential after A1, shares the aggregation dataframe with A3).

### A3. Implement per-company percentile rank (pure pandas, no scipy) [x]
- Within each `(mes, metrica)` group, compute each company's percentile rank via
  pandas `rank(pct=True) * 100` (or an equivalent `(s <= value).mean() * 100` pattern
  — deliberately choose one and document it in the script's own docstring; either
  satisfies "pure pandas" per `design.md` Open Questions — RESOLVED #2).
- Emit `flota/percentiles_empresa.csv` with header exactly
  `account_id,mes,metrica,valor,percentil` (frozen, `FB-2`) — do **not** add a
  redundant fleet-`p50` column here (explicitly disallowed by `FB-2`'s requirement text:
  "MUST NOT be duplicated as a redundant column in this file").
- `account_id` must be string-safe (join key matches `_tempData`'s
  `account_id ?? owner_id`, per `design.md` Interfaces section) — cast to `str` before
  writing.
- Spec link: `FB-2` (Per-Company Percentile CSV Schema + its scenario).
- Depends on: A2 (same aggregation dataframe `g`).
- Parallel: no (sequential after A2; same script file, same run).

### A4. Manual verification pass — script output [x]
- Run the script locally against the existing `DATA/IMPACTOS/impactos_*.csv`.
- Verify: (a) both output files exist with exactly the frozen headers (byte-for-byte
  column names/order — `FB-1`, `FB-2` scenarios); (b) row counts are sane — reference
  file has one row per distinct `(mes, metrica)` pair actually present in the data,
  per-company file has one row per `(account_id, mes, metrica)` triple; (c) spot-check
  one known company/mes/metrica by hand (compute the mean manually from the source CSV,
  compare to `valor`, and sanity-check `percentil` against the reference row's
  `p10`-`p90` band for that same key — the value's relative position should roughly
  match the reported percentile); (d) no `NaN`/empty cells in numeric columns; (e) all
  14 metric identifiers appear (no typo drift from `#temp-metrica-sel`).
- No test runner exists for this script — this is the entirety of its verification
  (per proposal/design's explicit call-out that manual inspection is the checklist).
- Spec link: `FB-1`, `FB-2` scenarios.
- Depends on: A3.
- Parallel: no (final step of Work Unit A).

---

## Work Unit B — Dashboard fetch + graceful degradation (`dashboard_r2`)

Must be fully testable **without** the `flota/*.csv` files existing in R2 yet (the
graceful-degradation path is the default state until the user uploads them). Blocks
Work Unit C (band) and Work Unit D (period comparison) at the code level, since both
consume `_flotaRef`/`_flotaEmp`. Independent of Work Unit A's actual completion —
only depends on the frozen schema, not the generated data.

### B1. Add `flota/` path constants + `temporalLoadFlota()` loader in `js/temporal.js` [x]
- Add two path constants (`flota/percentiles_referencia.csv`,
  `flota/percentiles_empresa.csv`) local to `temporal.js` — do **not** touch `TOKENS`
  in `core.js` (frozen object, explicitly out of scope per `design.md`'s "no TOKENS
  edit" decision).
- Add `_flotaRef` (`Map` keyed `"${mes}|${metrica}"`) and `_flotaEmp` (`Map` keyed
  `"${account_id}|${mes}|${metrica}"`) module-level caches, initialized empty —
  matches `design.md`'s "Dashboard join maps" section exactly.
- Add `temporalLoadFlota()`: `Promise.allSettled([fetchParseCsv(refPath),
  fetchParseCsv(empPath)])`; on each fulfilled result, populate the corresponding Map;
  on rejection (404/network error), leave that Map empty — no thrown error, no console
  error spam (a single `console.info`/debug-level note is fine, not `console.error`).
- After both settle (success or failure), re-run `tempApplyFilters()` if data has
  already been ingested (`_tempData.length`) so the band/percentile columns pick up
  without a full page reload — matches `design.md`'s Data Flow diagram
  ("re-run tempApplyFilters()").
- This fetch is **additive and non-blocking**: it must not be awaited by
  `temporalIngest()` or `tempApplyFilters()`'s primary render path.
- Spec link: `FB-3` (Additive, Non-Blocking Reference Fetch).
- Parallel: no (foundation for B2-B4 and all of Work Units C/D).

### B2. Wire the trigger in `js/r2.js` [x]
- In `_empresaSourceIngest` (or immediately after the `temporalIngest` call around
  `js/r2.js:252-258`), add one guarded line:
  `if (typeof temporalLoadFlota === 'function') temporalLoadFlota();` — matches
  `design.md`'s exact "Decision: `flota/` fetch triggered from r2.js, owned by
  temporal.js" mechanism. Keep it a fire-and-forget call (no `await`), consistent with
  the additive/non-blocking requirement.
- Do not let `r2.js` reach into `temporal.js`'s `_flotaRef`/`_flotaEmp` state directly —
  same encapsulation boundary already documented at `js/r2.js:240-245` for
  `temporalIngest`.
- Spec link: `FB-3`.
- Depends on: B1.
- Parallel: no.

### B3. Graceful-degradation verification (testable before real data exists) [x] (code-trace + user-confirmed in-browser 2026-07-14)
- Manual test, R2 CSVs absent/404 (the current real state): load an empresa, confirm
  KPIs/evolution chart/día-semana chart/tabla render exactly as they do today, no
  console error, no blocking UI, `_flotaRef`/`_flotaEmp` remain empty Maps.
- Confirmed by user in-browser: Empresa → Temporal renders identically to pre-Work-Unit-B
  behavior with the `flota/*.csv` files still absent from R2.
- This is `design.md` Testing Strategy scenario **#3** and spec scenario `FB-4`
  ("Reference CSV not yet uploaded") — explicitly callable now, independent of whether
  Work Unit A has actually been run/uploaded.
- Spec link: `FB-4` (Graceful Degradation When Reference Is Absent).
- Depends on: B2.
- Parallel: no (closes out Work Unit B before B4/C/D build on top of it).
- **Verification note (2026-07-14)**: code-path traced — `r2Fetch` rejects on
  any non-2xx (`if (!res.ok) throw new Error('HTTP ' + res.status)`, `core.js:73`),
  which propagates through `fetchParseCsv`'s promise chain and is caught by
  `Promise.allSettled` inside `temporalLoadFlota()`; the corresponding Map
  (`_flotaRef`/`_flotaEmp`) is simply left at its initial empty value, a
  `console.info` (not `console.error`) is logged, and `tempApplyFilters()` is
  only re-invoked if `_tempData.length` — no code path reads `_flotaRef`/
  `_flotaEmp` yet (Work Units C/D not landed), so there is nothing downstream
  that could crash on empty Maps. Empirically confirmed live network
  reachability to the deployed Worker (`curl` → `403` on
  `flota/percentiles_referencia.csv`, matching `r2Fetch`'s explicit
  `TOKEN_INVALIDO` branch) but could **not** empirically confirm the specific
  404-for-missing-file case, since no valid bearer token was available in this
  session to get past the auth gate first. Full in-browser confirmation
  (KPIs/evolution/día-semana/tabla render unaffected, zero console errors,
  with a real token and the current real R2 state where `flota/*.csv` do not
  exist) remains for the user to do, same as PR3 of the prior
  `restructure-empresa-panel` change.

### B4. (Optional, low-risk) Local fixture test with hand-written sample CSVs
- To validate B1-B2's happy path without waiting on Work Unit A/the manual R2 upload,
  hand-author two tiny sample CSVs matching the frozen schema (a handful of rows) and
  temporarily point the fetch at them (or drop them at the real `flota/` path if the
  local dev R2 proxy serves from a local folder) to confirm the Maps populate and
  `tempApplyFilters()` re-runs without error. Discard/do not commit the fixture files.
- Spec link: `FB-3` (Scenario: Reference loads after core view).
- Depends on: B3.
- Parallel: yes (can run in parallel with early parts of C/D once B1-B3 land, since
  it only exercises the loader, not the renderers).

---

## Work Unit C — Percentile band overlay on the evolution chart (`js/temporal.js`)

### C1. Add band datasets to `_renderEvolChart` [x]
- Inside `_renderEvolChart` (`js/temporal.js:147-208`), after computing the existing
  per-company `datasets` array, conditionally prepend/append three extra Chart.js line
  datasets **only when** `dim === 'mes'` **and** exactly one company is selected
  (`empsToShow.length === 1`, i.e. `empresa !== 'all'`) **and** `_flotaRef` has at
  least one matching key for the current `metrica`/months shown:
  - p10 line (lower bound), no fill.
  - p90 line (upper bound), `fill: '-1'` (fills toward the p10 dataset one index
    below it, per `design.md`'s exact Filler-plugin mechanism) — order these two
    consecutively in the `datasets` array for the relative-index fill to resolve
    correctly.
  - p50 dashed median line (`borderDash: [4,3]` or similar), no fill, drawn on top.
  - Build each point by looking up `_flotaRef.get(`${mes}|${metrica}`)` for every
    `mes` label already on the x-axis; `null` for months with no reference row
    (`spanGaps: true`, consistent with the existing company lines).
- Use the neutral muted styling `design.md` specifies verbatim: line `#8a867e` at
  ~0.35 alpha, fill `rgba(138,134,126,0.10)` — local constants in `temporal.js`, not a
  `TOKENS` addition.
- Label the two boundary/median datasets `"Rango flota (p10–p90)"` /
  `"Mediana flota (p50)"` (chart legend, per `design.md`).
- Ensure `Chart.js`'s Filler plugin is active (it's a built-in plugin of the already
  vendored Chart.js 4.4.0 per `design.md` — confirm no separate registration is needed
  or add the one-line `Chart.register(Filler)`/global default if the vendored build
  requires explicit registration; check the vendored bundle before assuming tree-shaken
  builds include it by default).
- Spec link: `FB-5` (Percentile Band on Evolution Chart) and its 3 scenarios
  (band renders; band hidden for non-mes dimensions; band hidden when all companies
  selected).
- Depends on: B1-B3 (needs `_flotaRef` populated, tested against both absent and
  present states).
- Parallel: no (single-file, single-function change; sequential to avoid merge
  conflicts with C2/D work in the same file).

### C2. Manual verification — band rendering [x] (code-trace verified only; no live/empirical render, see note)
- Scenario 1 (design.md Testing Strategy): both `flota/*.csv` present (use the B4
  fixture or real uploaded data if available by this point), single company,
  `dim=mes` → gray band + dashed p50 render behind the company line, clearly reads as
  reference not a company series.
- Scenario 2: switch `metrica` and confirm the band updates to match; switch back to
  `dim=dia_semana` or `hora_salida` → band disappears (scenario 4).
- Scenario: select "Todas las empresas" → band does not render (`FB-5` "Band hidden
  when all companies selected" scenario).
- Spec link: `FB-5` scenarios; `design.md` Testing Strategy #1, #2, #4.
- Depends on: C1.
- Parallel: no.
- **Verification note (2026-07-14)**: `node --check js/temporal.js` passes. The
  gating logic (`dim === 'mes' && empsToShow.length === 1 && _flotaRef.size`) was
  code-traced, not run against real reference data, since `flota/*.csv` are still
  absent from R2 (same real state as Work Unit B) — no valid token/data was
  available in this session to exercise the happy path live, and the B4 fixture
  was not built as part of this work unit (out of scope per the assigned Work
  Unit C task list; B4 is itself optional/unstarted). Traced instead:
  (a) `_flotaRef.size === 0` (current real state) short-circuits the `&&` before
  the `.map`/`.some` band-building code ever runs, so `datasets` is left exactly
  as the pre-existing per-company array — zero extra/empty/broken dataset
  entries, existing company line(s) render unchanged, consistent with Work Unit
  B's confirmed degradation behavior; (b) `dim !== 'mes'` (`dia_semana` /
  `hora_salida`) short-circuits the same condition regardless of `_flotaRef`
  contents — band never built; (c) `empresa === 'all'` (or any multi-company
  selection) makes `empsToShow.length !== 1`, short-circuiting the condition —
  band never built; (d) even if `_flotaRef` were hypothetically populated but had
  no key matching the current `metrica` across the `mes` values on screen,
  `hasBand` (`refPoints.some(p => p != null)` ) evaluates false and the
  `datasets.unshift(...)` call is skipped — no null-filled band datasets are ever
  added. Band-with-real-data visual rendering (gray band + dashed p50 actually
  drawn, legend dedup behavior, values plausible across `metrica`/`mes`
  switches) remains genuinely untested and requires the user to upload
  `flota/percentiles_referencia.csv` (and ideally `flota/percentiles_empresa.csv`
  for consistency, though C1 only reads the reference file) to R2 first — same
  category of outstanding verification as B3's live in-browser confirmation.

---

## Work Unit D — Period-A-vs-B comparison UI (`js/temporal.js` + `index.html`)

### D1. Add `#temp-periodo-a` / `#temp-periodo-b` selectors + comparison card markup in `index.html`
- Add a new `temp-periodo-card` block inside `#temp-content`, after the tabla card
  (`index.html` around line 774-776, i.e. right after `</div>` closing `#temp-tabla`'s
  parent `.temp-chart-card` and before the closing `</div>` of `#temp-content`).
- Two `<select>` elements (`#temp-periodo-a`, `#temp-periodo-b`) with an `onchange`
  handler calling a new render function (see D2); populated dynamically from JS, not
  hardcoded `<option>`s (values depend on the selected company's available months).
- A results container (e.g. `#temp-periodo-cmp`) for the comparison table.
- Card visibility: hidden by default via inline `style="display:none"` or a CSS class,
  toggled from JS when `empresa !== 'all'`.
- Spec link: `PC-1` (Period Selectors Scoped to One Company) and its scenarios.
- Parallel: yes (markup-only, can be authored alongside C1 in a different file with no
  conflict).

### D2. Implement `_renderPeriodoCmp` + selector population in `js/temporal.js`
- New function, populate `#temp-periodo-a`/`#temp-periodo-b` `<option>`s from the
  distinct `mes` values present in `_tempData` for the currently selected company
  (labels via existing `MESES_LBL`) — called whenever `tempApplyFilters()` runs and
  `empresa !== 'all'`; hide/clear the card entirely when `empresa === 'all'`
  (`PC-1` "Comparison hidden for all companies" scenario).
- On period selection (both A and B set), render a table with **all 14 metrics** from
  `#temp-metrica-sel` (not just the currently-selected `metrica` — `PC-2` explicitly
  requires "every metric ... not only the currently-selected one"), one row per metric:
  `Métrica | Mes A valor | pctl A | Mes B valor | pctl B | Δ valor`.
- `valor` for each period: reuse `_avgBy`-equivalent logic filtered to the selected
  company + that `mes` (same `v > 0` semantics as `_avgBy`, `js/temporal.js:112-126`)
  computed inline from `_tempData` — this must work with **zero** dependency on
  `_flotaEmp` (`PC-2` "Comparison works when reference data is absent" scenario).
- `pctl` for each period: read from `_flotaEmp.get(`${account_id}|${mes}|${metrica}`)`
  when present; render as `—`/"no disponible" when `_flotaEmp` is empty or the key is
  missing (`PC-2` "Percentile columns present when reference data is loaded" scenario
  vs the absent-data scenario — both must be handled by the same function, not two
  separate code paths that drift).
- Δ = Mes B valor − Mes A valor, per metric. Render with a direction indicator
  (↑/↓) and signed magnitude.
- **Polarity (resolved)**: apply uniformly across all 14 metrics — Δ > 0 (increase,
  B higher than A) → "worse" styling (red); Δ < 0 (decrease) → "better" styling
  (green); Δ === 0 → neutral/no-change state, no directional arrow (`PC-3`'s "Same
  period selected twice" scenario, and more generally any zero-delta row).
- Spec link: `PC-2` (Per-Metric Comparison Output, All Temporal Metrics), `PC-3`
  (Directional Delta Display With Impact Polarity) and all their scenarios.
- Depends on: D1 (DOM elements must exist), B1-B3 (for the optional `pctl` columns —
  but must degrade correctly per `PC-2` when absent, so this is a soft dependency:
  D2's raw-value path can be built and tested before B1-B3 lands, but the percentile
  columns need it).
- Parallel: no (single function, sequential authoring recommended to keep the
  raw-path and percentile-path consistent in one pass).

### D3. Wire `_renderPeriodoCmp` into the filter/re-render flow
- Call the selector-population step from `tempApplyFilters()` (so switching company
  refreshes available months) and call the actual comparison render whenever both
  selects have values, on their own `onchange` (not gated behind the full
  `tempApplyFilters()` — the raw-`_tempData` comparison doesn't need `metrica`/`dim`
  filter state, but should still respect the currently-selected company).
- Ensure this also gets a repaint when `temporalLoadFlota()` resolves late (percentile
  columns should appear without requiring the user to reselect periods) — same
  "re-run" hook described in B1/`design.md`'s Data Flow diagram
  (`_renderEvolChart (+band) ─► _renderTabla ─► _renderPeriodoCmp`).
- Spec link: `PC-1`, `PC-2`.
- Depends on: D2.
- Parallel: no.

### D4. Manual verification — period comparison
- Single company, pick Mes A + Mes B → table shows all 14 metrics, correct deltas,
  red-on-increase/green-on-decrease consistently (`design.md` Testing Strategy #5).
- `empresa=all` → card hidden (`design.md` Testing Strategy #6, `PC-1` scenario).
- With `flota/*.csv` absent → raw comparison still renders, `pctl` columns show
  unavailable state, no errors (`PC-2` scenario).
- With `flota/*.csv` present (fixture or real) → `pctl` columns populate for both
  periods (`PC-2` scenario).
- Same Mes selected for both A and B → zero/no-change state, no arrow (`PC-3`
  scenario).
- Spec link: `PC-1`, `PC-2`, `PC-3` scenarios; `design.md` Testing Strategy #5, #6.
- Depends on: D3.
- Parallel: no.

---

## Work Unit E — `hora_salida` chart removal (lowest risk, sequence-flexible)

Can run any time after Work Unit B lands (no functional dependency on C/D) but is
sequenced last per the requested ordering since it's the lowest-risk, most mechanical
change and benefits from a stable file to diff against.

### E1. Delete `_renderHoraChart` and its call site in `js/temporal.js`
- Delete the `_renderHoraChart` function body (`js/temporal.js:238-267`).
- Delete its call in `tempApplyFilters` (`js/temporal.js:77`,
  `_renderHoraChart(filtered, metrica);`).
- **Do not touch**: the `hora_salida` branch inside `_renderEvolChart`
  (`js/temporal.js:161-165, 180` — the `else` branch building `horas`/`labels`/
  `groupFn` for the evolution chart) — this stays, per `design.md`'s "Keep
  `hora_salida` in the dimension selector" decision and `ST` spec's explicit
  "no MODIFIED Requirements" scope note.
- Spec link: `ST-REMOVED-1` (Hora de Salida Distribution Chart, REMOVED Requirement).
- Parallel: yes (isolated deletion, no dependency on C/D's additions to the same
  file beyond avoiding literal line-range merge conflicts — do this in its own
  small commit/diff to keep the removal easy to review in isolation).

### E2. Delete `#temp-chart-hora` card in `index.html`
- Delete the second column of `.temp-charts-2col` — the card containing
  `<canvas id="temp-chart-hora">` (`index.html:759-765`).
- Implementer choice per `design.md`: either promote "Por día de semana" to full
  width (drop the 2-col grid entirely for that section) or keep the 2-col grid with
  a second cell (e.g. a short band/reference explainer, or just leave it 1-col).
  Recommendation: simplest and lowest-risk is dropping `.temp-charts-2col` down to a
  single full-width `.temp-chart-card` for "Por día de semana" — avoids introducing
  new filler content not requested by any spec requirement.
- **Do not touch**: `#temp-dim-sel`'s `hora_salida` `<option>` (`index.html:722`) —
  stays exactly as-is.
- Spec link: `ST-REMOVED-1`.
- Depends on: E1 (do both halves of the deletion together to avoid an intermediate
  broken state where the canvas element is gone but the JS still tries to
  `getContext('2d')` on it, or vice versa).
- Parallel: no.

### E3. Manual verification — removal + retained option
- `#temp-chart-hora` canvas/card is gone from the DOM; no console error referencing
  a missing canvas (`document.getElementById('temp-chart-hora').getContext` would
  throw if E1/E2 are done out of order — confirm no such error).
- `hora_salida` is still present and selectable in `#temp-dim-sel` ("Ver por"); the
  evolution chart still renders correctly when it's selected.
- Spec link: `ST-REMOVED-1` scenario is implicit (no formal scenario block in the
  REMOVED section, but its Migration note is the acceptance bar); `ST-3`'s "hora_salida
  remains selectable" scenario (ADDED Requirements, Evolution Chart with Selectable
  Dimension) is the explicit spec scenario to check.
- Depends on: E2.
- Parallel: no.

---

## Work Unit F — CSS (`css/styles.css`)

### F1. Band legend/label styling
- Any label/legend styling needed beyond what Chart.js's built-in legend renders for
  the `"Rango flota (p10–p90)"` / `"Mediana flota (p50)"` datasets (e.g. a small
  caption under the chart clarifying it's a fleet reference, not a company, if the
  implementer decides the chart legend alone isn't sufficiently clear).
- Spec link: `FB-5` (supports its "renders as fleet reference, not a company" bar,
  `design.md` Testing Strategy #1's expected outcome text).
- Depends on: C1 (needs to know the final dataset/label shape before styling).
- Parallel: yes (independent of D's table styling).

### F2. Period-comparison table + delta polarity coloring
- Table styling for `#temp-periodo-cmp` — reuse `.temp-table`'s existing conventions
  (`css/styles.css:1194-1210`: header/row/`td-num`/`td-accent` patterns) rather than
  inventing a parallel table style from scratch.
- Two new utility classes (or reuse `td-accent`-style naming) for delta polarity:
  a "worse" red class and a "better" green class, applied to the Δ cell per D2's
  polarity logic. Also style the zero/no-change state distinctly (neutral, no arrow).
- Spec link: `PC-3` (all three scenarios — worse-is-higher red, better-is-lower green,
  same-period zero state).
- Depends on: D2 (needs the final cell/class structure `_renderPeriodoCmp` emits).
- Parallel: yes (independent of F1).

---

## Work Unit G — Final full manual verification pass

Maps directly to `design.md`'s Testing Strategy table (7 scenarios). Run after all
other work units land, on the full merged `dashboard_r2` branch state.

### G1. Run all 7 `design.md` Testing Strategy scenarios end-to-end
1. Both `flota/*.csv` present, single company, `dim=mes` → band + p50 render correctly,
   reads as reference not a company.
2. Switch `metrica` and `mes` → band updates plausibly.
3. `flota/*.csv` absent/404 → no console error, rest of Temporal unaffected, no band.
4. `dim=dia_semana` or `hora_salida` → no band, chart otherwise normal.
5. Single company, Mes A + Mes B → comparison table, correct directional/polarity Δ
   across all 14 metrics.
6. `empresa=all` → period-comparison card hidden.
7. Whole tab → `#temp-chart-hora` gone, `hora_salida` still selectable, no console
   errors anywhere in the sub-tab.
- Also re-confirm load order is intact: `core.js → r2.js → gps.js → animation.js →
  comparativas.js → temporal.js → h3overlay.js → ruido.js → init.js` (no new
  `<script>` reordering was introduced by any task above).
- Spec link: all of `FB-*`, `PC-*`, `ST-*` scenarios (cross-cutting closure check).
- Depends on: B-F all complete.
- Parallel: no (final gate).

---

## Review Workload Forecast

| Work Unit | Files touched | Est. changed lines | Risk tier | Suggested lens (if triggered) |
|---|---|---|---|---|
| A (Python script) | 1 new file (`Definitos/build_flota_percentiles.py`) | ~150-220 | Standard | `review-reliability` (data transform correctness, no automated tests) |
| B (fetch + degrade) | `js/temporal.js`, `js/r2.js` | ~40-60 | Standard | `review-resilience` (partial failure / degraded dependency path is the whole point of B3) |
| C (band overlay) | `js/temporal.js` | ~40-70 | Standard | `review-readability` (chart config additions, no state/security risk) |
| D (period comparison) | `js/temporal.js`, `index.html` | ~90-140 | Standard | `review-reliability` (new render function, conditional data paths, dual raw/enhanced modes) |
| E (hora_salida removal) | `js/temporal.js`, `index.html` | ~30-40 (mostly deletions) | Low/trivial-adjacent | none required if scoped as a clean deletion-only diff; `review-readability` if bundled with other changes |
| F (CSS) | `css/styles.css` | ~30-50 | Low | none (styling-only, but not pure doc/comment so still "standard" if it crosses the trivial-tier line — judgment call at review time) |
| G (verification) | none (no diff) | 0 | N/A | no lens; this is a manual QA pass, not a code change |

**Suggested PR / work-unit split** (per the requested framing — two projects, no
code-level interdependency, only a data-contract dependency):

1. **PR 1 — `Definitos/build_flota_percentiles.py`** (Work Unit A only). Fully
   self-contained, own repo/location, own review cadence, no dashboard reviewer
   needed beyond a schema sanity check against the frozen contract.
2. **PR 2 — Dashboard fetch + graceful degradation** (Work Unit B). Small, foundational,
   should land and be verifiable (B3) before C/D build on top, to keep the
   degradation path provably correct in isolation rather than entangled with the
   band/comparison UI's own bugs.
3. **PR 3 — Band overlay** (Work Unit C, + F1 CSS if any). Depends on PR 2.
4. **PR 4 — Period comparison UI** (Work Unit D, + F2 CSS). Depends on PR 2; can be
   developed in parallel with PR 3 (different functions/DOM regions in the same
   files) but should merge sequentially to avoid `js/temporal.js` conflict churn —
   flagging this as the main **chained-PR bottleneck**: PR 3 and PR 4 both edit
   `js/temporal.js` and `tempApplyFilters()`'s render sequence, so whichever lands
   second must rebase, not just merge.
5. **PR 5 — `hora_salida` removal** (Work Unit E). Can be its own tiny PR at any
   point after PR 2, or bundled into PR 3/4 as a trailing commit — lowest risk,
   flagged last only per the requested sequencing, not because it's blocked.
6. **Final verification** (Work Unit G) gates the last PR's merge, not a PR itself.

**Chained-PR / bottleneck risk**: `js/temporal.js` is the single shared file across
Work Units B, C, D, and E. The real ownership bottleneck is not cross-project (Python
vs JS have zero code coupling) but **intra-file**: `_renderEvolChart` (touched by C
and untouched-but-adjacent to E's `hora_salida` branch) and `tempApplyFilters` (touched
by B's re-render hook, D's wiring, and E's deletion) are the two functions every later
work unit must rebase against. Recommend landing B → C → D → E in that literal order
on a single shared branch (or sequential PRs against the same base) rather than
attempting parallel independent branches for C/D, to avoid a 3-way merge on the same
~15-line region of `tempApplyFilters`.
