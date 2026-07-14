# Proposal: Restructure the Empresa Panel

## Intent

The "Empresa" surface is three unrelated concepts sharing one word, plus duplicated color/data logic and dead code. This makes the panel hard to reason about, easy to break (cross-file state writes with no interface), and visually inconsistent (a company shows different colors per sub-tab). Restructure for consistent naming, a unified fetch→compute→render path, shared color tokens, and dead-code removal — within the current dependency-free static architecture.

## Scope

### In Scope
- Naming consistency across the three empresa concepts: the "Empresa" tab whose internal id is `comparativas`/`cmp` (tab-comparativas, comparativas.js, `initCmpTab`), the Camión company selector `#r2-empresa-sel`→`r2LoadEmpresa()` (r2.js), and the GPS filter `#gps-empresa-sel`→`onEmpresaChange()` (gps.js).
- Unify the empresa-comparison pipeline: `runComparativaEmpresas()`→`_calcEmpresaMetrics` (comparativas.js:351-515) →`_renderEmpresaCols` (comparativas.js:518-723), separating aggregation from I/O and DOM/inline-CSS construction.
- Consolidate the 4 redundant color palettes (gps.js:244-294, gps.js:2305-2308, comparativas.js:614-615, temporal.js:26-29) and the hand-synced `EMP_A/EMP_B` (comparativas.js:17-19 + css/styles.css:682-683) into shared design tokens with a single source of truth.
- Remove dead code: orphaned js/impactos.js (never in index.html) and temporal.js `tempLoadCSV` (:32-78, no trigger); fix comparativas.js:25 stale credit.
- Remove production debug logs (comparativas.js:513, 522, 524).

### Out of Scope
- Full ES-module migration / adding a build tool or bundler (decision point — see question round).
- Adding a test runner or automated tests (none exists; verification stays manual/browser).
- Behavioral/UX redesign of the panel, new metrics, or data-schema changes.
- Refactoring the Camión or GPS tabs beyond the naming touchpoints above.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
None (internal refactor; no spec-level requirement changes).

## Approach

Targeted refactor inside the existing global-`<script>` architecture (no bundler). Introduce a shared color-token layer read from CSS custom properties via `getComputedStyle` so JS and CSS share one source. Extract a small empresa fetch/parse helper to replace the 3 inline `Papa.parse` paths and per-file caches. Split compute from render so aggregation is pure and DOM/CSS is data-driven (kill the repeated ~300-char inline style strings). Rename the `cmp`/`comparativas` internals to a consistent empresa-comparison vocabulary while preserving DOM ids the CSS/HTML depend on (or updating both together). Preserve load order: r2.js→gps.js→animation.js→comparativas.js→temporal.js→h3overlay.js→ruido.js→init.js.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `js/comparativas.js` | Modified | Split compute/render, tokenize colors, drop debug logs, fix stale credit |
| `js/temporal.js` | Modified/Removed | Remove `tempLoadCSV`; use shared color tokens |
| `js/gps.js` | Modified | Consolidate GSE/EDAD palettes to tokens |
| `js/r2.js` | Modified | Route empresa loads through shared helper; clarify cross-file writes |
| `css/styles.css` | Modified | Single color-token source |
| `js/impactos.js` | Removed | Orphaned dead file |
| `index.html` | Modified | DOM ids/handlers may be renamed for consistency; file name stays `index.html` |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Renaming DOM ids breaks CSS/HTML wiring | Med | Rename ids and their CSS/HTML refs together, or keep ids and rename only JS symbols |
| Cross-file state coupling (r2.js writes temporal.js state/DOM) breaks on refactor | Med | Introduce a thin explicit interface before moving logic; verify live path in-browser |
| No automated tests to catch regressions | High | Manual browser verification checklist per sub-tab (Global + Temporal) |
| Color changes shift established visuals | Low | Tokens seed from current values; visual diff before/after |

## Rollback Plan

Single-branch, file-scoped change with no data migration. Revert the branch/commits to restore prior behavior; no persisted state or schema is touched.

## Dependencies

- Papa Parse, Chart.js, Leaflet (already vendored) — unchanged.
- Decision on ES-module scope (below) before design.

## Success Criteria

- [ ] One documented vocabulary distinguishes the 3 empresa concepts; internals no longer conflate "cmp/comparativas" with "Empresa".
- [ ] Single source of truth for empresa and GSE/EDAD colors; a company renders the same color across sub-tabs.
- [ ] Comparison pipeline separates aggregation from I/O and DOM; no repeated inline CSS strings.
- [ ] js/impactos.js and `tempLoadCSV` removed; no debug logs in comparison path.
- [ ] Both sub-tabs (Global, Temporal) and Camión/GPS empresa selectors verified working in-browser.

## Proposal question round — RESOLVED

Decisions confirmed by user on 2026-07-13:

1. **ES-module migration**: No. Stay a targeted refactor inside the current global-`<script>` model. No bundler, no build step.
2. **DOM id renaming**: `index.html` MAY be edited — its content, DOM ids, and structure can change freely as part of this refactor. The only fixed constraint is the file name itself: it must remain `index.html` (do not rename/move the entry file). Renaming of DOM ids (with matching CSS/JS updates) is therefore in scope wherever it improves naming consistency.
3. **Color source of truth**: JS palettes are authoritative, not CSS. When consolidating the 4 redundant color arrays and the `EMP_A`/`EMP_B` duplication, the JS-defined values win; `css/styles.css` custom properties (`--emp-a`, `--emp-b`) should be brought in line with the JS source, not the other way around (reverses this proposal's original `getComputedStyle`-from-CSS suggestion).
4. **Naming target**: No preference given — sdd-design should propose the public/internal vocabulary for the 3 empresa concepts.
5. **Verification bar**: Manual per-sub-tab browser checklist is sufficient as the acceptance gate. No smoke-test harness needed.
