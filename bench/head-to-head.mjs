// Head-to-head benchmark: original PhosphorJS demo vs. this reimplementation.
//
// Apples-to-apples: same Chrome, same viewport, same workload script. Each
// metric runs N times and the median is reported.
//
// Metrics:
//   1. Network: bytes on the wire + decoded bytes, request count
//   2. Load time (DOMContentLoaded → networkidle0)
//   3. Steady-state idle FPS (3 s observation, no input)
//   4. Scroll FPS + per-frame interval percentiles (3 s of synthetic wheel events)
//   5. Resize-to-paint latency (30 random viewport sizes)
//
// Requires puppeteer-core (kept out of package.json so this repo stays at
// zero runtime deps + Vite-only dev deps). One-shot install + run:
//   npm i --no-save puppeteer-core && node bench/head-to-head.mjs
//
// macOS Chrome path is the default; override via CHROME env var on Linux/Win.

import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME ||
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const TARGETS = {
    'Original PhosphorJS': 'https://phosphorjs.github.io/examples/datagrid/',
    'This implementation': 'https://batpigandme.github.io/phosphorjs-challenge/',
};

const VIEWPORT = { width: 1280, height: 800 };

function median(xs) { const s = xs.slice().sort((a,b)=>a-b); return s[Math.floor(s.length/2)]; }

async function measure(url) {
    const browser = await puppeteer.launch({
        executablePath: CHROME,
        headless: 'new',
        defaultViewport: VIEWPORT,
        args: ['--no-sandbox', '--disable-features=PaintHolding'],
    });
    const page = await browser.newPage();

    // --- Network accounting via CDP ---
    let bytesOnWire = 0;
    let bytesUncompressed = 0;
    let requestCount = 0;
    const cdp = await page.target().createCDPSession();
    await cdp.send('Network.enable');
    cdp.on('Network.loadingFinished', e => {
        bytesOnWire += e.encodedDataLength;
    });
    cdp.on('Network.responseReceived', e => {
        requestCount += 1;
    });

    const t0 = Date.now();
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
    const loadMs = Date.now() - t0;

    // Get true content sizes (decoded) for the JS payload(s):
    bytesUncompressed = await page.evaluate(async () => {
        const entries = performance.getEntriesByType('resource');
        return entries.reduce((acc, e) => acc + (e.decodedBodySize || 0), 0);
    });

    // Wait a beat for first idle frame + tickers to settle.
    await new Promise(r => setTimeout(r, 1000));

    // --- Idle FPS (3 s observation) ---
    const idleFps = await page.evaluate(async () => {
        return await new Promise(resolve => {
            let frames = 0;
            const start = performance.now();
            function tick() {
                frames++;
                if (performance.now() - start < 3000) requestAnimationFrame(tick);
                else resolve(frames / 3);
            }
            requestAnimationFrame(tick);
        });
    });

    // --- Scroll FPS + per-frame script time over 3 s wheel-spam ---
    const scroll = await page.evaluate(async () => {
        const canvases = Array.from(document.querySelectorAll('canvas'));
        if (canvases.length === 0) return { fps: 0, longTasks: 0, frames: 0, scriptP50: 0, scriptMax: 0, scriptP95: 0 };
        canvases.sort((a, b) => (b.width * b.height) - (a.width * a.height));
        const target = canvases[0];

        let longTasks = 0;
        const lt = new PerformanceObserver(list => { longTasks += list.getEntries().length; });
        try { lt.observe({ entryTypes: ['longtask'] }); } catch (e) {}

        // Per-frame script time: time spent between rAF dispatch and rAF return.
        // We bracket the rAF callback with setTimeout(0) to mark task boundary,
        // but a simpler proxy: time inside our rAF cb = browser-given
        // budget consumed by JS this frame.
        const frameTimes = [];
        let rafActive = true;
        let prevT = performance.now();

        function rafLoop(t) {
            // Time since last rAF returned ≈ idle + paint + composite. The work
            // *we* do in this callback we measure separately:
            const cbStart = performance.now();
            // Burn no work — we want to measure how much script the *page* runs
            // per frame (its own rAF callbacks, model ticks, etc.). The metric
            // we care about is "frame interval" — gap between consecutive rAFs.
            // If the page's own paint takes >1 frame we'll see >8.3ms intervals.
            const interval = cbStart - prevT;
            frameTimes.push(interval);
            prevT = cbStart;
            if (rafActive) requestAnimationFrame(rafLoop);
        }
        requestAnimationFrame(rafLoop);

        const rect = target.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const interval = setInterval(() => {
            target.dispatchEvent(new WheelEvent('wheel', {
                bubbles: true, cancelable: true,
                deltaY: 100, clientX: cx, clientY: cy,
            }));
        }, 16);

        const start = performance.now();
        await new Promise(r => setTimeout(r, 3000));
        clearInterval(interval);
        rafActive = false;
        try { lt.disconnect(); } catch {}

        const elapsed = (performance.now() - start) / 1000;
        // Drop first/last frame intervals (warm-up / shutdown).
        const trimmed = frameTimes.slice(2, -2).sort((a, b) => a - b);
        const pct = (p) => trimmed[Math.floor(trimmed.length * p)] || 0;
        return {
            fps: frameTimes.length / elapsed,
            longTasks,
            frames: frameTimes.length,
            frameP50: pct(0.5),
            frameP95: pct(0.95),
            frameMax: trimmed[trimmed.length - 1] || 0,
        };
    });

    // --- Resize stress: 60 random sizes, measure JS-time per resize ---
    const resize = await measureResizeLatency(page, browser);

    await browser.close();

    return {
        loadMs,
        bytesOnWire,
        bytesUncompressed,
        requestCount,
        idleFps,
        scrollFps: scroll.fps,
        scrollLongTasks: scroll.longTasks,
        scrollFrameP50: scroll.frameP50,
        scrollFrameP95: scroll.frameP95,
        scrollFrameMax: scroll.frameMax,
        resizeMs_p50: median(resize),
        resizeMs_max: Math.max(...resize),
        resizeMs_min: Math.min(...resize),
    };
}

async function measureResizeLatency(page, browser) {
    // Resize the OS window via CDP, measure JS task time per resize.
    // We approximate "resize → first paint" as the JS task (synchronous resize
    // observers + paint) by timing rAF after a setViewport.
    const sizes = [];
    for (let i = 0; i < 30; i++) {
        const w = 800 + (i * 13) % 600;
        const h = 500 + (i * 17) % 350;
        sizes.push({ width: w, height: h });
    }

    const samples = [];
    for (const s of sizes) {
        await page.setViewport(s);
        const ms = await page.evaluate(async () => {
            // Wait for next rAF, that's our "first frame after resize"
            const t0 = performance.now();
            await new Promise(r => requestAnimationFrame(() => r()));
            return performance.now() - t0;
        });
        samples.push(ms);
    }
    return samples;
}

// ----------- main -----------
const RUNS = 3;

function pickRunSummary(passes) {
    // Use median run for each metric independently to wash out outliers.
    const keys = Object.keys(passes[0]);
    const out = {};
    for (const k of keys) {
        const vals = passes.map(p => p[k]).sort((a, b) => a - b);
        out[k] = vals[Math.floor(vals.length / 2)];
    }
    return out;
}

const results = {};
for (const [label, url] of Object.entries(TARGETS)) {
    const passes = [];
    for (let r = 0; r < RUNS; r++) {
        process.stderr.write(`[${label}] run ${r+1}/${RUNS} ...\n`);
        passes.push(await measure(url));
    }
    results[label] = [pickRunSummary(passes)];
}

function fmtBytes(n) {
    if (n >= 1024*1024) return (n/1024/1024).toFixed(2) + ' MB';
    if (n >= 1024) return (n/1024).toFixed(1) + ' KB';
    return n + ' B';
}

console.log('\n=== Head-to-head ===');
for (const [label, passes] of Object.entries(results)) {
    const r = passes[0]; // single run
    console.log(`\n--- ${label} ---`);
    console.log(`  Load (DCL→networkidle):      ${r.loadMs} ms`);
    console.log(`  Total bytes on wire:         ${fmtBytes(r.bytesOnWire)} (${r.bytesOnWire.toLocaleString()} B, ${r.requestCount} requests)`);
    console.log(`  Total bytes decoded:         ${fmtBytes(r.bytesUncompressed)} (${r.bytesUncompressed.toLocaleString()} B)`);
    console.log(`  Idle FPS (3 s):              ${r.idleFps.toFixed(1)}`);
    console.log(`  Scroll FPS (3 s wheel-spam): ${r.scrollFps.toFixed(1)}  long-tasks: ${r.scrollLongTasks}`);
    console.log(`  Scroll frame interval:       p50 ${r.scrollFrameP50.toFixed(2)} ms  p95 ${r.scrollFrameP95.toFixed(2)}  max ${r.scrollFrameMax.toFixed(2)}`);
    console.log(`  Resize JS time per frame:    p50 ${r.resizeMs_p50.toFixed(2)} ms  min ${r.resizeMs_min.toFixed(2)}  max ${r.resizeMs_max.toFixed(2)}`);
}

console.log('\n=== Ratio (original ÷ ours) ===');
const a = results['Original PhosphorJS'][0];
const b = results['This implementation'][0];
console.log(`  Bytes on wire:    ${(a.bytesOnWire / b.bytesOnWire).toFixed(1)}× larger`);
console.log(`  Bytes decoded:    ${(a.bytesUncompressed / b.bytesUncompressed).toFixed(1)}× larger`);
console.log(`  Load time:        ${(a.loadMs / b.loadMs).toFixed(2)}× slower`);
console.log(`  Resize p50:       ${(a.resizeMs_p50 / b.resizeMs_p50).toFixed(2)}× slower`);
