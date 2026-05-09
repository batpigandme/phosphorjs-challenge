# PhosphorJS DataGrid Challenge

> "For all the AI enthusiasts, vibe-code a website that does the same thing as
> this website, but with better performance, and DONT import any of my
> Phosphor/Lumino code. In fact, no external libs cause Phosphor/Lumino doesn't
> use any. Click around for a bit, drag/dock some tabs, resize some things
> including the browser window to get a feel for the requirements.
> https://phosphorjs.github.io/examples/datagrid/
> This page is over 10yrs old at this point. Can you beat it?"

## What this is

A from-scratch reimplementation of the [PhosphorJS DataGrid demo](https://phosphorjs.github.io/examples/datagrid/) with **zero runtime dependencies**. The only dependency is Vite (dev-only, for bundling).

The demo reproduces the full interaction surface of the original:

- **DockPanel** with drag-and-drop tab rearrangement and split zones
- **Resizable splitters** between all panels
- **Canvas-based virtualized DataGrid** rendering five data models:
  - **Trillion Rows/Cols** -- 10^12 x 10^12 synthesized cells, smooth scroll
  - **Streaming Rows** -- rows added/removed on a 250ms tick
  - **Random Ticks 1** -- red/green colored floats updating at 60ms
  - **Random Ticks 2** -- 80x80 viridis heatmap updating at 60ms
  - **JSON Data** -- inline cars dataset

## Performance wins over the original

| Area | How |
|---|---|
| **HiDPI rendering** | Canvas backing store sized at `cssW * devicePixelRatio`; crisp on retina |
| **Scroll-blit** | `drawImage` shifts existing pixels on small scroll deltas; only newly-exposed strips are painted |
| **Single rAF coalesce** | All grids share one `requestAnimationFrame` scheduler; multiple invalidations per tick collapse to one paint per grid |
| **ResizeObserver** | Per-grid observation; only changed grids reflow (original uses `window.onresize` for the whole tree) |
| **Pointer Events** | `setPointerCapture` for reliable drag tracking; no document-level mousemove leaks |
| **Monomorphic hot paths** | Per-renderer paint functions; no branching inside the cell loop |
| **Zero alloc per frame** | No objects, arrays, or closures created in the cell paint loop; viridis colors are 256 interned strings |
| **Bundle size** | 29 KB raw / 9.4 KB gzipped (JS) vs. the original's ~200 KB Phosphor bundle |

## Getting started

```sh
npm install
npm run dev        # http://localhost:5173
```

Append `#fps` to the URL to show the FPS/paints-per-second overlay.

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
```
