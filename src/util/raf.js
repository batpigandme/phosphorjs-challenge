// Single shared rAF scheduler. All paint-driven components subscribe their
// dirty-flag callback here; multiple invalidations in the same tick collapse
// to one paint per component per frame.
//
// Why one scheduler: with N grids each calling requestAnimationFrame on every
// model change, you get N callbacks per frame even though the browser can
// only paint once. Routing all of them through one rAF tick means each grid
// repaints at most once per frame regardless of how many invalidations it
// received.
//
// Shape stability: the scheduler holds a Set<() => void>. Callbacks are
// plain function references (no closure churn), so the Set never grows
// past the number of registered components.

/** @type {Set<() => void>} */
const dirty = new Set();
let scheduled = false;

const _flushBuf = new Array(16);
let _flushLen = 0;

function _collectCb(cb) {
	_flushBuf[_flushLen++] = cb;
}

function flush() {
	scheduled = false;
	_flushLen = 0;
	dirty.forEach(_collectCb);
	dirty.clear();
	for (let i = 0; i < _flushLen; i++) {
		_flushBuf[i]();
		_flushBuf[i] = null;
	}
}

/**
 * Mark `paintFn` dirty. The next animation frame will call it once.
 * Subsequent calls before the next frame are coalesced.
 *
 * @param {() => void} paintFn
 */
export function invalidate(paintFn) {
	dirty.add(paintFn);
	if (!scheduled) {
		scheduled = true;
		requestAnimationFrame(flush);
	}
}

/** Cancel a pending paint (e.g. on dispose). */
export function cancel(paintFn) {
	dirty.delete(paintFn);
}
