// Cell renderer base class. One renderer per grid (not per cell). The grid
// calls renderer.paint(...) inside its hot loop; subclasses override paint
// with a body that consults the model and draws the cell.
//
// Why a class: a single hidden-class shape on the renderer means the call
// site `this.renderer.paint(...)` is monomorphic. The IC sees one map; V8
// emits one CheckMap + a direct call. Subclasses are still allowed (the
// shape is stable per subclass), but the grid is configured with one
// renderer at construction time and never swaps them.
//
// Coordinates: paint receives (x, y, w, h) in CSS pixels in the canvas
// coordinate space (origin = canvas top-left). The grid has already
// computed the cell rect; the renderer just paints into it.

export class CellRenderer {
	/**
	 * @param {CanvasRenderingContext2D} ctx
	 * @param {import('../data/DataModel.js').DataModel} model
	 * @param {number} row
	 * @param {number} col
	 * @param {number} x
	 * @param {number} y
	 * @param {number} w
	 * @param {number} h
	 */
	paint(ctx, model, row, col, x, y, w, h) {
		// Default behavior: black text on transparent background, left-aligned.
		const v = model.data(row, col);
		ctx.fillStyle = '#000';
		const s = typeof v === 'string' ? v : v == null ? '' : '' + v;
		ctx.fillText(s, x + 4, y + h / 2, w - 8);
	}
}

// ---- TextRenderer: configurable text + bg color, format, alignment ----

const FONT_DEFAULT = '12px ui-sans-serif, system-ui, sans-serif';

export class TextRenderer extends CellRenderer {
	/**
	 * @param {{
	 *   font?: string,
	 *   align?: 'left'|'center'|'right',
	 *   format?: ((row: number, col: number, value: any) => string) | null,
	 *   color?: ((row: number, col: number, value: any) => string) | string | null,
	 *   bg?: ((row: number, col: number, value: any) => string) | string | null,
	 *   padding?: number
	 * }} opts
	 */
	constructor(opts) {
		super();
		this.font = opts.font ?? FONT_DEFAULT;
		this.align = opts.align ?? 'left';
		this.format = opts.format ?? null;
		this.color = opts.color ?? '#000000';
		this.bg = opts.bg ?? null;
		this.padding = opts.padding ?? 4;
		// Pre-bind tag flags to avoid typeof checks in hot paint().
		this._formatIsFn = typeof this.format === 'function';
		this._colorIsFn = typeof this.color === 'function';
		this._bgIsFn = typeof this.bg === 'function';
	}

	paint(ctx, model, row, col, x, y, w, h) {
		const v = model.data(row, col);
		const bg = this._bgIsFn ? this.bg(row, col, v) : this.bg;
		if (bg) {
			ctx.fillStyle = bg;
			ctx.fillRect(x, y, w, h);
		}
		const s = this._formatIsFn
			? this.format(row, col, v)
			: typeof v === 'string'
				? v
				: v == null
					? ''
					: '' + v;
		const color = this._colorIsFn ? this.color(row, col, v) : this.color;
		ctx.fillStyle = color;
		ctx.font = this.font;
		ctx.textBaseline = 'middle';
		const align = this.align;
		ctx.textAlign = align;
		const pad = this.padding;
		let tx;
		if (align === 'center') tx = x + w / 2;
		else if (align === 'right') tx = x + w - pad;
		else tx = x + pad;
		ctx.fillText(s, tx, y + h / 2, w - pad * 2);
	}
}

// ---- Viridis colormap (interpolated to 256 RGB strings, baked at load) ----
// Source: matplotlib's viridis lookup, downsampled. Strings are interned
// (allocated once at module load) so the inner-loop fillStyle assignment
// hands V8 a stable string every time, skipping per-cell rgb()-template churn.

const VIRIDIS_STOPS = [
	[68, 1, 84],
	[71, 39, 117],
	[59, 81, 139],
	[44, 113, 142],
	[33, 144, 141],
	[39, 173, 129],
	[92, 200, 99],
	[170, 220, 50],
	[253, 231, 37]
];

/** @type {string[]} */
export const VIRIDIS = (function () {
	const out = new Array(256);
	const stops = VIRIDIS_STOPS;
	const n = stops.length;
	for (let i = 0; i < 256; i++) {
		const t = (i / 255) * (n - 1);
		const k = Math.floor(t);
		const f = t - k;
		const a = stops[k];
		const b = stops[Math.min(n - 1, k + 1)];
		const r = Math.round(a[0] + (b[0] - a[0]) * f);
		const g = Math.round(a[1] + (b[1] - a[1]) * f);
		const bl = Math.round(a[2] + (b[2] - a[2]) * f);
		out[i] = 'rgb(' + r + ',' + g + ',' + bl + ')';
	}
	return out;
})();

/** Inverse text color (black or white) per viridis index, baked. */
export const VIRIDIS_TEXT = (function () {
	const out = new Array(256);
	const stops = VIRIDIS_STOPS;
	const n = stops.length;
	for (let i = 0; i < 256; i++) {
		const t = (i / 255) * (n - 1);
		const k = Math.floor(t);
		const f = t - k;
		const a = stops[k];
		const b = stops[Math.min(n - 1, k + 1)];
		const r = a[0] + (b[0] - a[0]) * f;
		const g = a[1] + (b[1] - a[1]) * f;
		const bl = a[2] + (b[2] - a[2]) * f;
		// Perceptual luminance threshold.
		const lum = 0.299 * r + 0.587 * g + 0.114 * bl;
		out[i] = lum < 128 ? '#fff' : '#000';
	}
	return out;
})();

/** Map a [0,1] float to an interned viridis color string. */
export function viridis(t) {
	const i = t < 0 ? 0 : t > 1 ? 255 : (t * 255) | 0;
	return VIRIDIS[i];
}
export function viridisText(t) {
	const i = t < 0 ? 0 : t > 1 ? 255 : (t * 255) | 0;
	return VIRIDIS_TEXT[i];
}
