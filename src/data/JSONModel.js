// Cars dataset (subset). Mirrors the PhosphorJS demo's "JSON Data" panel:
// 30 rows × 8 columns of mixed numeric/string fields.

import { DataModel } from './DataModel.js';

const SCHEMA = ['index', 'Acceleration', 'Cylinders', 'Displacement', 'Horsepower', 'Miles_per_Gallon'];

const ROWS = [
	[0, 12, 8, 307, 130, 18],
	[1, 11.5, 8, 350, 165, 15],
	[2, 11, 8, 318, 150, 18],
	[3, 12, 8, 304, 150, 16],
	[4, 10.5, 8, 302, 140, 17],
	[5, 10, 8, 429, 198, 15],
	[6, 9, 8, 454, 220, 14],
	[7, 8.5, 8, 440, 215, 14],
	[8, 10, 8, 455, 225, 14],
	[9, 8.5, 8, 390, 190, 15],
	[10, 17.5, 4, 133, 115, 0],
	[11, 11.5, 8, 350, 165, 0],
	[12, 11, 8, 351, 153, 0],
	[13, 10.5, 8, 383, 175, 0],
	[14, 10, 8, 340, 170, 15],
	[15, 8, 8, 302, 160, 14],
	[16, 8, 8, 302, 140, 0],
	[17, 9.5, 8, 400, 150, 15],
	[18, 10, 8, 455, 225, 14],
	[19, 15, 4, 113, 95, 24],
	[20, 15.5, 6, 198, 95, 22],
	[21, 15.5, 6, 199, 97, 18],
	[22, 16, 6, 200, 85, 21],
	[23, 14.5, 4, 97, 88, 27],
	[24, 20.5, 4, 97, 46, 26],
	[25, 17.5, 4, 110, 87, 25],
	[26, 14.5, 4, 107, 90, 24],
	[27, 17.5, 4, 104, 95, 25],
	[28, 12.5, 4, 121, 113, 26],
	[29, 15, 6, 199, 90, 21]
];

export class JSONModel extends DataModel {
	rowCount() {
		return ROWS.length;
	}
	columnCount() {
		return SCHEMA.length;
	}
	data(row, col) {
		return ROWS[row][col];
	}
	columnHeaderData(row, col) {
		return SCHEMA[col];
	}
	rowHeaderData(row, col) {
		return String(row);
	}
}
