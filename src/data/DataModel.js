// Base class for data models. Subclasses override rowCount/columnCount/data
// and emit 'change' events when the underlying data shifts. Listeners (the
// DataGrid) use the change descriptor to either invalidate the dirty rect
// or do a full repaint.
//
// Why a class with a fixed shape (not a duck-typed object): this is one of
// the hottest call sites in the system — `data(row, col)` is invoked once
// per visible cell on every paint. Inheritance from a single base means the
// IC at the call site sees one shape (the model instance) and the property
// load `model.data` is monomorphic. A bag-of-functions object would create
// a new shape per model and make this site polymorphic.

export const ChangeKind = {
	ROWS_INSERTED: 0,
	ROWS_REMOVED: 1,
	COLUMNS_INSERTED: 2,
	COLUMNS_REMOVED: 3,
	CELLS_CHANGED: 4,
	MODEL_RESET: 5
};

export class DataModel {
	constructor() {
		/** @type {Set<(change: any) => void>} */
		this._listeners = new Set();
	}

	rowCount() {
		return 0;
	}
	columnCount() {
		return 0;
	}
	data(row, col) {
		return '';
	}
	headerRowCount() {
		return 1;
	}
	headerColumnCount() {
		return 1;
	}
	columnHeaderData(row, col) {
		return 'C ' + col;
	}
	rowHeaderData(row, col) {
		return String(row);
	}
	cornerHeaderData(row, col) {
		return '';
	}

	on(fn) {
		this._listeners.add(fn);
	}
	off(fn) {
		this._listeners.delete(fn);
	}
	emit(change) {
		for (const fn of this._listeners) fn(change);
	}
}
