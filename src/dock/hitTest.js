// Drop-zone hit-testing.
//
// A tabs leaf rect is divided into 5 zones:
//   - center (50% × 50% in the middle): tab-after
//   - else: dominant edge wins (split-left/right/top/bottom)

/** @typedef {{ leaf: any, mode: 'tab-after'|'split-left'|'split-right'|'split-top'|'split-bottom', rect: {x:number,y:number,w:number,h:number} }} DropTarget */

/**
 * @param {any} root layout root
 * @param {number} px pointer x in dock-root local coords
 * @param {number} py pointer y in dock-root local coords
 * @returns {DropTarget | null}
 */
export function hitTestDrop(root, px, py) {
	const leaf = findLeafAt(root, px, py);
	if (!leaf) return null;
	const r = leaf._el.getBoundingClientRect();
	const dock = leaf._el.parentElement;
	// Walk up to the .dock-root for offset context.
	let dockRoot = leaf._el;
	while (dockRoot && !dockRoot.classList.contains('dock-root')) {
		dockRoot = dockRoot.parentElement;
	}
	const rootRect = dockRoot ? dockRoot.getBoundingClientRect() : { x: 0, y: 0 };
	const rect = {
		x: r.left - rootRect.left,
		y: r.top - rootRect.top,
		w: r.width,
		h: r.height
	};
	// Local coords inside leaf (0..1).
	const lx = (px - rect.x) / rect.w;
	const ly = (py - rect.y) / rect.h;
	const inCenter = lx >= 0.25 && lx <= 0.75 && ly >= 0.25 && ly <= 0.75;
	if (inCenter) {
		return { leaf, mode: 'tab-after', rect: previewRect(rect, 'tab-after') };
	}
	// Dominant edge.
	const dxLeft = lx;
	const dxRight = 1 - lx;
	const dyTop = ly;
	const dyBot = 1 - ly;
	const min = Math.min(dxLeft, dxRight, dyTop, dyBot);
	let mode;
	if (min === dxLeft) mode = 'split-left';
	else if (min === dxRight) mode = 'split-right';
	else if (min === dyTop) mode = 'split-top';
	else mode = 'split-bottom';
	return { leaf, mode, rect: previewRect(rect, mode) };
}

function previewRect(r, mode) {
	switch (mode) {
		case 'tab-after':
			return { x: r.x, y: r.y, w: r.w, h: r.h };
		case 'split-left':
			return { x: r.x, y: r.y, w: r.w / 2, h: r.h };
		case 'split-right':
			return { x: r.x + r.w / 2, y: r.y, w: r.w / 2, h: r.h };
		case 'split-top':
			return { x: r.x, y: r.y, w: r.w, h: r.h / 2 };
		case 'split-bottom':
			return { x: r.x, y: r.y + r.h / 2, w: r.w, h: r.h / 2 };
	}
}

function findLeafAt(node, px, py) {
	if (!node._el) return null;
	const r = node._el.getBoundingClientRect();
	if (px < r.left || px > r.right || py < r.top || py > r.bottom) return null;
	if (node.kind === 'tabs') return node;
	for (let i = 0; i < node.children.length; i++) {
		const found = findLeafAt(node.children[i], px, py);
		if (found) return found;
	}
	return null;
}
