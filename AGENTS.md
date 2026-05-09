# AGENTS.md

## Project overview

This is a zero-dependency reimplementation of the [PhosphorJS DataGrid demo](https://phosphorjs.github.io/examples/datagrid/). It renders five canvas-based virtualized data grids inside a drag-and-dock panel layout. The only build tool is Vite (dev dependency).

## Key constraints

- **Zero runtime dependencies.** No npm packages are imported at runtime. This is a hard rule, not a preference — the challenge specifically prohibits external libraries.
- **Performance is the primary goal.** Every architectural choice exists to beat the original PhosphorJS demo on frame time, scroll smoothness, and resize cost. Do not add abstractions, indirections, or allocations that trade performance for ergonomics.
- **Vanilla JS with JSDoc types.** No TypeScript. Type annotations go in JSDoc comments where they help; most code relies on clear naming instead.
- **Canvas rendering, not DOM.** The grids paint to `<canvas>` elements. Cell layout is computed in JS and drawn with `CanvasRenderingContext2D`. Do not switch to DOM-based cell rendering.

## Architecture at a glance

- **`src/main.js`** — entry point. Builds the layout tree and mounts grids.
- **`src/dock/`** — dock panel, layout tree (tagged union of `'tabs'` and `'split'` nodes), drag-to-dock, and split-handle resize. The tree is the source of truth; DOM is rebuilt from it on structural changes.
- **`src/grid/`** — `DataGrid` owns a canvas with HiDPI sizing, scroll-blit optimization, and a single-rAF paint loop. `CellRenderer` / `TextRenderer` define how cells are drawn. `sectionList` handles row/column offset lookups.
- **`src/data/`** — data models. `DataModel` is the base class with a change-event system. Models emit changes; grids subscribe and invalidate.
- **`src/util/`** — shared rAF scheduler (`raf.js`), DPR helpers (`dpr.js`), seedable PRNG (`prng.js`), FPS overlay (`fps.js`).

## Performance-critical patterns (do not regress)

1. **Scroll-blit**: on small scroll deltas, `DataGrid` uses `ctx.drawImage(canvas, ...)` to shift existing pixels and only paints the newly-exposed strip. Do not replace with full repaints.
2. **rAF coalescing**: all grids share one `requestAnimationFrame` via `raf.js`. Multiple data-model ticks in one frame produce one paint per grid. Do not add per-grid rAF loops.
3. **Zero allocation in cell paint**: the inner loop in `_paintBody` creates no objects, arrays, or closures. Viridis colors are 256 pre-interned strings. Format results use `toFixed(2)`. Do not introduce per-cell allocations.
4. **Monomorphic call sites**: `DataModel.data(row, col)` always returns the same type per model instance. Renderers are concrete classes, not generic callbacks. Preserve stable hidden-class shapes.
5. **HiDPI canvas sizing**: backing store is always `cssWidth * devicePixelRatio`. Context transform is set once via `setTransform(dpr, 0, 0, dpr, 0, 0)`. Do not use `ctx.scale()` per frame.
6. **Float64 scroll positions**: the trillion-row grid needs scroll positions up to ~2e13 pixels. Do not truncate to int32 (e.g., `| 0` on large values).

## Development

```sh
npm install
npm run dev          # starts Vite dev server at http://localhost:5173
npm run build        # production build to dist/
```

Append `#fps` to the URL to see the FPS overlay.

## Code style

- No comments unless they explain a non-obvious *why* (hidden constraint, workaround, surprising behavior).
- No abstractions beyond what the current code needs.
- Prefer editing existing files over creating new ones.
- Keep the bundle small — currently 29 KB raw / 9.4 KB gzipped.
