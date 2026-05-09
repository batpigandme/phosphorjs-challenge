// Streaming rows model: rows are inserted and removed on a timer, matching
// the PhosphorJS demo's streaming behavior. Uses a flat array-of-arrays
// with actual splice operations so the grid receives proper ROWS_INSERTED
// and ROWS_REMOVED events (scroll position adjusts, row headers renumber).

import { DataModel, ChangeKind } from './DataModel.js';
import { xorshift128 } from '../util/prng.js';

const TICK_MS = 250;
const MAX_ROWS = 500;
const MIN_ROWS = 4;

export class StreamingDataModel extends DataModel {
	constructor(initialRows, cols, seed = 9999) {
		super();
		this._cols = cols;
		this._rng = xorshift128(seed);
		this._data = [];
		for (let r = 0; r < initialRows; r++) {
			this._data.push(this._makeRow());
		}
		this._timer = setInterval(() => this._tick(), TICK_MS);
	}
	_makeRow() {
		const row = new Float64Array(this._cols);
		for (let c = 0; c < this._cols; c++) {
			row[c] = this._rng();
		}
		return row;
	}
	dispose() {
		clearInterval(this._timer);
		this._timer = 0;
	}
	rowCount() {
		return this._data.length;
	}
	columnCount() {
		return this._cols;
	}
	data(row, col) {
		return this._data[row][col];
	}
	columnHeaderData(row, col) {
		return 'C: ' + row + ', ' + col;
	}
	rowHeaderData(row, col) {
		return 'R: ' + row + ', ' + col;
	}
	cornerHeaderData(row, col) {
		return 'N: ' + row + ', ' + col;
	}
	_tick() {
		const nr = this._data.length;
		const r1 = this._rng();
		const r2 = this._rng();
		const i = Math.floor(r2 * nr);
		if ((r1 < 0.45 && nr > MIN_ROWS) || nr >= MAX_ROWS) {
			this._data.splice(i, 1);
			this.emit({ kind: ChangeKind.ROWS_REMOVED, index: i, span: 1 });
		} else {
			this._data.splice(i, 0, this._makeRow());
			this.emit({ kind: ChangeKind.ROWS_INSERTED, index: i, span: 1 });
		}
	}
}
