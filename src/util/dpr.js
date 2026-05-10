// HiDPI canvas sizing. Backing store at css * dpr; transform scaled so that
// drawing in CSS pixels maps 1:1 to backing pixels and stays crisp on retina.

/**
 * Resize a canvas to (cssWidth, cssHeight) accounting for devicePixelRatio.
 * Returns true if the backing store actually changed (caller should repaint).
 *
 * Backing store is sized to exact CSS×DPR — the browser stretches the entire
 * backing store into the CSS display rect, so over-allocating causes black
 * bands at the margins. CSS-only canvases (no DOM parent) still need both
 * dimensions set for drawImage to behave consistently.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {number} cssWidth
 * @param {number} cssHeight
 * @returns {boolean}
 */
export function resizeCanvas(canvas, cssWidth, cssHeight) {
	const dpr = window.devicePixelRatio || 1;
	const needW = Math.max(1, Math.round(cssWidth * dpr));
	const needH = Math.max(1, Math.round(cssHeight * dpr));
	canvas.style.width = cssWidth + 'px';
	canvas.style.height = cssHeight + 'px';
	if (needW === canvas.width && needH === canvas.height) {
		return false;
	}
	canvas.width = needW;
	canvas.height = needH;
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
