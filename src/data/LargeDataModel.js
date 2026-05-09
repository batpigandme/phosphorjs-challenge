// Synthetic 10^12 x 10^12 data model. Cells are computed on demand as
// "(row, col)" strings; nothing is materialized.
//
// JS numbers are IEEE754 doubles, so integers up to 2^53 are exact. 1e12 is
// well under that and we never hit precision issues for indices or offsets.

import { DataModel } from './DataModel.js';

export class LargeDataModel extends DataModel {
	constructor() {
		super();
		this._rows = 1e12;
		this._cols = 1e12;
	}
	rowCount() {
		return this._rows;
	}
	columnCount() {
		return this._cols;
	}
	data(row, col) {
		// Allocates a string per call; this is the cell-renderer's hot path.
		// We could intern the most-recent N strings if it shows up in profiles,
		// but `(r, c)` formatting is cheap and the JIT handles small-string
		// concatenation well.
		return '(' + row + ', ' + col + ')';
	}
	columnHeader(col) {
		return 'C ' + col;
	}
	rowHeader(row) {
		return String(row);
	}
}
