// Top-level dock panel. Owns a layout tree and renders it to absolute-
// positioned divs inside a host element.
//
// Rendering strategy: the tree is rendered using flexbox. Each split node
// becomes a `.dock-split` flex container; each tabs leaf becomes a `.dock-tabs`
// column flex (tabbar + content area holding the tab hosts).
//
// Tab hosts (the canvas-bearing elements) are reparented when tabs move.
// We never destroy and recreate them — that would lose the canvas state.
//
// Drag interaction: Pointer Events with capture. One handler set per
// dock-panel; tabbar pointerdown delegates to here.

import { makeTabs, walk, removeTab, dropTab, findTabsLeaf } from './LayoutNode.js';
import { hitTestDrop } from './hitTest.js';

const SPLIT_HANDLE_PX = 6;
const DRAG_THRESHOLD = 4;

export class DockPanel {
	/**
	 * @param {HTMLElement} host
	 * @param {any} root layout root (a LayoutNode tree)
	 */
	constructor(host, root) {
		this.host = host;
		host.classList.add('dock-root');
		this.root = root;
		// Drag state.
		this._drag = null;
		this._dragOverlay = null;
		this._dropPreview = null;
		this._dragGhost = null;
		this._render();
	}

	setRoot(root) {
		this.root = root;
		this._render();
	}

	// Rebuild the DOM to match the layout tree. Tab hosts (canvas containers)
	// are reparented; tabbar / split / content elements are recreated each pass
	// (cheap, all DOM, no canvas).
	_render() {
		// Detach every tab host so we can move them freely.
		walk(this.root, (n) => {
			if (n.kind === 'tabs') {
				for (let i = 0; i < n.tabs.length; i++) {
					const h = n.tabs[i].host;
					if (h.parentElement) h.parentElement.removeChild(h);
				}
				n._el = null;
				n._bar = null;
				n._content = null;
			} else {
				n._el = null;
			}
		});
		// Wipe the dock root.
		this.host.innerHTML = '';
		// Build fresh.
		this.host.appendChild(this._renderNode(this.root));
	}

	_renderNode(node) {
		if (node.kind === 'tabs') return this._renderTabs(node);
		return this._renderSplit(node);
	}

	_renderSplit(node) {
		const el = document.createElement('div');
		el.className = 'dock-split ' + node.dir;
		el.style.flex = '1 1 auto';
		el.style.minWidth = '0';
		el.style.minHeight = '0';
		node._el = el;
		for (let i = 0; i < node.children.length; i++) {
			if (i > 0) {
				const handle = document.createElement('div');
				handle.className = 'dock-split-handle';
				handle.dataset.handleIndex = String(i);
				this._wireHandle(handle, node, i);
				el.appendChild(handle);
			}
			const childEl = this._renderNode(node.children[i]);
			const frac = node.sizes[i] || 1 / node.children.length;
			const totalHandle = (node.children.length - 1) * SPLIT_HANDLE_PX;
			childEl.style.flex = `${frac} 1 0`;
			childEl.style.minWidth = '0';
			childEl.style.minHeight = '0';
			el.appendChild(childEl);
		}
		return el;
	}

	_renderTabs(node) {
		const el = document.createElement('div');
		el.className = 'dock-tabs';
		el.style.flex = '1 1 auto';
		const bar = document.createElement('div');
		bar.className = 'dock-tabbar';
		const content = document.createElement('div');
		content.className = 'dock-content';
		node._el = el;
		node._bar = bar;
		node._content = content;
		el.appendChild(bar);
		el.appendChild(content);
		// Render tabs.
		for (let i = 0; i < node.tabs.length; i++) {
			const tab = node.tabs[i];
			const tabEl = document.createElement('div');
			tabEl.className = 'dock-tab' + (i === node.activeIndex ? ' active' : '');
			tabEl.dataset.tabId = tab.id;
			const label = document.createElement('span');
			label.className = 'dock-tab-label';
			label.textContent = tab.title;
			tabEl.appendChild(label);
			const close = document.createElement('span');
			close.className = 'dock-tab-close';
			close.textContent = '×';
			close.addEventListener('pointerdown', (e) => {
				e.stopPropagation();
				if (e.button !== 0) return;
				this._closeTab(tab.id);
			});
			tabEl.appendChild(close);
			this._wireTab(tabEl, node, i);
			bar.appendChild(tabEl);
			tab.host.classList.toggle('active', i === node.activeIndex);
			content.appendChild(tab.host);
		}
		return el;
	}

	_wireTab(tabEl, node, indexInNode) {
		tabEl.addEventListener('pointerdown', (e) => {
			if (e.button !== 0) return;
			e.preventDefault();
			const tab = node.tabs[indexInNode];
			// Activate tab — toggle classes inline (no DOM rebuild) so the
			// pointer-capture target survives until pointerup.
			if (node.activeIndex !== indexInNode) {
				node.activeIndex = indexInNode;
				const bar = node._bar;
				if (bar) {
					for (let i = 0; i < bar.children.length; i++) {
						bar.children[i].classList.toggle('active', i === indexInNode);
					}
				}
				const content = node._content;
				if (content) {
					for (let i = 0; i < node.tabs.length; i++) {
						node.tabs[i].host.classList.toggle('active', i === indexInNode);
					}
				}
			}
			this._beginDrag(e, tab, node);
		});
	}

	_wireHandle(handle, splitNode, indexInSplit) {
		handle.addEventListener('pointerdown', (e) => {
			if (e.button !== 0) return;
			e.preventDefault();
			handle.setPointerCapture(e.pointerId);
			const startX = e.clientX;
			const startY = e.clientY;
			const splitEl = splitNode._el;
			const splitRect = splitEl.getBoundingClientRect();
			const totalPx = splitNode.dir === 'horizontal' ? splitRect.width : splitRect.height;
			const startSizes = splitNode.sizes.slice();
			const move = (ev) => {
				const dpx = splitNode.dir === 'horizontal' ? ev.clientX - startX : ev.clientY - startY;
				const dfrac = dpx / totalPx;
				let prev = startSizes[indexInSplit - 1] + dfrac;
				let next = startSizes[indexInSplit] - dfrac;
				const min = 0.05;
				if (prev < min) {
					next -= min - prev;
					prev = min;
				}
				if (next < min) {
					prev -= min - next;
					next = min;
				}
				splitNode.sizes[indexInSplit - 1] = prev;
				splitNode.sizes[indexInSplit] = next;
				// Apply flex grow without rebuilding.
				const childEls = [];
				let ix = 0;
				for (let i = 0; i < splitEl.children.length; i++) {
					const c = splitEl.children[i];
					if (!c.classList.contains('dock-split-handle')) childEls.push(c);
				}
				for (let i = 0; i < childEls.length; i++) {
					childEls[i].style.flex = `${splitNode.sizes[i]} 1 0`;
				}
			};
			const up = (ev) => {
				handle.releasePointerCapture(e.pointerId);
				handle.removeEventListener('pointermove', move);
				handle.removeEventListener('pointerup', up);
				handle.removeEventListener('pointercancel', up);
			};
			handle.addEventListener('pointermove', move);
			handle.addEventListener('pointerup', up);
			handle.addEventListener('pointercancel', up);
		});
	}

	_beginDrag(downEvent, tab, sourceLeaf) {
		const startX = downEvent.clientX;
		const startY = downEvent.clientY;
		const target = downEvent.currentTarget;
		target.setPointerCapture(downEvent.pointerId);
		this._drag = { tab, sourceLeaf, started: false, target };
		const move = (e) => {
			if (!this._drag) return;
			if (!this._drag.started) {
				const dx = e.clientX - startX;
				const dy = e.clientY - startY;
				if (dx * dx + dy * dy < DRAG_THRESHOLD * DRAG_THRESHOLD) return;
				this._drag.started = true;
				this._showDragUI(tab.title);
			}
			this._updateDragUI(e.clientX, e.clientY);
		};
		const up = (e) => {
			target.releasePointerCapture(downEvent.pointerId);
			target.removeEventListener('pointermove', move);
			target.removeEventListener('pointerup', up);
			target.removeEventListener('pointercancel', up);
			if (this._drag && this._drag.started) {
				this._commitDrop(e.clientX, e.clientY);
			}
			this._hideDragUI();
			this._drag = null;
		};
		target.addEventListener('pointermove', move);
		target.addEventListener('pointerup', up);
		target.addEventListener('pointercancel', up);
	}

	_showDragUI(title) {
		const overlay = document.createElement('div');
		overlay.className = 'drag-overlay';
		this._dragOverlay = overlay;
		const preview = document.createElement('div');
		preview.className = 'drop-preview';
		preview.style.display = 'none';
		this._dropPreview = preview;
		overlay.appendChild(preview);
		document.body.appendChild(overlay);
		const ghost = document.createElement('div');
		ghost.className = 'drag-ghost';
		ghost.textContent = title;
		this._dragGhost = ghost;
		document.body.appendChild(ghost);
	}

	_updateDragUI(px, py) {
		if (this._dragGhost) {
			this._dragGhost.style.left = px + 12 + 'px';
			this._dragGhost.style.top = py + 12 + 'px';
		}
		if (!this._dropPreview) return;
		const target = hitTestDrop(this.root, px, py);
		if (!target || target.leaf === this._drag.sourceLeaf && this._drag.sourceLeaf.tabs.length === 1 && target.mode !== 'tab-after') {
			this._dropPreview.style.display = 'none';
			this._dragLastTarget = null;
			return;
		}
		const dockRoot = this.host.getBoundingClientRect();
		this._dropPreview.style.display = 'block';
		this._dropPreview.style.left = dockRoot.left + target.rect.x + 'px';
		this._dropPreview.style.top = dockRoot.top + target.rect.y + 'px';
		this._dropPreview.style.width = target.rect.w + 'px';
		this._dropPreview.style.height = target.rect.h + 'px';
		this._dragLastTarget = target;
	}

	_hideDragUI() {
		if (this._dragOverlay) {
			document.body.removeChild(this._dragOverlay);
			this._dragOverlay = null;
			this._dropPreview = null;
		}
		if (this._dragGhost) {
			document.body.removeChild(this._dragGhost);
			this._dragGhost = null;
		}
	}

	_commitDrop(px, py) {
		const target = this._dragLastTarget;
		this._dragLastTarget = null;
		if (!target) return;
		const tab = this._drag.tab;
		const sourceLeaf = this._drag.sourceLeaf;
		// No-op: dropping on the same single-tab leaf.
		if (target.leaf === sourceLeaf && target.mode === 'tab-after' && sourceLeaf.tabs.length === 1) {
			return;
		}
		// Remove from source first.
		this.root = removeTab(this.root, tab.id);
		// Re-target after removal: the leaf reference may have been collapsed.
		// findTabsLeaf works because leaves are still object-identity-stable
		// unless they were emptied/removed — and `target.leaf` is the *destination*,
		// which hasn't been emptied.
		// (Edge case: source == target leaf. After removal the target may be empty.
		// In that case treat as if dropped on the (former) target's parent area.)
		// For robustness in v1: if target leaf is no longer in the tree, no-op.
		let targetStillExists = false;
		walk(this.root, (n) => {
			if (n === target.leaf) targetStillExists = true;
		});
		if (!targetStillExists) {
			// Re-add to source (or fall back to root).
			if (sourceLeaf.tabs.length === 0 || sourceLeaf._el === null) {
				// Source was collapsed too — make the dropped tab the new root.
				this.root = makeTabs([tab]);
			} else {
				sourceLeaf.tabs.push(tab);
				sourceLeaf.activeIndex = sourceLeaf.tabs.length - 1;
			}
		} else {
			this.root = dropTab(this.root, tab, target.leaf, target.mode);
		}
		this._render();
	}

	_closeTab(tabId) {
		this.root = removeTab(this.root, tabId);
		if (!this.root) {
			this.root = makeTabs([]);
		}
		this._render();
	}
}
