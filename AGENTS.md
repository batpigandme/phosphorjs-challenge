# AGENTS.md

> Keep this file in sync with `README.md`. Any change that affects bundle size,
> architecture, perf invariants, file layout, or benchmarks should land in both
> places in the same change.

## Project overview

Zero-dependency reimplementation of the [PhosphorJS DataGrid demo](https://phosphorjs.github.io/examples/datagrid/). Five canvas-based virtualized data grids inside a drag-and-dock panel layout. Vite is the only build tool (dev dependency). Live at https://batpigandme.github.io/phosphorjs-challenge/.

Current bundle: **45.7 KB raw / 13.4 KB gzipped** JS, plus a 3.2 KB stylesheet.

## Key constraints

- **Zero runtime dependencies.** No npm packages imported at runtime. Hard rule, not preference — the challenge prohibits external libraries.
- **Performance is the primary goal.** Every architectural choice exists to beat the original PhosphorJS demo on frame time, scroll smoothness, resize cost, and bundle size. Do not add abstractions, indirections, or allocations that trade performance for ergonomics.
- **Vanilla JS with JSDoc types.** No TypeScript. JSDoc where it helps; otherwise rely on clear naming.
- **Canvas rendering, not DOM.** Grids paint to `<canvas>` elements. Cell layout is computed in JS and drawn with `CanvasRenderingContext2D`. Do not switch to DOM-based cell rendering.

## Architecture at a glance

- **`src/main.js`** — entry point. Builds the layout tree and mounts grids.
- **`src/style.css`** — all styles (dock layout, themes, drag overlay).
- **`src/dock/`** — `DockPanel` (layout tree renderer, drag-to-dock, split-handle resize), `LayoutNode` (tagged union of `'tabs'` / `'split'`), `hitTest` (drop-zone detection). The tree is the source of truth; DOM is rebuilt from it on structural changes.
- **`src/grid/`** — `DataGrid` (canvas grid: HiDPI, scroll-blit, double-buffered paint, single-rAF), `CellRenderer` / `TextRenderer` (format/color/bg callbacks, viridis LUT), `SelectionModel` (rectangular selection: ranges, current cursor, key nav), `sectionList` (variable-size sections with O(1) uniform + sparse overrides).
- **`src/data/`** — `DataModel` base (rowCount / columnCount / data / change events), `LargeDataModel` (10^12 × 10^12 synthesized), `RandomDataModel` (Float64Array-backed ticks with seeded xorshift128), `StreamingDataModel` (ring-buffer rows, real `ROWS_INSERTED`/`ROWS_REMOVED` events on a 250 ms tick), `JSONModel` (inline cars dataset).
- **`src/util/`** — `raf.js` (shared rAF scheduler with coalesced invalidation), `dpr.js` (DPR-aware sizing), `prng.js` (xorshift128), `fps.js` (FPS + paints/sec overlay).
- **`bench/`** — `d8-hotpaths.js` (12-section V8-shell micro-benchmarks: SectionList, paint scratch arrays, RAF flush, viridis LUT, etc.) and `head-to-head.mjs` (Puppeteer harness comparing this app vs. the upstream demo).
- **`.github/workflows/deploy.yml`** — GitHub Pages deploy on push to `main` via OIDC (no PAT).

## Performance-critical patterns (do not regress)

1. **Double buffering.** Every paint draws into an offscreen cell buffer (`_buffer`, `alpha:false`); a separate `_lineBuffer` (`alpha:true`) holds body grid lines only. `_present()` blits both onto the visible canvas via two `drawImage` calls. The resize handler runs resize + paint + blit synchronously in one task. Do not break the sync resize-paint pipeline.
2. **Grid line layer.** Body grid lines are painted onto `_lineBuffer`, not the cell buffer. On scroll-blit, `_lineBuffer` is blit-shifted by the same `drawImage` memcpy as the cell buffer; only 1–2 newly-exposed edge lines are drawn. Do NOT move grid line drawing back to the cell buffer or skip the line buffer blit in `_paintScroll`. BitBlt principle: memcpy >> rasterization.
3. **Column-wise rendering + per-column clip.** The cell paint loop in `_paintBody` is column-major (outer `ci`, inner `ri`). Each column gets one `ctx.save() / ctx.clip() / ctx.restore()` wrapping its rows. Renderers receive `(x, y, w, h)` in canvas-space and are clipped to column width by the parent; they must not overflow their row height themselves. Do not revert to row-major or add per-cell clips. **Trade-off:** `nCols` save/restore pairs per paint (vs. 1 outer), and `_cached*` state sentinels reset per-column (not per-body-paint); this is intentional and correct.
4. **Scroll-blit.** On small scroll deltas, both `_buffer` (cells) and `_lineBuffer` (lines) are blit-shifted via `drawImage`; only newly-exposed strips are repainted. Do not replace with full repaints.
5. **rAF coalescing.** All grids share one `requestAnimationFrame` via `raf.js`. Multiple data-model ticks in one frame produce one paint per grid. Do not add per-grid rAF loops.
6. **Per-grid `ResizeObserver`.** Only changed grids reflow. Do not regress to a window-level resize listener that reflows everything.
7. **Zero allocation per frame.** Module-level pre-allocated `Float64Array` scratch buffers hold cell offsets across paints (~11× faster than per-frame alloc in d8). `_paintBody` creates no objects, arrays, or closures in the cell loop. Do not introduce per-cell allocations.
8. **O(1) section offsets.** `SectionList.offsetOf` uses a prefix-sum formula (~1.92× in d8). Preserve the prefix-sum invariant.
9. **Batched offset fill.** One `fillScreenPositions(...)` call per visible frame replaces ~92 `offsetOf` calls (~9.6× in d8). Do not revert to per-cell `offsetOf` lookups.
10. **Cached 2D context state.** `font` / `textBaseline` / `textAlign` are cached on the `TextRenderer` instance (plain JS object, not the host `ctx` object) to skip redundant canvas state writes. `renderer.resetCache()` is called at the start of each column (after `ctx.restore()`). Do not move the cache back onto the `CanvasRenderingContext2D` host object — host-object property access uses a slower IC path in V8.
11. **Monomorphic call sites.** `DataModel.data(row, col)` always returns the same type per model instance. Renderers are concrete classes, not generic callbacks. Preserve stable hidden-class shapes.
12. **HiDPI canvas sizing.** Backing store is always `cssWidth * devicePixelRatio`. Context transform set once via `setTransform(dpr, 0, 0, dpr, 0, 0)`. Do not call `ctx.scale()` per frame. Both `_buffer` and `_lineBuffer` are resized in `_handleResize`.
13. **Float64 scroll positions.** The trillion-row grid needs scroll positions up to ~2e13 pixels. Do not truncate to int32 (e.g., `| 0` on large values).
14. **Pointer Events with capture.** Drag tracking uses `setPointerCapture`; no document-level `mousemove` leaks.
15. **DockPanel collapse.** Split handles allow dragging to 0 (snap threshold ~28 px). A collapsed child renders as `flex: 0 0 28px`, keeping its tab bar visible as a restore handle. Do not restore the 5% minimum floor; neighbors redistribute freed space via flexbox.

## Development

```sh
npm install
npm run dev          # Vite dev server at http://localhost:5173
npm run build        # production build to dist/
npm run preview      # serve the build locally
```

Append `#fps` to the URL to see the FPS / paints-per-second overlay.

### Benchmarks

```sh
# Hot-path micro-benchmarks via d8 (V8 standalone shell).
d8 --allow-natives-syntax bench/d8-hotpaths.js

# Apples-to-apples comparison vs. the upstream PhosphorJS demo.
npm i --no-save puppeteer-core && node bench/head-to-head.mjs
```

The head-to-head numbers in `README.md` come from `bench/head-to-head.mjs`. If you change anything that could move them (paint pipeline, bundle size, resize behavior), re-run and update both files.

## Code style

- No comments unless they explain a non-obvious *why* (hidden constraint, workaround, surprising behavior).
- No abstractions beyond what the current code needs.
- Prefer editing existing files over creating new ones.
- Keep the bundle small.
