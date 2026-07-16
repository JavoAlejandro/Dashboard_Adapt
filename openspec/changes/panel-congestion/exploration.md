# Exploration: panel-congestion (Empresa + Camión congestion panel integration)

## Current State

`dashboard_r2` is a build-step-free static app: `index.html` + `css/styles.css` + 9 `js/*.js` files loaded via plain `<script>` tags in a fixed order: `core.js → r2.js → gps.js → animation.js → comparativas.js → temporal.js → h3overlay.js → ruido.js → init.js`.

- **Navigation**: two main tabs via `switchTab()` — `tab-gps` ("Camión") and `tab-comparativas` ("Empresa"). Camión has 4 sub-tabs via `switchSubTab()` (`js/init.js:2-17`): Exposición (fully built), Emisión (placeholder), **Congestión (placeholder — already wired in nav, `index.html:119-124` button + `:369-379` panel body)**, Ruido (fully built). Empresa has 2 sub-tabs via `switchCmpSubTab()` (`js/comparativas.js:3-13`): Global, Temporal — **no Congestión sub-tab exists here yet**.
- **Data loading convention**: everything is fetched at runtime from a private Cloudflare R2 bucket through an authenticated Worker proxy (`R2_BASE` + bearer-token modal in `js/r2.js`). `js/core.js` exposes the two shared I/O primitives `r2Fetch(path)` and `fetchParseCsv(path)` (Papa Parse wrapper) — every module calls through those, never raw `fetch()`.
- **Percentile/benchmark precedent already exists twice**: (1) `comparativas.js:910-970` KPI-velocímetro gauges reading `ruido/dashboard_kpis_empresa.csv` + `ruido/dashboard_kpis_referencia.csv` (flat-per-`account_id` + percentile-reference two-file pattern); (2) the designed-but-not-yet-implemented `empresa-temporal-flota-percentiles` change (`flota/percentiles_referencia.csv` + `flota/percentiles_empresa.csv`, long/tidy format, offline `Definitos/build_flota_percentiles.py`, manual R2 upload, graceful degradation when absent). Both are directly analogous templates for a congestion percentile/rank dataset.
- **Offline precompute scripts live outside `dashboard_r2`**, in the sibling `C:\Users\jasar\Desktop\ADAPT\dashboard\Definitos\` folder — `dashboard_r2` itself has zero Python/DATA. Flow: precompute script → CSV → user manually uploads to R2 → dashboard fetches via `fetchParseCsv`.
- **`js/core.js` `TOKENS`** is `Object.freeze`d, single color source-of-truth (company A/B colors, segment palettes). Feature-specific ramps (e.g. `ruido.js`'s `RUIDO_RAMP`) stay locally scoped rather than extending `TOKENS`.
- **No existing "mecc"/"iev"/"congestion" business logic** anywhere in `dashboard_r2` JS — grep hits are only the pre-existing "Congestión" nav label/placeholder and unrelated noise-context prose in `ruido.js` ("congestión" as English word, not a metric).
- **Vehicle/truck concept collision risk**: `gps.js` already owns a full per-truck entity (`gpsLayers`, bus IDs, día/mes filters, animation) under Camión→Exposición. Whether Congestión's "Camión" table is the *same* vehicle universe or an independent dataset keyed only by the congestion source's own IDs is unresolved.
- **Prior-change signal**: `empresa-temporal-flota-percentiles/proposal.md` explicitly lists "Congestión / Emisión gauges — explicitly deferred to a later, separate change" — confirms this change is the intended landing point, and that no design decisions were pre-made for it.
- **Data-source reality check**: `datos_congestion/09_dashboard_empresas.csv` and `08_dashboard_viajes.csv` are already flat/tidy CSVs (verified header rows: `account_id,n_veh,km,mecc,iev,rank,hwy_share,peak_share,calles_top_share,n_comparables,iev_global` and `id_viaje,owner_id,account_id,km_recorridos,mecc_veh_s`), structurally close to the existing `ruido/dashboard_kpis_*` pattern. The 268 `empresa_<id>.js` files are **only inside `02_datos_empresas.rar`** — not extracted anywhere visible on disk — so their exact hourly-array/Lorenz-field shape is unverified beyond the business-context prose.
- **Prototype's data-loading model is a mismatch**: `01_dashboard_empresa.html:448` reads `window.DASH` from a `<script src="data.js">`-style include, and a separate `window.EMPRESAS` array for the selector. This is a static per-page single-company bundle, incompatible with `dashboard_r2`'s dynamic fetch+parse, token-gated R2 pipeline used everywhere else.

## Affected Areas

- `index.html` — (a) Camión→Congestión: replace `#sub-tab-congestion` placeholder body with real content; nav already wired. (b) Empresa→Congestión: needs a **new** third `switchCmpSubTab` button in `#sub-tabs-empresa` + a new `#cmp-subpanel-congestion` div (mirrors `cmp-subpanel-global`/`cmp-subpanel-temporal`, `index.html:519-528`, `532`, `685`).
- `js/init.js:2-17` — `switchSubTab` clears **all** `.sub-tab-panel` globally, a class shared with Empresa's `cmp-subpanel-*` — latent coupling to check when adding a 3rd Empresa sub-tab (currently harmless because gated by different parent `.tab-panel`, but worth a design note).
- `js/comparativas.js:3-13` — `switchCmpSubTab`/`initCmpTab` pattern to extend; also the closest existing precedent for percentile-gauge rendering reusable for the "4 hallazgos"/rank cards.
- A new `js/congestion.js` (one-file-per-domain convention, matching `r2.js`/`gps.js`/`comparativas.js`/`temporal.js`/`ruido.js`) would own fetch + aggregation + render for both levels; load-order slot is an open design question (candidate: after `temporal.js`, near `h3overlay.js` if hex logic is reused for the map layer).
- `js/r2.js` — likely needs a guarded trigger call (mirrors `temporalLoadFlota()`) or an independent lazy-load-on-first-open pattern (mirrors `ruidoEnsureLoaded()`).
- `js/h3overlay.js` — the huella/footprint geojson (`04_mecc_red_imputada_sectra.geojson`) is LineString/edge-level with hourly `mecc_veh_s[24]`, conceptually different from the existing H3-hexagon overlay — likely a new Leaflet polyline+ramp concern, not a direct extension.
- `css/styles.css` — new styles for congestion KPI cards, hallazgos cards, Lorenz/scatter chart containers, vehicle table, detail panel.
- Outside `dashboard_r2` (sibling `dashboard/` folder): a new `Definitos/build_congestion_*.py` (naming convention observed: `build_<domain>_*.py`) to reshape `08_dashboard_viajes.csv` + `09_dashboard_empresas.csv` + the 268 `empresa_<id>.js` (after RAR extraction) into R2-ready CSV(s) under a new path prefix (candidate: `congestion/`, mirroring `flota/` and `ruido/`'s two-file convention).

## Approaches Considered

1. **CSV/R2-fetch-native (extend existing pattern)** — Precompute `datos_congestion/*` sources into 2-3 long/tidy CSVs (company-level, vehicle-level, hourly series) + serve the geojson as-is, all through the existing `r2Fetch`/`fetchParseCsv` pipeline; new `js/congestion.js` lazy-loads once (mirrors `ruidoEnsureLoaded()`), renders both levels from CSVs + geojson.
   - Pros: zero architecture drift (reuses Worker auth, Papa Parse, `TOKENS`, lazy-load/graceful-degrade conventions already used twice); matches both prior openspec changes' established data-contract style.
   - Cons: requires a new offline precompute script to reshape 268 per-company objects + hourly arrays into tidy rows before any real data can be exercised; must independently verify the reshaped numbers against the prototype.
   - Effort: Medium (offline) + Medium (front-end).

2. **Bundle-the-268-files (port prototype near-verbatim)** — Extract the RAR, serve the 268 `empresa_<id>.js` + `01_indice.js` as static assets, inject a `<script src="…/empresa_<id>.js">` per company selection, render from `window.DASH` as the prototype does.
   - Pros: closest to the already-validated working prototype; fastest visual first cut.
   - Cons: 268 static files is a maintenance smell; dynamic script-injection has **no precedent anywhere** in `dashboard_r2` (everything else is fetch+parse); `window.DASH` global gets overwritten per switch (race risk); conflicts with the token-gated R2 model used for every other dataset (script-tag injection needs a plain URL, not a bearer-token fetch).
   - Effort: Low initial, Medium-High hidden cost once auth/consistency gaps surface.

## Recommendation

Approach 1 (CSV/R2-fetch-native). It is the only option consistent with the token-gated R2 architecture and both prior changes' conventions; treat the standalone prototype strictly as a UX/visual reference, not a code source.

## Risks / Open Questions

- RAR contents (268 `empresa_<id>.js`) unverified on disk — schema (hourly-array field names, `desfase_k`, Lorenz `concentration` shape) is known only from business-context prose; must extract + inspect before sdd-spec freezes a CSV schema.
- Unresolved: is Congestión's "Camión" vehicle set the same entity as `gps.js`'s existing per-truck GPS data, or independent? Affects whether cross-linking (e.g., click a vehicle → jump to its route) is possible.
- The footprint geojson is LineString/edge-level, distinct from the H3-hexagon overlay pattern used elsewhere — a genuinely new Leaflet rendering concern, not a drop-in reuse of `h3overlay.js`.
- Auth/serving model for the geojson and new CSVs must go through the same private R2 Worker + bearer-token gate as everything else — no public-CDN shortcut, despite the prototype's CDN-only design.
- `switchSubTab`'s global `.sub-tab-panel` selector coupling (shared between Camión and Empresa sub-tab groups) should be re-verified once an Empresa-side Congestión sub-tab exists.
- Review-budget risk: this change touches `index.html` + 1-2 new JS files + CSS + an offline script outside the repo — likely exceeds the 400-line single-PR budget; sdd-tasks should plan chained/stacked delivery, naturally split along the business context's own Empresa/Camión two-level structure.
- No automated tests exist anywhere in this repo (confirmed pattern from both prior changes) — verification will again be a manual in-browser checklist.

## Files Read

- `openspec/changes/restructure-empresa-panel/proposal.md`, `design.md`
- `openspec/changes/empresa-temporal-flota-percentiles/proposal.md`, `design.md`
- `index.html`, `index.json`
- `js/r2.js`, `js/core.js` (full), `js/ruido.js`, `js/comparativas.js`, `js/init.js`, `css/styles.css` (grep)
- `datos_congestion/01_dashboard_empresa.html`, `09_dashboard_empresas.csv`, `08_dashboard_viajes.csv`
- Directory listings: `dashboard_r2/`, `dashboard_r2/js/`, `dashboard_r2/openspec/changes/**`, sibling `Definitos/`, `DATA/`

**Ready for proposal**: yes, provided the RAR-extraction/schema-verification and vehicle-identity questions above are flagged as open decisions for the proposal's question round.
