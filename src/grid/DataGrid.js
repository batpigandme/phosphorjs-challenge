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
//   * Two offscreen buffers: _buffer (cells, alpha:false) and _lineBuffer (grid
//     lines only, alpha:true). _present() composites both onto the visible canvas.
//   * On invalidate, the rAF scheduler calls `_paint` once per frame.
//   * `_paint` chooses between three modes:
//       - 'full': repaint every region (resize, model reset, theme change).
//       - 'scroll': scroll-blit BOTH the cell buffer and the line buffer, then
//                   paint only the newly-exposed strips. One blit + 1–2 new lines
//                   beats redrawing all N+M lines every frame (BitBlt principle:
//                   memcpy >> rasterization).
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
import { SelectionModel } from './SelectionModel.js';

const HEADER_FONT = '12px ui-sans-serif, system-ui, sans-serif';
const BODY_FONT = '12px ui-sans-serif, system-ui, sans-serif';
const SCROLLBAR_SIZE = 12;
const MIN_THUMB = 24;

// Pre-allocated scratch arrays for _paintBody; avoids one Float64Array allocation
// per paint call (4 arrays × 60 fps × 5 grids = 1200 allocs/s eliminated).
// 512 entries covers any realistic viewport at >= 4px min cell size.
const MAX_SCRATCH = 512;
const _scratchRowYs = new Float64Array(MAX_SCRATCH + 1);
const _scratchRowHs = new Float64Array(MAX_SCRATCH);
const _scratchColXs = new Float64Array(MAX_SCRATCH + 1);
const _scratchColWs = new Float64Array(MAX_SCRATCH);

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
	 *   renderer?: import('./CellRenderer.js').CellRenderer | null,
	 *   selectionMode?: 'cell'|'row'|'column',
	 *   stretchLastColumn?: boolean,
	 *   selectionStyle?: { fill?: string, border?: string, cursorBorder?: string }
	 * }} opts
	 */
	constructor(host, opts) {
		this.host = host;
		this.model = opts.model;
		this.rowHeight = opts.rowHeight ?? 20;
		this.colWidth = opts.colWidth ?? 64;
		this.headerColWidth = opts.headerColWidth ?? 64;
		this.headerRowHeight = opts.colHeaderHeight ?? 24;
		this.theme = opts.theme ?? null;
		this.renderer = opts.renderer ?? null;
		this.stretchLastColumn = opts.stretchLastColumn ?? false;

		this._headerRowCount = this.model.headerRowCount();
		this._headerColCount = this.model.headerColumnCount();
		this.colHeaderHeight = this.headerRowHeight * this._headerRowCount;
		this.rowHeaderWidth = this.headerColWidth * this._headerColCount;

		this.rows = new SectionList(this.model.rowCount(), this.rowHeight);
		this.cols = new SectionList(this.model.columnCount(), this.colWidth);

		this.cssWidth = 0;
		this.cssHeight = 0;
		this.bodyW = 0;
		this.bodyH = 0;
		this.scrollX = 0;
		this.scrollY = 0;
		this._prevScrollX = 0;
		this._prevScrollY = 0;
		/** @type {'full'|'scroll'|'cells'} */
		this._mode = 'full';

		this._stripe = stripeFor(this.theme);

		// Selection.
		const sm = opts.selectionMode ?? 'cell';
		this.selection = new SelectionModel(sm);
		this._selStyle = {
			fill: opts.selectionStyle?.fill ?? 'rgba(41, 98, 255, 0.15)',
			border: opts.selectionStyle?.border ?? 'rgba(41, 98, 255, 0.7)',
			cursorBorder: opts.selectionStyle?.cursorBorder ?? 'rgba(41, 98, 255, 1.0)'
		};
		this.selection.onChange(() => {
			// Selection changes don't need a full body repaint — both _paintFull
			// and _paintScroll overlay selections after the body. Only escalate
			// to 'full' if we're currently idle (mode==='cells'), not if a scroll
			// is already pending.
			if (this._mode === 'cells') this._mode = 'full';
			invalidate(this._paint);
		});
		this._autoScrollTimer = 0;
		this._draggingSelection = false;
		this._resizing = false;

		// Build DOM.
		host.classList.add('grid-host');
		if (this.theme) host.classList.add('theme-' + this.theme);
		this.canvas = document.createElement('canvas');
		this.canvas.style.position = 'absolute';
		this.canvas.style.inset = '0';
		this.canvas.style.cursor = 'default';
		this.canvas.tabIndex = 0;
		this.canvas.style.outline = 'none';
		host.appendChild(this.canvas);
		const frontCtx = this.canvas.getContext('2d', { alpha: false });
		if (!frontCtx) throw new Error('2d context unavailable');
		this._frontCtx = frontCtx;

		// Double buffering: every paint draws into an offscreen buffer canvas,
		// then we blit the buffer onto the visible canvas in a single drawImage.
		// This eliminates the black flicker that appears when ResizeObserver
		// clears the visible canvas backing store and the rAF paint hasn't run
		// yet — the visible canvas is only ever updated by atomic blits, never
		// observed mid-paint.
		this._buffer = document.createElement('canvas');
		const bufferCtx = this._buffer.getContext('2d', { alpha: false });
		if (!bufferCtx) throw new Error('2d buffer context unavailable');
		this.ctx = bufferCtx;

		// Separate offscreen canvas for body grid lines only (alpha:true so lines
		// composite transparently over cells). _present() blits cells then lines.
		// On scroll-blit the line buffer shifts identically to the cell buffer —
		// one drawImage memcpy + 1-2 new edge lines instead of redrawing all N+M
		// lines every frame (BitBlt principle).
		this._lineBuffer = document.createElement('canvas');
		const lineCtx = this._lineBuffer.getContext('2d', { alpha: true });
		if (!lineCtx) throw new Error('2d line buffer context unavailable');
		this._lineCtx = lineCtx;

		this._paint = this._paint.bind(this);

		this._ro = new ResizeObserver(() => this._handleResize());
		this._ro.observe(host);

		this._onWheel = this._onWheel.bind(this);
		this.canvas.addEventListener('wheel', this._onWheel, { passive: false });

		this._onPointerDown = this._onPointerDown.bind(this);
		this.canvas.addEventListener('pointerdown', this._onPointerDown);
		this._onPointerMove = this._onPointerMove.bind(this);
		this.canvas.addEventListener('pointermove', this._onPointerMove);

		this._onKeyDown = this._onKeyDown.bind(this);
		this.canvas.addEventListener('keydown', this._onKeyDown);

		this._onCopy = this._onCopy.bind(this);
		this.canvas.addEventListener('copy', this._onCopy);

		this._onModelChange = this._onModelChange.bind(this);
		this.model.on(this._onModelChange);

		this._handleResize();
	}

	dispose() {
		cancel(this._paint);
		this._ro.disconnect();
		if (this._autoScrollTimer) clearInterval(this._autoScrollTimer);
		this.canvas.removeEventListener('wheel', this._onWheel);
		this.canvas.removeEventListener('pointerdown', this._onPointerDown);
		this.canvas.removeEventListener('pointermove', this._onPointerMove);
		this.canvas.removeEventListener('keydown', this._onKeyDown);
		this.canvas.removeEventListener('copy', this._onCopy);
		this.model.off(this._onModelChange);
		this.host.removeChild(this.canvas);
	}

	_onModelChange(change) {
		if (change && typeof change === 'object') {
			if (change.kind === 0 /* ROWS_INSERTED */) {
				this.rows.insert(change.index, change.span);
				this.selection.onRowsInserted(change.index, change.span);
			} else if (change.kind === 1 /* ROWS_REMOVED */) {
				this.rows.remove(change.index, change.span);
				this.selection.onRowsRemoved(change.index, change.span);
			} else if (change.kind === 2 /* COLUMNS_INSERTED */) {
				this.cols.insert(change.index, change.span);
			} else if (change.kind === 3 /* COLUMNS_REMOVED */) {
				this.cols.remove(change.index, change.span);
			} else if (change.kind === 5 /* MODEL_RESET */) {
				this.rows = new SectionList(this.model.rowCount(), this.rowHeight);
				this.cols = new SectionList(this.model.columnCount(), this.colWidth);
				this.scrollX = 0;
				this.scrollY = 0;
				this.selection.clear();
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
		// Resize the buffer first, paint into it, then resize the visible
		// canvas (which clears it) and immediately blit. All in one task —
		// the browser only composites the result, never the empty interim.
		resizeCanvas(this._buffer, this.cssWidth, this.cssHeight);
		resizeCanvas(this._lineBuffer, this.cssWidth, this.cssHeight);
		resizeCanvas(this.canvas, this.cssWidth, this.cssHeight);
		if (this.stretchLastColumn) this._applyStretchLastColumn();
		this._mode = 'full';
		// Synchronous paint+blit prevents the rAF gap that would otherwise
		// expose the cleared visible canvas as black flicker mid-drag.
		cancel(this._paint);
		this._paint();
	}

	_applyStretchLastColumn() {
		const n = this.cols.count;
		if (n === 0) return;
		const totalWithoutLast = this.cols.totalSize() - this.cols.sizeOf(n - 1);
		const needed = Math.max(this.colWidth, this.bodyW - totalWithoutLast);
		this.cols.setSize(n - 1, needed);
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

	_hitResizeHandle(x, y) {
		const GRAB = 4;
		if (y < this.colHeaderHeight && x > this.rowHeaderWidth) {
			const bx = x - this.rowHeaderWidth + this.scrollX;
			const c = this.cols.indexOf(bx);
			if (c >= 0 && c < this.cols.count) {
				const edge = this.cols.offsetOf(c + 1) - this.scrollX + this.rowHeaderWidth;
				if (Math.abs(x - edge) <= GRAB) return { axis: 'col', index: c };
				if (c > 0) {
					const prevEdge = this.cols.offsetOf(c) - this.scrollX + this.rowHeaderWidth;
					if (Math.abs(x - prevEdge) <= GRAB) return { axis: 'col', index: c - 1 };
				}
			}
		}
		if (x < this.rowHeaderWidth && y > this.colHeaderHeight) {
			const by = y - this.colHeaderHeight + this.scrollY;
			const r = this.rows.indexOf(by);
			if (r >= 0 && r < this.rows.count) {
				const edge = this.rows.offsetOf(r + 1) - this.scrollY + this.colHeaderHeight;
				if (Math.abs(y - edge) <= GRAB) return { axis: 'row', index: r };
				if (r > 0) {
					const prevEdge = this.rows.offsetOf(r) - this.scrollY + this.colHeaderHeight;
					if (Math.abs(y - prevEdge) <= GRAB) return { axis: 'row', index: r - 1 };
				}
			}
		}
		return null;
	}

	_onPointerMove(e) {
		if (this._resizing) return;
		const rect = this.canvas.getBoundingClientRect();
		const x = e.clientX - rect.left;
		const y = e.clientY - rect.top;
		const hit = this._hitResizeHandle(x, y);
		this.canvas.style.cursor = hit ? (hit.axis === 'col' ? 'ew-resize' : 'ns-resize') : 'default';
	}

	_hitTestBody(canvasX, canvasY) {
		const bx = this.rowHeaderWidth;
		const by = this.colHeaderHeight;
		if (canvasX < bx || canvasY < by) return null;
		if (canvasX >= bx + this.bodyW || canvasY >= by + this.bodyH) return null;
		const bodyPxX = canvasX - bx + this.scrollX;
		const bodyPxY = canvasY - by + this.scrollY;
		const row = this.rows.indexOf(bodyPxY);
		const col = this.cols.indexOf(bodyPxX);
		if (row < 0 || row >= this.rows.count || col < 0 || col >= this.cols.count) return null;
		return { row, col };
	}

	_scrollToCursor() {
		const r = this.selection.cursorRow;
		const c = this.selection.cursorCol;
		if (r < 0 || c < 0) return;
		const bx = this.rowHeaderWidth;
		const by = this.colHeaderHeight;
		const cellTop = this.rows.offsetOf(r);
		const cellBot = cellTop + this.rows.sizeOf(r);
		const cellLeft = this.cols.offsetOf(c);
		const cellRight = cellLeft + this.cols.sizeOf(c);
		let sx = this.scrollX, sy = this.scrollY;
		if (cellBot > sy + this.bodyH) sy = cellBot - this.bodyH;
		if (cellTop < sy) sy = cellTop;
		if (cellRight > sx + this.bodyW) sx = cellRight - this.bodyW;
		if (cellLeft < sx) sx = cellLeft;
		if (sx !== this.scrollX || sy !== this.scrollY) this.scrollTo(sx, sy);
	}

	_onPointerDown(e) {
		if (e.button !== 0) return;
		const rect = this.canvas.getBoundingClientRect();
		const x = e.clientX - rect.left;
		const y = e.clientY - rect.top;

		// Column/row resize.
		const hit = this._hitResizeHandle(x, y);
		if (hit) {
			e.preventDefault();
			this.canvas.setPointerCapture(e.pointerId);
			this._resizing = true;
			const startPx = hit.axis === 'col' ? e.clientX : e.clientY;
			const list = hit.axis === 'col' ? this.cols : this.rows;
			const startSize = list.sizeOf(hit.index);
			const move = (ev) => {
				const delta = (hit.axis === 'col' ? ev.clientX : ev.clientY) - startPx;
				const newSize = Math.max(20, startSize + delta);
				list.setSize(hit.index, newSize);
				this._mode = 'full';
				invalidate(this._paint);
			};
			const up = () => {
				this.canvas.releasePointerCapture(e.pointerId);
				this.canvas.removeEventListener('pointermove', move);
				this.canvas.removeEventListener('pointerup', up);
				this.canvas.removeEventListener('pointercancel', up);
				this._resizing = false;
			};
			this.canvas.addEventListener('pointermove', move);
			this.canvas.addEventListener('pointerup', up);
			this.canvas.addEventListener('pointercancel', up);
			return;
		}

		// Body click → selection.
		const bodyHit = this._hitTestBody(x, y);
		if (bodyHit) {
			e.preventDefault();
			this.canvas.focus();
			const extend = e.shiftKey;
			const add = e.ctrlKey || e.metaKey;
			if (extend) {
				this.selection.resizeTo(bodyHit.row, bodyHit.col);
				this.selection.cursorRow = bodyHit.row;
				this.selection.cursorCol = bodyHit.col;
				this.selection._emit();
			} else {
				this.selection.select(bodyHit.row, bodyHit.col, add ? 'none' : 'all');
			}
			this._scrollToCursor();
			this._startDragSelect(e, bodyHit);
			return;
		}

		// Row header click → select row.
		if (x < this.rowHeaderWidth && y >= this.colHeaderHeight && y < this.colHeaderHeight + this.bodyH) {
			e.preventDefault();
			this.canvas.focus();
			const bodyPxY = y - this.colHeaderHeight + this.scrollY;
			const row = this.rows.indexOf(bodyPxY);
			if (row >= 0 && row < this.rows.count) {
				const extend = e.shiftKey;
				const add = e.ctrlKey || e.metaKey;
				if (extend) {
					this.selection.resizeTo(row, this.selection.cursorCol);
					this.selection.cursorRow = row;
					this.selection._emit();
				} else {
					const oldMode = this.selection.mode;
					this.selection.mode = 'row';
					this.selection.select(row, 0, add ? 'none' : 'all');
					this.selection.mode = oldMode;
				}
			}
			return;
		}

		// Column header click → select column.
		if (y < this.colHeaderHeight && x >= this.rowHeaderWidth && x < this.rowHeaderWidth + this.bodyW) {
			e.preventDefault();
			this.canvas.focus();
			const bodyPxX = x - this.rowHeaderWidth + this.scrollX;
			const col = this.cols.indexOf(bodyPxX);
			if (col >= 0 && col < this.cols.count) {
				const extend = e.shiftKey;
				const add = e.ctrlKey || e.metaKey;
				if (extend) {
					this.selection.resizeTo(this.selection.cursorRow, col);
					this.selection.cursorCol = col;
					this.selection._emit();
				} else {
					const oldMode = this.selection.mode;
					this.selection.mode = 'column';
					this.selection.select(0, col, add ? 'none' : 'all');
					this.selection.mode = oldMode;
				}
			}
			return;
		}

		// Corner click → select all.
		if (x < this.rowHeaderWidth && y < this.colHeaderHeight) {
			e.preventDefault();
			this.canvas.focus();
			this.selection.select(0, 0, 'all');
			this.selection.resizeTo(this.rows.count - 1, this.cols.count - 1);
			return;
		}

		// Scrollbar drag.
		const vTrackX = this.cssWidth - SCROLLBAR_SIZE;
		const vTrackY = this.colHeaderHeight;
		const vTrackH = this.bodyH;
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

	_startDragSelect(startEvent, startHit) {
		this.canvas.setPointerCapture(startEvent.pointerId);
		this._draggingSelection = true;
		const AUTO_MARGIN = 20;
		const AUTO_SPEED = 8;
		let lastClientX = startEvent.clientX;
		let lastClientY = startEvent.clientY;

		const autoScroll = () => {
			const rect = this.canvas.getBoundingClientRect();
			const lx = lastClientX - rect.left;
			const ly = lastClientY - rect.top;
			let dx = 0, dy = 0;
			const bodyRight = this.rowHeaderWidth + this.bodyW;
			const bodyBottom = this.colHeaderHeight + this.bodyH;
			if (lx < this.rowHeaderWidth + AUTO_MARGIN) dx = -AUTO_SPEED;
			else if (lx > bodyRight - AUTO_MARGIN) dx = AUTO_SPEED;
			if (ly < this.colHeaderHeight + AUTO_MARGIN) dy = -AUTO_SPEED;
			else if (ly > bodyBottom - AUTO_MARGIN) dy = AUTO_SPEED;
			if (dx || dy) this.scrollBy(dx, dy);
			const hit = this._hitTestBody(
				clamp(lx, this.rowHeaderWidth, bodyRight - 1),
				clamp(ly, this.colHeaderHeight, bodyBottom - 1)
			);
			if (hit) {
				this.selection.resizeTo(hit.row, hit.col);
				this.selection.cursorRow = hit.row;
				this.selection.cursorCol = hit.col;
			}
		};

		this._autoScrollTimer = setInterval(autoScroll, 50);

		const move = (ev) => {
			lastClientX = ev.clientX;
			lastClientY = ev.clientY;
			const rect = this.canvas.getBoundingClientRect();
			const lx = ev.clientX - rect.left;
			const ly = ev.clientY - rect.top;
			const bodyRight = this.rowHeaderWidth + this.bodyW;
			const bodyBottom = this.colHeaderHeight + this.bodyH;
			const hit = this._hitTestBody(
				clamp(lx, this.rowHeaderWidth, bodyRight - 1),
				clamp(ly, this.colHeaderHeight, bodyBottom - 1)
			);
			if (hit) {
				this.selection.resizeTo(hit.row, hit.col);
				this.selection.cursorRow = hit.row;
				this.selection.cursorCol = hit.col;
			}
		};
		const up = () => {
			if (this._autoScrollTimer) { clearInterval(this._autoScrollTimer); this._autoScrollTimer = 0; }
			this._draggingSelection = false;
			this.canvas.releasePointerCapture(startEvent.pointerId);
			this.canvas.removeEventListener('pointermove', move);
			this.canvas.removeEventListener('pointerup', up);
			this.canvas.removeEventListener('pointercancel', up);
		};
		this.canvas.addEventListener('pointermove', move);
		this.canvas.addEventListener('pointerup', up);
		this.canvas.addEventListener('pointercancel', up);
	}

	_onKeyDown(e) {
		const sel = this.selection;
		if (sel.cursorRow < 0) return;
		const maxRow = this.rows.count - 1;
		const maxCol = this.cols.count - 1;
		if (maxRow < 0 || maxCol < 0) return;
		const extend = e.shiftKey;
		const jump = e.ctrlKey || e.metaKey;
		let handled = true;
		switch (e.key) {
			case 'ArrowUp':
				if (jump) sel.jumpCursor(0, sel.cursorCol, maxRow, maxCol, extend);
				else sel.moveCursor(-1, 0, maxRow, maxCol, extend);
				break;
			case 'ArrowDown':
				if (jump) sel.jumpCursor(maxRow, sel.cursorCol, maxRow, maxCol, extend);
				else sel.moveCursor(1, 0, maxRow, maxCol, extend);
				break;
			case 'ArrowLeft':
				if (jump) sel.jumpCursor(sel.cursorRow, 0, maxRow, maxCol, extend);
				else sel.moveCursor(0, -1, maxRow, maxCol, extend);
				break;
			case 'ArrowRight':
				if (jump) sel.jumpCursor(sel.cursorRow, maxCol, maxRow, maxCol, extend);
				else sel.moveCursor(0, 1, maxRow, maxCol, extend);
				break;
			case 'PageUp': {
				const pageRows = Math.max(1, Math.floor(this.bodyH / this.rowHeight) - 1);
				sel.moveCursor(-pageRows, 0, maxRow, maxCol, extend);
				break;
			}
			case 'PageDown': {
				const pageRows = Math.max(1, Math.floor(this.bodyH / this.rowHeight) - 1);
				sel.moveCursor(pageRows, 0, maxRow, maxCol, extend);
				break;
			}
			case 'Home':
				if (jump) sel.jumpCursor(0, 0, maxRow, maxCol, extend);
				else sel.jumpCursor(sel.cursorRow, 0, maxRow, maxCol, extend);
				break;
			case 'End':
				if (jump) sel.jumpCursor(maxRow, maxCol, maxRow, maxCol, extend);
				else sel.jumpCursor(sel.cursorRow, maxCol, maxRow, maxCol, extend);
				break;
			case 'Escape':
				sel.clear();
				break;
			default:
				handled = false;
		}
		if (handled) {
			e.preventDefault();
			this._scrollToCursor();
		}
	}

	_onCopy(e) {
		const sel = this.selection;
		if (sel.selections.length === 0) return;
		e.preventDefault();
		const last = sel.selections[sel.selections.length - 1];
		const rMin = Math.min(last.r1, last.r2);
		const rMax = Math.min(Math.max(last.r1, last.r2), this.rows.count - 1);
		const cMin = Math.min(last.c1, last.c2);
		const cMax = Math.min(Math.max(last.c1, last.c2), this.cols.count - 1);
		const maxCells = 10000;
		if ((rMax - rMin + 1) * (cMax - cMin + 1) > maxCells) return;
		const lines = [];
		for (let r = rMin; r <= rMax; r++) {
			const cells = [];
			for (let c = cMin; c <= cMax; c++) {
				cells.push(stringify(this.model.data(r, c)));
			}
			lines.push(cells.join('\t'));
		}
		e.clipboardData.setData('text/plain', lines.join('\n'));
	}

	// ---- paint pipeline ----

	_paint() {
		if (this.cssWidth === 0 || this.cssHeight === 0) return;
		const ctx = this.ctx;
		applyDpr(ctx);
		applyDpr(this._lineCtx);

		const mode = this._mode;
		this._mode = 'cells';

		if (mode === 'scroll') {
			this._paintScroll();
		} else {
			this._paintFull();
		}

		this._prevScrollX = this.scrollX;
		this._prevScrollY = this.scrollY;
		this._present();
		notePaint();
	}

	// Atomic composite of cell buffer then line buffer onto the visible canvas.
	// Two drawImage calls = two memcpy-style GPU blits; no rasterization involved.
	_present() {
		const fctx = this._frontCtx;
		fctx.setTransform(1, 0, 0, 1, 0, 0);
		fctx.drawImage(this._buffer, 0, 0);       // cells (opaque)
		fctx.drawImage(this._lineBuffer, 0, 0);   // grid lines (transparent bg)
	}

	_paintFull() {
		const ctx = this.ctx;
		// Fill with white base — alpha:false means clearRect would leave black.
		ctx.fillStyle = '#ffffff';
		ctx.fillRect(0, 0, this.cssWidth, this.cssHeight);

		this._paintBody(0, 0, this.bodyW, this.bodyH);
		this._paintSelections();
		this._paintColumnHeaders(0, 0, this.bodyW, this.colHeaderHeight);
		this._paintRowHeaders(0, 0, this.rowHeaderWidth, this.bodyH);
		this._paintCorner();
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

		// Save & reset to identity to do a backing-pixel copy. Source is the
		// buffer (which holds the previous frame) — we shift those pixels to
		// their new screen positions, then paint the newly-exposed strips.
		ctx.save();
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.drawImage(this._buffer, sxBack, syBack, sw, sh, ddx * dpr, ddy * dpr, sw, sh);
		ctx.restore();
		applyDpr(ctx);

		// Shift the line buffer by the same amount. The non-exposed region of
		// pre-rendered grid lines is now at its correct post-scroll position.
		// _paintBody below will clearRect + redraw lines only for the exposed strip.
		// 'copy' compositing is required here: the line buffer is alpha:true, so
		// transparent source pixels must replace (not blend over) stale grid lines
		// in the destination — source-over would leave ghost lines from prior frames
		// that accumulate into a solid gray wash over many scroll steps.
		const lineCtx = this._lineCtx;
		lineCtx.save();
		lineCtx.setTransform(1, 0, 0, 1, 0, 0);
		lineCtx.globalCompositeOperation = 'copy';
		lineCtx.drawImage(this._lineBuffer, sxBack, syBack, sw, sh, ddx * dpr, ddy * dpr, sw, sh);
		lineCtx.restore();
		applyDpr(lineCtx);

		// Newly exposed body strips: the band(s) that drawImage didn't fill.
		if (dy !== 0) {
			const stripY = dy > 0 ? by + bh - dy : by;
			this._paintBody(0, Math.max(0, dy > 0 ? bh - dy : 0), bw, Math.abs(dy));
		}
		if (dx !== 0) {
			this._paintBody(Math.max(0, dx > 0 ? bw - dx : 0), 0, Math.abs(dx), bh);
		}

		// Selection overlay: the blitted region already carries correct selection
		// pixels from the previous frame (shifted to new positions by drawImage).
		// Only overlay selections on the newly exposed strips to avoid alpha
		// accumulation on the blitted area.
		if (this.selection.selections.length > 0) {
			this._paintSelectionsStrips(dx, dy);
		}

		// Always repaint both header strips: content changes on their respective
		// scroll axis, AND a partially-scrolled boundary row/col can bleed text
		// across the axis boundary into the header area in the non-renderer path.
		this._paintColumnHeaders(0, 0, bw, this.colHeaderHeight);
		this._paintRowHeaders(0, 0, this.rowHeaderWidth, bh);

		this._paintCorner();
		this._paintScrollbars();
	}

	_paintSelections() {
		const sel = this.selection;
		if (sel.selections.length === 0) return;
		const ctx = this.ctx;
		const bx = this.rowHeaderWidth;
		const by = this.colHeaderHeight;
		ctx.save();
		ctx.beginPath();
		ctx.rect(bx, by, this.bodyW, this.bodyH);
		ctx.clip();
		this._paintSelectionsInner(ctx, bx, by);
		ctx.restore();
	}

	_paintSelectionsStrips(dx, dy) {
		const ctx = this.ctx;
		const bx = this.rowHeaderWidth;
		const by = this.colHeaderHeight;
		const bw = this.bodyW;
		const bh = this.bodyH;
		ctx.save();
		ctx.beginPath();
		if (dy !== 0) {
			const stripY = dy > 0 ? by + bh - dy : by;
			ctx.rect(bx, stripY, bw, Math.abs(dy));
		}
		if (dx !== 0) {
			const stripX = dx > 0 ? bx + bw - dx : bx;
			ctx.rect(stripX, by, Math.abs(dx), bh);
		}
		ctx.clip();
		this._paintSelectionsInner(ctx, bx, by);
		ctx.restore();
	}

	_paintSelectionsInner(ctx, bx, by) {
		const sel = this.selection;
		for (const s of sel.selections) {
			const rMin = Math.min(s.r1, s.r2);
			const rMax = Math.max(s.r1, s.r2);
			const cMin = Math.min(s.c1, s.c2);
			const cMax = Math.max(s.c1, s.c2);
			const effRMax = Math.min(rMax, this.rows.count - 1);
			const effCMax = Math.min(cMax, this.cols.count - 1);
			if (effRMax < rMin || effCMax < cMin) continue;
			const x1 = bx + this.cols.offsetOf(cMin) - this.scrollX;
			const y1 = by + this.rows.offsetOf(rMin) - this.scrollY;
			const x2 = bx + this.cols.offsetOf(effCMax + 1) - this.scrollX;
			const y2 = by + this.rows.offsetOf(effRMax + 1) - this.scrollY;
			ctx.fillStyle = this._selStyle.fill;
			ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
			ctx.strokeStyle = this._selStyle.border;
			ctx.lineWidth = 1;
			ctx.strokeRect(
				Math.floor(x1) + 0.5, Math.floor(y1) + 0.5,
				Math.floor(x2 - x1), Math.floor(y2 - y1)
			);
		}
		if (sel.cursorRow >= 0 && sel.cursorCol >= 0 &&
			sel.cursorRow < this.rows.count && sel.cursorCol < this.cols.count) {
			const cx = bx + this.cols.offsetOf(sel.cursorCol) - this.scrollX;
			const cy = by + this.rows.offsetOf(sel.cursorRow) - this.scrollY;
			const cw = this.cols.sizeOf(sel.cursorCol);
			const ch = this.rows.sizeOf(sel.cursorRow);
			ctx.strokeStyle = this._selStyle.cursorBorder;
			ctx.lineWidth = 2;
			ctx.strokeRect(cx + 1, cy + 1, cw - 2, ch - 2);
		}
	}

	_paintBody(rx, ry, rw, rh) {
		const ctx = this.ctx;
		const lineCtx = this._lineCtx;
		const bx = this.rowHeaderWidth;
		const by = this.colHeaderHeight;
		// Pre-compute body-origin corners (used in multiple spots below).
		const bodyX  = bx + rx;    // left edge of the paint rect in canvas coords
		const bodyY  = by + ry;    // top edge of the paint rect in canvas coords
		const bodyX2 = bodyX + rw; // right edge (for grid-line lineTo)

		const x0 = this.scrollX + rx;
		const y0 = this.scrollY + ry;
		const x1 = x0 + rw;
		const y1 = y0 + rh;
		const r0 = clampInt(this.rows.indexOf(y0), 0, this.rows.count - 1);
		const r1 = clampInt(this.rows.indexOf(y1 - 0.0001), 0, this.rows.count - 1);
		const c0 = clampInt(this.cols.indexOf(x0), 0, this.cols.count - 1);
		const c1 = clampInt(this.cols.indexOf(x1 - 0.0001), 0, this.cols.count - 1);
		const nRows = r1 - r0 + 1;
		const nCols = c1 - c0 + 1;

		// Pre-compute floored screen positions of all visible row/col boundaries.
		// Uses module-level scratch arrays (no per-call allocation).
		// fillScreenPositions() fast path: one Math.floor + N integer additions
		// instead of N+1 function calls + multiplications.
		const rowYs = _scratchRowYs;
		const rowHs = _scratchRowHs;
		const colXs = _scratchColXs;
		const colWs = _scratchColWs;
		this.rows.fillScreenPositions(r0, nRows, by - this.scrollY, rowYs);
		this.cols.fillScreenPositions(c0, nCols, bx - this.scrollX, colXs);
		for (let i = 0; i < nRows; i++) rowHs[i] = rowYs[i + 1] - rowYs[i];
		for (let i = 0; i < nCols; i++) colWs[i] = colXs[i + 1] - colXs[i];

		// Background fill.
		ctx.fillStyle = this._stripe.even;
		ctx.fillRect(bodyX, bodyY, rw, rh);

		if (this._stripe.odd !== this._stripe.even) {
			ctx.fillStyle = this._stripe.odd;
			// Step by 2 instead of branching every row — cuts loop iterations in half.
			const startOdd = (r0 & 1) === 0 ? 1 : 0; // first i where r0+i is odd
			for (let i = startOdd; i < nRows; i += 2) {
				ctx.fillRect(bodyX, rowYs[i], rw, rowHs[i]);
			}
		}

		// Cells. Render column-wise (Phosphor pattern): one clip per column so
		// renderers cannot overflow their column's width. Height is the renderer's
		// responsibility. ctx.restore() after each column resets ctx state, so
		// _cached* sentinels are invalidated per-column (not per-body-paint).
		const renderer = this.renderer;
		if (renderer) {
			for (let ci = 0; ci < nCols; ci++) {
				const xx = colXs[ci];
				const cw = colWs[ci];
				ctx.save();
				ctx.beginPath();
				ctx.rect(xx, bodyY, cw, rh);
				ctx.clip();
				renderer.resetCache();
				for (let ri = 0; ri < nRows; ri++) {
					renderer.paint(ctx, this.model, r0 + ri, c0 + ci, xx, rowYs[ri], cw, rowHs[ri]);
				}
				ctx.restore();
			}
		} else {
			ctx.font = BODY_FONT;
			ctx.textBaseline = 'middle';
			ctx.textAlign = 'left';
			ctx.fillStyle = '#000';
			for (let ci = 0; ci < nCols; ci++) {
				const xx = colXs[ci];
				const cw = colWs[ci];
				for (let ri = 0; ri < nRows; ri++) {
					const v = this.model.data(r0 + ri, c0 + ci);
					ctx.fillText(stringify(v), xx + 4, rowYs[ri] + rowHs[ri] / 2, cw - 8);
				}
			}
		}

		// Grid lines go to the separate line buffer (alpha:true) so they can be
		// blit-shifted independently on scroll — one drawImage memcpy + a handful
		// of new edge lines, vs. redrawing all N+M lines every frame.
		// clearRect first so stale pixels from a previous scroll position don't bleed.
		lineCtx.clearRect(bodyX, bodyY, rw, rh);
		lineCtx.strokeStyle = '#d0d0d0';
		lineCtx.lineWidth = 1;
		lineCtx.beginPath();
		for (let i = 0; i <= nRows; i++) {
			const yy = rowYs[i] + 0.5;
			lineCtx.moveTo(bodyX, yy);
			lineCtx.lineTo(bodyX2, yy);
		}
		for (let i = 0; i <= nCols; i++) {
			const xx = colXs[i] + 0.5;
			lineCtx.moveTo(xx, bodyY);
			lineCtx.lineTo(xx, bodyY + rh);
		}
		lineCtx.stroke();
	}

	_paintColumnHeaders(rx, _ry, rw, rh) {
		const ctx = this.ctx;
		const bx = this.rowHeaderWidth;
		const hrc = this._headerRowCount;
		const hrh = this.headerRowHeight;
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
		const nCH = c1 - c0;
		// +1 extra boundary position so the grid-lines loop has c1+1's offset.
		this.cols.fillScreenPositions(c0, nCH + 1, bx - this.scrollX, _scratchColXs);

		ctx.font = HEADER_FONT;
		ctx.textBaseline = 'middle';
		ctx.textAlign = 'center';
		ctx.fillStyle = '#000'; // constant for all header cells; set once before loops
		for (let hr = 0; hr < hrc; hr++) {
			const yy = hr * hrh;
			for (let ci = 0; ci <= nCH; ci++) {
				const xx = _scratchColXs[ci];
				const cw = _scratchColXs[ci + 1] - _scratchColXs[ci];
				ctx.fillText(this.model.columnHeaderData(hr, c0 + ci), xx + cw / 2, yy + hrh / 2, cw - 6);
			}
		}

		ctx.strokeStyle = '#d0d0d0';
		ctx.lineWidth = 1;
		ctx.beginPath();
		for (let hr = 0; hr <= hrc; hr++) {
			const yy = Math.floor(hr * hrh) - 0.5;
			ctx.moveTo(bx + rx, yy);
			ctx.lineTo(bx + rx + rw, yy);
		}
		// _scratchColXs[0..nCH+1] covers c0..c1+1 (already floored).
		for (let ci = 0; ci <= nCH + 1; ci++) {
			const xx = _scratchColXs[ci] + 0.5;
			ctx.moveTo(xx, 0);
			ctx.lineTo(xx, rh);
		}
		ctx.stroke();

		ctx.strokeStyle = '#a0a0a0';
		ctx.beginPath();
		ctx.moveTo(bx + rx, rh - 0.5);
		ctx.lineTo(bx + rx + rw, rh - 0.5);
		ctx.stroke();

		ctx.restore();
	}

	_paintRowHeaders(_rx, ry, rw, rh) {
		const ctx = this.ctx;
		const by = this.colHeaderHeight;
		const hcc = this._headerColCount;
		const hcw = this.headerColWidth;
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
		const nRH = r1 - r0;
		// +1 extra boundary position so the grid-lines loop has r1+1's offset.
		this.rows.fillScreenPositions(r0, nRH + 1, by - this.scrollY, _scratchRowYs);

		ctx.font = HEADER_FONT;
		ctx.textBaseline = 'middle';
		ctx.fillStyle = '#000'; // constant for all header cells; set once before loops
		for (let ri = 0; ri <= nRH; ri++) {
			const r = r0 + ri;
			const yy = _scratchRowYs[ri];
			const rh2 = _scratchRowYs[ri + 1] - _scratchRowYs[ri];
			for (let hc = 0; hc < hcc; hc++) {
				const xx = hc * hcw;
				ctx.textAlign = hc === hcc - 1 ? 'right' : 'center';
				const xAnchor = hc === hcc - 1 ? xx + hcw - 6 : xx + hcw / 2;
				ctx.fillText(this.model.rowHeaderData(r, hc), xAnchor, yy + rh2 / 2, hcw - 8);
			}
		}

		ctx.strokeStyle = '#d0d0d0';
		ctx.lineWidth = 1;
		ctx.beginPath();
		for (let hc = 0; hc <= hcc; hc++) {
			const xx = Math.floor(hc * hcw) + 0.5;
			ctx.moveTo(xx, by + ry);
			ctx.lineTo(xx, by + ry + rh);
		}
		// _scratchRowYs[0..nRH+1] already covers r0..r1+1 (already floored).
		for (let ri = 0; ri <= nRH + 1; ri++) {
			const yy = _scratchRowYs[ri] + 0.5;
			ctx.moveTo(0, yy);
			ctx.lineTo(rw, yy);
		}
		ctx.stroke();

		ctx.strokeStyle = '#a0a0a0';
		ctx.beginPath();
		ctx.moveTo(rw - 0.5, by + ry);
		ctx.lineTo(rw - 0.5, by + ry + rh);
		ctx.stroke();

		ctx.restore();
	}

	_paintCorner() {
		const ctx = this.ctx;
		const rhw = this.rowHeaderWidth;
		const chh = this.colHeaderHeight;
		const hrc = this._headerRowCount;
		const hcc = this._headerColCount;
		const hrh = this.headerRowHeight;
		const hcw = this.headerColWidth;

		ctx.fillStyle = '#e0e0e0';
		ctx.fillRect(0, 0, rhw, chh);

		ctx.font = HEADER_FONT;
		ctx.textBaseline = 'middle';
		ctx.textAlign = 'center';
		ctx.fillStyle = '#000';
		for (let hr = 0; hr < hrc; hr++) {
			for (let hc = 0; hc < hcc; hc++) {
				const xx = hc * hcw;
				const yy = hr * hrh;
				ctx.fillText(
					this.model.cornerHeaderData(hr, hc),
					xx + hcw / 2, yy + hrh / 2, hcw - 8
				);
			}
		}

		ctx.strokeStyle = '#d0d0d0';
		ctx.lineWidth = 1;
		ctx.beginPath();
		for (let hr = 1; hr < hrc; hr++) {
			const yy = Math.floor(hr * hrh) + 0.5;
			ctx.moveTo(0, yy);
			ctx.lineTo(rhw, yy);
		}
		for (let hc = 1; hc < hcc; hc++) {
			const xx = Math.floor(hc * hcw) + 0.5;
			ctx.moveTo(xx, 0);
			ctx.lineTo(xx, chh);
		}
		ctx.stroke();

		ctx.strokeStyle = '#a0a0a0';
		ctx.beginPath();
		ctx.moveTo(rhw - 0.5, 0);
		ctx.lineTo(rhw - 0.5, chh);
		ctx.moveTo(0, chh - 0.5);
		ctx.lineTo(rhw, chh - 0.5);
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
