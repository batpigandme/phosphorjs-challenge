// Variable-size section list with prefix sums.
//
// V1 supports two modes:
//   1. Uniform mode (default): every section is `defaultSize` wide.
//      offsetOf and indexOf are O(1), totalSize is O(1).
//      This is the trillion-row case: count up to 1e12, no per-row state.
//   2. Override mode: a small Map<index, size> overrides the default for a
//      sparse subset of sections (e.g. user-resized columns). offsetOf and
//      indexOf walk the sorted overrides; for the column case (≤ 80 entries)
//      this is fine.
//
// Shape stability: the constructor sets every field; subsequent calls only
// mutate the override Map and `_dirty`. The exposed methods do not allocate
// in the hot path.

export class SectionList {
	/**
	 * @param {number} count Number of sections.
	 * @param {number} defaultSize Default size per section, in CSS px.
	 */
	constructor(count, defaultSize) {
		/** @type {number} */
		this.count = count;
		/** @type {number} */
		this.defaultSize = defaultSize;
		/** Sparse overrides: section index -> size (in px). */
		/** @type {Map<number, number>} */
		this._overrides = new Map();
		/** Sum of (override - default) across all overrides. */
		this._delta = 0;
		/** Sorted list of override indices for binary search; lazily rebuilt. */
		/** @type {Int32Array} */
		this._sortedKeys = new Int32Array(0);
		/** Prefix sum (offset of each sortedKeys[i] section start). */
		/** @type {Float64Array} */
		this._sortedOffsets = new Float64Array(0);
		this._sortedDirty = false;
	}

	/** Total size in CSS px across all sections. */
	totalSize() {
		return this.count * this.defaultSize + this._delta;
	}

	/** Size of section `i`, in px. */
	sizeOf(i) {
		const o = this._overrides.get(i);
		return o === undefined ? this.defaultSize : o;
	}

	/**
	 * Pixel offset of the start of section `i`.
	 * @param {number} i
	 * @returns {number}
	 */
	offsetOf(i) {
		if (i <= 0) return 0;
		if (i >= this.count) return this.totalSize();
		if (this._overrides.size === 0) return i * this.defaultSize;
		this._rebuildIfDirty();
		// Find how many overrides are at index < i, sum their delta.
		const keys = this._sortedKeys;
		let lo = 0;
		let hi = keys.length;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if (keys[mid] < i) lo = mid + 1;
			else hi = mid;
		}
		// Indices [0, lo) of overrides are before section i.
		let extra = 0;
		for (let k = 0; k < lo; k++) {
			extra += /** @type {number} */ (this._overrides.get(keys[k])) - this.defaultSize;
		}
		return i * this.defaultSize + extra;
	}

	/**
	 * Section index containing pixel offset `px`. Returns -1 if px < 0,
	 * count if px >= totalSize.
	 * @param {number} px
	 * @returns {number}
	 */
	indexOf(px) {
		if (px < 0) return -1;
		const total = this.totalSize();
		if (px >= total) return this.count;
		if (this._overrides.size === 0) {
			const i = Math.floor(px / this.defaultSize);
			return i >= this.count ? this.count - 1 : i;
		}
		// With overrides: rebuild sorted offsets (offset at start of each
		// override section) and binary-search.
		this._rebuildIfDirty();
		const keys = this._sortedKeys;
		const offs = this._sortedOffsets;
		// Find largest k with offs[k] <= px.
		let lo = 0;
		let hi = keys.length;
		while (lo < hi) {
			const mid = (lo + hi) >>> 1;
			if (offs[mid] <= px) lo = mid + 1;
			else hi = mid;
		}
		// k = lo - 1 is the latest override start at or before px.
		if (lo === 0) {
			// No override before px: uniform region from 0.
			return Math.floor(px / this.defaultSize);
		}
		const k = lo - 1;
		const sectionStart = offs[k];
		const sectionIndex = keys[k];
		const sectionSize = /** @type {number} */ (this._overrides.get(sectionIndex));
		if (px < sectionStart + sectionSize) return sectionIndex;
		// We're past the override section; uniform region until the next override.
		const after = sectionIndex + 1;
		const offsetAtAfter = sectionStart + sectionSize;
		const j = Math.floor((px - offsetAtAfter) / this.defaultSize);
		return after + j;
	}

	/** Override the size of section `i`. Pass -1 to clear. */
	setSize(i, size) {
		if (i < 0 || i >= this.count) return;
		const prev = this._overrides.get(i);
		if (size < 0) {
			if (prev !== undefined) {
				this._delta -= prev - this.defaultSize;
				this._overrides.delete(i);
				this._sortedDirty = true;
			}
			return;
		}
		if (prev !== undefined) this._delta -= prev - this.defaultSize;
		this._overrides.set(i, size);
		this._delta += size - this.defaultSize;
		this._sortedDirty = true;
	}

	/** Insert `n` sections at `i` with default size. */
	insert(i, n) {
		if (n <= 0) return;
		// Shift override keys >= i by n.
		if (this._overrides.size > 0) {
			const next = new Map();
			for (const [k, v] of this._overrides) {
				next.set(k >= i ? k + n : k, v);
			}
			this._overrides = next;
			this._sortedDirty = true;
		}
		this.count += n;
	}

	/** Remove `n` sections starting at `i`. */
	remove(i, n) {
		if (n <= 0) return;
		if (this._overrides.size > 0) {
			const next = new Map();
			for (const [k, v] of this._overrides) {
				if (k >= i && k < i + n) {
					this._delta -= v - this.defaultSize;
				} else if (k >= i + n) {
					next.set(k - n, v);
				} else {
					next.set(k, v);
				}
			}
			this._overrides = next;
			this._sortedDirty = true;
		}
		this.count = Math.max(0, this.count - n);
	}

	_rebuildIfDirty() {
		if (!this._sortedDirty) return;
		const n = this._overrides.size;
		const keys = new Int32Array(n);
		let i = 0;
		for (const k of this._overrides.keys()) keys[i++] = k;
		keys.sort();
		const offs = new Float64Array(n);
		let extra = 0;
		for (let k = 0; k < n; k++) {
			offs[k] = keys[k] * this.defaultSize + extra;
			extra += /** @type {number} */ (this._overrides.get(keys[k])) - this.defaultSize;
		}
		this._sortedKeys = keys;
		this._sortedOffsets = offs;
		this._sortedDirty = false;
	}
}
