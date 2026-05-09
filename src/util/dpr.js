// HiDPI canvas sizing. Backing store at css * dpr; transform scaled so that
// drawing in CSS pixels maps 1:1 to backing pixels and stays crisp on retina.
//
// The Phosphor demo predates a lot of HiDPI hygiene; on a 2x display its
// text antialiasing is noticeably soft. We get crisp text for free by
// resizing on every observed dimension change.

/**
 * Resize a canvas to (cssWidth, cssHeight) accounting for devicePixelRatio.
 * Returns true if the backing store actually changed (caller should repaint).
 *
 * @param {HTMLCanvasElement} canvas
 * @param {number} cssWidth
 * @param {number} cssHeight
 * @returns {boolean}
 */
export function resizeCanvas(canvas, cssWidth, cssHeight) {
	const dpr = window.devicePixelRatio || 1;
	const w = Math.max(1, Math.round(cssWidth * dpr));
	const h = Math.max(1, Math.round(cssHeight * dpr));
	if (canvas.width === w && canvas.height === h) {
		// Still update CSS size in case the layout changed by a sub-pixel.
		canvas.style.width = cssWidth + 'px';
		canvas.style.height = cssHeight + 'px';
		return false;
	}
	canvas.width = w;
	canvas.height = h;
	canvas.style.width = cssWidth + 'px';
	canvas.style.height = cssHeight + 'px';
	return true;
}

/**
 * Apply the dpr transform to a 2d context. Call after resizeCanvas, before
 * any drawing, on each paint. Resets to identity first so it's idempotent.
 *
 * @param {CanvasRenderingContext2D} ctx
 */
export function applyDpr(ctx) {
	const dpr = window.devicePixelRatio || 1;
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
