// Lightweight FPS / paint counter overlay. Runs its own rAF loop counting
// frames; subscribes to the shared rAF scheduler via a paint-instrumentation
// hook to count actual grid paints per second.
//
// Toggled by including `#fps` in the URL hash.

let _paintCount = 0;
export function notePaint() {
	_paintCount++;
}

export function attachFPSOverlay() {
	if (!location.hash.includes('fps')) return;
	const el = document.createElement('div');
	el.style.cssText =
		'position:fixed;top:6px;right:6px;z-index:9999;' +
		'padding:4px 8px;background:rgba(0,0,0,0.75);color:#0f0;' +
		'font:11px ui-monospace,Consolas,monospace;border-radius:3px;' +
		'pointer-events:none;';
	el.textContent = 'fps: --';
	document.body.appendChild(el);
	let frames = 0;
	let lastT = performance.now();
	let lastPaintCount = 0;
	const tick = (t) => {
		frames++;
		if (t - lastT >= 1000) {
			const fps = (frames * 1000) / (t - lastT);
			const paints = _paintCount - lastPaintCount;
			el.textContent =
				'fps: ' + fps.toFixed(0) + '  paints/s: ' + paints + '  dpr: ' + window.devicePixelRatio;
			frames = 0;
			lastT = t;
			lastPaintCount = _paintCount;
		}
		requestAnimationFrame(tick);
	};
	requestAnimationFrame(tick);
}
