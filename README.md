# PhosphorJS DataGrid Challenge

> "For all the AI enthusiasts, vibe-code a website that does the same thing as
> this website, but with better performance, and DONT import any of my
> Phosphor/Lumino code. In fact, no external libs cause Phosphor/Lumino doesn't
> use any. Click around for a bit, drag/dock some tabs, resize some things
> including the browser window to get a feel for the requirements.
> https://phosphorjs.github.io/examples/datagrid/
> This page is over 10yrs old at this point. Can you beat it?"

**Live demo:** https://batpigandme.github.io/phosphorjs-challenge/

## What this is

A from-scratch reimplementation of the [PhosphorJS DataGrid demo](https://phosphorjs.github.io/examples/datagrid/) with **zero runtime dependencies**. The only dependency is Vite (dev-only, for bundling). Ships as one JS file (44.9 KB raw / 13.2 KB gzipped) plus a 3.2 KB stylesheet.

The demo reproduces the full interaction surface of the original:

- **DockPanel** with drag-and-drop tab rearrangement, split zones, and tab close buttons
- **Resizable splitters** between all panels; **column/row resize** via a 4 px grab zone on header borders
- **Multi-region headers** (corner, row-header, column-header) per data model
- **Cell selection** with a dedicated `SelectionModel`
- **Canvas-based virtualized DataGrid** rendering five data models:
  - **Trillion Rows/Cols** -- 10^12 x 10^12 synthesized cells, smooth scroll
  - **Streaming Rows** -- rows spliced in/out on a 250 ms tick (real `ROWS_INSERTED`/`ROWS_REMOVED` events)
  - **Random Ticks 1** -- red/green colored floats updating at 60ms
  - **Random Ticks 2** -- 80x80 viridis heatmap updating at 60ms
  - **JSON Data** -- inline cars dataset

## Performance wins over the original

| Area | How |
|---|---|
| **HiDPI rendering** | Canvas backing store sized at `cssW * devicePixelRatio`; crisp on retina |
| **Double buffering** | Every paint draws into an offscreen buffer canvas; the buffer is blitted to the visible canvas in one atomic `drawImage`. The resize handler does the resize + paint + blit synchronously in one task, so the cleared backing store is never composited — no black flicker mid-drag |
| **Scroll-blit** | `drawImage` shifts existing pixels on small scroll deltas; only newly-exposed strips are painted (source = the buffer's previous frame) |
| **Single rAF coalesce** | All grids share one `requestAnimationFrame` scheduler; multiple invalidations per tick collapse to one paint per grid |
| **ResizeObserver** | Per-grid observation; only changed grids reflow (original uses `window.onresize` for the whole tree) |
| **Pointer Events** | `setPointerCapture` for reliable drag tracking; no document-level mousemove leaks |
| **Monomorphic hot paths** | Per-renderer paint functions; no branching inside the cell loop |
| **Zero alloc per frame** | Module-level pre-allocated scratch `Float64Array`s for cell offsets; **11×** faster than per-frame allocation in d8 |
| **O(1) section offsets** | `SectionList.offsetOf` uses a prefix-sum formula instead of binary-search + linear scan over overrides (**1.92×** in d8) |
| **Batched offset fill** | One `fillScreenPositions(...)` call replaces ~92 `offsetOf` calls per visible frame (**9.6×** in d8) |
| **ctx state caching** | `font` / `textBaseline` / `textAlign` / `fillStyle` cached on the 2D context to skip redundant state writes |
| **Interned colors** | Viridis LUT is 256 pre-built `rgb(...)` strings; red/green tick palette is shared |
| **Bundle size** | 44.9 KB raw / 13.2 KB gzipped (JS) vs. the original's ~200 KB Phosphor bundle |

## Benchmarks

Hot paths are micro-benchmarked with d8 (V8's standalone shell). Run from a checkout:

```sh
d8 --allow-natives-syntax bench/d8-hotpaths.js
```

The harness covers 12 sections: `SectionList` offset/index, xorshift128 PRNG, `RandomDataModel._tick`, ctx-state caching, RAF flush, `_paintBody` scratch arrays, `LargeDataModel.data()` string building, viridis LUT, header `fillStyle` hoisting, `fillScreenPositions`, full-frame offset loops, and grid-line `Math.floor` redundancy.

## Getting started

```sh
npm install
npm run dev        # http://localhost:5173
```

Append `#fps` to the URL to show the FPS/paints-per-second overlay.

Pushes to `main` deploy to GitHub Pages via `.github/workflows/deploy.yml` (OIDC, no PAT).

### Production build

```sh
npm run build      # outputs to dist/
npm run preview    # serve the build locally
```

## Project structure

```
src/
  main.js                  # bootstrap: build layout tree, mount grids
  style.css                # all styles (dock layout, themes, drag overlay)

  dock/
    DockPanel.js            # layout tree renderer, drag-to-dock, split resize
    LayoutNode.js           # tagged-union tree: 'tabs' | 'split' nodes
    hitTest.js              # point-in-layout drop zone detection

  grid/
    DataGrid.js             # canvas grid: HiDPI, scroll-blit, rAF paint
    CellRenderer.js         # TextRenderer with format/color/bg callbacks, viridis LUT
    SelectionModel.js       # rectangular cell selection: ranges, current cursor, key nav
    sectionList.js          # variable-size sections with O(1) uniform + sparse overrides

  data/
    DataModel.js            # base: rowCount, columnCount, data(row, col), change events
    LargeDataModel.js       # 10^12 x 10^12 synthesized coordinate strings
    RandomDataModel.js      # Float64Array-backed random ticks with seeded xorshift128
    StreamingDataModel.js   # ring-buffer rows, add/remove on timer
    JSONModel.js            # inline cars dataset (30 rows, 8 columns)

  util/
    raf.js                  # shared rAF scheduler with coalesced invalidation
    dpr.js                  # devicePixelRatio-aware canvas sizing
    fps.js                  # FPS + paints/sec overlay (enabled via #fps hash)
    prng.js                 # xorshift128 seedable PRNG

bench/
  d8-hotpaths.js            # 12-section d8 micro-benchmark harness for hot paths

.github/workflows/
  deploy.yml                # GitHub Pages deploy on push to main (OIDC)
```
