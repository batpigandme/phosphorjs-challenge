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

A from-scratch reimplementation of the [PhosphorJS DataGrid demo](https://phosphorjs.github.io/examples/datagrid/) with **zero runtime dependencies**. The only dependency is Vite (dev-only, for bundling). Ships as one JS file (45.7 KB raw / 13.4 KB gzipped) plus a 3.2 KB stylesheet.

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

## Head-to-head benchmark vs. the original

Both pages loaded back-to-back in the same Chrome (1280×800 viewport, headless), median of 3 runs. Reproduce with `bench/head-to-head.mjs` (see [Benchmarks](#benchmarks)).

| Metric | [Original](https://phosphorjs.github.io/examples/datagrid/) | [This implementation](https://batpigandme.github.io/phosphorjs-challenge/) | Delta |
|---|---:|---:|---:|
| Bytes on the wire | 231.1 KB | 20.4 KB | **11.3× lighter** |
| Bytes decoded (JS+CSS+HTML) | 1.10 MB | 56.1 KB | **20.2× lighter** |
| HTTP requests | 7 | 4 | — |
| Load (DCL → networkidle0) | 1031 ms | 877 ms | **1.18× faster** |
| Idle FPS (120 Hz display) | 120.7 | 120.7 | parity (display-bound) |
| Scroll FPS (3 s wheel-spam) | 120.0 | 120.0 | parity (display-bound) |
| Scroll frame interval p50 / p95 / max | 8.30 / 9.20 / 9.40 ms | 8.30 / 9.20 / 9.40 ms | parity |
| Resize JS time per frame (p50 / max) | 6.10 / 7.00 ms | 5.20 / 6.40 ms | **1.17× faster** |
| Long tasks during scroll | 0 | 0 | parity |

Honest summary: at steady state both apps saturate the display refresh rate with no dropped frames, so FPS is not a discriminator on a healthy machine. The clear win is **bundle size** (an order of magnitude lighter on the wire, **20× lighter decoded**).

## Architectural notes

| Area | How |
|---|---|
| **HiDPI rendering** | Canvas backing store sized at `cssW * devicePixelRatio`; crisp on retina |
| **Double buffering** | Every paint draws into an offscreen buffer canvas; the buffer is blitted to the visible canvas in one atomic `drawImage`. The resize handler does the resize + paint + blit synchronously in one task, so the cleared backing store is never composited — prevents flicker |
| **Grid line layer** | Body grid lines are drawn on a separate `alpha:true` offscreen canvas and composited on top of the cell buffer. On scroll-blit, the line buffer is blit-shifted identically to the cell buffer (one `drawImage` memcpy); only 1–2 newly-exposed edge lines are redrawn per frame instead of all N+M lines. BitBlt principle: memcpy >> rasterization |
| **Column-wise rendering** | Cell paint loop is column-major with one `clip()` per column; renderers cannot overflow their column's width, and height is the renderer's responsibility. Matches Phosphor's rendering direction and enables correct behaviour for arbitrary custom renderers |
| **Scroll-blit** | `drawImage` shifts existing pixels on small scroll deltas; only newly-exposed strips are painted (source = the buffer's previous frame). Applied to both the cell buffer and the line buffer |
| **Single rAF coalesce** | All grids share one `requestAnimationFrame` scheduler; multiple invalidations per tick collapse to one paint per grid |
| **ResizeObserver** | Per-grid observation; only changed grids reflow (original uses `window.onresize` for the whole tree) |
| **Pointer Events** | `setPointerCapture` for reliable drag tracking; no document-level mousemove leaks |
| **DockPanel collapse** | Split handles can be dragged to fully collapse an intermediate widget (snap threshold ~28 px); neighbors redistribute the freed space. Tab bar remains visible as a restore handle |
| **Monomorphic hot paths** | Per-renderer paint functions; no branching inside the cell loop |
| **Zero alloc per frame** | Module-level pre-allocated scratch `Float64Array`s for cell offsets; **11×** faster than per-frame allocation in d8 |
| **O(1) section offsets** | `SectionList.offsetOf` uses a prefix-sum formula instead of binary-search + linear scan over overrides (**1.92×** in d8) |
| **Batched offset fill** | One `fillScreenPositions(...)` call replaces ~92 `offsetOf` calls per visible frame (**9.6×** in d8) |
| **ctx state caching** | `font` / `textBaseline` / `textAlign` cached on the `TextRenderer` instance (plain JS object) to skip redundant canvas state writes; `resetCache()` per column after `ctx.restore()` |
| **Interned colors** | Viridis LUT is 256 pre-built `rgb(...)` strings; red/green tick palette is shared |

## Benchmarks

Two benchmark harnesses live under `bench/`:

```sh
# Hot-path micro-benchmarks via d8 (V8 standalone shell). 12 sections covering
# SectionList, paint scratch arrays, RAF flush, viridis LUT, etc.
d8 --allow-natives-syntax bench/d8-hotpaths.js

# Apples-to-apples comparison vs. the upstream PhosphorJS demo.
# Drives both pages through the same Chrome with synthetic input. Requires
# puppeteer-core but doesn't pollute package.json:
npm i --no-save puppeteer-core && node bench/head-to-head.mjs
```

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
  head-to-head.mjs          # puppeteer harness comparing this app vs. the original

.github/workflows/
  deploy.yml                # GitHub Pages deploy on push to main (OIDC)
```
