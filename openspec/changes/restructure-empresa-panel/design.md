# Design: Restructure the Empresa Panel

## Technical Approach

Targeted in-place refactor inside the existing global-`<script>` architecture (no bundler, no ES modules). `index.html` is now editable (proposal decision 2); the **only** fixed constraint is the entry file's name — it must stay `index.html`. DOM ids, structure, inline handlers, and `<script>` tags may all change.

New load order (one file prepended): `core.js → r2.js → gps.js → animation.js → comparativas.js → temporal.js → h3overlay.js → ruido.js → init.js`.

The prior design was built on two constraints that no longer hold: *C1 — frozen public API* and *C2 — no new script file*. Both are dropped. The decisions below re-weigh each on its own engineering merits (risk, review budget, clarity), not on the old "cannot touch HTML" prohibition.

## Architecture Decisions

### Decision: Naming vocabulary + public entry-point stability

**Choice.** Adopt the role-suffix vocabulary — **empresa-source** (Camión loader), **empresa-filter** (GPS map filter), **empresa-compare** (comparativas A-vs-B) — applied to renameable internals, new helpers, and comment banners. **Keep public entry-point names stable** (`r2LoadEmpresa`, `onEmpresaChange`, `switchCmpSubTab`, `runComparativaEmpresas`, `tempApplyFilters`), even though inline handlers could now be edited.

| Concept | Public entry (kept) | Renameable internals → new |
|---|---|---|
| empresa-source (`#r2-empresa-sel`) | `r2LoadEmpresa()` | `_r2ProcesarImpactos` → `_empresaSourceIngest` |
| empresa-filter (`#gps-empresa-sel`) | `onEmpresaChange()` | comment banner only |
| empresa-compare (comparativas) | `runComparativaEmpresas()` | `_calcEmpresaMetrics` → `_empresaCompareAggregate`; `_renderEmpresaCols` → `_empresaCompareRender` |

**Alternatives.** Rename public functions + update inline handlers — **rejected**: inline `onclick`/`onchange` strings have zero static checking, so each rename trades a clean internal refactor for runtime-only breakage surfaced solely by manually clicking every control; the diff churn competes with the substantive work for the 400-line review budget; and the three concepts are already disambiguated at the DOM boundary by id prefix (`r2-`/`gps-`/`cmp-`), so public names are not where the conflation lives. **Rationale.** The conflation the proposal targets is in the internal helper/variable soup — fixing that fully satisfies the success criterion while keeping the public surface reversible and low-risk. The constraint changed; the conclusion is now a deliberate tradeoff ("can, but shouldn't"), not an imposed freeze.

### Decision: New shared `core.js` file

**Choice.** Create `js/core.js`, loaded **first** via a new `<script src="js/core.js">` tag ahead of `js/r2.js`. It holds the app-wide shared foundation: the `TOKENS` palette object, the `:root` custom-property injection, and the generic `r2Fetch` + `fetchParseCsv` helpers (both moved out of r2.js).

**Alternatives.** Jam `TOKENS`/`fetchParseCsv` at the top of r2.js (the old C2 workaround) — **rejected** now that a script tag can be added: it overloads r2.js (the Camión-tab file) as the de-facto globals host. **Rationale.** A file whose name announces "shared core" screams its role; a guaranteed-first load position makes ordering explicit rather than incidental. Moving `r2Fetch` alongside `fetchParseCsv` keeps `core.js` self-contained (no forward reference to r2.js). `temporalIngest` and `gpsSetStats` stay in their owning files — that is encapsulation, not shared foundation.

### Decision: Color tokens — JS authoritative (unchanged), ergonomics refined

**Choice (authority fixed).** `TOKENS` (in `core.js`) is the single source; at startup it pushes `--emp-a/-b(+soft)` onto `:root` via `setProperty`. CSS `--emp-*` declarations remain as documented fallback seeded to the same values. **Ergonomic refinement enabled by editable markup:** standardize color slots on `data-side="a|b"` + CSS classes resolving to `var(--emp-a/b)` (the pattern CSS already uses at `.cmp-company-id.side-a`, `[data-side]`). JS keeps hex only where a value is required — Leaflet polylines and Chart.js datasets read `TOKENS.empresaA/B`; DOM element styling drops the hardcoded `EMP_A/EMP_B` hex concatenation in inline style strings in favor of `data-side` hooks. Net: the literal palette appears in JS only in `TOKENS` + the injection.

## Data Flow

Unchanged pipeline (carried forward), now sourced from `core.js`:

    #r2-empresa-sel ─ r2LoadEmpresa()
        │  fetchParseCsv(path)  ← core.js: r2Fetch + Papa.parse → rows[]
        ├─→ gpsSetStats(rows) ........ statsData (gps.js)
        ├─→ calcEstimadores(rows) .... estPropGSE / estPropEdad
        └─→ temporalIngest(rows) ..... temporal.js state + render

    runComparativaEmpresas()
        _empresaCompareAggregate(ids) → metrics   (PURE: no DOM/I/O/logs)
                     ▼
        _empresaCompareRender(...)  → DOM   (colors via data-side/TOKENS)

### DOM id renaming — decision: no renames

The three empresa concepts already have distinct id prefixes, so ids are not the confusion source. `cmp-*` accurately namespaces the comparativas tab (hosting both camión-vs-camión and empresa-vs-empresa modes); renaming `cmp-*`→`empresa-*` would be semantically wrong for the camión-mode ids and would touch **182 JS/CSS + ~50 HTML** sites — a high-risk, low-value diff that alone would exceed the 400-line budget.

| Candidate considered | Verdict | Reason |
|---|---|---|
| `cmp-*` → `empresa-*` (bulk) | Keep | 232+ refs; `cmp` = comparativas tab, half belong to camión mode |
| `cmp-emp-a/b`, `cmp-found-emp-*` | Keep | already carry `emp`; not misleading; ~20 refs |
| `cmp-subtab/subpanel-*` | Keep | tab-structural, prefix accurate |

Mapping table: **empty by decision** — no ids renamed.

## File Changes

| File | Action | Description |
|---|---|---|
| `js/core.js` | Create | `TOKENS` + `:root` injection; move in `r2Fetch`, add `fetchParseCsv`; loaded first |
| `index.html` | Modify | Add `<script src="js/core.js">` before `js/r2.js`; normalize `data-side="a|b"` hooks on any static color slot lacking one. **No id/handler renames** |
| `js/r2.js` | Modify | Remove `r2Fetch`/`TOKENS` (now in core.js); route loads through `fetchParseCsv`; `_r2ProcesarImpactos`→`_empresaSourceIngest`; call `temporalIngest`; `gpsSetStats`; role banner |
| `js/comparativas.js` | Modify | `_calcEmpresaMetrics`→`_empresaCompareAggregate` (pure); `_renderEmpresaCols`→`_empresaCompareRender`; Leaflet/Chart read `TOKENS`, DOM styling via `data-side`; drop `EMP_A/EMP_B`; remove `console.log` 513/522/524 (keep `console.error` 525); fix stale credit :25 |
| `js/temporal.js` | Modify/Remove | Delete `tempLoadCSV` (:32-78); add `temporalIngest(rows)`; `EMP_COLORS`→`TOKENS.companySeriesColors` |
| `js/gps.js` | Modify | `BSP_COLORS_GSE/EDAD` + `EST_*_COLORS`→`TOKENS.segmentColors`; role banner on `onEmpresaChange` |
| `css/styles.css` | Modify | `--emp-*` kept as documented fallback seeded to `TOKENS`; cross-ref comment |
| `js/impactos.js` | Delete | Orphaned; never in `index.html`; `BSP_*` actually live in `gps.js` |

## Interfaces / Contracts

    // core.js (loaded first)
    const TOKENS = Object.freeze({
      empresaA:'#e8a020', empresaB:'#4a6fa5',
      empresaASoft:'rgba(232,160,32,0.07)', empresaBSoft:'rgba(74,111,165,0.07)',
      segmentColors:[/* 6 GSE + 6 edad */], companySeriesColors:[/* cycling */],
    });
    async function r2Fetch(path) { /* moved from r2.js */ }
    function fetchParseCsv(path) { /* → Promise<rows[]> */ }
    // temporal.js
    function temporalIngest(rows) { /* owns _tempData,_tempEmpConf,#temp-* + render */ }
    // gps.js
    function gpsSetStats(rows)   { /* builds statsData */ }

Load-order safety: `core.js` first, so `TOKENS`/`fetchParseCsv` exist before every consumer; cross-file calls (`temporalIngest`) guard with `typeof fn === 'function'`.

## Testing Strategy

Carried forward — manual per-sub-tab browser checklist (no test runner):

| Area | Check |
|---|---|
| Camión / empresa-source | `#r2-empresa-sel` loads routes+impactos; `#gps-status` counts; no console errors |
| GPS / empresa-filter | `#gps-empresa-sel` filters map routes |
| Comparativas → Global | Run compare; map A (gold)/B (slate); GSE+edad grid + Δ arrows; no debug logs |
| Comparativas → Temporal | KPIs, charts, tabla; series colors match Global |
| Color consistency | Same company identical color across Camión/Global/Temporal |
| Tokens | `getComputedStyle(:root).--emp-a` == `TOKENS.empresaA` |
| Load order | `core.js` present before `r2.js`; app boots with `impactos.js` deleted, no `tempLoadCSV` ref errors |

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or process-integration boundary. Client-side static-asset refactor.

## Migration / Rollout

No migration. Single-branch, file-scoped; revert commits to restore prior behavior. No persisted state or schema touched.

## Open Questions

- [ ] None blocking. Confirm at apply time that `js/impactos.js` has no `<script>` tag before deletion, and that no static color slot loses its `data-side` hook during the `core.js`/markup edit.
