// d8-hotpaths.js — micro-benchmarks for the phosphorjs-challenge hot paths.
//
// Run:  d8 --allow-natives-syntax bench/d8-hotpaths.js
//
// Covers:
//   1. SectionList.offsetOf / indexOf  (uniform + with overrides)
//   2. SectionList.offsetOf O(1) candidate vs current O(lo) linear scan
//   3. xorshift128 PRNG throughput
//   4. RandomDataModel._tick() Float64Array update pattern
//   5. TextRenderer ctx-caching guard pattern (mock ctx)
//   6. RAF dirty-set flush: Array.from vs pre-allocated iteration
//   7. _paintBody scratch array: new Float64Array per call vs pre-allocated
//   8. String-building patterns for LargeDataModel.data()
//   9. viridis() table lookup throughput
//  10. Header paint: ctx.fillStyle inside loop vs hoisted outside

'use strict';

// ---- Harness ----------------------------------------------------------------

const ITERS_FAST   = 5_000_000;
const ITERS_MEDIUM = 1_000_000;
const ITERS_SLOW   =   100_000;

function pad(s, n) {
    while (s.length < n) s = s + ' ';
    return s;
}

function bench(name, fn, iters) {
    iters = iters || ITERS_FAST;
    // V8 14+: must call PrepareForOptimization before any warm-up, then
    // OptimizeFunctionOnNextCall just before the trigger call.
    %PrepareFunctionForOptimization(fn);
    // Warm up (allow IC stabilisation).
    for (let i = 0; i < 2000; i++) fn();
    %OptimizeFunctionOnNextCall(fn);
    fn(); // trigger optimisation
    // Drain any deopt / re-optimise:
    for (let i = 0; i < 200; i++) fn();

    const t0 = Date.now();
    for (let i = 0; i < iters; i++) fn();
    const ms = Date.now() - t0;
    const ns = (ms / iters) * 1e6;
    print(pad(name, 52) + '  ' + pad(ms + 'ms', 8) + '  ' + ns.toFixed(1) + ' ns/iter');
}

function section(title) {
    print('');
    print('=== ' + title + ' ===');
}

// ---- 1. SectionList ---------------------------------------------------------

// Paste the current implementation inline so d8 can benchmark it directly.

class SectionList {
    constructor(count, defaultSize) {
        this.count = count;
        this.defaultSize = defaultSize;
        this._overrides = new Map();
        this._delta = 0;
        this._sortedKeys = new Int32Array(0);
        this._sortedOffsets = new Float64Array(0);
        this._sortedDirty = false;
    }
    totalSize() { return this.count * this.defaultSize + this._delta; }
    sizeOf(i) { const o = this._overrides.get(i); return o === undefined ? this.defaultSize : o; }

    // CURRENT offsetOf: binary-search then linear scan over lo overrides.
    offsetOf(i) {
        if (i <= 0) return 0;
        if (i >= this.count) return this.totalSize();
        if (this._overrides.size === 0) return i * this.defaultSize;
        this._rebuildIfDirty();
        const keys = this._sortedKeys;
        let lo = 0, hi = keys.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (keys[mid] < i) lo = mid + 1; else hi = mid;
        }
        let extra = 0;
        for (let k = 0; k < lo; k++) {
            extra += this._overrides.get(keys[k]) - this.defaultSize;
        }
        return i * this.defaultSize + extra;
    }

    // OPTIMISED offsetOf: O(1) using prefix-sum stored in _sortedOffsets.
    // When lo < keys.length:
    //   _sortedOffsets[lo] = keys[lo] * defaultSize + Σ(override_k - default, k < lo)
    //   => Σ(override_k - default, k < lo) = _sortedOffsets[lo] - keys[lo]*defaultSize
    // When lo == keys.length: Σ = this._delta  (sum of all overrides).
    offsetOfFast(i) {
        if (i <= 0) return 0;
        if (i >= this.count) return this.totalSize();
        if (this._overrides.size === 0) return i * this.defaultSize;
        this._rebuildIfDirty();
        const keys = this._sortedKeys;
        let lo = 0, hi = keys.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (keys[mid] < i) lo = mid + 1; else hi = mid;
        }
        const extra = lo < keys.length
            ? this._sortedOffsets[lo] - keys[lo] * this.defaultSize
            : this._delta;
        return i * this.defaultSize + extra;
    }

    indexOf(px) {
        if (px < 0) return -1;
        const total = this.totalSize();
        if (px >= total) return this.count;
        if (this._overrides.size === 0) {
            const i = Math.floor(px / this.defaultSize);
            return i >= this.count ? this.count - 1 : i;
        }
        this._rebuildIfDirty();
        const keys = this._sortedKeys;
        const offs = this._sortedOffsets;
        let lo = 0, hi = keys.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (offs[mid] <= px) lo = mid + 1; else hi = mid;
        }
        if (lo === 0) return Math.floor(px / this.defaultSize);
        const k = lo - 1;
        const sectionStart = offs[k];
        const sectionIndex = keys[k];
        const sectionSize = this._overrides.get(sectionIndex);
        if (px < sectionStart + sectionSize) return sectionIndex;
        const after = sectionIndex + 1;
        const offsetAtAfter = sectionStart + sectionSize;
        const j = Math.floor((px - offsetAtAfter) / this.defaultSize);
        return after + j;
    }

    setSize(i, size) {
        if (i < 0 || i >= this.count) return;
        const prev = this._overrides.get(i);
        if (size < 0) {
            if (prev !== undefined) { this._delta -= prev - this.defaultSize; this._overrides.delete(i); this._sortedDirty = true; }
            return;
        }
        if (prev !== undefined) this._delta -= prev - this.defaultSize;
        this._overrides.set(i, size);
        this._delta += size - this.defaultSize;
        this._sortedDirty = true;
    }

    insert(i, n) {
        if (n <= 0) return;
        if (this._overrides.size > 0) {
            const next = new Map();
            for (const [k, v] of this._overrides) next.set(k >= i ? k + n : k, v);
            this._overrides = next;
            this._sortedDirty = true;
        }
        this.count += n;
    }

    remove(i, n) {
        if (n <= 0) return;
        if (this._overrides.size > 0) {
            const next = new Map();
            for (const [k, v] of this._overrides) {
                if (k >= i && k < i + n) this._delta -= v - this.defaultSize;
                else if (k >= i + n) next.set(k - n, v);
                else next.set(k, v);
            }
            this._overrides = next;
            this._sortedDirty = true;
        }
        this.count = Math.max(0, this.count - n);
    }

    _rebuildIfDirty() {
        if (!this._sortedDirty) return;
        const n = this._overrides.size;
        const keys = new Int32Array(n);
        let i = 0;
        for (const k of this._overrides.keys()) keys[i++] = k;
        keys.sort();
        const offs = new Float64Array(n);
        let extra = 0;
        for (let k = 0; k < n; k++) {
            offs[k] = keys[k] * this.defaultSize + extra;
            extra += this._overrides.get(keys[k]) - this.defaultSize;
        }
        this._sortedKeys = keys;
        this._sortedOffsets = offs;
        this._sortedDirty = false;
    }
}

section('1. SectionList — no overrides (hot path: uniform grid)');

const slUniform = new SectionList(1_000_000_000_000, 20); // trillion rows
let _sink = 0;
bench('offsetOf(i) — no overrides', () => {
    _sink += slUniform.offsetOf(500_000_000);
    _sink += slUniform.offsetOf(1);
    _sink += slUniform.offsetOf(999_999_999_999);
}, ITERS_FAST);

bench('indexOf(px) — no overrides', () => {
    _sink += slUniform.indexOf(10_000_000_000_000);
    _sink += slUniform.indexOf(40);
    _sink += slUniform.indexOf(1_999_999_999_980);
}, ITERS_FAST);

section('2. SectionList — with 5 overrides (column-resize case)');

const slOverrides = new SectionList(80, 60);
slOverrides.setSize(2, 120);
slOverrides.setSize(10, 90);
slOverrides.setSize(25, 150);
slOverrides.setSize(50, 80);
slOverrides.setSize(70, 100);
// Force rebuild before benchmarking.
slOverrides.offsetOf(0);

bench('offsetOf — current (binary-search + linear scan)', () => {
    _sink += slOverrides.offsetOf(0);
    _sink += slOverrides.offsetOf(3);
    _sink += slOverrides.offsetOf(11);
    _sink += slOverrides.offsetOf(30);
    _sink += slOverrides.offsetOf(55);
    _sink += slOverrides.offsetOf(75);
    _sink += slOverrides.offsetOf(80);
}, ITERS_FAST);

bench('offsetOfFast — O(1) prefix-sum formula', () => {
    _sink += slOverrides.offsetOfFast(0);
    _sink += slOverrides.offsetOfFast(3);
    _sink += slOverrides.offsetOfFast(11);
    _sink += slOverrides.offsetOfFast(30);
    _sink += slOverrides.offsetOfFast(55);
    _sink += slOverrides.offsetOfFast(75);
    _sink += slOverrides.offsetOfFast(80);
}, ITERS_FAST);

// Verify correctness.
for (let i = 0; i <= 80; i++) {
    const a = slOverrides.offsetOf(i);
    const b = slOverrides.offsetOfFast(i);
    if (a !== b) throw new Error('offsetOfFast mismatch at i=' + i + ': ' + a + ' vs ' + b);
}
print('  correctness: offsetOfFast matches offsetOf for all 0..80 ✓');

section('3. xorshift128 PRNG throughput');

function xorshift128(seed) {
    let s0 = seed | 0 || 1;
    let s1 = s0 * 1103515245 + 12345;
    let s2 = s1 * 1103515245 + 12345;
    let s3 = s2 * 1103515245 + 12345;
    return function next() {
        let t = s3;
        t ^= t << 11;
        t ^= t >>> 8;
        s3 = s2; s2 = s1; s1 = s0;
        t ^= s0;
        t ^= s0 >>> 19;
        s0 = t;
        return (t >>> 0) / 4294967296;
    };
}

const rng = xorshift128(42);
bench('xorshift128 — single call', () => {
    _sink += rng();
}, ITERS_FAST);

// Alternative: integer-only (skip the / 4294967296 division)
function xorshift128Int(seed) {
    let s0 = seed | 0 || 1;
    let s1 = s0 * 1103515245 + 12345;
    let s2 = s1 * 1103515245 + 12345;
    let s3 = s2 * 1103515245 + 12345;
    return function nextInt() {
        let t = s3;
        t ^= t << 11;
        t ^= t >>> 8;
        s3 = s2; s2 = s1; s1 = s0;
        t ^= s0;
        t ^= s0 >>> 19;
        s0 = t;
        return t >>> 0; // uint32, no float division
    };
}
const rngInt = xorshift128Int(42);
// For [0,1): v = rngInt() * (1/4294967296); — multiply is ~same cost as divide but foldable
const INV_U32 = 1 / 4294967296;
bench('xorshift128 — multiply by inv (1/2^32)', () => {
    _sink += rngInt() * INV_U32;
}, ITERS_FAST);

section('4. RandomDataModel._tick pattern — Float64Array random update');

const ROWS = 80, COLS = 80;
const buf = new Float64Array(ROWS * COLS);
const rng2 = xorshift128(9999);
// Pre-fill
for (let i = 0; i < buf.length; i++) buf[i] = rng2();

const DELTA_FRAC = 0.04;
const DELTA_AMP = 0.05;
const n = buf.length;
const k = Math.max(1, (n * DELTA_FRAC) | 0);

bench('_tick — Float64Array random update (' + k + '/' + n + ' cells)', () => {
    for (let i = 0; i < k; i++) {
        const idx = rng2() * n | 0;
        let v = buf[idx] + (rng2() - 0.5) * DELTA_AMP;
        if (v < 0) v = 0;
        else if (v > 1) v = 1;
        buf[idx] = v;
    }
}, ITERS_MEDIUM);

// Alternative: pre-compute (rng2() * n) as integer to avoid float->int conversion
const rng3 = xorshift128Int(9999);
const buf2 = new Float64Array(ROWS * COLS);
for (let i = 0; i < buf2.length; i++) buf2[i] = rng3() * INV_U32;

bench('_tick — integer rng, multiply-inv, clamp with Math.min/max', () => {
    for (let i = 0; i < k; i++) {
        const idx = (rng3() % n); // integer mod — avoid float path
        let v = buf2[idx] + (rng3() * INV_U32 - 0.5) * DELTA_AMP;
        buf2[idx] = v < 0 ? 0 : v > 1 ? 1 : v;
    }
}, ITERS_MEDIUM);

section('5. TextRenderer ctx-caching guard: effectiveness');

// Simulate the hot path inside TextRenderer.paint() with a mock ctx.
// Baseline: always set font/align/baseline
const mockCtxAlwaysSet = {
    font: '',
    textBaseline: '',
    textAlign: '',
    fillStyle: '',
    fillText: function(s, x, y, w) { _sink += s.length; }
};

const FONT = '12px ui-sans-serif, system-ui, sans-serif';
const ALIGN = 'right';

bench('ctx-state: always set font/align/baseline', () => {
    mockCtxAlwaysSet.font = FONT;
    mockCtxAlwaysSet.textBaseline = 'middle';
    mockCtxAlwaysSet.textAlign = ALIGN;
    mockCtxAlwaysSet.fillStyle = '#000';
    mockCtxAlwaysSet.fillText('0.42', 100, 10, 60);
}, ITERS_FAST);

// With caching guards (current approach)
const mockCtxCached = {
    font: '',
    textBaseline: '',
    textAlign: '',
    fillStyle: '',
    _cachedFont: null,
    _cachedBaseline: null,
    _cachedAlign: null,
    fillText: function(s, x, y, w) { _sink += s.length; }
};

bench('ctx-state: cached guards (skip if same)', () => {
    if (mockCtxCached._cachedFont !== FONT) { mockCtxCached.font = FONT; mockCtxCached._cachedFont = FONT; }
    if (mockCtxCached._cachedBaseline !== 'middle') { mockCtxCached.textBaseline = 'middle'; mockCtxCached._cachedBaseline = 'middle'; }
    if (mockCtxCached._cachedAlign !== ALIGN) { mockCtxCached.textAlign = ALIGN; mockCtxCached._cachedAlign = ALIGN; }
    mockCtxCached.fillStyle = '#000';
    mockCtxCached.fillText('0.42', 100, 10, 60);
}, ITERS_FAST);

section('6. RAF dirty-set flush: Array.from vs pre-allocated');

const dirtySetA = new Set();
function paintFn1() { _sink++; }
function paintFn2() { _sink++; }
function paintFn3() { _sink++; }
function paintFn4() { _sink++; }
function paintFn5() { _sink++; }

// Current: Array.from(dirty) allocates every flush
function flushCurrent() {
    dirtySetA.add(paintFn1); dirtySetA.add(paintFn2); dirtySetA.add(paintFn3);
    dirtySetA.add(paintFn4); dirtySetA.add(paintFn5);
    const callbacks = Array.from(dirtySetA);
    dirtySetA.clear();
    for (let i = 0; i < callbacks.length; i++) callbacks[i]();
}

const _preallocArr = new Array(16); // pre-allocated, re-used
let _preallocLen = 0;
const dirtySetB = new Set();

// Optimised: iterate Set directly, then clear
function flushOptimised() {
    dirtySetB.add(paintFn1); dirtySetB.add(paintFn2); dirtySetB.add(paintFn3);
    dirtySetB.add(paintFn4); dirtySetB.add(paintFn5);
    // Snapshot into pre-allocated array (avoids Array.from allocation)
    _preallocLen = 0;
    for (const cb of dirtySetB) _preallocArr[_preallocLen++] = cb;
    dirtySetB.clear();
    for (let i = 0; i < _preallocLen; i++) { _preallocArr[i](); _preallocArr[i] = null; }
}

bench('RAF flush: Array.from(dirty)', flushCurrent, ITERS_MEDIUM);
bench('RAF flush: pre-alloc snapshot', flushOptimised, ITERS_MEDIUM);

section('7. _paintBody scratch arrays: new Float64Array each call vs pre-alloc');

const nRows7 = 40, nCols7 = 50; // streaming grid

// Current: allocates 4 typed arrays every _paintBody call
function paintBodyScratchAlloc() {
    const rowYs = new Float64Array(nRows7 + 1);
    const rowHs = new Float64Array(nRows7);
    const colXs = new Float64Array(nCols7 + 1);
    const colWs = new Float64Array(nCols7);
    for (let i = 0; i <= nRows7; i++) rowYs[i] = i * 20;
    for (let i = 0; i < nRows7; i++) rowHs[i] = rowYs[i + 1] - rowYs[i];
    for (let i = 0; i <= nCols7; i++) colXs[i] = i * 64;
    for (let i = 0; i < nCols7; i++) colWs[i] = colXs[i + 1] - colXs[i];
    _sink += rowYs[nRows7] + colXs[nCols7];
}

// Optimised: pre-allocated scratch buffers (enough for max grid dims)
const MAX_ROWS = 256, MAX_COLS = 256;
const _rowYs = new Float64Array(MAX_ROWS + 1);
const _rowHs = new Float64Array(MAX_ROWS);
const _colXs = new Float64Array(MAX_COLS + 1);
const _colWs = new Float64Array(MAX_COLS);

function paintBodyScratchPrealloc() {
    for (let i = 0; i <= nRows7; i++) _rowYs[i] = i * 20;
    for (let i = 0; i < nRows7; i++) _rowHs[i] = _rowYs[i + 1] - _rowYs[i];
    for (let i = 0; i <= nCols7; i++) _colXs[i] = i * 64;
    for (let i = 0; i < nCols7; i++) _colWs[i] = _colXs[i + 1] - _colXs[i];
    _sink += _rowYs[nRows7] + _colXs[nCols7];
}

bench('paintBody scratch: new Float64Array each call', paintBodyScratchAlloc, ITERS_SLOW);
bench('paintBody scratch: pre-allocated arrays        ', paintBodyScratchPrealloc, ITERS_SLOW);

section('8. String building: LargeDataModel.data()');

bench('string concat: "(" + r + ", " + c + ")"', () => {
    const s = '(' + 123456789 + ', ' + 987654321 + ')';
    _sink += s.length;
}, ITERS_FAST);

bench('template literal: `(${r}, ${c})`', () => {
    const r = 123456789, c = 987654321;
    const s = `(${r}, ${c})`;
    _sink += s.length;
}, ITERS_FAST);

bench('string: String(n) vs n + ""', () => {
    _sink += (123456789 + '').length;
}, ITERS_FAST);

section('9. viridis() table lookup throughput');

const VIRIDIS_STOPS = [
    [68,1,84],[71,39,117],[59,81,139],[44,113,142],[33,144,141],
    [39,173,129],[92,200,99],[170,220,50],[253,231,37]
];
const VIRIDIS = (function() {
    const out = new Array(256);
    const stops = VIRIDIS_STOPS;
    const n = stops.length;
    for (let i = 0; i < 256; i++) {
        const t = (i / 255) * (n - 1);
        const k = Math.floor(t);
        const f = t - k;
        const a = stops[k], b = stops[Math.min(n - 1, k + 1)];
        const r = Math.round(a[0] + (b[0] - a[0]) * f);
        const g = Math.round(a[1] + (b[1] - a[1]) * f);
        const bl = Math.round(a[2] + (b[2] - a[2]) * f);
        out[i] = 'rgb(' + r + ',' + g + ',' + bl + ')';
    }
    return out;
})();

const rng4 = xorshift128(1234);
bench('viridis table lookup x4/iter', () => {
    const i = (rng4() * 255) | 0;
    _sink += VIRIDIS[i].length;
    _sink += VIRIDIS[(i + 64) & 255].length;
    _sink += VIRIDIS[(i + 128) & 255].length;
    _sink += VIRIDIS[(i + 192) & 255].length;
}, ITERS_FAST);

section('10. Header paint: ctx.fillStyle inside loop vs hoisted');

const mockHeader = {
    fillStyle: '',
    fillText: function(s, x, y, w) { _sink += s.length; }
};

// Current: sets fillStyle on every column header cell
function paintColHeadersInner() {
    for (let c = 0; c < 80; c++) {
        mockHeader.fillStyle = '#000'; // redundant after first iter
        mockHeader.fillText('C: 0, ' + c, c * 60 + 30, 12, 54);
    }
}
bench('header: fillStyle inside loop (×80)', paintColHeadersInner, ITERS_MEDIUM);

// Fixed: hoist fillStyle before loop
function paintColHeadersHoisted() {
    mockHeader.fillStyle = '#000';
    for (let c = 0; c < 80; c++) {
        mockHeader.fillText('C: 0, ' + c, c * 60 + 30, 12, 54);
    }
}
bench('header: fillStyle hoisted before loop (×80)', paintColHeadersHoisted, ITERS_MEDIUM);

section('11a. fillScreenPositions — uniform fast path vs offsetOf loop');

// Add fillScreenPositions to benchmark SectionList (inline the updated logic)
SectionList.prototype.fillScreenPositions = function(start, n, base, dest) {
    const d = this.defaultSize;
    if (this._overrides.size === 0 && (d | 0) === d) {
        const origin = Math.floor(base + start * d);
        for (let i = 0; i <= n; i++) dest[i] = origin + i * d;
    } else {
        for (let i = 0; i <= n; i++) {
            dest[i] = Math.floor(base + this.offsetOf(start + i));
        }
    }
};

const destBuf = new Float64Array(513);
const slFast = new SectionList(500, 20);
const slFastC = new SectionList(50, 96);

// Verify correctness.
slFast.fillScreenPositions(10, 40, 24 - 0, destBuf);
for (let i = 0; i <= 40; i++) {
    const expected = Math.floor(24 + slFast.offsetOf(10 + i) - 0);
    if (destBuf[i] !== expected) throw new Error('fillScreenPositions mismatch at i=' + i);
}
print('  correctness: fillScreenPositions uniform fast path ✓');

function simOldOffsetLoop() {
    for (let i = 0; i <= 40; i++) _sink += slFast.offsetOf(10 + i);
    for (let i = 0; i <= 50; i++) _sink += slFastC.offsetOf(i);
}
function simFillPositions() {
    slFast.fillScreenPositions(10, 40, 0, destBuf);
    slFastC.fillScreenPositions(0, 50, 0, destBuf);
    _sink += destBuf[0] + destBuf[50];
}

bench('old: 41+51 offsetOf() calls per frame', simOldOffsetLoop, ITERS_MEDIUM);
bench('new: 2 fillScreenPositions() calls per frame', simFillPositions, ITERS_MEDIUM);

section('11. SectionList.offsetOf — full frame simulation');
// Simulate what _paintBody does: compute nRows+nCols offsets for a 40×50 grid.
const slStream = new SectionList(500, 20); // streaming model: up to 500 rows, 50 cols
const slStreamC = new SectionList(50, 96);

function simPaintBodyOffsets() {
    const r0 = 10, r1 = 50, c0 = 5, c1 = 55;
    for (let i = 0; i <= (r1 - r0); i++) _sink += slStream.offsetOf(r0 + i);
    for (let i = 0; i <= (c1 - c0); i++) _sink += slStreamC.offsetOf(c0 + i);
}
bench('offsetOf loop — 40 rows + 50 cols, no overrides', simPaintBodyOffsets, ITERS_MEDIUM);

// With 5 resized columns
const slStreamCOverride = new SectionList(50, 96);
slStreamCOverride.setSize(10, 150);
slStreamCOverride.setSize(20, 120);
slStreamCOverride.setSize(30, 80);
slStreamCOverride.setSize(40, 110);
slStreamCOverride.setSize(45, 70);
slStreamCOverride.offsetOf(0); // force rebuild

function simPaintBodyOffsetsCurrent() {
    const r0 = 10, r1 = 50, c0 = 5, c1 = 49;
    for (let i = 0; i <= (r1 - r0); i++) _sink += slStream.offsetOf(r0 + i);
    for (let i = 0; i <= (c1 - c0); i++) _sink += slStreamCOverride.offsetOf(c0 + i);
}
function simPaintBodyOffsetsFast() {
    const r0 = 10, r1 = 50, c0 = 5, c1 = 49;
    for (let i = 0; i <= (r1 - r0); i++) _sink += slStream.offsetOf(r0 + i);
    for (let i = 0; i <= (c1 - c0); i++) _sink += slStreamCOverride.offsetOfFast(c0 + i);
}

bench('offsetOf loop — 40 rows + col overrides (current)', simPaintBodyOffsetsCurrent, ITERS_MEDIUM);
bench('offsetOfFast loop — 40 rows + col overrides (fast)', simPaintBodyOffsetsFast, ITERS_MEDIUM);

section('12. Math.floor redundancy in grid lines');
// Current: rowYs already floor()'d, but grid-lines loop calls Math.floor(rowYs[i]) again.
const rowYsPrefloor = new Float64Array(41);
for (let i = 0; i <= 40; i++) rowYsPrefloor[i] = Math.floor(24 + i * 20 - 0); // already floored

bench('grid lines: Math.floor(rowYs[i]) + 0.5 (redundant)', () => {
    let sum = 0;
    for (let i = 0; i <= 40; i++) sum += Math.floor(rowYsPrefloor[i]) + 0.5;
    _sink += sum;
}, ITERS_MEDIUM);

bench('grid lines: rowYs[i] + 0.5 (already floored)', () => {
    let sum = 0;
    for (let i = 0; i <= 40; i++) sum += rowYsPrefloor[i] + 0.5;
    _sink += sum;
}, ITERS_MEDIUM);

// ---- Summary ----------------------------------------------------------------
print('');
print('_sink (prevent dead-code elimination): ' + _sink);
print('');
print('Done.');
