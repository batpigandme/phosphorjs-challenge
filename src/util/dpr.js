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
const GRANULARITY = 512;

export function resizeCanvas(canvas, cssWidth, cssHeight) {
	const dpr = window.devicePixelRatio || 1;
	const needW = Math.max(1, Math.round(cssWidth * dpr));
	const needH = Math.max(1, Math.round(cssHeight * dpr));
	canvas.style.width = cssWidth + 'px';
	canvas.style.height = cssHeight + 'px';
	const curW = canvas.width;
	const curH = canvas.height;
	if (needW <= curW && needH <= curH &&
		needW > curW - GRANULARITY && needH > curH - GRANULARITY) {
		return false;
	}
	const allocW = (Math.ceil(needW / GRANULARITY) + 1) * GRANULARITY;
	const allocH = (Math.ceil(needH / GRANULARITY) + 1) * GRANULARITY;
	canvas.width = allocW;
	canvas.height = allocH;
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
