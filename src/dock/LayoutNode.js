// Layout tree primitives. Two node shapes — kept stable so that any code that
// inspects them sees one of two hidden classes.
//
// Tabs node:
//   { kind: 'tabs', tabs: Tab[], activeIndex: number, _el: HTMLElement|null,
//     _bar: HTMLElement|null, _content: HTMLElement|null }
//
// Split node:
//   { kind: 'split', dir: 'horizontal'|'vertical', children: LayoutNode[],
//     sizes: number[] /* fractional, sums to 1 */, _el: HTMLElement|null }
//
// Tab:
//   { id: string, title: string, host: HTMLElement }
//
// Trees are mutated in place; the DockPanel rebuilds the DOM after each
// structural change. The DOM elements stored on nodes are recycled across
// rebuilds so we don't lose canvases.

let _tabIdCounter = 0;

export function makeTab(title, host) {
	return {
		id: 't' + ++_tabIdCounter,
		title,
		host
	};
}

export function makeTabs(tabs, activeIndex = 0) {
	return {
		kind: 'tabs',
		tabs,
		activeIndex: Math.min(activeIndex, Math.max(0, tabs.length - 1)),
		_el: null,
		_bar: null,
		_content: null
	};
}

export function makeSplit(dir, children, sizes) {
	const n = children.length;
	if (!sizes) {
		sizes = new Array(n).fill(1 / n);
	}
	return {
		kind: 'split',
		dir,
		children,
		sizes,
		_el: null
	};
}

// ---- tree mutations ----

/** Walk every node in the tree, parent-first. */
export function walk(node, fn, parent = null, indexInParent = -1) {
	fn(node, parent, indexInParent);
	if (node.kind === 'split') {
		for (let i = 0; i < node.children.length; i++) {
			walk(node.children[i], fn, node, i);
		}
	}
}

/** Find the tabs-leaf containing a tab with the given id. */
export function findTabsLeaf(root, tabId) {
	let result = null;
	walk(root, (n) => {
		if (n.kind === 'tabs') {
			for (let i = 0; i < n.tabs.length; i++) {
				if (n.tabs[i].id === tabId) result = n;
			}
		}
	});
	return result;
}

/** Find the parent (split) of a node. Returns { parent, index } or null for root. */
export function findParent(root, target) {
	let result = null;
	walk(root, (n) => {
		if (n.kind === 'split') {
			for (let i = 0; i < n.children.length; i++) {
				if (n.children[i] === target) result = { parent: n, index: i };
			}
		}
	});
	return result;
}

/**
 * Replace `target` with `replacement` in the tree. Returns the new root
 * (which is `replacement` if `target` was the root).
 */
export function replaceNode(root, target, replacement) {
	if (root === target) return replacement;
	const found = findParent(root, target);
	if (!found) return root;
	found.parent.children[found.index] = replacement;
	return root;
}

/**
 * Remove a tab from the tree. If the tab's leaf becomes empty, collapse the
 * leaf and balance ancestor splits. Returns the new root.
 */
export function removeTab(root, tabId) {
	const leaf = findTabsLeaf(root, tabId);
	if (!leaf) return root;
	const idx = leaf.tabs.findIndex((t) => t.id === tabId);
	if (idx < 0) return root;
	leaf.tabs.splice(idx, 1);
	if (leaf.activeIndex >= leaf.tabs.length) leaf.activeIndex = leaf.tabs.length - 1;
	if (leaf.activeIndex < 0) leaf.activeIndex = 0;
	if (leaf.tabs.length > 0) return root;
	// Leaf is empty — remove it from parent and balance.
	return _collapseEmptyLeaf(root, leaf);
}

function _collapseEmptyLeaf(root, leaf) {
	if (root === leaf) return makeTabs([]);
	const found = findParent(root, leaf);
	if (!found) return root;
	const { parent, index } = found;
	parent.children.splice(index, 1);
	parent.sizes.splice(index, 1);
	if (parent.children.length === 1) {
		// Replace the split with its remaining child.
		return replaceNode(root, parent, parent.children[0]);
	}
	if (parent.children.length === 0) {
		return _collapseEmptyLeaf(root, parent);
	}
	// Renormalize sizes.
	const total = parent.sizes.reduce((a, b) => a + b, 0);
	if (total > 0) {
		for (let i = 0; i < parent.sizes.length; i++) parent.sizes[i] /= total;
	} else {
		const e = 1 / parent.sizes.length;
		for (let i = 0; i < parent.sizes.length; i++) parent.sizes[i] = e;
	}
	return root;
}

/**
 * Insert `tab` into the tree at a drop target.
 * `mode` ∈ { 'tab-after', 'split-left', 'split-right', 'split-top', 'split-bottom' }
 * `target` is the tabs-leaf the user is dropping onto.
 */
export function dropTab(root, tab, target, mode) {
	if (mode === 'tab-after') {
		target.tabs.push(tab);
		target.activeIndex = target.tabs.length - 1;
		return root;
	}
	const newLeaf = makeTabs([tab]);
	const dir =
		mode === 'split-left' || mode === 'split-right' ? 'horizontal' : 'vertical';
	const before = mode === 'split-left' || mode === 'split-top';
	// Try to merge into an existing split parent of the same direction.
	const found = findParent(root, target);
	if (found && found.parent.dir === dir) {
		const insertAt = before ? found.index : found.index + 1;
		// New child gets half of target's space; renormalize.
		const targetSize = found.parent.sizes[found.index];
		const half = targetSize / 2;
		found.parent.sizes[found.index] = half;
		found.parent.sizes.splice(insertAt, 0, half);
		found.parent.children.splice(insertAt, 0, newLeaf);
		return root;
	}
	// Otherwise wrap target in a new split.
	const newSplit = makeSplit(
		dir,
		before ? [newLeaf, target] : [target, newLeaf],
		[0.5, 0.5]
	);
	return replaceNode(root, target, newSplit);
}
