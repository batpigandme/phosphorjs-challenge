import { DataModel, ChangeKind } from './DataModel.js';
import { xorshift128 } from '../util/prng.js';

const TICK_MS = 60;
const DELTA_FRAC = 0.04;
const DELTA_AMP = 0.05;

export class RandomDataModel extends DataModel {
	constructor(rows, cols, seed = 12345) {
		super();
		this._rows = rows;
		this._cols = cols;
		this._rng = xorshift128(seed);
		this._buf = new Float64Array(rows * cols);
		for (let i = 0; i < this._buf.length; i++) {
			this._buf[i] = this._rng();
		}
		this._timer = setInterval(() => this._tick(), TICK_MS);
	}
	dispose() {
		clearInterval(this._timer);
		this._timer = 0;
	}
	rowCount() {
		return this._rows;
	}
	columnCount() {
		return this._cols;
	}
	data(row, col) {
		// Hot path: typed-array indexed read. The IC at the call site stays
		// monomorphic in Float64Array; the result is unboxed.
		return this._buf[row * this._cols + col];
	}
	columnHeaderData(row, col) {
		return String(col);
	}
	rowHeaderData(row, col) {
		return String(row);
	}
	_tick() {
		const n = this._buf.length;
		const k = Math.max(1, (n * DELTA_FRAC) | 0);
		const buf = this._buf;
		const rng = this._rng;
		for (let i = 0; i < k; i++) {
			const idx = rng() * n | 0;
			let v = buf[idx] + (rng() - 0.5) * DELTA_AMP;
			if (v < 0) v = 0;
			else if (v > 1) v = 1;
			buf[idx] = v;
		}
		// Fire one CELLS_CHANGED for the whole grid; the DataGrid invalidates
		// itself and the rAF scheduler coalesces multi-tick updates into one
		// paint per frame.
		this.emit({ kind: ChangeKind.CELLS_CHANGED });
	}
}
