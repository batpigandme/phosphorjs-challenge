// Selection model: tracks rectangular cell selections and a cursor.
// Supports cell, row, and column selection modes matching Phosphor's
// BasicSelectionModel.

export class SelectionModel {
	/**
	 * @param {'cell'|'row'|'column'} mode
	 */
	constructor(mode = 'cell') {
		this.mode = mode;
		/** @type {Array<{r1:number,c1:number,r2:number,c2:number}>} */
		this.selections = [];
		this.cursorRow = -1;
		this.cursorCol = -1;
		/** @type {Set<(()=>void)>} */
		this._listeners = new Set();
	}

	onChange(fn) { this._listeners.add(fn); }
	offChange(fn) { this._listeners.delete(fn); }
	_emit() { for (const fn of this._listeners) fn(); }

	clear() {
		if (this.selections.length === 0 && this.cursorRow === -1) return;
		this.selections.length = 0;
		this.cursorRow = -1;
		this.cursorCol = -1;
		this._emit();
	}

	/**
	 * Select from the cursor cell, extending selection based on mode.
	 * @param {number} row
	 * @param {number} col
	 * @param {'all'|'current'|'none'} clearMode
	 */
	select(row, col, clearMode = 'all') {
		if (clearMode === 'all') {
			this.selections.length = 0;
		} else if (clearMode === 'current' && this.selections.length > 0) {
			this.selections.pop();
		}
		this.cursorRow = row;
		this.cursorCol = col;
		let r1 = row, c1 = col, r2 = row, c2 = col;
		if (this.mode === 'row') {
			c1 = 0;
			c2 = Infinity;
		} else if (this.mode === 'column') {
			r1 = 0;
			r2 = Infinity;
		}
		this.selections.push({ r1, c1, r2, c2 });
		this._emit();
	}

	/**
	 * Extend the last selection to include (row, col).
	 */
	resizeTo(row, col) {
		if (this.selections.length === 0) {
			this.select(row, col);
			return;
		}
		const last = this.selections[this.selections.length - 1];
		if (this.mode === 'row') {
			last.r2 = row;
		} else if (this.mode === 'column') {
			last.c2 = col;
		} else {
			last.r2 = row;
			last.c2 = col;
		}
		this._emit();
	}

	/**
	 * Move cursor by delta, optionally extending selection.
	 * Returns the new cursor position.
	 */
	moveCursor(dr, dc, maxRow, maxCol, extend = false) {
		let nr = this.cursorRow + dr;
		let nc = this.cursorCol + dc;
		nr = nr < 0 ? 0 : nr > maxRow ? maxRow : nr;
		nc = nc < 0 ? 0 : nc > maxCol ? maxCol : nc;
		if (extend) {
			this.resizeTo(nr, nc);
			this.cursorRow = nr;
			this.cursorCol = nc;
		} else {
			this.select(nr, nc);
		}
		return { row: nr, col: nc };
	}

	/**
	 * Jump cursor to an absolute position.
	 */
	jumpCursor(row, col, maxRow, maxCol, extend = false) {
		row = row < 0 ? 0 : row > maxRow ? maxRow : row;
		col = col < 0 ? 0 : col > maxCol ? maxCol : col;
		if (extend) {
			this.resizeTo(row, col);
			this.cursorRow = row;
			this.cursorCol = col;
		} else {
			this.select(row, col);
		}
		return { row, col };
	}

	isCellSelected(row, col) {
		for (let i = 0; i < this.selections.length; i++) {
			const s = this.selections[i];
			const rMin = Math.min(s.r1, s.r2);
			const rMax = Math.max(s.r1, s.r2);
			const cMin = Math.min(s.c1, s.c2);
			const cMax = Math.max(s.c1, s.c2);
			if (row >= rMin && row <= rMax && col >= cMin && col <= cMax) return true;
		}
		return false;
	}

	isRowSelected(row) {
		for (let i = 0; i < this.selections.length; i++) {
			const s = this.selections[i];
			const rMin = Math.min(s.r1, s.r2);
			const rMax = Math.max(s.r1, s.r2);
			if (row >= rMin && row <= rMax) return true;
		}
		return false;
	}

	isColumnSelected(col) {
		for (let i = 0; i < this.selections.length; i++) {
			const s = this.selections[i];
			const cMin = Math.min(s.c1, s.c2);
			const cMax = Math.max(s.c1, s.c2);
			if (col >= cMin && col <= cMax) return true;
		}
		return false;
	}

	/**
	 * Adapt selections when rows are inserted or removed.
	 */
	onRowsInserted(index, count) {
		for (const s of this.selections) {
			if (s.r1 >= index) s.r1 += count;
			if (s.r2 >= index) s.r2 += count;
		}
		if (this.cursorRow >= index) this.cursorRow += count;
	}

	onRowsRemoved(index, count) {
		this.selections = this.selections.filter(s => {
			if (s.r1 >= index) s.r1 = Math.max(index, s.r1 - count);
			if (s.r2 >= index) s.r2 = Math.max(index, s.r2 - count);
			return Math.min(s.r1, s.r2) <= Math.max(s.r1, s.r2);
		});
		if (this.cursorRow >= index) this.cursorRow = Math.max(0, this.cursorRow - count);
	}
}
