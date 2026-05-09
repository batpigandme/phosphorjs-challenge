// Cars dataset (subset). Mirrors the PhosphorJS demo's "JSON Data" panel:
// 30 rows × 8 columns of mixed numeric/string fields.

import { DataModel } from './DataModel.js';

const SCHEMA = ['name', 'mpg', 'cyl', 'hp', 'wt', 'sec', 'year', 'origin'];

const ROWS = [
	['Chevrolet Chevelle Malibu', 18.0, 8, 130, 3504, 12.0, 70, 'USA'],
	['Buick Skylark 320', 15.0, 8, 165, 3693, 11.5, 70, 'USA'],
	['Plymouth Satellite', 18.0, 8, 150, 3436, 11.0, 70, 'USA'],
	['AMC Rebel SST', 16.0, 8, 150, 3433, 12.0, 70, 'USA'],
	['Ford Torino', 17.0, 8, 140, 3449, 10.5, 70, 'USA'],
	['Ford Galaxie 500', 15.0, 8, 198, 4341, 10.0, 70, 'USA'],
	['Chevrolet Impala', 14.0, 8, 220, 4354, 9.0, 70, 'USA'],
	['Plymouth Fury iii', 14.0, 8, 215, 4312, 8.5, 70, 'USA'],
	['Pontiac Catalina', 14.0, 8, 225, 4425, 10.0, 70, 'USA'],
	['AMC Ambassador DPL', 15.0, 8, 190, 3850, 8.5, 70, 'USA'],
	['Citroen DS-21 Pallas', 0.0, 4, 115, 3090, 17.5, 70, 'Europe'],
	['Chevrolet Chevelle Concours', 0.0, 8, 165, 4142, 11.5, 70, 'USA'],
	['Ford Torino 500', 0.0, 8, 153, 4034, 11.0, 70, 'USA'],
	['Plymouth Satellite Sebring', 0.0, 8, 175, 4166, 10.5, 70, 'USA'],
	['Dodge Challenger SE', 15.0, 8, 170, 3563, 10.0, 70, 'USA'],
	["Plymouth 'Cuda 340", 14.0, 8, 160, 3609, 8.0, 70, 'USA'],
	['Ford Mustang Boss 302', 0.0, 8, 140, 3353, 8.0, 70, 'USA'],
	['Chevrolet Monte Carlo', 15.0, 8, 150, 3761, 9.5, 70, 'USA'],
	['Buick Estate Wagon (sw)', 14.0, 8, 225, 3086, 10.0, 70, 'USA'],
	['Toyota Corona Mark ii', 24.0, 4, 95, 2372, 15.0, 70, 'Japan'],
	['Plymouth Duster', 22.0, 6, 95, 2833, 15.5, 70, 'USA'],
	['AMC Hornet', 18.0, 6, 97, 2774, 15.5, 70, 'USA'],
	['Ford Maverick', 21.0, 6, 85, 2587, 16.0, 70, 'USA'],
	['Datsun PL510', 27.0, 4, 88, 2130, 14.5, 70, 'Japan'],
	['Volkswagen 1131 Deluxe Sedan', 26.0, 4, 46, 1835, 20.5, 70, 'Europe'],
	['Peugeot 504', 25.0, 4, 87, 2672, 17.5, 70, 'Europe'],
	['Audi 100 LS', 24.0, 4, 90, 2430, 14.5, 70, 'Europe'],
	['Saab 99e', 25.0, 4, 95, 2375, 17.5, 70, 'Europe'],
	['BMW 2002', 26.0, 4, 113, 2234, 12.5, 70, 'Europe'],
	['AMC Gremlin', 21.0, 6, 90, 2648, 15.0, 70, 'USA']
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
	columnHeader(col) {
		return SCHEMA[col];
	}
	rowHeader(row) {
		return String(row);
	}
}
