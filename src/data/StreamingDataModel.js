// Streaming rows model: a ring of float values; on each tick a row is added
// and an old one removed. Mirrors PhosphorJS's example_datagrid streaming
// model; we use a circular Float64Array so per-tick allocation is zero.

import { DataModel, ChangeKind } from './DataModel.js';
import { xorshift128 } from '../util/prng.js';

const TICK_MS = 250;

export class StreamingDataModel extends DataModel {
	constructor(initialRows, cols, seed = 9999) {
		super();
		this._cols = cols;
		this._cap = Math.max(initialRows, 256);
		this._head = 0; // Index of the oldest row in _buf.
		this._size = initialRows;
		this._buf = new Float64Array(this._cap * cols);
		this._rng = xorshift128(seed);
		for (let r = 0; r < initialRows; r++) {
			for (let c = 0; c < cols; c++) {
				this._buf[r * cols + c] = this._rng() * 100;
			}
		}
		this._timer = setInterval(() => this._tick(), TICK_MS);
	}
	dispose() {
		clearInterval(this._timer);
		this._timer = 0;
	}
	rowCount() {
		return this._size;
	}
	columnCount() {
		return this._cols;
	}
	data(row, col) {
		const idx = ((this._head + row) % this._cap) * this._cols + col;
		return this._buf[idx];
	}
	columnHeaderData(row, col) {
		return 'C' + col;
	}
	rowHeaderData(row, col) {
		return String(row);
	}
	_tick() {
		// Add 1, remove 1 from the front (visually: rows shift up; new row appears at bottom).
		const cols = this._cols;
		const tail = (this._head + this._size) % this._cap;
		// Write new row at tail.
		for (let c = 0; c < cols; c++) {
			this._buf[tail * cols + c] = this._rng() * 100;
		}
		// Remove the oldest row by advancing head; size stays the same.
		this._head = (this._head + 1) % this._cap;
		// Notify: in this model we conceptually remove row 0 and insert at end,
		// but since the cell values at every visible row position have shifted,
		// emit a CELLS_CHANGED — the grid will repaint visible cells, and the
		// rAF scheduler coalesces. This avoids the complication of shifting
		// scroll position to track a removed row.
		this.emit({ kind: ChangeKind.CELLS_CHANGED });
	}
}
