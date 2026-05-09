// Canvas-virtualized DataGrid.
//
// Layout (CSS px):
//   +--------+----------------------------+ +
//   | corner | column headers             | | header row (rowHeaderH)
//   +--------+----------------------------+ +
//   |        |                            |
//   | row    | body                       | (vertical body region)
//   | hdrs   |                            |
//   |        |                            |
//   +--------+----------------------------+
//   | h-scrollbar (across body+rowhdrs)   |
//   +-------------------------------------+
//
// Painting strategy:
//   * Single canvas, single 2d ctx. Backing store sized for devicePixelRatio.
//   * On invalidate, the rAF scheduler calls `_paint` once per frame.
//   * `_paint` chooses between three modes:
//       - 'full': repaint every region (resize, model reset, theme change).
//       - 'scroll': scroll-blit the body (and header strips on the moving axis)
//                   and only paint the newly-exposed strips. Used when only
//                   scroll position changed and the delta is small enough for
//                   the existing pixels to be reused.
//       - 'cells': repaint a dirty cell rect on top of unchanged pixels.
//
// Trillion-row scrolling: scrollY is a Float64 in body-pixel coordinates.
// JS doubles preserve integers exactly up to 2^53, so 1e12 rows × 20px = 2e13 px
// is well within range. The scrollbar UI represents fractional position
// (0..1) and translates to/from this absolute pixel coordinate.

import { invalidate, cancel } from '../util/raf.js';
import { resizeCanvas, applyDpr } from '../util/dpr.js';
import { notePaint } from '../util/fps.js';
import { SectionList } from './sectionList.js';

const HEADER_FONT = '12px ui-sans-serif, system-ui, sans-serif';
const BODY_FONT = '12px ui-sans-serif, system-ui, sans-serif';
const SCROLLBAR_SIZE = 12;
const MIN_THUMB = 24;

export class DataGrid {
	/**
	 * @param {HTMLElement} host
	 * @param {{
	 *   model: import('../data/DataModel.js').DataModel,
	 *   rowHeight?: number,
	 *   colWidth?: number,
	 *   rowHeaderWidth?: number,
	 *   colHeaderHeight?: number,
	 *   theme?: 'blue'|'brown'|'green'|null,
	 *   renderer?: import('./CellRenderer.js').CellRenderer | null
	 * }} opts
	 */
	constructor(host, opts) {
		this.host = host;
		this.model = opts.model;
		this.rowHeight = opts.rowHeight ?? 20;
		this.colWidth = opts.colWidth ?? 64;
		this.rowHeaderWidth = opts.rowHeaderWidth ?? 64;
		this.colHeaderHeight = opts.colHeaderHeight ?? 24;
		this.theme = opts.theme ?? null;
		this.renderer = opts.renderer ?? null;

		this.rows = new SectionList(this.model.rowCount(), this.rowHeight);
		this.cols = new SectionList(this.model.columnCount(), this.colWidth);

		// Dimensions in CSS pixels.
		this.cssWidth = 0;
		this.cssHeight = 0;
		// Body region (excludes headers + scrollbars).
		this.bodyW = 0;
		this.bodyH = 0;
		// Scroll position in body-pixel coordinates.
		this.scrollX = 0;
		this.scrollY = 0;
		// Previous scroll for blit decisions.
		this._prevScrollX = 0;
		this._prevScrollY = 0;
		// Repaint mode for the next frame.
		/** @type {'full'|'scroll'|'cells'} */
		this._mode = 'full';

		// Stripe theme colors looked up once.
		this._stripe = stripeFor(this.theme);

		// Build DOM: a positioned canvas inside `host`.
		host.classList.add('grid-host');
		if (this.theme) host.classList.add('theme-' + this.theme);
		this.canvas = document.createElement('canvas');
		this.canvas.style.position = 'absolute';
		this.canvas.style.inset = '0';
		this.canvas.style.cursor = 'default';
		host.appendChild(this.canvas);
		const ctx = this.canvas.getContext('2d', { alpha: false });
		if (!ctx) throw new Error('2d context unavailable');
		this.ctx = ctx;

		// Bound paint callback so the rAF scheduler keys on a stable identity.
		this._paint = this._paint.bind(this);

		// Resize via ResizeObserver — only the affected element reflows.
		this._ro = new ResizeObserver(() => this._handleResize());
		this._ro.observe(host);

		// Wheel scrolling.
		this._onWheel = this._onWheel.bind(this);
		this.canvas.addEventListener('wheel', this._onWheel, { passive: false });

		// Scrollbar drag.
		this._onPointerDown = this._onPointerDown.bind(this);
		this.canvas.addEventListener('pointerdown', this._onPointerDown);

		// Subscribe to model changes.
		this._onModelChange = this._onModelChange.bind(this);
		this.model.on(this._onModelChange);

		this._handleResize();
	}

	dispose() {
		cancel(this._paint);
		this._ro.disconnect();
		this.canvas.removeEventListener('wheel', this._onWheel);
		this.model.off(this._onModelChange);
		this.host.removeChild(this.canvas);
	}

	_onModelChange(change) {
		// Update section lists for row insert/remove; cell changes just dirty-paint.
		if (change && typeof change === 'object') {
			if (change.kind === 0 /* ROWS_INSERTED */) {
				this.rows.insert(change.index, change.span);
			} else if (change.kind === 1 /* ROWS_REMOVED */) {
				this.rows.remove(change.index, change.span);
			} else if (change.kind === 2 /* COLUMNS_INSERTED */) {
				this.cols.insert(change.index, change.span);
			} else if (change.kind === 3 /* COLUMNS_REMOVED */) {
				this.cols.remove(change.index, change.span);
			} else if (change.kind === 5 /* MODEL_RESET */) {
				this.rows = new SectionList(this.model.rowCount(), this.rowHeight);
				this.cols = new SectionList(this.model.columnCount(), this.colWidth);
				this.scrollX = 0;
				this.scrollY = 0;
			}
		}
		this._mode = 'full';
		invalidate(this._paint);
	}

	_handleResize() {
		const rect = this.host.getBoundingClientRect();
		this.cssWidth = Math.max(0, rect.width);
		this.cssHeight = Math.max(0, rect.height);
		this.bodyW = Math.max(0, this.cssWidth - this.rowHeaderWidth - SCROLLBAR_SIZE);
		this.bodyH = Math.max(0, this.cssHeight - this.colHeaderHeight - SCROLLBAR_SIZE);
		const changed = resizeCanvas(this.canvas, this.cssWidth, this.cssHeight);
		this._mode = 'full';
		if (changed || true) invalidate(this._paint);
	}

	// Maximum scrollable distance in px on each axis.
	get _scrollMaxX() {
		return Math.max(0, this.cols.totalSize() - this.bodyW);
	}
	get _scrollMaxY() {
		return Math.max(0, this.rows.totalSize() - this.bodyH);
	}

	scrollBy(dx, dy) {
		const nx = clamp(this.scrollX + dx, 0, this._scrollMaxX);
		const ny = clamp(this.scrollY + dy, 0, this._scrollMaxY);
		if (nx === this.scrollX && ny === this.scrollY) return;
		this.scrollX = nx;
		this.scrollY = ny;
		// Tag for scroll-blit on next paint (full-paint takes priority if set).
		if (this._mode !== 'full') this._mode = 'scroll';
		invalidate(this._paint);
	}

	scrollTo(x, y) {
		this.scrollBy(x - this.scrollX, y - this.scrollY);
	}

	_onWheel(e) {
		e.preventDefault();
		const factor = e.deltaMode === 1 ? this.rowHeight : 1;
		this.scrollBy(e.deltaX * factor, e.deltaY * factor);
	}

	// Scrollbar drag. Hit-test the click against the scrollbar tracks; if it
	// lands on a thumb, start a drag; if on a track, page-jump.
	_onPointerDown(e) {
		if (e.button !== 0) return;
		const rect = this.canvas.getBoundingClientRect();
		const x = e.clientX - rect.left;
		const y = e.clientY - rect.top;
		// Vertical scrollbar region.
		const vTrackX = this.cssWidth - SCROLLBAR_SIZE;
		const vTrackY = this.colHeaderHeight;
		const vTrackH = this.bodyH;
		// Horizontal scrollbar region.
		const hTrackX = this.rowHeaderWidth;
		const hTrackY = this.cssHeight - SCROLLBAR_SIZE;
		const hTrackW = this.bodyW;
		const inV =
			x >= vTrackX && x < vTrackX + SCROLLBAR_SIZE && y >= vTrackY && y < vTrackY + vTrackH;
		const inH =
			y >= hTrackY && y < hTrackY + SCROLLBAR_SIZE && x >= hTrackX && x < hTrackX + hTrackW;
		if (!inV && !inH) return;
		e.preventDefault();
		this.canvas.setPointerCapture(e.pointerId);
		const axis = inV ? 'y' : 'x';
		const trackStart = axis === 'y' ? vTrackY : hTrackX;
		const trackLen = axis === 'y' ? vTrackH : hTrackW;
		const totalContent = axis === 'y' ? this.rows.totalSize() : this.cols.totalSize();
		const view = axis === 'y' ? this.bodyH : this.bodyW;
		const thumbLen = Math.max(MIN_THUMB, (view / totalContent) * trackLen);
		const scrollMax = axis === 'y' ? this._scrollMaxY : this._scrollMaxX;
		const fracOf = (cursorPx) => {
			const lo = trackStart;
			const hi = trackStart + trackLen - thumbLen;
			if (hi <= lo) return 0;
			return clamp((cursorPx - thumbLen / 2 - lo) / (hi - lo), 0, 1);
		};
		// If pointer is on the thumb, preserve the offset within the thumb so
		// the thumb doesn't jump.
		const startCursor = axis === 'y' ? y : x;
		const startFrac =
			scrollMax === 0 ? 0 : (axis === 'y' ? this.scrollY : this.scrollX) / scrollMax;
		const startThumbStart = trackStart + startFrac * (trackLen - thumbLen);
		const onThumb =
			startCursor >= startThumbStart && startCursor < startThumbStart + thumbLen;
		const cursorOffset = onThumb ? startCursor - startThumbStart - thumbLen / 2 : 0;
		const apply = (cursorPx) => {
			const frac = fracOf(cursorPx - cursorOffset);
			const target = frac * scrollMax;
			if (axis === 'y') this.scrollTo(this.scrollX, target);
			else this.scrollTo(target, this.scrollY);
		};
		// Initial jump for track-clicks (not on thumb).
		if (!onThumb) apply(startCursor);
		const move = (ev) => {
			const r = this.canvas.getBoundingClientRect();
			const cx = ev.clientX - r.left;
			const cy = ev.clientY - r.top;
			apply(axis === 'y' ? cy : cx);
		};
		const up = () => {
			this.canvas.releasePointerCapture(e.pointerId);
			this.canvas.removeEventListener('pointermove', move);
			this.canvas.removeEventListener('pointerup', up);
			this.canvas.removeEventListener('pointercancel', up);
		};
		this.canvas.addEventListener('pointermove', move);
		this.canvas.addEventListener('pointerup', up);
		this.canvas.addEventListener('pointercancel', up);
	}

	// ---- paint pipeline ----

	_paint() {
		if (this.cssWidth === 0 || this.cssHeight === 0) return;
		const ctx = this.ctx;
		applyDpr(ctx);

		const mode = this._mode;
		this._mode = 'cells';

		if (mode === 'scroll') {
			this._paintScroll();
		} else {
			this._paintFull();
		}

		this._prevScrollX = this.scrollX;
		this._prevScrollY = this.scrollY;
		notePaint();
	}

	_paintFull() {
		const ctx = this.ctx;
		ctx.clearRect(0, 0, this.cssWidth, this.cssHeight);

		// Body
		this._paintBody(0, 0, this.bodyW, this.bodyH);
		// Column headers (above body)
		this._paintColumnHeaders(0, 0, this.bodyW, this.colHeaderHeight);
		// Row headers (left of body)
		this._paintRowHeaders(0, 0, this.rowHeaderWidth, this.bodyH);
		// Top-left corner
		this._paintCorner();
		// Scrollbars
		this._paintScrollbars();
	}

	// Scroll-blit: copy unchanged pixels and paint the newly exposed strips.
	_paintScroll() {
		const dx = this.scrollX - this._prevScrollX;
		const dy = this.scrollY - this._prevScrollY;
		if (dx === 0 && dy === 0) return;

		// If delta is bigger than the visible body, full repaint is cheaper.
		if (Math.abs(dx) >= this.bodyW || Math.abs(dy) >= this.bodyH) {
			return this._paintFull();
		}

		const ctx = this.ctx;
		const dpr = window.devicePixelRatio || 1;

		// --- Body: shift in canvas-backing-pixel coordinates via drawImage ---
		// Region origin (in css px) within the canvas:
		const bx = this.rowHeaderWidth;
		const by = this.colHeaderHeight;
		const bw = this.bodyW;
		const bh = this.bodyH;

		// Copy current body pixels shifted by (-dx, -dy). Use the canvas as
		// the source so we read from the existing backing store.
		// Source rect (in backing pixels): the area we want to *keep*.
		const sxBack = (bx + Math.max(0, dx)) * dpr;
		const syBack = (by + Math.max(0, dy)) * dpr;
		const sw = (bw - Math.abs(dx)) * dpr;
		const sh = (bh - Math.abs(dy)) * dpr;
		// Destination rect (in css px since we're under the dpr transform):
		const ddx = bx + Math.max(0, -dx);
		const ddy = by + Math.max(0, -dy);
		const ddw = bw - Math.abs(dx);
		const ddh = bh - Math.abs(dy);

		// Save & reset to identity to do a backing-pixel copy.
		ctx.save();
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.drawImage(
			this.canvas,
			sxBack,
			syBack,
			sw,
			sh,
			ddx * dpr,
			ddy * dpr,
			sw,
			sh
		);
		ctx.restore();
		applyDpr(ctx);

		// Newly exposed body strips: the band(s) that drawImage didn't fill.
		if (dy !== 0) {
			const stripY = dy > 0 ? by + bh - dy : by;
			this._paintBody(0, Math.max(0, dy > 0 ? bh - dy : 0), bw, Math.abs(dy));
		}
		if (dx !== 0) {
			this._paintBody(Math.max(0, dx > 0 ? bw - dx : 0), 0, Math.abs(dx), bh);
		}

		// Headers move with their corresponding axis.
		if (dx !== 0) {
			this._paintColumnHeaders(0, 0, bw, this.colHeaderHeight);
		}
		if (dy !== 0) {
			this._paintRowHeaders(0, 0, this.rowHeaderWidth, bh);
		}

		// Scrollbars (cheap; redraw fully each frame for now).
		this._paintScrollbars();
	}

	// region (rx, ry, rw, rh) is in body-local CSS px (origin = body top-left).
	_paintBody(rx, ry, rw, rh) {
		const ctx = this.ctx;
		const bx = this.rowHeaderWidth;
		const by = this.colHeaderHeight;

		// Clip to the body region.
		ctx.save();
		ctx.beginPath();
		ctx.rect(bx + rx, by + ry, rw, rh);
		ctx.clip();

		// Compute visible cell range covering (rx..rx+rw, ry..ry+rh).
		const x0 = this.scrollX + rx;
		const y0 = this.scrollY + ry;
		const x1 = x0 + rw;
		const y1 = y0 + rh;
		const r0 = clampInt(this.rows.indexOf(y0), 0, this.rows.count - 1);
		const r1 = clampInt(this.rows.indexOf(y1 - 0.0001), 0, this.rows.count - 1);
		const c0 = clampInt(this.cols.indexOf(x0), 0, this.cols.count - 1);
		const c1 = clampInt(this.cols.indexOf(x1 - 0.0001), 0, this.cols.count - 1);

		// Background fill (theme stripe).
		ctx.fillStyle = this._stripe.even;
		ctx.fillRect(bx + rx, by + ry, rw, rh);

		// Striped rows.
		if (this._stripe.odd !== this._stripe.even) {
			for (let r = r0; r <= r1; r++) {
				if ((r & 1) !== 1) continue;
				const yy = by + this.rows.offsetOf(r) - this.scrollY;
				ctx.fillStyle = this._stripe.odd;
				ctx.fillRect(bx + rx, yy, rw, this.rows.sizeOf(r));
			}
		}

		// Cells: draw text + grid lines per cell.
		ctx.font = BODY_FONT;
		ctx.textBaseline = 'middle';
		ctx.textAlign = 'left';
		ctx.fillStyle = '#000';

		const renderer = this.renderer;

		for (let r = r0; r <= r1; r++) {
			const yy = by + this.rows.offsetOf(r) - this.scrollY;
			const rh2 = this.rows.sizeOf(r);
			for (let c = c0; c <= c1; c++) {
				const xx = bx + this.cols.offsetOf(c) - this.scrollX;
				const cw = this.cols.sizeOf(c);
				if (renderer) {
					renderer.paint(ctx, this.model, r, c, xx, yy, cw, rh2);
				} else {
					const v = this.model.data(r, c);
					ctx.fillStyle = '#000';
					ctx.fillText(stringify(v), xx + 4, yy + rh2 / 2, cw - 8);
				}
			}
		}

		// Grid lines.
		ctx.strokeStyle = '#d0d0d0';
		ctx.lineWidth = 1;
		ctx.beginPath();
		for (let r = r0; r <= r1 + 1; r++) {
			const yy = Math.floor(by + this.rows.offsetOf(r) - this.scrollY) + 0.5;
			ctx.moveTo(bx + rx, yy);
			ctx.lineTo(bx + rx + rw, yy);
		}
		for (let c = c0; c <= c1 + 1; c++) {
			const xx = Math.floor(bx + this.cols.offsetOf(c) - this.scrollX) + 0.5;
			ctx.moveTo(xx, by + ry);
			ctx.lineTo(xx, by + ry + rh);
		}
		ctx.stroke();

		ctx.restore();
	}

	_paintColumnHeaders(rx, _ry, rw, rh) {
		const ctx = this.ctx;
		const bx = this.rowHeaderWidth;
		ctx.save();
		ctx.beginPath();
		ctx.rect(bx + rx, 0, rw, rh);
		ctx.clip();
		ctx.fillStyle = '#f0f0f0';
		ctx.fillRect(bx + rx, 0, rw, rh);

		const x0 = this.scrollX + rx;
		const x1 = x0 + rw;
		const c0 = clampInt(this.cols.indexOf(x0), 0, this.cols.count - 1);
		const c1 = clampInt(this.cols.indexOf(x1 - 0.0001), 0, this.cols.count - 1);

		ctx.font = HEADER_FONT;
		ctx.textBaseline = 'middle';
		ctx.textAlign = 'center';
		ctx.fillStyle = '#000';
		for (let c = c0; c <= c1; c++) {
			const xx = bx + this.cols.offsetOf(c) - this.scrollX;
			const cw = this.cols.sizeOf(c);
			ctx.fillText(this.model.columnHeader(c), xx + cw / 2, rh / 2, cw - 6);
		}

		// bottom border + cell separators
		ctx.strokeStyle = '#a0a0a0';
		ctx.lineWidth = 1;
		ctx.beginPath();
		ctx.moveTo(bx + rx, rh - 0.5);
		ctx.lineTo(bx + rx + rw, rh - 0.5);
		ctx.strokeStyle = '#d0d0d0';
		for (let c = c0; c <= c1 + 1; c++) {
			const xx = Math.floor(bx + this.cols.offsetOf(c) - this.scrollX) + 0.5;
			ctx.moveTo(xx, 0);
			ctx.lineTo(xx, rh);
		}
		ctx.stroke();
		ctx.restore();
	}

	_paintRowHeaders(_rx, ry, rw, rh) {
		const ctx = this.ctx;
		const by = this.colHeaderHeight;
		ctx.save();
		ctx.beginPath();
		ctx.rect(0, by + ry, rw, rh);
		ctx.clip();
		ctx.fillStyle = '#f0f0f0';
		ctx.fillRect(0, by + ry, rw, rh);

		const y0 = this.scrollY + ry;
		const y1 = y0 + rh;
		const r0 = clampInt(this.rows.indexOf(y0), 0, this.rows.count - 1);
		const r1 = clampInt(this.rows.indexOf(y1 - 0.0001), 0, this.rows.count - 1);

		ctx.font = HEADER_FONT;
		ctx.textBaseline = 'middle';
		ctx.textAlign = 'right';
		ctx.fillStyle = '#000';
		for (let r = r0; r <= r1; r++) {
			const yy = by + this.rows.offsetOf(r) - this.scrollY;
			const rh2 = this.rows.sizeOf(r);
			ctx.fillText(this.model.rowHeader(r), rw - 6, yy + rh2 / 2, rw - 8);
		}

		ctx.strokeStyle = '#a0a0a0';
		ctx.lineWidth = 1;
		ctx.beginPath();
		ctx.moveTo(rw - 0.5, by + ry);
		ctx.lineTo(rw - 0.5, by + ry + rh);
		ctx.strokeStyle = '#d0d0d0';
		for (let r = r0; r <= r1 + 1; r++) {
			const yy = Math.floor(by + this.rows.offsetOf(r) - this.scrollY) + 0.5;
			ctx.moveTo(0, yy);
			ctx.lineTo(rw, yy);
		}
		ctx.stroke();
		ctx.restore();
	}

	_paintCorner() {
		const ctx = this.ctx;
		ctx.fillStyle = '#e0e0e0';
		ctx.fillRect(0, 0, this.rowHeaderWidth, this.colHeaderHeight);
		ctx.strokeStyle = '#a0a0a0';
		ctx.beginPath();
		ctx.moveTo(this.rowHeaderWidth - 0.5, 0);
		ctx.lineTo(this.rowHeaderWidth - 0.5, this.colHeaderHeight);
		ctx.moveTo(0, this.colHeaderHeight - 0.5);
		ctx.lineTo(this.rowHeaderWidth, this.colHeaderHeight - 0.5);
		ctx.stroke();
	}

	_paintScrollbars() {
		const ctx = this.ctx;
		// Track + thumb for vertical scrollbar.
		const vTrackX = this.cssWidth - SCROLLBAR_SIZE;
		const vTrackY = this.colHeaderHeight;
		const vTrackH = this.bodyH;
		ctx.fillStyle = '#f4f4f4';
		ctx.fillRect(vTrackX, vTrackY, SCROLLBAR_SIZE, vTrackH);
		const totalY = this.rows.totalSize();
		if (totalY > this.bodyH) {
			const thumbH = Math.max(MIN_THUMB, (this.bodyH / totalY) * vTrackH);
			const frac = this._scrollMaxY === 0 ? 0 : this.scrollY / this._scrollMaxY;
			const thumbY = vTrackY + frac * (vTrackH - thumbH);
			ctx.fillStyle = '#b0b0b0';
			roundRect(ctx, vTrackX + 2, thumbY, SCROLLBAR_SIZE - 4, thumbH, 3);
			ctx.fill();
		}
		// Horizontal scrollbar.
		const hTrackX = this.rowHeaderWidth;
		const hTrackY = this.cssHeight - SCROLLBAR_SIZE;
		const hTrackW = this.bodyW;
		ctx.fillStyle = '#f4f4f4';
		ctx.fillRect(hTrackX, hTrackY, hTrackW, SCROLLBAR_SIZE);
		const totalX = this.cols.totalSize();
		if (totalX > this.bodyW) {
			const thumbW = Math.max(MIN_THUMB, (this.bodyW / totalX) * hTrackW);
			const frac = this._scrollMaxX === 0 ? 0 : this.scrollX / this._scrollMaxX;
			const thumbX = hTrackX + frac * (hTrackW - thumbW);
			ctx.fillStyle = '#b0b0b0';
			roundRect(ctx, thumbX, hTrackY + 2, thumbW, SCROLLBAR_SIZE - 4, 3);
			ctx.fill();
		}
		// Bottom-right corner square between scrollbars.
		ctx.fillStyle = '#e0e0e0';
		ctx.fillRect(this.cssWidth - SCROLLBAR_SIZE, this.cssHeight - SCROLLBAR_SIZE, SCROLLBAR_SIZE, SCROLLBAR_SIZE);
	}
}

function stripeFor(theme) {
	switch (theme) {
		case 'blue':
			return { even: '#ffffff', odd: '#eef5ff' };
		case 'brown':
			return { even: '#ffffff', odd: '#fff0e0' };
		case 'green':
			return { even: '#ffffff', odd: '#e8f6e8' };
		default:
			return { even: '#ffffff', odd: '#ffffff' };
	}
}

function clamp(v, lo, hi) {
	return v < lo ? lo : v > hi ? hi : v;
}

// `v | 0` would truncate to int32 — fine for normal grids, catastrophic for
// trillion-row scrolling. Indices here can exceed 2^31, so we use Math.floor
// (or trust that indexOf already returns an integer-valued double).
function clampInt(v, lo, hi) {
	if (v < lo) return lo;
	if (v > hi) return hi;
	return v;
}

function stringify(v) {
	return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function roundRect(ctx, x, y, w, h, r) {
	ctx.beginPath();
	ctx.moveTo(x + r, y);
	ctx.lineTo(x + w - r, y);
	ctx.arcTo(x + w, y, x + w, y + r, r);
	ctx.lineTo(x + w, y + h - r);
	ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
	ctx.lineTo(x + r, y + h);
	ctx.arcTo(x, y + h, x, y + h - r, r);
	ctx.lineTo(x, y + r);
	ctx.arcTo(x, y, x + r, y, r);
	ctx.closePath();
}
