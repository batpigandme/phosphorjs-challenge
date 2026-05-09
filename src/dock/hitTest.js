// Drop-zone hit-testing.
//
// A tabs leaf rect is divided into 5 zones:
//   - center (50% × 50% in the middle): tab-after
//   - else: dominant edge wins (split-left/right/top/bottom)

/** @typedef {{ leaf: any, mode: 'tab-after'|'split-left'|'split-right'|'split-top'|'split-bottom', rect: {x:number,y:number,w:number,h:number}, rootEdge?: boolean }} DropTarget */

const ROOT_EDGE_PX = 28;

/**
 * @param {any} root layout root
 * @param {number} px pointer x (viewport coords)
 * @param {number} py pointer y (viewport coords)
 * @returns {DropTarget | null}
 */
export function hitTestDrop(root, px, py) {
	if (!root._el) return null;

	// Root-edge drops: narrow band along the dock panel edges.
	let dockRoot = root._el;
	while (dockRoot && !dockRoot.classList.contains('dock-root')) {
		dockRoot = dockRoot.parentElement;
	}
	const rootRect = dockRoot ? dockRoot.getBoundingClientRect() : root._el.getBoundingClientRect();
	const rlx = px - rootRect.left;
	const rly = py - rootRect.top;
	const rw = rootRect.width;
	const rh = rootRect.height;

	if (rlx >= 0 && rlx <= rw && rly >= 0 && rly <= rh) {
		// Find the root-level tabs leaf to attach to (first leaf in tree).
		const rootLeaf = findFirstLeaf(root);
		if (rootLeaf) {
			if (rlx < ROOT_EDGE_PX) {
				return { leaf: rootLeaf, mode: 'split-left', rootEdge: true,
					rect: { x: 0, y: 0, w: rw / 4, h: rh } };
			}
			if (rlx > rw - ROOT_EDGE_PX) {
				return { leaf: rootLeaf, mode: 'split-right', rootEdge: true,
					rect: { x: rw * 3 / 4, y: 0, w: rw / 4, h: rh } };
			}
			if (rly < ROOT_EDGE_PX) {
				return { leaf: rootLeaf, mode: 'split-top', rootEdge: true,
					rect: { x: 0, y: 0, w: rw, h: rh / 4 } };
			}
			if (rly > rh - ROOT_EDGE_PX) {
				return { leaf: rootLeaf, mode: 'split-bottom', rootEdge: true,
					rect: { x: 0, y: rh * 3 / 4, w: rw, h: rh / 4 } };
			}
		}
	}

	const leaf = findLeafAt(root, px, py);
	if (!leaf) return null;
	const r = leaf._el.getBoundingClientRect();
	const rect = {
		x: r.left - rootRect.left,
		y: r.top - rootRect.top,
		w: r.width,
		h: r.height
	};
	// Local coords inside leaf (0..1).
	const lx = (px - rootRect.left - rect.x) / rect.w;
	const ly = (py - rootRect.top - rect.y) / rect.h;
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

function findFirstLeaf(node) {
	if (node.kind === 'tabs') return node;
	for (let i = 0; i < node.children.length; i++) {
		const found = findFirstLeaf(node.children[i]);
		if (found) return found;
	}
	return null;
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
