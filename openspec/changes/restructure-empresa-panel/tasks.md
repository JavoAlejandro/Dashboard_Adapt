# Tasks: Restructure the Empresa Panel

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 550-750 |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 → PR 2 → PR 3 |
| Delivery strategy | ask-on-risk (default; none supplied) |
| Chain strategy | stacked-to-main — PR 1 → merge → PR 2 → merge → PR 3, each branched from the updated `main` in sequence |

Decision needed before apply: No — resolved 2026-07-13
Chained PRs recommended: Yes
Chain strategy: stacked-to-main-in-sequence (confirmed by user)
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | `core.js` foundation + dead-code removal (Phases 1-2) | PR 1 | N/A — no test runner | Open `index.html`; run checklist rows "Load order" / "Tokens" | Revert `core.js`, its `<script>` tag, and `impactos.js` deletion |
| 2 | r2.js/temporal.js/gps.js pipeline split (Phases 3-5) | PR 2 | N/A — no test runner | Checklist rows "Camión/empresa-source", "GPS/empresa-filter" | Revert `r2.js`/`temporal.js`/`gps.js` diffs; PR 1 stands alone |
| 3 | comparativas.js split + CSS tokens + final verify (Phases 6-7) | PR 3 | N/A — no test runner | Checklist rows "Comparativas Global/Temporal", "Color consistency" | Revert `comparativas.js`/`styles.css` diffs; PR 1+2 stand alone |

## Phase 1: Foundation — core.js

- [x] 1.1 Create `js/core.js`: `TOKENS` object seeded from `comparativas.js:17-19` (`EMP_A/EMP_B`), `gps.js:244-294`/`:2305-2308`, `temporal.js:26-29` (`EMP_COLORS`); `:root` injection via `setProperty`; move `r2Fetch` from `r2.js`; add `fetchParseCsv(path)`.
- [x] 1.2 Add `<script src="js/core.js">` to `index.html` before `js/r2.js`.
- [x] 1.3 Manual check: `core.js` loads first; `TOKENS`/`fetchParseCsv` defined; no console errors on boot.

## Phase 2: Dead-Code Removal

- [x] 2.1 Confirm `js/impactos.js` has no `<script>` tag anywhere in `index.html`.
- [x] 2.2 Delete `js/impactos.js`.
- [x] 2.3 Manual check: app boots clean with `impactos.js` deleted, no missing-reference errors.

## Phase 3: r2.js — Route Through core.js

- [x] 3.1 Remove `r2Fetch`/`TOKENS` definitions from `js/r2.js`; route empresa CSV load through `fetchParseCsv(path)`.
- [x] 3.2 Rename `_r2ProcesarImpactos` → `_empresaSourceIngest` (internal only); add empresa-source role banner comment.
- [x] 3.3 Manual check: `#r2-empresa-sel` loads routes+impactos; `#gps-status` counts; no console errors.

## Phase 4: temporal.js — Explicit Ingest Interface

- [x] 4.1 Delete `tempLoadCSV` (`temporal.js:32-78`).
- [x] 4.2 Add `temporalIngest(rows)` owning `_tempData`/`_tempEmpConf`/`#temp-*` state + render.
- [x] 4.3 Update `r2.js` to call `temporalIngest(rows)` (guarded `typeof fn === 'function'`) instead of direct state/DOM writes.
- [x] 4.4 Replace `temporal.js`'s `EMP_COLORS` with `TOKENS.companySeriesColors`.
- [x] 4.5 Manual check: no `tempLoadCSV` reference errors; Temporal sub-tab renders.

## Phase 5: gps.js — Palette Consolidation

- [x] 5.1 Confirm `gpsSetStats(rows)` builds `statsData`, invoked from the shared r2.js load path.
- [x] 5.2 Replace `BSP_COLORS_GSE/EDAD` + `EST_*_COLORS` with `TOKENS.segmentColors`.
- [x] 5.3 Add empresa-filter role banner comment on `onEmpresaChange`.
- [x] 5.4 Manual check: `#gps-empresa-sel` filters map routes; no console errors.

## Phase 6: comparativas.js — Split + Tokenize + Cleanup

- [x] 6.1 Split `_calcEmpresaMetrics` → pure `_empresaCompareAggregate` (no DOM/I/O/logs).
- [x] 6.2 Split `_renderEmpresaCols` → `_empresaCompareRender` (DOM/CSS construction via `data-side`/`TOKENS`).
- [x] 6.3 Update comparativas markup: `data-side="a|b"` hooks replace hardcoded hex in inline styles (static `index.html` markup had no hardcoded hex to fix — the color-string duplication lived in `_renderEmpresaCols`'s JS-generated DOM; added `data-side` + `.cmp-metric-hdr`/`.cmp-metric-val` hooks there, resolved in `styles.css`).
- [x] 6.4 Drop `EMP_A/EMP_B` hex concatenation; Leaflet/Chart.js read `TOKENS.empresaA/B`.
- [x] 6.5 Remove `console.log` at `comparativas.js:513,522,524` (keep `console.error` `:525`); fix stale credit comment at `:25`.
- [x] 6.6 Manual check: Comparativas → Global — compare runs; map A(gold)/B(slate); GSE+edad grid + Δ arrows; no debug logs. Confirmed by user in-browser 2026-07-14 (post cache-fix retest — the earlier `gpsSetStats is not defined` console error was a stale browser cache serving pre-PR2 `gps.js`, not a code defect; resolved via hard refresh with DevTools "Disable cache").
- [x] 6.7 Manual check: Comparativas → Temporal — KPIs, charts, tabla; series colors match Global. Confirmed by user in-browser 2026-07-14.

## Phase 7: CSS Alignment + Final Verification

- [x] 7.1 Update `css/styles.css` `--emp-*` custom properties to mirror `TOKENS` values exactly (documented fallback).
- [x] 7.2 Manual check: same company renders identical color across Camión/Global/Temporal. Confirmed by user in-browser 2026-07-14.
- [x] 7.3 `--emp-a`/`--emp-b`(+soft) static CSS values confirmed textually identical to `TOKENS.empresaA`/`TOKENS.empresaB`(+Soft) (static comparison; live rendering also confirmed working in-browser 2026-07-14).
- [x] 7.4 Full regression pass against every row in design.md's Testing Strategy table. Load order/tokens (PR1), Camión/empresa-source + GPS/empresa-filter (PR2), and Comparativas Global/Temporal + color consistency (PR3) all confirmed working in-browser across this session.
