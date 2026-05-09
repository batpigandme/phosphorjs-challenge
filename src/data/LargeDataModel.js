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
		return '(' + row + ', ' + col + ')';
	}
	headerRowCount() {
		return 2;
	}
	headerColumnCount() {
		return 3;
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
}
