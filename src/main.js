// Phase 3 wiring: DockPanel with five panels in a layout matching the
// PhosphorJS demo's starting arrangement.
//
// Initial layout (mirrors phosphor's example_datagrid):
//   horizontal-split:
//     vertical-split (left):
//       Trillion Rows/Cols
//       Random Ticks 1
//     vertical-split (right):
//       Streaming Rows
//       Random Ticks 2
//       JSON Data

import { DataGrid } from './grid/DataGrid.js';
import { TextRenderer, viridis, viridisText } from './grid/CellRenderer.js';
import { LargeDataModel } from './data/LargeDataModel.js';
import { RandomDataModel } from './data/RandomDataModel.js';
import { StreamingDataModel } from './data/StreamingDataModel.js';
import { JSONModel } from './data/JSONModel.js';
import { DockPanel } from './dock/DockPanel.js';
import { makeTab, makeTabs, makeSplit } from './dock/LayoutNode.js';
import { attachFPSOverlay } from './util/fps.js';

const root = document.getElementById('root');
root.innerHTML = '';

function makeGridHost(model, opts) {
	const host = document.createElement('div');
	host.style.cssText = 'position:absolute;inset:0;';
	new DataGrid(host, { ...opts, model });
	return host;
}

const trillionHost = makeGridHost(new LargeDataModel(), {
	theme: 'blue',
	selectionMode: 'cell'
});

const streamingHost = makeGridHost(new StreamingDataModel(40, 50), {
	theme: 'brown',
	colWidth: 96,
	selectionMode: 'column'
});

const ticks1Host = makeGridHost(new RandomDataModel(15, 10), {
	theme: 'blue',
	colWidth: 80,
	selectionMode: 'cell',
	stretchLastColumn: true,
	renderer: new TextRenderer({
		align: 'right',
		format: (_r, _c, v) => v.toFixed(2),
		color: (_r, _c, v) => (v < 0.33 ? '#c00' : v > 0.66 ? '#080' : '#000')
	})
});

const ticks2Host = makeGridHost(new RandomDataModel(80, 80, 7777), {
	theme: null,
	colWidth: 60,
	selectionMode: 'cell',
	selectionStyle: {
		fill: 'rgba(255,255,255,0.2)',
		border: 'rgba(255,255,255,0.8)',
		cursorBorder: '#ffffff'
	},
	renderer: new TextRenderer({
		align: 'center',
		format: (_r, _c, v) => v.toFixed(2),
		bg: (_r, _c, v) => viridis(v),
		color: (_r, _c, v) => viridisText(v)
	})
});

const jsonHost = makeGridHost(new JSONModel(), {
	theme: 'green',
	rowHeight: 28,
	colWidth: 132,
	colHeaderHeight: 28,
	selectionMode: 'row',
	renderer: new TextRenderer({
		align: 'right'
	})
});

const tabTrillion = makeTab('Trillion Rows/Cols', trillionHost);
const tabStreaming = makeTab('Streaming Rows', streamingHost);
const tabTicks1 = makeTab('Random Ticks 1', ticks1Host);
const tabTicks2 = makeTab('Random Ticks 2', ticks2Host);
const tabJSON = makeTab('JSON Data', jsonHost);

const layout = makeSplit(
	'horizontal',
	[
		makeSplit(
			'vertical',
			[makeTabs([tabTrillion]), makeTabs([tabTicks1])],
			[0.5, 0.5]
		),
		makeSplit(
			'vertical',
			[makeTabs([tabStreaming]), makeTabs([tabJSON]), makeTabs([tabTicks2])],
			[0.34, 0.33, 0.33]
		)
	],
	[0.5, 0.5]
);

const dock = new DockPanel(root, layout);

attachFPSOverlay();

/** @type {any} */
(window).__dock = dock;
